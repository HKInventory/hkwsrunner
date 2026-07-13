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

let _running = false, _onlineKarts = [], _detailRunning = false;
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
// Pull each ONLINE kart's live per-kart telemetry into rimo_detail so the app's kart detail is live.
async function detailSweep(){
  if (!supa || _detailRunning || !loggedIn) return;
  _detailRunning = true;
  try {
    const list = _onlineKarts.slice(0, 80);
    let ok = 0;
    for (const k of list){
      try { const d = await fetchKartData(k.id); if (d){ await supa.from('rimo_detail').upsert({ serial_no: k.serial, kart_no: k.kartNo, data: d, updated_at: new Date().toISOString() }, { onConflict: 'serial_no' }); ok++; } }
      catch (e) {}
      await new Promise(r => setTimeout(r, 120));
    }
    if (ok) console.log(`[rimo] detail: ${ok}/${list.length} online karts refreshed`);
  } finally { _detailRunning = false; }
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
    // Remember which karts are online (+ their internal id) so the detail sweep can pull kartdata.php.
    _onlineKarts = rows.filter(r => r.online && r._rimoId).map(r => ({ serial: r.serial_no, id: r._rimoId, kartNo: r.kart_no }));
    // Only write karts whose meaningful state changed since the last poll. At a 1s poll that means
    // ~0 writes most seconds and a handful when a kart flips online/off — the whole fleet is still
    // fully readable (unchanged rows keep their last value), we just avoid re-writing 200 rows/sec.
    const now = new Date().toISOString();
    const changed = [];
    for (const x of rows){
      const sig = [x.online ? 1 : 0, x.bms_ok ? 1 : 0, x.soc, x.last_online, x.hours, x.preset, x.speedset, x.group_name, x.kart_no].join('|');
      if (_rimoSig[x.serial_no] !== sig){ _rimoSig[x.serial_no] = sig; const { _rimoId, ...rest } = x; changed.push({ ...rest, updated_at: now }); }
    }
    if (!changed.length) return;   // nothing changed — skip the write entirely
    const { error } = await supa.from('rimo_karts').upsert(changed, { onConflict: 'serial_no' });
    if (error) console.error('[rimo] upsert:', error.message);
    else console.log(`[rimo] ${changed.length} changed · ${rows.filter(x => x.online).length}/${rows.length} online`);
  } catch (e) { console.error('[rimo]', e.message || e); }   // auth resets happen explicitly; don't loop re-login here
  finally { _running = false; }
}

function startRimo(){
  if (!USER || !PASS) { console.log('[rimo] RIMO_USER/RIMO_PASS not set — RiMO poller disabled'); return; }
  syncRimo();
  setInterval(syncRimo, POLL_MS);
  const DETAIL_MS = Math.max(6, parseInt(process.env.RIMO_DETAIL_SEC || '12', 10)) * 1000;
  setTimeout(function run(){ detailSweep().catch(() => {}).finally(() => setTimeout(run, DETAIL_MS)); }, 5000);   // per-kart telemetry sweep
  console.log(`[rimo] poller started — grid every ${POLL_MS / 1000}s, detail every ${DETAIL_MS / 1000}s`);
}

module.exports = { startRimo, syncRimo, parseRimoRows };
