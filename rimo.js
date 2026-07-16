'use strict';
/* ============================================================================
   RiMO Germany WFM poller
   Logs into wfm.rimo-germany.com, pulls the live karts grid (Online / BMS / SOC /
   last-online) rapid-fire, and mirrors it into the rimo_karts table. The app reads
   that table to light each kart chip's green/red dot.

   ENV:
     RIMO_USER, RIMO_PASS        — the WFM login codes (required to enable the poller)
     RIMO_BASE                   — default http://wfm.rimo-germany.com
     RIMO_POLL_SEC               — default 4 (how often to pull the grid)
     RIMO_KARTS_URL              — OPTIONAL: exact data-feed URL. If unset, the poller
                                   discovers it from karts.php. Set this to the "Update
                                   List" request URL if discovery ever fails.
     SUPABASE_URL / SB_URL, SUPABASE_SERVICE_KEY / SB_SERVICE_KEY

   The grid XML is dhtmlx format: <rows><row><cell>…</cell>…</row></rows>. Cell order
   (0-based): 0 Kart-No, 1 Serial, 2 Karttrack, 3 Group, 4 Preset, 5 Speedset, 6 Hours,
   7 Online(1/0), 8 BMS(1/0), 11 SOC(%), 20 Last-online. The rest is kept in `raw`.
   ========================================================================== */
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SB_URL = process.env.SUPABASE_URL || process.env.SB_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SB_SERVICE_KEY;
const supa = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;

const BASE    = (process.env.RIMO_BASE || 'http://wfm.rimo-germany.com').replace(/\/+$/, '');
const USER    = (process.env.RIMO_USER || '').trim();
const PASS    = (process.env.RIMO_PASS || '').trim();
const POLL_MS = Math.max(1, parseInt(process.env.RIMO_POLL_SEC || '4', 10)) * 1000;
let   KARTS_URL = process.env.RIMO_KARTS_URL || `${BASE}/data/kartgrid.php`;   // confirmed live-grid feed

// RiMO's login page hashes the password as md5(md5(password) + PHPSESSID) — the session id is a
// per-login salt baked into the page. So we fetch login.php for the session, then hash the same way.
function md5hex(s){ return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }
function cryptPass(rawPass, sid){ return md5hex(md5hex(rawPass) + sid); }

