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

const SB_URL = process.env.SUPABASE_URL || process.env.SB_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SB_SERVICE_KEY;
const supa = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;

const BASE    = (process.env.RIMO_BASE || 'http://wfm.rimo-germany.com').replace(/\/+$/, '');
const USER    = process.env.RIMO_USER || '';
const PASS    = process.env.RIMO_PASS || '';
const POLL_MS = Math.max(1, parseInt(process.env.RIMO_POLL_SEC || '4', 10)) * 1000;
let   KARTS_URL = process.env.RIMO_KARTS_URL || `${BASE}/data/kartgrid.php`;   // confirmed live-grid feed

// ---- tiny cookie jar (PHPSESSID) --------------------------------------------
let jar = {};
function absorb(res){
  let list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!list || !list.length) { const raw = res.headers.get('set-cookie'); if (raw) list = [raw]; }   // fallback
  for (const sc of (list || [])){ const p = sc.split(';')[0], i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
}
function cookieHeader(){ return Object.keys(jar).map(k => `${k}=${jar[k]}`).join('; '); }
function H(extra = {}){ return { Cookie: cookieHeader(), 'User-Agent': 'HKWorkshopBot/1.0', ...extra }; }

let loggedIn = false;
let _rimoSig = {};   // serial_no -> last state signature, so we only write karts that changed

async function rimoLogin(){
  jar = {};
  // 1) touch login.php so PHP hands us a session cookie
  try { const r0 = await fetch(`${BASE}/login.php`, { headers: H({ Accept: 'text/html' }), redirect: 'manual', signal: AbortSignal.timeout(15000) }); absorb(r0); } catch (e) {}
  // 2) submit the codes
  const body = new URLSearchParams({ user: USER, password: PASS }).toString();
  const r = await fetch(`${BASE}/template/logincheck.php`, { method: 'POST',
    headers: H({ 'Content-type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE, Referer: `${BASE}/login.php`, Accept: '*/*' }), body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  absorb(r);
  const txt = await r.text().catch(() => '');
  // 3) establish + VERIFY the session by loading karts.php (the page that hosts the grid). Some PHP
  //    setups only finalise the authed session once you land on a real page after logincheck, and this
  //    also tells us definitively whether the credentials were accepted.
  let vloc = '', vstatus = 0, vbody = '';
  try {
    const v = await fetch(`${BASE}/karts.php`, { headers: H({ Accept: 'text/html', Referer: `${BASE}/login.php` }), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    absorb(v); vstatus = v.status; vloc = v.headers.get('location') || ''; vbody = await v.text().catch(() => '');
  } catch (e) {}
  const ok = !(vstatus === 302 && /login\.php/i.test(vloc)) && !/<input[^>]*name=["']?password/i.test(vbody) && vstatus < 400;
  if (!ok) {
    loggedIn = false;
    console.log(`[rimo] login NOT accepted — logincheck(${r.status}) "${String(txt).slice(0, 60).replace(/\s+/g, ' ')}" · karts.php(${vstatus}${vloc ? ' -> ' + vloc : ''}) · cookies: ${Object.keys(jar).join(',') || 'NONE'} — check RIMO_USER/RIMO_PASS`);
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
    out.push({
      serial_no:  cells[1],
      kart_no:    /^\d+$/.test(cells[0]) ? parseInt(cells[0], 10) : null,
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

let _running = false;
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
    // Only write karts whose meaningful state changed since the last poll. At a 1s poll that means
    // ~0 writes most seconds and a handful when a kart flips online/off — the whole fleet is still
    // fully readable (unchanged rows keep their last value), we just avoid re-writing 200 rows/sec.
    const now = new Date().toISOString();
    const changed = [];
    for (const x of rows){
      const sig = [x.online ? 1 : 0, x.bms_ok ? 1 : 0, x.soc, x.last_online, x.hours, x.preset, x.speedset, x.group_name, x.kart_no].join('|');
      if (_rimoSig[x.serial_no] !== sig){ _rimoSig[x.serial_no] = sig; changed.push({ ...x, updated_at: now }); }
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
  console.log(`[rimo] poller started — every ${POLL_MS / 1000}s`);
}

module.exports = { startRimo, syncRimo, parseRimoRows };
