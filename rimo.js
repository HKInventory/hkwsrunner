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
let   KARTS_URL = process.env.RIMO_KARTS_URL || '';

// ---- tiny cookie jar (PHPSESSID) --------------------------------------------
let jar = {};
function absorb(res){
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const sc of list){ const p = sc.split(';')[0], i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
}
function cookieHeader(){ return Object.keys(jar).map(k => `${k}=${jar[k]}`).join('; '); }
function H(extra = {}){ return { Cookie: cookieHeader(), 'User-Agent': 'HKWorkshopBot/1.0', ...extra }; }

let loggedIn = false;
let _rimoSig = {};   // serial_no -> last state signature, so we only write karts that changed

async function rimoLogin(){
  jar = {};
  // 1) touch login.php so PHP hands us a session cookie
  try { const r0 = await fetch(`${BASE}/login.php`, { headers: H({ Accept: 'text/html' }), redirect: 'manual' }); absorb(r0); } catch (e) {}
  // 2) submit the codes
  const body = new URLSearchParams({ user: USER, password: PASS }).toString();
  const r = await fetch(`${BASE}/template/logincheck.php`, { method: 'POST',
    headers: H({ 'Content-type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
      Origin: BASE, Referer: `${BASE}/login.php`, Accept: '*/*' }), body, redirect: 'manual' });
  absorb(r);
  const txt = await r.text().catch(() => '');
  if (r.status >= 400 || /invalid|incorrect|fehler|denied|wrong/i.test(txt)) {
    loggedIn = false; throw new Error(`login failed (${r.status}) ${txt.slice(0, 120)}`);
  }
  loggedIn = true;
  console.log('[rimo] logged in');
}

let _discAt = 0;
async function discoverKartsUrl(){
  if (KARTS_URL) return KARTS_URL;
  // Back off HARD when we can't find the feed — otherwise we refetch karts.php every poll (bandwidth).
  if (Date.now() - _discAt < 60000) return '';
  _discAt = Date.now();
  const r = await fetch(`${BASE}/karts.php`, { headers: H({ Accept: 'text/html' }), redirect: 'manual' });
  absorb(r);
  const html = await r.text().catch(() => '');
  if (/name=["']?password/i.test(html)) { loggedIn = false; return ''; }
  // dhtmlxGrid data source: grid.load("x.php") / loadXML("x.php") / url:"x.php"
  const m = html.match(/\.load(?:XML)?\s*\(\s*["']([^"']+\.php[^"']*)["']/i)
         || html.match(/url\s*[:=]\s*["']([^"']+\.php[^"']*)["']/i)
         || html.match(/["']([^"']*kart[^"']*\.php\?[^"']*)["']/i);
  if (m) { KARTS_URL = new URL(m[1], `${BASE}/`).href; console.log('[rimo] karts feed:', KARTS_URL); return KARTS_URL; }
  console.log('[rimo] could not find the karts data-feed URL — set RIMO_KARTS_URL to the Update List request URL (backing off 60s)');
  return '';
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
  const r = await fetch(url, { headers: H({ Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/karts.php` }), redirect: 'manual' });
  absorb(r);
  const loc = r.headers.get('location') || '';
  const xml = await r.text().catch(() => '');
  if (r.status === 302 || /login\.php/i.test(loc) || /name=["']?password/i.test(xml)) { loggedIn = false; return null; }
  return xml;
}

async function syncRimo(){
  if (!supa) { console.error('[rimo] missing Supabase env'); return; }
  try {
    if (!loggedIn) await rimoLogin();
    const url = await discoverKartsUrl();
    if (!url) return;   // no feed URL yet (backed off) — do NOT fetch the grid every second
    let xml = await fetchGrid(url);
    if (xml == null) { await rimoLogin(); xml = await fetchGrid(url); }   // session expired mid-poll → re-login once
    if (xml == null) { console.log('[rimo] could not read the grid (auth?)'); return; }
    const rows = parseRimoRows(xml);
    if (!rows.length) { console.log('[rimo] no rows parsed — check RIMO_KARTS_URL / feed format'); return; }
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
}

function startRimo(){
  if (!USER || !PASS) { console.log('[rimo] RIMO_USER/RIMO_PASS not set — RiMO poller disabled'); return; }
  syncRimo();
  setInterval(syncRimo, POLL_MS);
  console.log(`[rimo] poller started — every ${POLL_MS / 1000}s`);
}

module.exports = { startRimo, syncRimo, parseRimoRows };