// ---- tiny cookie jar (PHPSESSID) --------------------------------------------
let jar = {};
function absorb(res){
  let list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!list || !list.length) { const raw = res.headers.get('set-cookie'); if (raw) list = [raw]; }   // fallback
  for (const sc of (list || [])){ const p = sc.split(';')[0], i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
}
function cookieHeader(){ return Object.keys(jar).map(k => `${k}=${jar[k]}`).join('; '); }
function H(extra = {}){ return { Cookie: cookieHeader(), 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', ...extra }; }

let loggedIn = false;
let _rimoSig = {};   // serial_no -> last state signature, so we only write karts that changed

async function rimoLogin(){
  jar = {};
  // 1) load login.php → gives us the session cookie AND the page bakes the hash salt into crypt():
  //    crypt(str){ return md5(md5(str)+"<salt>"); }  — the salt is the session id in practice, but we
  //    read it straight from the page so we always hash with the exact value the browser would use.
  let html = '';
  try { const r0 = await fetch(`${BASE}/login.php`, { headers: H({ Accept: 'text/html' }), redirect: 'manual', signal: AbortSignal.timeout(15000) }); absorb(r0); html = await r0.text().catch(() => ''); } catch (e) {}
  const m = html.match(/md5\s*\(\s*md5\s*\([^)]*\)\s*\+\s*"([^"]+)"/i);
  const salt = (m && m[1]) || jar.PHPSESSID || '';
  if (!salt) { loggedIn = false; console.log('[rimo] login: could not read the hash salt from login.php'); throw new Error('no salt'); }
  // 2) submit user + md5(md5(password) + salt), exactly like the login page's crypt()
  const body = new URLSearchParams({ user: USER, password: cryptPass(PASS, salt) }).toString();
  const r = await fetch(`${BASE}/template/logincheck.php`, { method: 'POST',
    headers: H({ 'Content-type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE, Referer: `${BASE}/login.php`, Accept: '*/*' }), body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  absorb(r);
  const txt = (await r.text().catch(() => '')).trim();
  if (txt !== 'ok') {   // the login page treats any response other than "ok" as failure
    loggedIn = false;
    console.log(`[rimo] login NOT accepted — sent user='${USER}' · logincheck(${r.status}) "${txt.slice(0, 60).replace(/\s+/g, ' ')}" · cookies: ${Object.keys(jar).join(',') || 'NONE'} — RIMO_PASS must be your PLAIN password now (not a hash)`);
    throw new Error('login not accepted');
  }
  loggedIn = true;
  console.log(`[rimo] logged in (cookies: ${Object.keys(jar).join(',') || 'none'})`);
}

function feedUrl(){
  // The browser hits the grid with a fresh ?e=<ms> cache-buster each time; do the same so no proxy
  // or PHP session cache can hand us a stale grid. Strip any stale cache-buster from KARTS_URL first.
  let u = KARTS_URL.replace(/([?&])e=\d+/i, '$1').replace(/[?&]+$/, '');
  u = u.replace(/([?&])&+/g, '$1');
  return u + (u.includes('?') ? '&' : '?') + 'e=' + Date.now();
}

function cellText(inner){
  const m = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : inner).replace(/<[^>]*>/g, '').trim();
}
function parseRimoRows(xml){
  const out = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  let rm;
  while ((rm = rowRe.exec(xml))){
    const cells = [];
    const cellRe = /<cell\b[^>]*>([\s\S]*?)<\/cell>/gi;
    let cm; while ((cm = cellRe.exec(rm[1]))) cells.push(cellText(cm[1]));
    if (cells.length < 9 || !cells[1]) continue;   // need at least through BMS + a serial
    const socRaw = (cells[11] || '').replace('%', '').trim();
    const last   = (cells[20] || '').trim();
    const idm    = rm[0].match(/<row\b[^>]*\bid=["']?([^"'\s>]+)/i);
    out.push({
      serial_no:  cells[1],
      kart_no:    /^\d+$/.test(cells[0]) ? parseInt(cells[0], 10) : null,
      _rimoId:    idm ? idm[1] : null,
      karttrack:  cells[2] || '',
      group_name: cells[3] || '',
      preset:     cells[4] || '',
      speedset:   cells[5] || '',
      hours:      cells[6] || '',
      online:     cells[7] === '1',
      bms_ok:     cells[8] === '1',
      soc:        (socRaw && !isNaN(+socRaw)) ? parseInt(socRaw, 10) : null,
      last_online: last || null,
      raw:        cells
    });
  }
  return out;
}

async function fetchGrid(url){
  const r = await fetch(url, { headers: H({ Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/karts.php` }), redirect: 'manual', signal: AbortSignal.timeout(15000) });
  absorb(r);
  const loc = r.headers.get('location') || '';
  const body = await r.text().catch(() => '');
  const authFail = (r.status === 302 || /login\.php/i.test(loc) || /name=["']?password/i.test(body));
  if (authFail) loggedIn = false;
  return { status: r.status, loc, body, authFail };
}

let _running = false, _idBySerial = {}, _focusRunning = false, _bmsLogged = false;
let _byKartNo = {};                                  // kart_no -> {id, serial, online, track} (prefers online row)
let _byKartTrack = {};                                // "num|track" -> {id, serial, online, track} — exact when numbers duplicate
// Normalise RaceFacer/RiMO track names to a common token so "Intermediate Track" == "intermediate".
function _normTrack(t){ t = String(t || '').toLowerCase(); if (/inter/.test(t)) return 'inter'; if (/adult/.test(t)) return 'adult'; if (/junior/.test(t)) return 'junior'; if (/mini/.test(t)) return 'mini'; if (/twin/.test(t)) return 'twin'; if (/melb/.test(t)) return 'melb'; if (/cadet/.test(t)) return 'cadet'; return t.replace(/[^a-z0-9]/g, ''); }
let _histRunning = false, _histSig = {}, _histActive = { at: 0, karts: [] }, _histLinkLogged = false, _histSessLogged = '';
// kartdata.php returns XML like <data><tag><![CDATA[value]]></tag>…</data>. Pull every leaf field.
function parseKartData(xml){
  const inner = (String(xml).match(/<data>([\s\S]*)<\/data>/i) || [null, String(xml)])[1];
  const out = {};
  const re = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
  let m; while ((m = re.exec(inner))){
    const k = m[1]; let v = m[2];
    const cd = v.match(/<!\[CDATA\[([\s\S]*?)\]\]>/); if (cd) v = cd[1];
    out[k] = v.trim();
  }
  return out;
}
async function fetchKartData(id){
  const u = `${BASE}/data/kartdata.php?id=${encodeURIComponent(id)}`;
  const r = await fetch(u, { headers: H({ Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/karts.php` }), redirect: 'manual', signal: AbortSignal.timeout(15000) });
  absorb(r);
  if (r.status === 302 || /login\.php/i.test(r.headers.get('location') || '')) { loggedIn = false; return null; }
  const body = await r.text().catch(() => '');
  if (!/<data>/i.test(body)) return null;
  return parseKartData(body);
}
async function fetchKartBms(id){
  const u = `${BASE}/data/kartbmsdata.php?id=${encodeURIComponent(id)}`;
  const r = await fetch(u, { headers: H({ Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/karts.php` }), redirect: 'manual', signal: AbortSignal.timeout(15000) });
  absorb(r);
  if (r.status === 302 || /login\.php/i.test(r.headers.get('location') || '')) { loggedIn = false; return null; }
  const body = await r.text().catch(() => '');
  if (!/<data>/i.test(body)) return null;
  if (!_bmsLogged){ _bmsLogged = true; console.log(`[rimo] kartbmsdata sample (id ${id}, ${body.length} bytes) ::: ${String(body).replace(/\s+/g, ' ').slice(0, 4000)}`); }
  return parseKartData(body);
}
const _detailSig = {};
// Signature of the LIVE values only (timestamps stripped) so a parked/unchanging kart doesn't re-write.
function _detailSigOf(d, bms){
  const strip = o => { if (!o) return o; const c = { ...o }; ['timestamp','timestampReboot','timestampEnginestart'].forEach(k => delete c[k]); return c; };
  return JSON.stringify(strip(d)) + '|' + JSON.stringify(strip(bms));
}
// Fast per-kart refresh for the kart the app is CURRENTLY viewing (rows in rimo_focus). We FETCH every
// ~1.5s (cheap — inbound), but only WRITE to Supabase (the metered outbound) when the live values actually
// change. So a kart sitting idle costs ~nothing; a driving kart updates live like RiMO's own page.
async function focusSweep(){
  if (!supa || _focusRunning || !loggedIn || process.env.RIMO_DETAIL === 'off') return;
  _focusRunning = true;
  try {
    const since = new Date(Date.now() - 20000).toISOString();
    const { data } = await supa.from('rimo_focus').select('serial_no').gte('updated_at', since);
    const focus = (data || []).map(r => r.serial_no).filter(Boolean).slice(0, 4);
    for (const serial of focus){
      const id = _idBySerial[serial]; if (!id) continue;
      try {
        const [d, bms] = await Promise.all([ fetchKartData(id).catch(() => null), fetchKartBms(id).catch(() => null) ]);
        if (!d && !bms) continue;
        const sig = _detailSigOf(d, bms);
        if (_detailSig[serial] === sig) continue;   // unchanged since last write — skip it (this is the bandwidth saver)
        _detailSig[serial] = sig;
        const data = { ...(d || {}), _bms: (bms || null) };
        await supa.from('rimo_detail').upsert({ serial_no: serial, kart_no: (d && d.kartNo) || null, data, updated_at: new Date().toISOString() }, { onConflict: 'serial_no' });
      } catch (e) {}
    }
  } finally { _focusRunning = false; }
}
async function syncRimo(){
  if (!supa) { console.error('[rimo] missing Supabase env'); return; }
  if (_running) return;   // CRITICAL: never overlap — concurrent polls share one cookie jar and clobber each other's login
  _running = true;
  try {
    if (!loggedIn) await rimoLogin();
    const url = feedUrl();
    let res = await fetchGrid(url);
    if (res.authFail) { await rimoLogin(); res = await fetchGrid(url); }   // one clean retry after a fresh login
    if (res.authFail) {
      console.log(`[rimo] grid auth-fail (status ${res.status}${res.loc ? ' -> ' + res.loc : ''}) ${String(res.body).slice(0, 120).replace(/\s+/g, ' ')}`);
      return;
    }
    const rows = parseRimoRows(res.body);
    if (!rows.length) { console.log(`[rimo] 0 rows parsed (status ${res.status}, ${String(res.body).length} bytes) ${String(res.body).slice(0, 120).replace(/\s+/g, ' ')}`); return; }
    // Map every kart's serial -> internal id so the focus sweep can pull its per-kart feeds on demand.
    // Also kart_no -> {id, serial} (prefer the ONLINE row when numbers duplicate) for the history logger.
    rows.forEach(r => { if (r._rimoId) _idBySerial[r.serial_no] = r._rimoId; });
    rows.forEach(r => { if (!r._rimoId) return; const cur = _byKartNo[r.kart_no]; if (!cur || r.online) _byKartNo[r.kart_no] = { id: r._rimoId, serial: r.serial_no, online: !!r.online, track: r.group_name || '' }; });
    // Also index by number+track so duplicate kart numbers across types (Junior 2 vs Inter 2) resolve
    // exactly. Key: "<num>|<normalised track>". Prefer the online row on collision.
    rows.forEach(r => { if (!r._rimoId || r.kart_no == null) return; const key = r.kart_no + '|' + _normTrack(r.group_name); const cur = _byKartTrack[key]; if (!cur || r.online) _byKartTrack[key] = { id: r._rimoId, serial: r.serial_no, online: !!r.online, track: r.group_name || '' }; });
    // Only write karts whose meaningful state changed since the last poll. At a 1s poll that means
    // ~0 writes most seconds and a handful when a kart flips online/off — the whole fleet is still
    // fully readable (unchanged rows keep their last value), we just avoid re-writing 200 rows/sec.
    const now = new Date().toISOString();
    const changed = [];
    for (const x of rows){
      // Only meaningful state triggers a write. last_online ticks every second and hours drifts constantly
      // for every online kart — including them here re-wrote the whole online fleet every single poll (the
      // bandwidth drain). They still get written — they ride along on the next real change — just aren't a
      // trigger themselves. online/bms flips and soc/preset/speedset changes still write promptly.
      const sig = [x.online ? 1 : 0, x.bms_ok ? 1 : 0, x.soc, x.preset, x.speedset, x.group_name, x.kart_no].join('|');
      if (_rimoSig[x.serial_no] !== sig){ _rimoSig[x.serial_no] = sig; const { _rimoId, raw, ...rest } = x; changed.push({ ...rest, updated_at: now }); }   // drop raw (large cell array, nothing reads it) from the write
    }
    if (!changed.length) return;   // nothing changed — skip the write entirely
    const { error } = await supa.from('rimo_karts').upsert(changed, { onConflict: 'serial_no' });
    if (error) console.error('[rimo] upsert:', error.message);
    else console.log(`[rimo] ${changed.length} changed · ${rows.filter(x => x.online).length}/${rows.length} online`);
  } catch (e) { console.error('[rimo]', e.message || e); }   // auth resets happen explicitly; don't loop re-login here
  finally { _running = false; }
}

/* ── BMS CELL HISTORY (for HK AI: "which cell died during the 10:00 session?") ─────────────
   Logs per-cell voltages at RiMO tick (RIMO_HIST_MS, default 1000ms) for karts that are IN A
   SESSION right now (rf_sessions in_progress / inside its time window, synced by rf_sessions.js).
   Fetches from RiMO are inbound = free on Render; Supabase WRITES only happen when a kart's cell
   values actually changed (the same change-detection as the grid), batched one insert per tick.
   Kill switch: RIMO_HISTORY=off. Retention: rf_sessions.js prunes rows older than 7 days.

   Kart linking: primary = fleet_management_id (from the session) matched against the RiMO serial;
   fallback = kart number. A one-time "[hist] link check" log prints both side-by-side so we can
   confirm whether fleet_management_id really is the RiMO serial. */
async function _histRefreshActive(){
  // Which karts are on track right now? Cached 15s — one cheap read, not one per tick.
  if (Date.now() - _histActive.at < 15000) return _histActive.karts;
  _histActive.at = Date.now();
  try {
    const nowIso = new Date().toISOString();
    // ONLY log karts in a session that is actually RUNNING (green-flagged → status in_progress).
    // The old version also matched any session whose SCHEDULED time window covered "now", which
    // logged sessions that were never started. RaceFacer reports status:"in_progress" for a live
    // race, so we gate strictly on that.
    const { data: sess } = await supa.from('rf_sessions')
      .select('uuid,label,status,track,scheduled_at,ends_at')
      .eq('status', 'in_progress')
      .limit(12);
    const uuids = (sess || []).map(s => s.uuid);
    if (!uuids.length){ _histActive.karts = []; return []; }
    if (!_histSessLogged || _histSessLogged !== uuids.join(',')){ _histSessLogged = uuids.join(',');
      console.log(`[hist] ${uuids.length} session(s) IN PROGRESS → logging: ${(sess || []).map(s => s.label + ' [' + (s.track || '?') + ']').join(', ')}`); }
    const trackByUuid = {}; (sess || []).forEach(s => { trackByUuid[s.uuid] = s.track || ''; });
    const { data: runs } = await supa.from('rf_session_runs')
      .select('kart_no,fleet_management_id,session_uuid')
      .in('session_uuid', uuids).limit(120);
    const seen = {}, out = [];
    for (const r of (runs || [])){
      const kn = parseInt(r.kart_no, 10); if (!Number.isFinite(kn) || seen[kn]) continue;
      seen[kn] = true; out.push({ kart_no: kn, fm_id: (r.fleet_management_id || '').trim(), track: trackByUuid[r.session_uuid] || '' });
    }
    _histActive.karts = out;
  } catch (e) { /* keep last known set */ }
  return _histActive.karts;
}
function _histResolve(k){
  // fleet_management_id is CONFIRMED not the RiMO serial (fm_id "0578" vs serial "092018291"), so
  // we link by KART NUMBER — the thing painted on the kart, consistent across RaceFacer and RiMO.
  // To handle duplicate numbers across types (Junior 2 vs Intermediate 2), match number + TRACK
  // first (exact), then fall back to number alone (preferring the online row).
  if (k.track){
    const exact = _byKartTrack[k.kart_no + '|' + _normTrack(k.track)];
    if (exact) return { id: exact.id, serial: exact.serial, via: 'num+track' };
  }
  const byNo = _byKartNo[k.kart_no] || _byKartNo[String(k.kart_no)];
  if (byNo) return { id: byNo.id, serial: byNo.serial, via: 'kart_no' };
  return null;
}
function _histRowOf(bms, serial, kartNo){
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const cells = [];
  for (const side of ['Left', 'Right']) for (let i = 1; i <= 8; i++) cells.push(num(bms[`cell${i}Voltage${side}`]));
  const faults = {};
  ['overCurrent','systemFault','chassisConnectionFault','errorCOM','errorRelais'].forEach(f => { if (num(bms[f])) faults[f] = num(bms[f]); });
  ['cellFault','tempExtFault','tempIntFault','underVoltage','overVoltage','overTempFault'].forEach(f => ['Left','Right'].forEach(s => { if (num(bms[f + s])) faults[f + s] = num(bms[f + s]); }));
  return {
    serial_no: serial, kart_no: kartNo, at: new Date().toISOString(),
    soc: num(bms.socLeft), pack_v: num(bms.voltageLeft), avg_v: num(bms.voltageRight),
    current_a: num(bms.actualCurrent), cells,
    faults: Object.keys(faults).length ? faults : null,
  };
}
async function historySweep(){
  if (!supa || _histRunning || !loggedIn || process.env.RIMO_HISTORY === 'off') return;
  _histRunning = true;
  try {
    const active = await _histRefreshActive();
    if (!active.length) return;
    const targets = [];
    for (const k of active){ const t = _histResolve(k); if (t && (!_byKartNo[k.kart_no] || _byKartNo[k.kart_no].online !== false)) targets.push({ ...t, kart_no: k.kart_no, track: k.track }); }
    if (!targets.length) return;
    if (!_histLinkLogged){ _histLinkLogged = true;
      const s = targets.slice(0, 5).map(t => `kart ${t.kart_no} (${t.track || 'no-track'}) -> serial="${t.serial}" via ${t.via}`).join('  ·  ');
      console.log(`[hist] link check: ${s}`); }
    // Fetch BMS for every target with bounded concurrency (be polite to RiMO's server).
    const CONC = Math.max(2, Math.min(10, parseInt(process.env.RIMO_HIST_CONC || '6', 10)));
    const rows = [];
    for (let i = 0; i < targets.length; i += CONC){
      const batch = targets.slice(i, i + CONC);
      const got = await Promise.all(batch.map(t => fetchKartBms(t.id).then(b => ({ t, b })).catch(() => ({ t, b: null }))));
      for (const { t, b } of got){
        if (!b) continue;
        const row = _histRowOf(b, t.serial, t.kart_no);
        const sig = JSON.stringify([row.cells, row.soc, row.current_a, row.pack_v]);
        if (_histSig[t.serial] === sig) continue;   // no cell/soc/current movement -> no write
        _histSig[t.serial] = sig;
        rows.push(row);
      }
    }
    if (!rows.length) return;
    const { error } = await supa.from('rimo_bms_history').insert(rows);
    if (error){ if (!/relation|does not exist/i.test(error.message)) console.error('[hist] insert:', error.message); }
  } catch (e) { console.error('[hist]', e.message || e); }
  finally { _histRunning = false; }
}

function startRimo(){
  if (!USER || !PASS) { console.log('[rimo] RIMO_USER/RIMO_PASS not set — RiMO poller disabled'); return; }
  syncRimo();
  setInterval(syncRimo, POLL_MS);
  const detailOn = process.env.RIMO_DETAIL !== 'off';
  const FOCUS_MS = Math.max(1000, parseInt(process.env.RIMO_FOCUS_MS || '1500', 10));
  if (detailOn) setTimeout(function run(){ focusSweep().catch(() => {}).finally(() => setTimeout(run, FOCUS_MS)); }, 3000);   // fast per-kart telemetry for the viewed kart
  // BMS cell-history logger (session karts, RiMO tick, write-on-change). RIMO_HISTORY=off disables.
  const histOn = process.env.RIMO_HISTORY !== 'off';
  const HIST_MS = Math.max(500, parseInt(process.env.RIMO_HIST_MS || '1000', 10));
  if (histOn) setTimeout(function run(){ historySweep().catch(() => {}).finally(() => setTimeout(run, HIST_MS)); }, 6000);
  console.log(`[rimo] poller started — grid every ${POLL_MS / 1000}s` + (detailOn ? `, focus detail every ${FOCUS_MS}ms (only writes on change)` : ', detail OFF (grid only: online/SOC/BMS)') + (histOn ? `, cell history every ${HIST_MS}ms for session karts` : ', history OFF'));
}

module.exports = { startRimo, syncRimo, parseRimoRows };
