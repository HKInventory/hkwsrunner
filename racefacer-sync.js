// racefacer-sync.js
// Logs in to RaceFacer (HKWS), pulls each kart's details/repairs/parts, parses them,
// writes them to Supabase, then reconciles the day's repairs against app stock scan-outs
// and writes the discrepancy notifications. Designed to run on a schedule (end of day).
//
// Node 18+. Handles RaceFacer's self-signed certificate via an undici Agent.
//
// Env: RF_BASE, RF_USER, RF_PASS, SB_URL, SB_SERVICE_KEY
// Optional: RF_KART_IDS (comma list), RF_KART_TYPE_UUIDS (comma list), SITE (default sydney)

const { fetch, Agent } = require('undici');
const crypto = require('crypto');
// Short stable hash of a repair row's content — a changed field (incl. mechanic) changes the hash.
function contentHash(s){ return crypto.createHash('sha1').update(String(s)).digest('base64').slice(0, 20); }
const { parseKartDetails, parseRepairs, parseParts, parseKartNotes, parseActiveNotes, parseGarageStatuses, parseNotificationsList, parseKartNoteButtons, parseKartNotesTableRows } = require('./racefacer-parse');
const { reconcileDay } = require('./racefacer-reconcile');

const RF_BASE = process.env.RF_BASE || 'https://103.166.146.163';
const RF_USER = process.env.RF_USER, RF_PASS = process.env.RF_PASS;
const SB_URL = process.env.SB_URL, SB_KEY = process.env.SB_SERVICE_KEY;
const SITE = (process.env.SITE || 'sydney').trim().toLowerCase();   // lowercase: the app queries site='sydney', so an env var set to 'SYDNEY' must not drift the stored value
// How often to run the FULL sync (repairs/parts/notes/prune). Between those, only
// kart status is refreshed, which is fast. Default 5 min; tune with HEAVY_INTERVAL_SEC.
const HEAVY_INTERVAL_MS = Math.max(60000, (parseInt(process.env.HEAVY_INTERVAL_SEC, 10) || 300) * 1000);
// How often the heavy child does the EXPENSIVE per-kart detail/parts loop (230 karts x 2 RaceFacer
// fetches). This data (km/hours/cost/parts_history) changes slowly and isn't what status/notes latency
// depends on, so it runs on its own long cadence; the frequent heavy runs then only do incremental
// repairs + reconcile, which is nearly free on RaceFacer. Default 30 min; tune with KART_DETAILS_SEC.
const KART_DETAILS_INTERVAL_MS = Math.max(300000, (parseInt(process.env.KART_DETAILS_SEC, 10) || 1800) * 1000);

const insecure = new Agent({ connect: { rejectUnauthorized: false } }); // accept the self-signed cert

// ---- tiny cookie jars ----
// Two independent RaceFacer sessions. RaceFacer is PHP/Laravel, which LOCKS a session for the duration of
// each request — so requests sharing one session cookie SERIALIZE server-side. A slow ~20s notes-page
// fetch on the shared session would hold that lock and stall every status poll behind it (the observed
// 5-13s status cycles). `jarStatus` gives the fast status loop its OWN session so it never waits on the
// shared one; everything else (notes, sessions, heavy read-backs) keeps `jar`.
const jar = {};
const jarStatus = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function storeCookies(res, j) {
  j = j || jar;
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';'); const i = pair.indexOf('=');
    if (i > 0) {
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (v && v.toLowerCase() !== 'deleted') j[k] = v; // don't let a stray response clear our session
    }
  }
}
const cookieHeader = (j) => Object.entries(j || jar).map(([k, v]) => `${k}=${v}`).join('; ');
// Use the dedicated status session when it's actually logged in (the main worker process), otherwise fall
// back to the shared session (e.g. inside the spawned heavy child, which never establishes jarStatus).
const statusJar = () => (jarStatus['laravel_session'] ? jarStatus : jar);

// Turn RaceFacer type + number into the team's label, e.g. "Adult Track" + "19" -> "Adult 19".
function kartLabel(type, name) {
  const t = (type || '').replace(/\s*track\s*$/i, '').trim()
    .replace(/^intermediate$/i, 'Inter');
  const n = (name || '').trim();
  return t ? `${t} ${n}`.trim() : (n || null);
}

async function rf(path, { method = 'GET', body, headers = {}, ajax = false, jar: j } = {}) {
  j = j || jar;
  // RaceFacer's ajax/* endpoints only return JSON when the request looks like an XHR (what jQuery sends).
  const ajaxHeaders = ajax ? { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' } : {};
  const res = await fetch(path.startsWith('http') ? path : RF_BASE + path, {
    method, body, redirect: 'manual', dispatcher: insecure,
    headers: { 'Cookie': cookieHeader(j), 'User-Agent': 'Mozilla/5.0 HKWorkshopSync/1.0', ...ajaxHeaders, ...headers },
  });
  storeCookies(res, j);
  return res;
}

// fetch an ajax endpoint and parse JSON; clear error (with HTTP status) if it isn't JSON
async function rfJson(path, tries = 3, j) {
  let res, text;
  for (let i = 0; i < tries; i++) {
    res = await rf(path, { ajax: true, jar: j });
    text = await res.text();
    if (text) { try { return JSON.parse(text); } catch { /* empty/garbled -> retry */ } }
    if (i < tries - 1) await sleep(400 * (i + 1)); // brief back-off, then try again
  }
  throw new Error(`HTTP ${res.status}${res.headers.get('location') ? ' -> ' + res.headers.get('location') : ''} (not JSON): ${(text || '').slice(0, 80).replace(/\s+/g, ' ') || '<empty>'}`);
}

// ---- login ----
// Logs into RaceFacer, storing cookies in jar `j` (defaults to the shared jar). Pass jarStatus to
// establish the status loop's dedicated session.
async function login(j) {
  j = j || jar;
  const page = await (await rf('/en/auth/login', { jar: j })).text();
  const formMatch = page.match(/<form[^>]*action="([^"]*login[^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  const action = formMatch ? formMatch[1] : '/en/auth/login';
  const formHtml = formMatch ? formMatch[2] : page;
  const body = new URLSearchParams();
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]*)"/) || [])[1]; if (!name) continue;
    const type = (tag.match(/type="([^"]*)"/) || [])[1] || 'text';
    const val = (tag.match(/value="([^"]*)"/) || [])[1] || '';
    if (type === 'password') body.set(name, RF_PASS);
    else if (type === 'hidden') body.set(name, val);
    else if (/user|email|login|name/i.test(name)) body.set(name, RF_USER);
  }
  body.set('username', RF_USER);   // confirmed field name from the login payload
  body.set('password', RF_PASS);
  console.log('[login] action=%s fields=%s', action, [...body.keys()].join(','));

  const res = await rf(action, { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, jar: j });
  console.log('[login] POST status=%s location=%s%s', res.status, res.headers.get('location') || '(none)', j === jarStatus ? ' (status session)' : '');
  if (!j['laravel_session']) throw new Error(`login failed (status ${res.status}); no session cookie`);
  return true;
}
// Establish/refresh the status loop's DEDICATED session (see the jarStatus note above).
function loginStatus(){ return login(jarStatus); }

// ---- current track layout: pull RaceFacer's "track configurations", flag the live one ----
// /settings -> track_configurations (id = the layout's identity, sub_track_id = physical track, name).
// Today's sessions-schedule says which configuration is running now (or last ran); we upsert that
// one into `tracks` flagged live. merge-duplicates preserves designer-owned map/beacon columns.
async function syncTracks() {
  // 1) the layout list
  let cfgs = [];
  try {
    const s = await rfJson('/ajax/session-management/settings');
    cfgs = (s && s.track_configurations && s.track_configurations.data) || [];
  } catch (e) { console.log('[tracks] settings failed:', e.message); }
  if (!cfgs.length) { console.log('[tracks] no track_configurations — skipping'); return; }
  const byName = new Map(cfgs.map((c) => [String(c.name || '').trim().toLowerCase(), c]));

  // 2) which layout(s) are live RIGHT NOW?
  //    - MAIN/Adult track: it gets reconfigured between sessions, so a day holds many configs. We pick
  //      only the CURRENT main layout (most-recent running, else last finished/started) — never every
  //      layout that ran. Scans back so a closed day still shows the last main layout.
  //    - SET tracks (Mini/Junior/Intermediate): they run on their own and count as live ONLY when they
  //      have a session running now (e.g. weekends, alongside the main track).
  const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  async function daySessions(ds) {
    try {
      const sch = await rfJson(`/ajax/session-management/sessions-schedule?date=${ds}`);
      return ((sch && sch.schedule && sch.schedule.data) || []).filter((x) => x && x.type === 'session' && x.configuration);
    } catch (e) { return []; }
  }
  const TZ = SITE === 'melbourne' ? 'Australia/Melbourne' : 'Australia/Sydney';   // venue wall-clock (both AEST/AEDT)
  let nowKey = '';
  try { nowKey = new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace('T', ' '); }   // "YYYY-MM-DD HH:MM:SS" — matches start_time_key
  catch (e) { nowKey = new Date().toISOString().slice(0, 19).replace('T', ' '); }
  const RUN_RE  = /progress|running|active|ongoing|on[-\s]?track|racing|started|\blive\b/i;
  const DONE_RE = /finish|complete|done|closed|ended|past/i;
  const isRunning = (s) => RUN_RE.test(String(s.status || s.state || s.session_status || ''));
  const cfgOf = (s) => byName.get(String(s.configuration).trim().toLowerCase());
  const SET_TRACK_IDS = new Set([9, 15, 16]);   // Mini=9, Intermediate=15, Junior=16 — live only while racing
  const isSet = (c) => !!c && (SET_TRACK_IDS.has(c.id) || /\b(mini|junior|intermediate|inter)\b/i.test(String(c.name || '')));
  const byTimeDesc = (a, b) => String(b.start_time_key || '').localeCompare(String(a.start_time_key || ''));

  const today = new Date();
  const todaySessions = await daySessions(dayOf(today));
  if (todaySessions.length) {
    console.log('[tracks] today statuses:', JSON.stringify([...new Set(todaySessions.map((s) => String(s.status || s.state || s.session_status || '')))]));
    console.log('[tracks] today configs:', JSON.stringify([...new Set(todaySessions.map((s) => String(s.configuration)))]));
  }

  // current MAIN layout (scan back to the most recent day the main track ran)
  let mainCfg = null;
  for (let i = 0; i < 14 && !mainCfg; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ss = (i === 0) ? todaySessions : await daySessions(dayOf(d));
    const mains = ss.filter((s) => { const c = cfgOf(s); return c && !isSet(c); });
    if (!mains.length) continue;
    const pick = mains.filter(isRunning).sort(byTimeDesc)[0]
              || mains.filter((s) => DONE_RE.test(String(s.status || s.state || ''))).sort(byTimeDesc)[0]
              || mains.filter((s) => String(s.start_time_key || '') <= nowKey).sort(byTimeDesc)[0]
              || mains.slice().sort(byTimeDesc)[0];
    mainCfg = cfgOf(pick);
  }

  // set tracks running right now (today only — never a stale fallback)
  const setCfgs = [];
  todaySessions.filter(isRunning).forEach((s) => { const c = cfgOf(s); if (isSet(c) && !setCfgs.some((x) => x.id === c.id)) setCfgs.push(c); });

  // diagnostic: which set tracks (Mini/Junior/Inter) are visible in today's feed and their state. If a
  // set track is racing (incl. midweek school holidays) but shows "none in feed" here, RaceFacer's
  // schedule isn't surfacing it and it needs a per-track fetch.
  const setStatus = {};
  todaySessions.forEach((s) => { const c = cfgOf(s); if (!isSet(c)) return; if (isRunning(s)) setStatus[c.name] = 'running'; else if (!setStatus[c.name]) setStatus[c.name] = 'idle'; });
  console.log('[tracks] set-tracks today:', Object.keys(setStatus).length ? Object.entries(setStatus).map(([n, v]) => `${n}=${v}`).join(', ') : 'none in feed');

  const liveIds = new Set(), liveNames = [];
  [mainCfg].concat(setCfgs).forEach((c) => { if (c && !liveIds.has(c.id)) { liveIds.add(c.id); liveNames.push(c.name); } });
  if (!liveIds.size) console.log('[tracks] no live layout resolved this pass — writing names, leaving live flags as-is');

  // 3) upsert EVERY layout (names straight from RaceFacer), flagging the live set (and clearing the rest)
  //    in one bulk upsert. merge-duplicates preserves designer-owned columns (map_svg / blueprint_url /
  //    barriers) and any beacons.
  const dirOf = (n) => (/anti[-\s]?clockwise/i.test(n) ? 'Anti-Clockwise' : (/clockwise/i.test(n) ? 'Clockwise' : null));
  const nowIso = new Date().toISOString();
  const rows = cfgs.map((c) => {
    const nm = String(c.name || '').trim();
    const row = { site: SITE, rf_config_id: c.id, rf_sub_track_id: c.sub_track_id, name: nm, direction: dirOf(nm), synced_at: nowIso };
    if (liveIds.size) row.live = liveIds.has(c.id);   // only touch live flags when we resolved the live set
    return row;
  });
  try {
    await sb('tracks?on_conflict=site,rf_config_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: rows });
    console.log('[tracks] upserted %s layouts for %s%s', rows.length, SITE, liveIds.size ? ` · live (${liveIds.size}): ${liveNames.join(', ')}` : '');
  } catch (e) { console.log('[tracks] upsert failed:', e.message); }

  // Record the live-layout TIMELINE on the heavy pass too — so capture works under the GitHub
  // Actions "sync" workflow (sync:once = heavy) and as a safety reconcile on the worker. It's
  // write-on-change, so when the fast loop already logged this change it's a harmless no-op.
  if (liveIds.size) {
    const liveList = [mainCfg].concat(setCfgs).filter(Boolean)
      .map((c) => { const nm = String(c.name || '').trim(); return { id: c.id, name: nm, direction: dirOf(nm) }; });
    if (liveList.length) await logTrackSegments(SITE, liveList);
  }
}

// Lightweight live-flag refresh for the FAST loop, so "what's on track now" self-corrects within a
// couple of minutes instead of waiting for the ~2h heavy pass. Reads the layout names already in the
// DB (no settings call), checks TODAY's schedule only, and PATCHes just the `live` column:
//   - main/Adult track  -> its current layout (most-recent running, else last finished/started)
//   - set tracks (Mini/Junior/Inter, cfg 9/15/16) -> live only while actually running today
// If the main track hasn't raced yet today (early morning / closed), it leaves the flags untouched so
// the last heavy pass's layout stays put.
async function refreshLiveTracks() {
  try {
    const layouts = await sb(`tracks?site=eq.${SITE}&select=rf_config_id,name,direction`);
    if (!layouts || !layouts.length) return;
    const byName = new Map();
    layouts.forEach((t) => byName.set(String(t.name || '').trim().toLowerCase(), { id: t.rf_config_id, name: t.name, direction: t.direction || null }));
    const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const TZ = SITE === 'melbourne' ? 'Australia/Melbourne' : 'Australia/Sydney';
    let nowKey = '';
    try { nowKey = new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace('T', ' '); } catch (e) { nowKey = new Date().toISOString().slice(0, 19).replace('T', ' '); }
    const RUN_RE = /progress|running|active|ongoing|on[-\s]?track|racing|started|\blive\b/i;
    const DONE_RE = /finish|complete|done|closed|ended|past/i;
    const isRunning = (s) => RUN_RE.test(String(s.status || s.state || s.session_status || ''));
    const SET_TRACK_IDS = new Set([9, 15, 16]);
    const isSet = (c) => !!c && (SET_TRACK_IDS.has(c.id) || /\b(mini|junior|intermediate|inter)\b/i.test(String(c.name || '')));
    const cfgOf = (s) => byName.get(String(s.configuration).trim().toLowerCase());
    const byTimeDesc = (a, b) => String(b.start_time_key || '').localeCompare(String(a.start_time_key || ''));

    const sch = await rfJson(`/ajax/session-management/sessions-schedule?date=${dayOf(new Date())}`, 3, statusJar());   // status-loop call -> status session
    const today = ((sch && sch.schedule && sch.schedule.data) || []).filter((x) => x && x.type === 'session' && x.configuration);
    const mains = today.filter((s) => { const c = cfgOf(s); return c && !isSet(c); });
    if (!mains.length) { await closeStaleOpenSegments(SITE, TZ); return; }   // venue closed / pre-open — flush yesterday's open span, leave today's flags as the heavy pass left them
    const pick = mains.filter(isRunning).sort(byTimeDesc)[0]
              || mains.filter((s) => DONE_RE.test(String(s.status || s.state || ''))).sort(byTimeDesc)[0]
              || mains.filter((s) => String(s.start_time_key || '') <= nowKey).sort(byTimeDesc)[0]
              || mains.slice().sort(byTimeDesc)[0];
    const mainCfg = cfgOf(pick);
    if (!mainCfg) return;

    const liveCfgs = new Map([[mainCfg.id, mainCfg]]);              // id -> {id, name, direction}
    today.filter(isRunning).forEach((s) => { const c = cfgOf(s); if (isSet(c) && c) liveCfgs.set(c.id, c); });
    const ids = [...liveCfgs.keys()];

    const setStatus = {};
    today.forEach((s) => { const c = cfgOf(s); if (!isSet(c)) return; if (isRunning(s)) setStatus[c.name] = 'running'; else if (!setStatus[c.name]) setStatus[c.name] = 'idle'; });
    console.log('[live] set-tracks today:', Object.keys(setStatus).length ? Object.entries(setStatus).map(([n, v]) => `${n}=${v}`).join(', ') : 'none in feed');

    await sb(`tracks?site=eq.${SITE}`, { method: 'PATCH', prefer: 'return=minimal', body: { live: false } });
    await sb(`tracks?site=eq.${SITE}&rf_config_id=in.(${ids.join(',')})`, { method: 'PATCH', prefer: 'return=minimal', body: { live: true } });
    console.log(`[live] refreshed · live(${ids.length}) cfg ${ids.join(',')}`);

    // Intelligence-engine data foundation: record the live-layout TIMELINE (write-on-change).
    await logTrackSegments(SITE, [...liveCfgs.values()].map((c) => ({ id: c.id, name: String(c.name || '').trim(), direction: c.direction || null })));
  } catch (e) { console.log('[live] refresh skipped:', e.message); }
}

// ---- track-layout TIMELINE capture (the Intelligence-engine data foundation) ----
// Records the HISTORY of which layout was live, as spans in `track_log`:
//     (site, rf_config_id, name, direction, started_at, ended_at)
//   ended_at IS NULL  => that layout is live RIGHT NOW (the open segment).
// When the live set changes, we close the open row(s) that dropped out and open the
// newly-live one(s). Later, a repair's date_discovered is matched against these
// time-ranges to learn which layout was live when each part broke (per-layout damage
// rate + danger score). Until this has banked a few weeks of data there's nothing
// honest to predict, so it just runs quietly and accumulates.
//
// WRITE-ON-CHANGE: a cycle with no layout change writes NOTHING (one tiny read of the
// open rows, then return) — so on the ~10s always-on loop it adds no realtime/egress
// load, the same discipline as statusFast(). Freshness of an open segment is implied
// by rf_sync_state.last_status (bumped every cycle); a stale row left by a crash or an
// overnight gap is closed on the next resolve at that last-confirmed-alive time, so a
// closed span never stretches across hours the venue was shut.
//   `live`: [{ id, name, direction }] of the configs live this cycle (main + running set tracks).
//          MUST be non-empty — callers only pass a resolved live set. The only path that
//          closes everything is closeStaleOpenSegments (prior-day flush), never this one.
async function logTrackSegments(site, live) {
  if (!Array.isArray(live) || !live.length) return;          // never close-all from here — guard against an empty resolve
  let open;
  try { open = (await sb(`track_log?site=eq.${site}&ended_at=is.null&select=id,rf_config_id`)) || []; }
  catch (e) { console.log('[tracklog] read failed:', e.message); return; }
  const liveById = new Map(live.map((c) => [c.id, c]));
  const openIds  = new Set(open.map((r) => r.rf_config_id));
  const toClose  = open.filter((r) => !liveById.has(r.rf_config_id)).map((r) => r.id);
  const toOpen   = live.filter((c) => !openIds.has(c.id));
  if (!toClose.length && !toOpen.length) return;             // no layout change this cycle -> no writes

  const nowIso = new Date().toISOString();
  if (toClose.length) {
    // close at the last confirmed-alive heartbeat so a crash/overnight gap can't stretch
    // the closed span up to "now"; fall back to now if it's missing or somehow in the future.
    let closeAt = nowIso;
    try { const st = await sb('rf_sync_state?k=eq.last_status&select=v'); const v = st && st[0] && st[0].v; if (v && v < nowIso) closeAt = v; } catch (e) {}
    try { await sb(`track_log?id=in.(${toClose.join(',')})`, { method: 'PATCH', prefer: 'return=minimal', body: { ended_at: closeAt } }); }
    catch (e) { console.log('[tracklog] close failed:', e.message); }
  }
  if (toOpen.length) {
    try { await sb('track_log', { method: 'POST', prefer: 'return=minimal', body: toOpen.map((c) => ({
      site, rf_config_id: c.id, name: c.name, direction: c.direction, started_at: nowIso, ended_at: null })) }); }
    catch (e) { console.log('[tracklog] open failed:', e.message); }
  }
  console.log(`[tracklog] +${toOpen.length} open / -${toClose.length} closed${toOpen.length ? ' · now live: ' + toOpen.map((c) => c.name).join(', ') : ''}`);
}

// Daily flush: when the venue has had no main sessions yet (overnight / before open), any segment
// still open from a PREVIOUS local day is stale — close it at the last confirmed-alive heartbeat so
// it doesn't bleed across the closed hours. A same-day open segment is left alone (it could just be a
// transient schedule-feed miss mid-day). Idempotent: once closed, later cycles find nothing to do.
async function closeStaleOpenSegments(site, tz) {
  try {
    const open = (await sb(`track_log?site=eq.${site}&ended_at=is.null&select=id,started_at`)) || [];
    if (!open.length) return;
    const dayInTz = (iso) => { try { return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); } catch (e) { return String(iso || '').slice(0, 10); } };
    const today = dayInTz(new Date().toISOString());
    const stale = open.filter((r) => dayInTz(r.started_at) < today).map((r) => r.id);
    if (!stale.length) return;
    const nowIso = new Date().toISOString();
    let closeAt = nowIso;
    try { const st = await sb('rf_sync_state?k=eq.last_status&select=v'); const v = st && st[0] && st[0].v; if (v && v < nowIso) closeAt = v; } catch (e) {}
    await sb(`track_log?id=in.(${stale.join(',')})`, { method: 'PATCH', prefer: 'return=minimal', body: { ended_at: closeAt } });
    console.log(`[tracklog] daily flush — closed ${stale.length} stale open segment(s) from before ${today}`);
  } catch (e) { console.log('[tracklog] daily flush skipped:', e.message); }
}

// ---- enumerate kart ids ----
// Each garage "type" page maps to a (site, track-type) pair. This is the source
// of truth for which site a kart belongs to (kart-details doesn't tell us the site).
// Add a row here to onboard a new site/type.
const KART_TYPES = {
  '6de9e147-ce23-4b60-ae56-6c3dd1e1d871': { site: 'sydney',    type: 'Adult Track' },
  'e0abc9ae-153e-41bb-be90-9877e39391c3': { site: 'sydney',    type: 'Intermediate Track' },
  '86ffcdf3-f02e-4eb6-9955-0873c846f9b0': { site: 'sydney',    type: 'Junior Track' },
  '3005c630-1894-47f0-bc47-93979f118d17': { site: 'sydney',    type: 'Mini Track' },
  '00dd982c-d763-4d21-a4ad-a79035495eaf': { site: 'sydney',    type: 'Twin' },
  'bde73675-16a9-424f-b659-ada7338a2202': { site: 'sydney',    type: 'BattleKart' },
  '8d460fb0-ffc4-4838-bf6f-667f65095e65': { site: 'melbourne', type: 'Adult Track' },
};

async function enumerateKarts() {
  // Returns a Map of rf_id -> { site, type } so each kart is tagged by the page it came from.
  const map = new Map();
  if (process.env.RF_KART_IDS) {
    for (const s of process.env.RF_KART_IDS.split(',')) { const n = +s.trim(); if (n) map.set(n, { site: SITE, type: null }); }
    return map;
  }
  for (const [uuid, meta] of Object.entries(KART_TYPES)) {
    const html = await (await rf(`/en/administration/garage/garage?kart_type_uuid=${uuid}`)).text();
    const ids = new Set();
    for (const re of [/kart-details\?id=(\d+)/g, /[?&]kart_id=(\d+)/g, /data-kart_id="(\d+)"/g, /select_kart\w*\((\d+)/g]) {
      let m; while ((m = re.exec(html))) ids.add(+m[1]);
    }
    for (const id of ids) map.set(id, { site: meta.site, type: meta.type }); // last page wins if a kart appears twice
  }
  if (!map.size) throw new Error('could not enumerate karts — check login / type UUIDs');
  return map;
}

// ---- Supabase REST helpers (service role) ----
async function sb(path, { method = 'GET', body, prefer, headers } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SB ${method} ${path} -> ${res.status} ${text}`);
  if (!text) return null;                 // empty body: write with no representation, or 204 delete
  try { return JSON.parse(text); } catch { return null; }
}
const dmy = (d) => { const [a, b, c] = (d || '').split('.'); return c ? `${c}-${b}-${a}` : null; };

// Write a diagnostic row to rf_debug (created by rf_debug.sql). Best-effort — a Render Background
// Worker has no public URL, so this table is the only place we can surface a page dump for Harvey.
// Bounded payload; the table self-trims to the newest 20 rows.
async function rfDebug(kind, kartId, note, payload) {
  try {
    await sb('rf_debug', { method: 'POST', body: [{ kind, kart_id: kartId || null,
      note: String(note || '').slice(0, 500), payload: String(payload || '').slice(0, 400000) }] });
  } catch (e) { /* diagnostics must never break the sync */ }
}

const noteFp = (id, n) => `${id}|${n.createdIso || ''}|${n.note}`.slice(0, 250);
// RaceFacer reports note times in its own clock with no zone. Pin that clock here and store a real
// UTC instant, so the app can render it in whatever timezone the device is in. Default 'Z' (UTC);
// set RF_SOURCE_TZ to e.g. '+01:00' if RaceFacer turns out to be on Central European time.
const RF_TZ = process.env.RF_SOURCE_TZ || 'Z';
const toUtc = (naive) => { if (!naive) return null; const d = new Date(naive + RF_TZ); return isNaN(d.getTime()) ? naive : d.toISOString(); };

// A real kart's name is just its number — 1 to 3 digits (e.g. 1, 18, 104).
// Anything else ("George", "Late 2", "Archived 3", test entries) is not real fleet.
const KEEP_NAME = /^\d{1,3}$/;

// ---- FULL-FLEET repairs ----------------------------------------------------------------------
// Pull RaceFacer's entire damage / repairs list (/ajax/garage/repairs_list) — every kart, active
// or retired — instead of hitting each current kart's page. The list is keyed by RaceFacer's own
// repair id (it counts up over time, so newest = highest), and we store id = that id. Two wins:
//   * ordering is exact — the app sorts by id, so same-day repairs no longer shuffle; and
//   * re-syncs upsert on that id, so edits update in place and nothing gets reshuffled or lost.
// Returns a Map rf_kart_id -> [repair objects] so syncKart can still hand the day's repairs to the
// reconcile step, exactly as the old per-kart path did.
const dashToIso = (d) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((d || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const dashToDot = (d) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((d || '').trim()); return m ? `${m[1]}.${m[2]}.${m[3]}` : ''; };
const REPAIRS_PER_PAGE = parseInt(process.env.RF_REPAIRS_PER_PAGE, 10) || 500;

async function syncAllRepairs({ fullSweep = false } = {}) {
  const byKart = new Map();              // rf_kart_id -> [{ dateDiscovered, dateRepaired, user, parts }]
  const byId = new Map();                // repair id -> { row, parts } — de-dupes across page boundaries

  // ── read existing id->fingerprint FIRST, so an incremental run can stop at the stable tail ──
  // Render meters OUTBOUND bytes; reads from Supabase are inbound (free-ish) — and knowing what we
  // already have lets us stop FETCHING from RaceFacer early too (the real win here).
  // PostgREST caps a response at 1000 rows, so page through ALL rows via Range headers.
  let existing = new Map();
  try {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const chunk = await sb('rf_repairs?select=id,fingerprint', { headers: { Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' } });
      if (!chunk || !chunk.length) break;
      for (const r of chunk) existing.set(Number(r.id), r.fingerprint || '');
      if (chunk.length < PAGE) break;
    }
    console.log(`[repairs] fingerprint map: ${existing.size} existing rows read`);
  } catch (e) { console.error('[repairs] fingerprint pre-read failed (writing all):', (e.message || '').slice(0, 100)); }

  // INCREMENTAL FETCH: repairs_list is newest-first by id, so any NEW or recently-EDITED repair is near
  // the front. Once we hit a full page whose repairs are ALL already stored with an unchanged
  // fingerprint, the far larger unchanged tail behind it doesn't need fetching — turning a 39-page
  // (~19k-repair) fetch into ~1-2 pages on a quiet fleet. This is the single biggest RaceFacer-load cut
  // in the heavy sync. THREE guards force a FULL fetch instead (so we never silently miss anything):
  //   • first-ever run (nothing stored yet),
  //   • an explicit fullSweep (periodic hourly safety net for edits to OLD repairs deep in the list),
  //   • page 1 not actually descending-by-id (ordering assumption unverified -> don't risk stopping).
  let forceFull = fullSweep || existing.size === 0;

  let page = 1, total = Infinity, guard = 0, fails = 0;
  while (guard++ < 5000) {
    let j;
    try { j = await rfJson(`/ajax/garage/repairs_list/?page=${page}&results=${REPAIRS_PER_PAGE}&search=`); }
    catch (e) {
      fails++;
      console.error(`[repairs] page ${page} fetch failed (${(e.message || '').slice(0, 110)})`);
      if (fails >= 6) { console.error('[repairs] too many page failures — stopping fetch.'); break; }
      page += 1; await sleep(600); continue;            // skip this page, keep going
    }
    if (j && j.total != null && Number(j.total)) total = Number(j.total);
    const items = (j && j.items) || [];
    if (page === 1) console.log(`[repairs] page 1: ${items.length} item(s); server reports total=${j && j.total}, last_page=${j && j.last_page}, per_page=${j && j.per_page}`);
    if (page === 1 && items.length && !syncAllRepairs._logged){ syncAllRepairs._logged = true;
      const s = items[0];
      console.log(`[repairs] item keys: ${Object.keys(s).join(',')}`);
      console.log(`[repairs] sample annotation="${String(s.annotation || '').slice(0, 60)}" damage_annotation="${String(s.damage_annotation || s.damage_description || s.notification_annotation || '').slice(0, 60)}"`);
      console.log(`[repairs] mechanic candidates: user_name="${s.user_name||''}" mechanic_name="${s.mechanic_name||''}" repairer_name="${s.repairer_name||''}" repair_user_name="${s.repair_user_name||''}"`);
    }
    if (!items.length) break;                            // past the end
    // ORDERING GUARD: only trust early-stop if page 1 is genuinely newest-first (id descending). If it
    // isn't, a new repair could be at the BACK, so we must fetch everything this run.
    if (page === 1 && !forceFull && items.length > 1) {
      const first = Number(items[0].id), last = Number(items[items.length - 1].id);
      if (!(Number.isFinite(first) && Number.isFinite(last) && first > last)) { forceFull = true; console.log('[repairs] list not descending-by-id — full fetch this run'); }
    }
    let added = 0, pageChanged = 0;
    for (const it of items) {
      if (it.id == null || byId.has(it.id)) continue;    // skip dupes (a repair can straddle two pages)
      added++;
      const kid = it.kart_id;
      const tc = it.kart_type_color ? ('#' + String(it.kart_type_color).replace(/^#/, '')) : null;
      const parts = (((it.used_parts || {}).data) || []).map((p) => ({
        name: p.warehouse_stock_name || 'Part', qty: Number(p.quantity) || 0, price: (p.price != null ? p.price : ''),
      }));
      // Mechanic: prefer an explicit mechanic/repairer field if RaceFacer sends one (editing the
      // repair's user in RF changes THAT, while user_name can stay as the original creator —
      // which is why the TV kept crediting the old mechanic). Falls back to user_name.
      const mech = it.mechanic_name || it.repairer_name || it.repair_user_name || it.user_name || null;
      const row = {
        id: it.id, rf_kart_id: kid,
        description: it.annotation || '', notes: '',
        date_discovered: dashToIso(it.damage_discovery_date),
        date_repaired: dashToIso(it.repair_date),
        mileage: (Number.isFinite(Number(it.repair_km)) ? Number(it.repair_km) : null),
        cost: (Number.isFinite(Number(it.cost)) ? Number(it.cost) : null),
        mechanic: mech,
        kart_name: (it.kart_name != null ? String(it.kart_name) : null),
        kart_type: it.kart_type_name || null,
        kart_garage_id: it.kart_garage_id || null,
        type_color: tc,
      };
      // Fingerprint = hash of the row content (+ parts) — lets each run skip unchanged rows
      // instead of rewriting the whole table every heavy pass. Any edit (incl. mechanic) changes it.
      row.fingerprint = contentHash(JSON.stringify(row) + '|' + JSON.stringify(parts));
      if (!(existing.has(Number(row.id)) && existing.get(Number(row.id)) === row.fingerprint)) pageChanged++;   // new or edited
      byId.set(it.id, { row, parts });
      if (!byKart.has(kid)) byKart.set(kid, []);
      byKart.get(kid).push({ dateDiscovered: dashToDot(it.damage_discovery_date), dateRepaired: dashToDot(it.repair_date), user: it.user_name, parts });
    }
    if (page === 1 || page % 10 === 0) console.log(`[repairs] page ${page}: +${added} changed=${pageChanged} (${byId.size} unique${Number.isFinite(total) ? '/' + total : ''})`);
    page += 1;
    if (!added) break;                                   // no new rows this page -> end of list (or server ignoring the page param)
    if (byId.size >= total) break;                       // collected everything RaceFacer reports
    if (!forceFull && pageChanged === 0) { console.log(`[repairs] incremental: page ${page - 1} fully known — stopping at stable tail (${byId.size} fetched).`); break; }
    await sleep(80);
  }
  console.log(`[repairs] fetch complete: ${byId.size} unique repairs over ${page - 1} page(s) [${forceFull ? 'full' : 'incremental'}]${Number.isFinite(total) ? ` (RaceFacer reports ${total})` : ''}.`);

  const repairRows = [], partRows = [], changedIds = [];
  for (const { row, parts } of byId.values()) {
    if (existing.has(Number(row.id)) && existing.get(Number(row.id)) === row.fingerprint) continue;   // unchanged — skip entirely
    repairRows.push(row);
    changedIds.push(row.id);
    for (const p of parts) partRows.push({ repair_id: row.id, part_name: p.name, qty: p.qty, price: p.price });
  }
  if (!repairRows.length) { console.log(`[repairs] full-fleet: 0 changed of ${byId.size} — no writes.`); return byKart; }

  // Write in chunks; if a chunk is rejected (in PostgREST one bad row fails the whole batch), split it
  // in half and retry each half — isolating a bad row in ~log2(n) calls so it can't stall the run.
  async function writeChunked(path, rows, prefer, label) {
    let dropped = 0;
    async function put(slice) {
      if (!slice.length) return;
      try { await sb(path, { method: 'POST', prefer, body: slice }); }
      catch (e) {
        if (slice.length === 1) {
          dropped++;
          console.error(`[${label}] dropped id=${slice[0].id != null ? slice[0].id : slice[0].repair_id}: ${(e.message || '').slice(0, 130)}`);
          return;
        }
        const mid = slice.length >> 1;          // split and retry each half — isolates a bad row in ~log2(n) calls
        await put(slice.slice(0, mid));
        await put(slice.slice(mid));
      }
    }
    for (let i = 0; i < rows.length; i += 500) await put(rows.slice(i, i + 500));
    return dropped;
  }

  // repairs first (parts FK references them); upsert on the RaceFacer id so edits update in place
  const badR = await writeChunked('rf_repairs?on_conflict=id', repairRows, 'resolution=merge-duplicates,return=minimal', 'repairs');
  // parts: wipe + rebuild ONLY for the repairs that changed (deleting/re-inserting the whole
  // table every pass was pure outbound waste when nothing had changed)
  try {
    for (let i = 0; i < changedIds.length; i += 200) {
      const chunk = changedIds.slice(i, i + 200);
      await sb(`rf_repair_parts?repair_id=in.(${chunk.join(',')})`, { method: 'DELETE' });
    }
  } catch (e) { console.error('[repairs] parts wipe failed:', (e.message || '').slice(0, 120)); }
  const badP = await writeChunked('rf_repair_parts', partRows, 'return=minimal', 'repair-parts');
  console.log(`[repairs] full-fleet: ${repairRows.length - badR}/${repairRows.length} changed repairs written (of ${byId.size} total${Number.isFinite(total) ? ', ' + total + ' reported by RaceFacer' : ''}), ${partRows.length - badP}/${partRows.length} part lines, ${byKart.size} karts.`);
  return byKart;
}

async function syncKart(id, meta, repairsByKart) {
  meta = meta || {};
  const dj = await rfJson(`/ajax/garage/kart-details?id=${id}`);
  if (!dj || dj.success === false || !dj.kart) return null;
  const details = parseKartDetails(dj);
  if (!KEEP_NAME.test((details.name || '').trim())) return { id, skipped: true };   // non-numeric name (George/Late/etc.) — not real fleet
  const type = meta.type || details.type;   // page-derived type is authoritative (reflects Adult<->Inter moves)
  const site = meta.site || 'sydney';
  // Type colour comes straight from RaceFacer's kart type object (confirmed: kart.type.color, e.g. "5d28ae").
  const _t = dj.kart.type || {};
  let typeColor = _t.color || _t.colour || _t.color_hex || _t.hex || _t.bg_color || dj.kart.color || dj.kart.colour || null;
  if (typeColor) typeColor = '#' + String(typeColor).replace(/^#/, '');
  await sb('rf_karts?on_conflict=rf_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{
    rf_id: id, name: details.name, kart_id_label: details.kartIdLabel, type: type, site: site,
    label: kartLabel(type, details.name),
    status: details.status, status_code: details.statusCode, total_km: details.totalKm,
    total_laps: details.totalLaps, total_hours: details.totalHours, total_cost: details.totalCost,
    brand: details.brand, model: details.model,
    type_color: typeColor,
    fetched_at: new Date().toISOString(),
  }] });

  // Repairs are pulled once for the whole fleet (see syncAllRepairs) and handed in here, so each
  // kart still reports its repairs to the alias/reconcile steps without a per-kart fetch or write.
  const repairs = (repairsByKart && repairsByKart.get(id)) || [];

  const parts = parseParts(await rfJson(`/ajax/garage/kart-parts?id=${id}`));
  await sb(`rf_parts_history?rf_kart_id=eq.${id}`, { method: 'DELETE' });
  const phSeen = new Set(), phRows = [];
  parts.forEach((p) => {
    const row = { rf_kart_id: id, date: dmy(p.date), part_name: p.part, hours_since: p.hoursSinceRepair, km_since: p.kmSinceRepair };
    const k = `${row.date}|${row.part_name}|${row.km_since}`;      // matches the table's unique key
    if (!phSeen.has(k)) { phSeen.add(k); phRows.push(row); }
  });
  if (phRows.length) await sb('rf_parts_history', { method: 'POST', body: phRows });

  let notesWritten = 0;
  // Notes are owned by the worker's in-process notesLoop (+ its periodic full sweep). The heavy child
  // sets HEAVY_SKIP_KART_NOTES=1 so it does NOT re-fetch/re-sync every kart's notes here — that was a
  // third RaceFacer fetch per kart (~230/run) duplicating work notesLoop already does, needlessly
  // pinning the shared box and starving status. When the flag isn't set (e.g. a manual/one-off run of
  // this script), notes still sync as before.
  if (process.env.HEAVY_SKIP_KART_NOTES !== '1') {
    // Which notes is RaceFacer currently showing in its top "active" list (starred, not X'd)?
    // Their fingerprints match the same notes in the Kart Notes table, so we can flag them.
    const activeFps = activeNoteMap(id, dj.html);   // Map(fp -> notifId): flags active notes AND captures the id a repair needs to clear them
    try { notesWritten = await syncKartNotes(id, site, activeFps); } catch (e) { console.error(`[notes] kart ${id} failed: ${e.message}`); }
  }

  return { id, name: details.name, type: type, site: site, label: kartLabel(type, details.name), repairs, notesWritten };
}

// Kart notes -> rf_kart_notes. Full history for the Kart Notes tab, plus an `active` flag marking the
// notes RaceFacer currently shows in its top list (starred / not X'd). CRITICAL: de-dupe by fingerprint
// first — RaceFacer can list the exact same note twice, and a bulk upsert with a repeated conflict key
// throws "cannot affect row a second time", which previously left those karts with NO notes.
//
// DELETION SYNC: RaceFacer notes that get deleted must disappear from the app too. This fetch is the
// authoritative current list for THIS kart, so after upserting we DELETE any rf_kart_notes row for this
// kart whose fingerprint is no longer present. Scoped per-kart and only when the fetch succeeded, so a
// transient RaceFacer error can never wipe a kart's notes — a failed fetch throws before we get here.
/* fp -> RaceFacer notification id for a kart's ACTIVE notes. The id is what a repair must send
   as notification_id to CLEAR the note; parseActiveNotes digs it out of the row's X button. */
function activeNoteMap(id, html) {
  const map = new Map();
  for (const a of parseActiveNotes(html || '')) map.set(noteFp(id, a), (a.notifId != null ? a.notifId : null));
  return map;
}

async function syncKartNotes(id, site, activeFps) {
  const notesRaw = await rfJson(`/ajax/garage/kart-notes?id=${id}`);
  const notes = parseKartNotes(notesRaw);

  // ONE-TIME DIAGNOSTIC: dump the raw notes page (and, once, a notifications page) so we can find
  // RaceFacer's NOTIFICATION id — the number the damage form needs to CLEAR a note. Fires at most a
  // few times total, gated on the rf_notification_id column still being empty everywhere.
  if (process.env.CAPTURE_NOTE_IDS !== '0' && !global.__noteCapDone) {
    try {
      const already = (await sb('rf_kart_notes?rf_notification_id=not.is.null&select=rf_kart_id&limit=1')) || [];
      if (!already.length && notes.length) {
        await rfDebug('kart_notes_html', id, `raw notes page for kart ${id} (${notes.length} notes) — find the notification id`,
          typeof notesRaw === 'string' ? notesRaw : JSON.stringify(notesRaw));
        try {
          const notif = await (await rf(`/en/administration/notifications`)).text();
          await rfDebug('notifications_html', id, 'notifications list page — find note_id here', notif);
        } catch (e) { /* endpoint may differ; the notes page alone may suffice */ }
        global.__noteCapDone = true;
      } else if (already.length) { global.__noteCapDone = true; }
    } catch (e) { /* diagnostic only */ }
  }

  // activeFps may be a legacy Set of fingerprints, or a Map(fp -> notifId).
  const isMap = activeFps && typeof activeFps.get === 'function';
  const activeSet = isMap ? new Set(activeFps.keys()) : (activeFps || new Set());
  const rows = [], batch = new Set();
  for (const n of notes) {
    const fp = noteFp(id, n);
    if (batch.has(fp)) continue;                 // same note listed twice in RaceFacer -> store once
    batch.add(fp);
    const row = { note_fp: fp, rf_kart_id: id, site, note: n.note,
      created_at: toUtc(n.createdIso), created_by: n.createdBy, archived_at: toUtc(n.archivedIso), archived_by: n.archivedBy,
      active: activeSet.has(fp),
      // RaceFacer's notification id — the number that lets a repair CLEAR this note. Null when the
      // note isn't in the active list or the id couldn't be read from the markup.
      rf_notification_id: (isMap && activeFps.get(fp) != null) ? activeFps.get(fp) : null };
    // RaceFacer's kart-note id (data-id on the Kart Notes page's edit/delete button) — DISTINCT from the
    // notification id, and NOT available from this endpoint: /ajax/garage/kart-notes?id= has no buttons at
    // all, so n.kartNoteId is always null here. The real source is getKartNoteIndex() (the global Kart
    // Notes page), which backfills this column separately in notesFromKartNotesPage(). CRITICAL: omit the
    // key entirely when we don't have a fresh value — explicitly writing `rf_kart_note_id: null` on every
    // upsert (merge-duplicates writes every key present in the payload) was WIPING OUT that backfilled id
    // on every re-sync, which meant any kart the notes-diff touched immediately lost its id again and got
    // re-flagged next cycle — the actual cause of the "148 karts differ, forever" storm and of the app's
    // delete silently failing (the id it needed kept getting nulled out from under it).
    if (n.kartNoteId != null) row.rf_kart_note_id = n.kartNoteId;
    rows.push(row);
  }
  if (rows.length) {
    // Bulk upsert applies ONE column list to the whole request, so a batch that MIXES rows with and
    // without rf_kart_note_id could still let PostgREST null it out for the rows lacking it. This source
    // will in practice never supply the id (see note above) so every row omits the key — but split into
    // homogeneous batches regardless, so that guarantee holds even if that ever changes.
    const withId = rows.filter((r) => 'rf_kart_note_id' in r);
    const withoutId = rows.filter((r) => !('rf_kart_note_id' in r));
    for (const batch of [withId, withoutId]) {
      if (!batch.length) continue;
      try {
        await sb('rf_kart_notes?on_conflict=note_fp', { method: 'POST', prefer: 'resolution=merge-duplicates', body: batch });
      } catch (e) {
        // If the rf_notification_id / rf_kart_note_id columns haven't been added yet (rf_note_queue_action.sql),
        // retry without them so note syncing never stalls on a missing migration.
        if (/rf_notification_id|rf_kart_note_id/.test(e.message || '')) {
          const bare = batch.map(({ rf_notification_id, rf_kart_note_id, ...r }) => r);
          await sb('rf_kart_notes?on_conflict=note_fp', { method: 'POST', prefer: 'resolution=merge-duplicates', body: bare });
        } else throw e;
      }
    }
  }

  // Remove notes deleted in RaceFacer. `batch` is every fingerprint RaceFacer currently lists for this
  // kart; anything in the DB for this kart but not in that set was deleted upstream -> delete it here,
  // which fires the realtime DELETE the app now listens for. An empty RaceFacer list legitimately means
  // "all notes deleted", so we still prune then (the per-kart fetch already succeeded).
  //
  // IMPORTANT: delete ONE fingerprint per request. Cramming many long note texts into a single
  // ?note_fp=in.(...) URL makes a huge query string that Supabase's API worker rejects with a 1101
  // "Worker threw exception". Fingerprints are long free text, so even ~10 blows the URL limit.
  try {
    const have = (await sb(`rf_kart_notes?rf_kart_id=eq.${id}&select=note_fp`)) || [];
    const gone = have.map((r) => r.note_fp).filter((fp) => fp && !batch.has(fp));
    let removed = 0;
    for (const fp of gone) {
      try {
        // eq. filter on a single value, URL-encoded — small, safe request.
        await sb(`rf_kart_notes?rf_kart_id=eq.${id}&note_fp=eq.${encodeURIComponent(fp)}`, { method: 'DELETE' });
        removed++;
      } catch (e) { console.error(`[notes] kart ${id} delete one failed: ${e.message}`); }
    }
    if (removed) console.log(`[notes] kart ${id}: removed ${removed} deleted in RaceFacer`);
  } catch (e) { console.error(`[notes] kart ${id} delete-sync failed: ${e.message}`); }

  return rows.length;
}

async function refreshAliases(allPartNames) {
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const appParts = await sb('parts?select=sku,description');
  const byName = new Map(appParts.map((p) => [norm(p.description), p.sku]));
  const rows = [...new Set(allPartNames.filter(Boolean))].map((n) => ({ rf_part_name: n, sku: byName.get(norm(n)) || null, updated_at: new Date().toISOString() }));
  if (rows.length) await sb('part_aliases?on_conflict=rf_part_name', { method: 'POST', prefer: 'resolution=merge-duplicates', body: rows });
  const aliases = {}; for (const r of rows) aliases[r.rf_part_name] = r.sku;
  return aliases;
}

async function reconcileToday(perKart, aliases) {
  const today = new Date().toISOString().slice(0, 10);
  const takes = await sb(`logs?select=staff_name,sku,qty,ts,action&site=eq.${SITE}&action=eq.TAKEN&ts=gte.${today}T00:00:00&ts=lte.${today}T23:59:59`);
  const nameBySku = new Map((await sb('parts?select=sku,description')).map((p) => [p.sku, p.description]));
  for (const t of (takes || [])) t.desc = nameBySku.get(t.sku) || t.sku; // part name for the message; logs has no desc column
  const rfRepairs = [];
  for (const k of perKart) for (const r of k.repairs) if (dmy(r.dateRepaired) === today)
    rfRepairs.push({ kartName: k.label || k.name, mechanic: r.user, date: r.dateRepaired, repairedAt: null, parts: r.parts });
  const lines = reconcileDay({ day: today, rfRepairs, appTakes: takes || [], aliases });
  await sb(`rf_discrepancies?day=eq.${today}&status=eq.new`, { method: 'DELETE' });
  if (lines.length) await sb('rf_discrepancies', { method: 'POST', body: lines.map((d) => ({
    day: d.day, kind: d.kind, rf_kart_name: d.rf_kart_name, mechanic: d.mechanic, part_name: d.part_name,
    sku: d.sku, rf_qty: d.rf_qty, app_qty: d.app_qty, at: d.at, message: d.message,
  })) });
  return lines.length;
}

// Remove karts (and their children) that are no longer listed under any type —
// e.g. stripped/archived ghosts. Guarded so a transient empty enumeration can't wipe the table.
async function pruneStale(activeIds) {
  if (process.env.RF_KART_IDS) return 0;           // never prune on a partial/test run
  if (!activeIds || activeIds.length < 10) { console.log(`[prune] skipped — only ${activeIds ? activeIds.length : 0} active ids (looks like a bad enumeration)`); return 0; }
  const existing = (await sb('rf_karts?select=rf_id')) || [];
  const active = new Set(activeIds);
  const stale = existing.map((r) => r.rf_id).filter((id) => !active.has(id));
  if (!stale.length) return 0;
  const list = stale.join(',');
  await sb(`rf_parts_history?rf_kart_id=in.(${list})`, { method: 'DELETE' });
  // rf_repairs is intentionally NOT pruned here — the full-fleet damage list keeps every kart's
  // repair history, including retired / removed karts, which is the whole point of pulling it.
  await sb(`rf_karts?rf_id=in.(${list})`, { method: 'DELETE' });
  return stale.length;
}

// FAST NOTES PASS — near-instant note ADD / DELETE without hammering RaceFacer.
//
// The problem: RaceFacer has no "all notes" endpoint and no webhook, so catching a note change
// means fetching a kart's notes page — one request per kart, ~190 karts. Polling all of them every
// cycle would get us rate-limited. But the garage LIST pages (already fetched by statusFast, ~5
// requests for the whole fleet) tell us which karts CURRENTLY have an open note. So:
//
//   1. Read the fleet's note-flags off the same list pages statusFast uses (free — already fetched).
//   2. Compare to what the DB believes: a kart whose flag FLIPPED (gained or lost its note) is the
//      only place a change can have happened. Fetch notes for just those karts.
//   3. Also refresh karts that still have open notes, so edits / partial multi-note deletes on an
//      already-flagged kart clear too.
//
// Net: a note added to a clean kart, or the last note removed from a kart, is caught in one status
// cycle (~10s) with ~0 extra requests; only genuinely-changed karts get an individual fetch.
// Rotating cursor so successive fast cycles cover different karts, sweeping the whole fleet
// every ~30s without fetching all 211 every cycle.
let _noteCursor = 0;
// Read ONE kart's notes back from RaceFacer into rf_kart_notes (kart-details for the active-note
// flags, then the kart-notes table). NEVER throws — the pusher calls this straight after creating a
// note in RaceFacer so the real note (with its RF id) lands in Supabase within a second or two and the
// app's "syncing…" clears at once, without waiting for a sweep. A throw here must not fail the push.
async function readKartNotes(id){
  try {
    const dj = await rfJson(`/ajax/garage/kart-details?id=${id}`);
    const activeFps = activeNoteMap(id, (dj && dj.html) || '');
    return await syncKartNotes(id, SITE, activeFps);
  } catch (e){ console.error(`[notes-readback] kart ${id}: ${e.message}`); return 0; }
}
// Module-level state for the note detectors below.
let _notifHighWater = 0;      // epoch(ms) of the newest notification we've already acted on
let _notifDiagDone = false;
let _goneCursor = 0;
let _knPageDiagDone = false;
const _normNote = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
// EXACT match only (after whitespace/case normalization) — deliberately NOT a prefix/substring match.
// This fleet has real near-duplicate notes on the same kart (e.g. "Slowing down to speed 1" and
// "...randomly" as two separate active notes); a prefix match treats the shorter one as matching the
// longer one, which silently assigns the WRONG kart_note_id. When text doesn't match exactly, the
// single-candidate-per-kart fallback (in the caller) is the only other thing allowed to resolve it.
function _noteMatch(a, b){ a = _normNote(a); b = _normNote(b); return !!a && !!b && a === b; }

// One GET, parsed as JSON if possible, else null (no retry/throw — for probing candidate endpoints).
async function rfMaybeJson(path){ try { const t = await (await rf(path, { ajax:true })).text(); return JSON.parse(t); } catch { return null; } }

// FLEET NOTE INDEX: [{kartNoteId, rfKartId, note}] for every note, so we can resolve the kart_note_id the
// app->RF delete needs and backfill it into the DB. The Kart Notes management PAGE renders its rows over
// AJAX (not in the page HTML), so we discover/try RaceFacer's notes-list JSON endpoint — same family as
// /ajax/garage/repairs_list. We PROBE for the working endpoint at most occasionally (a delete triggers a
// probe); once found it's memoised and just re-fetched cheaply. The notes loop calls with {probe:false} so
// it never pays the discovery cost — it only benefits once a probe has found the endpoint.
let _kni = { at: 0, data: [] };     // short cache of the resolved index
let _kniSrc = null;                 // null=unknown, 'table'=ajax endpoint works, 'page'=page HTML works
let _kniFailed = false;             // true only when BOTH sources returned nothing (used for back-off)
let _kniProbeAt = 0, _kniDiag = false;
const _KNI_BACKOFF = 60 * 1000;   // short: a failed probe should not lock deletes out of the id lookup for long

function _kniParse(j, add){
  const items = j && (j.data || j.aaData || j.items || j.rows || j.records || (Array.isArray(j) ? j : null));
  if (!Array.isArray(items) || !items.length) return false;
  let any = false;
  for (const it of items){
    if (it && typeof it === 'object' && !Array.isArray(it)){
      const id = it.id != null ? it.id : (it.kart_note_id != null ? it.kart_note_id : it.note_id);
      const kart = it.kart_id != null ? it.kart_id : (it.kart_garage_id != null ? it.kart_garage_id : it.rf_kart_id);
      let note = it.note != null ? it.note : (it.message != null ? it.message : (it.annotation != null ? it.annotation : it.description));
      const htmlBlob = Object.values(it).filter((v) => typeof v === 'string' && /kart_note/.test(v)).join(' ');   // any cell holding the action buttons
      if (htmlBlob){ for (const b of parseKartNoteButtons(htmlBlob)) if (add(b.kartNoteId, kart != null ? kart : b.rfKartId, note != null ? note : b.note)) any = true; }
      if (id != null && add(id, kart, note)) any = true;
    } else if (Array.isArray(it)){
      const joined = it.map((c) => (c == null ? '' : String(c))).join(' ');
      let textCell = '';
      for (const c of it){ const t = String(c == null ? '' : c).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); if (t.length > textCell.length && !/^\d+$/.test(t) && !/^\d{2}\.\d{2}\.\d{4}/.test(t)) textCell = t; }
      for (const b of parseKartNoteButtons(joined)) if (add(b.kartNoteId, b.rfKartId, b.note || textCell)) any = true;
    }
  }
  return any;
}
// Extract note (kart_note_id, rf_kart_id, text) from a RAW response. CONFIRMED SHAPE (from the live
// Render log): kart-notes-table answers {"error":false,"success":true,"html":"<div...><table ...rows..."}
// — the note rows (with the edit/delete anchors carrying data-id / data-kart-id / data-message) live in
// the `html` string. So: JSON-parse, then run the button parser on j.html (a proper decoded HTML string).
// The other branches remain as fallbacks for any endpoint that shapes rows differently.
function _kniExtractRaw(text, add){
  if (!text) return false;
  let any = false;
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (j && typeof j === 'object'){
    for (const k of ['html', 'table', 'content', 'view', 'body']){
      if (typeof j[k] === 'string' && j[k].length > 20){
        try { for (const r of parseKartNotesTableRows(j[k])) if (add(r.kartNoteId, r.rfKartId, r.note, r.archived)) any = true; } catch (e) {}
      }
    }
    if (!any && _kniParse(j, add)) any = true;
  }
  if (any) return true;
  const unesc = String(text).replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>').replace(/\\u0026/gi, '&').replace(/\\"/g, '"').replace(/\\\//g, '/');
  try { for (const r of parseKartNotesTableRows(unesc)) if (add(r.kartNoteId, r.rfKartId, r.note, r.archived)) any = true; } catch (e) {}
  // Raw attribute scan as a final fallback — archived state unknowable here, so pass null (treated as
  // "present but not provably open": never counted as a new note, never treated as deleted).
  const grab = (re) => { let m; while ((m = re.exec(unesc))) { const id = Number(m[1]); const kart = m[2] != null ? Number(m[2]) : null; const msg = m[3] != null ? m[3] : null; if (add(id, kart, msg, null)) any = true; } };
  grab(/data-id="(\d+)"[^>]{0,120}?data-kart-id="(\d+)"[^>]{0,200}?data-message="([^"]*)"/g);
  if (!any) grab(/data-id="(\d+)"[^>]{0,120}?data-kart-id="(\d+)"()/g);
  return any;
}
async function _kniFetch(url){
  const out = [], seen = new Set();
  const add = (id, kart, note, archived) => { const n = Number(id); if (!n || seen.has(n)) return false; seen.add(n); out.push({ kartNoteId: n, rfKartId: (kart != null && /^\d+$/.test(String(kart))) ? Number(kart) : null, note: note != null ? String(note).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null, archived: archived === true ? true : (archived === false ? false : null) }); return true; };
  let text = ''; try { text = await (await rf(url, { ajax: true })).text(); } catch (e) { return { data: [], sample: '' }; }
  _kniExtractRaw(text, add);
  return { data: out, sample: text.slice(0, 600) };
}
// Fetch the note index from the global Kart Notes PAGE (rows are server-rendered there, unlike the
// kart-notes-table ajax which returns an empty shell without params). Returns [] on miss.
async function _fetchNotesViaPage(){
  const out = [], seen = new Set();
  const add = (id, kart, note, archived) => { const n = Number(id); if (!n || seen.has(n)) return false; seen.add(n); out.push({ kartNoteId: n, rfKartId: (kart != null && /^\d+$/.test(String(kart))) ? Number(kart) : null, note: note != null ? String(note).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null, archived: archived === true ? true : (archived === false ? false : null) }); return true; };
  try {
    const html = await (await rf('/en/administration/garage/kart-notes')).text();
    if (/name=["']password["']|\/auth\/login/i.test(html || '')) throw new Error('session expired');
    for (const r of parseKartNotesTableRows(html)) add(r.kartNoteId, r.rfKartId, r.note, r.archived);
  } catch (e) { if (/session expired/.test(e.message || '')) throw e; }
  return out;
}
async function getKartNoteIndex({ probe = true } = {}){
  if (_kni.data.length && Date.now() - _kni.at < 4000) return _kni.data;
  // Known source -> just refetch it (kept fast + memoised so the loop and deletes both get fresh data).
  if (_kniSrc === 'table'){ const r = await _kniFetch('/ajax/garage/kart-notes-table'); if (r.data.length){ _kni = { at: Date.now(), data: r.data }; return r.data; } _kniSrc = null; }
  if (_kniSrc === 'page'){ const d = await _fetchNotesViaPage(); if (d.length){ _kni = { at: Date.now(), data: d }; return d; } _kniSrc = null; }
  // Only genuine "both sources failed" state backs off. A working page source is NOT a back-off.
  if (_kniSrc === null && _kniFailed && Date.now() - _kniProbeAt < _KNI_BACKOFF) return [];
  _kniProbeAt = Date.now();

  // 1) the confirmed ajax endpoint (may return an empty shell -> no data -> fall through)
  {
    const r = await _kniFetch('/ajax/garage/kart-notes-table');
    if (r.data.length){ _kniSrc = 'table'; _kni = { at: Date.now(), data: r.data }; console.log(`[notes] kart-note index: ${r.data.length} notes via kart-notes-table`); return r.data; }
    if (r.sample && !_kniDiag){ _kniDiag = true; try { await rfDebug('kart_notes_table_sample', 0, 'kart-notes-table returned no parseable rows (empty shell?) — using the page instead', r.sample); } catch (e) {} }
  }
  // 2) the page (rows are rendered in its HTML) — this is the source that actually works here
  const d = await _fetchNotesViaPage();
  if (d.length){ _kniSrc = 'page'; _kniFailed = false; _kni = { at: Date.now(), data: d }; console.log(`[notes] kart-note index: ${d.length} notes via kart-notes page`); return d; }

  _kniSrc = null; _kniFailed = true; _kni = { at: Date.now(), data: [] };
  return [];
}

// PRIMARY note detector — the GLOBAL Kart Notes page (/en/administration/garage/kart-notes). Its rows carry,
// on the edit/delete buttons, everything we need: kart_note_id (data-id), rf kart id (data-kart-id) and the
// note text (data-message). One cheap fetch therefore lets us, fleet-wide and without blind rotation:
//   • BACKFILL rf_kart_note_id onto stored notes (so app->RF deletes clear the Kart Notes list reliably),
//   • detect ADDS  (a note on the page that isn't active in the DB)  -> fetch that kart,
//   • detect DELETES (a note active in the DB that's gone from the page) -> re-fetch that kart to prune.
// Returns karts synced, or null if the page yields no buttons (server-side table) so the caller falls back.
let _knBaselined = false, _knChangedCursor = 0;
let _knSeenIdsByKart = new Map();   // kart -> Set(kartNoteId) last observed on the global Kart Notes page
async function notesFromKartNotesPage(){
  const idx = (await getKartNoteIndex()).filter((b) => b.rfKartId != null && b.note != null);
  if (!idx.length) return null;

  // 1) Backfill kart_note_id onto active notes. Two passes:
  //    a) rows with NO id yet — match EXACT text, or (if that misses) "this kart has exactly one
  //       UN-CLAIMED page note and exactly one un-backfilled row" — unambiguous without needing text to
  //       agree at all. We deliberately do NOT fall back to a prefix/substring match: this fleet has real
  //       near-duplicate notes on the SAME kart (e.g. "Slowing down to speed 1" and "...randomly" as two
  //       separate active notes), and a prefix match silently picked the wrong one.
  //       Candidates are NOT filtered by the page's `archived` flag: a real diagnostic dump showed karts
  //       with 15-44 rows ALL marked archived:false (obviously mostly historical/resolved notes, not
  //       simultaneously-open ones) — that flag isn't a reliable "still open" signal on this markup.
  //       Instead a candidate is simply any page row for the kart not already claimed by another active
  //       DB row for that same kart.
  //    b) rows that already HAVE an id — verify it, but ONLY on a KART mismatch (this id now belongs to a
  //       note on a DIFFERENT kart on RaceFacer — real proof of a stale/reassigned id). Do NOT clear on a
  //       TEXT mismatch alone: page.note comes from the Kart Notes page's `data-message` attribute while
  //       the DB's note came from the per-kart endpoint's rendered table cell (parseKartNotesTableRows vs
  //       parseKartNotes in racefacer-parse.js) — two independently-formatted sources for the same note
  //       that are NOT guaranteed to match exactly even when they're the same note.
  try {
    const byId = new Map(); for (const b of idx) if (b.kartNoteId != null) byId.set(Number(b.kartNoteId), b);

    // (b) verify + self-correct existing ids first, so a freshly-cleared bad id gets fixed in this same pass.
    const withId = (await sb('rf_kart_notes?active=eq.true&rf_kart_note_id=not.is.null&select=id,rf_kart_id,note,rf_kart_note_id')) || [];
    const toClear = [];
    for (const n of withId){
      const page = byId.get(Number(n.rf_kart_note_id));
      if (page && Number(page.rfKartId) !== Number(n.rf_kart_id)) toClear.push(n.id);
    }
    if (toClear.length){
      console.log(`[notes] backfill: clearing ${toClear.length} rf_kart_note_id(s) reassigned to a different kart on RaceFacer (self-correcting a stale id)`);
      for (const id of toClear){ try { await sb(`rf_kart_notes?id=eq.${id}`, { method:'PATCH', prefer:'return=minimal', body:{ rf_kart_note_id: null } }); } catch (e) {} }
    }

    // Candidates per kart = page rows for that kart not already claimed by another active DB row for the
    // same kart (post-clear) — no archived/open filtering, see note above.
    const claimedByKart = new Map();
    for (const n of withId){ if (toClear.includes(n.id)) continue; if (!claimedByKart.has(n.rf_kart_id)) claimedByKart.set(n.rf_kart_id, new Set()); claimedByKart.get(n.rf_kart_id).add(Number(n.rf_kart_note_id)); }
    const candByKart = new Map();
    for (const b of idx){
      if (b.rfKartId == null || b.kartNoteId == null) continue;
      const claimed = claimedByKart.get(b.rfKartId);
      if (claimed && claimed.has(b.kartNoteId)) continue;
      if (!candByKart.has(b.rfKartId)) candByKart.set(b.rfKartId, []);
      candByKart.get(b.rfKartId).push(b);
    }

    // (a) resolve rows with no id (includes any just cleared above).
    const need = (await sb('rf_kart_notes?active=eq.true&rf_kart_note_id=is.null&select=id,rf_kart_id,note')) || [];
    const needByKart = new Map();
    for (const n of need) { if (!needByKart.has(n.rf_kart_id)) needByKart.set(n.rf_kart_id, []); needByKart.get(n.rf_kart_id).push(n); }
    for (const n of need){
      let m = idx.find((b) => Number(b.rfKartId) === Number(n.rf_kart_id) && _noteMatch(b.note, n.note));
      if (!m){
        const cands = candByKart.get(n.rf_kart_id);
        const needSame = needByKart.get(n.rf_kart_id);
        if (cands && cands.length === 1 && needSame && needSame.length === 1) m = cands[0];   // unambiguous single-note kart
      }
      if (m && m.kartNoteId != null){ try { await sb(`rf_kart_notes?id=eq.${n.id}`, { method:'PATCH', prefer:'return=minimal', body:{ rf_kart_note_id: m.kartNoteId } }); } catch (e) {} }
    }
  } catch (e) {}

  // 2) Diff. Pure "what changed since we last looked" — an in-memory snapshot of the page's OWN
  //    kartNoteId set per kart, compared to itself over time. Deliberately NOT compared against what
  //    rf_kart_notes holds: an earlier version tried "is this page row already matched by an existing DB
  //    id or DB text for this kart", which requires the PER-KART endpoint (/ajax/garage/kart-notes?id=,
  //    what syncKartNotes reads) to eventually reproduce every note the GLOBAL page shows, matched by
  //    text. Live logs proved that false — the flagged count (53 karts, dbNoId=79) sat perfectly still
  //    across cycles even after fetching 24 of those karts, meaning the per-kart endpoint doesn't return
  //    full history (almost certainly a paginated/recent-window response), so old notes visible on the
  //    global page could NEVER get a matching DB row no matter how many times we re-fetched the kart —
  //    permanently "changed", permanently wasted fetches.
  //
  //    Comparing the page against its own last-seen state sidesteps that entirely: a kartNoteId is "new"
  //    the first time it's ever observed for that kart, and "deleted" only once it actually vanishes from
  //    the page — regardless of whether our own sync manages to fully mirror it. The snapshot is commited
  //    unconditionally below (even karts we don't end up fetching this cycle), which is what makes this
  //    converge: once noticed, a note stops being re-flagged going forward. It resets on a worker restart
  //    (in-memory only) — same as the existing baseline guard already tolerates — and the ~15min full
  //    sweep (sweepNotesAll in index.js) is the backstop for anything a single fetch didn't fully capture.
  const currentIdsByKart = new Map();
  for (const b of idx) { if (b.kartNoteId == null || b.rfKartId == null) continue; const k = Number(b.rfKartId); if (!currentIdsByKart.has(k)) currentIdsByKart.set(k, new Set()); currentIdsByKart.get(k).add(Number(b.kartNoteId)); }
  const changed = new Set();
  for (const [k, curIds] of currentIdsByKart) {
    const prev = _knSeenIdsByKart.get(k);
    if (!prev) { changed.add(k); continue; }                                            // never tracked before -> new to us
    for (const id of curIds) { if (!prev.has(id)) { changed.add(k); break; } }           // ADD: an id we haven't seen before
  }
  for (const [k, prevIds] of _knSeenIdsByKart) {
    const cur = currentIdsByKart.get(k);
    for (const id of prevIds) { if (!cur || !cur.has(id)) { changed.add(k); break; } }   // DELETE: a previously-seen id is gone
  }
  // NOTE: un-backfilled active rows (rf_kart_note_id still null) are deliberately NOT independently
  // diffed here by text. An earlier version of this function did that as a "delete" fallback for rows
  // that can't be tracked by id yet — comparing DB text (from the per-kart endpoint) against page text
  // (from the data-message attribute) fresh, every cycle, with no memory. That's the exact same fragile
  // cross-source text join (1) above already had to work around, and it bypasses the snapshot entirely,
  // so it can never converge: a live sample showed a DB-active note with NO matching text anywhere on
  // that kart's page rows, flagged "changed" identically cycle after cycle. It's not actually needed —
  // the snapshot above already catches a genuine delete for ANY page row it has ever seen (regardless of
  // whether that specific DB row got backfilled with an id), because it tracks the page's kartNoteId set
  // directly, not through the DB. A note that somehow never appears on the global page at all (so the
  // snapshot never sees it to lose it) still gets caught by the ~15min full sweep (sweepNotesAll).
  let dbNoId = [];
  try { dbNoId = (await sb('rf_kart_notes?active=eq.true&rf_kart_note_id=is.null&select=rf_kart_id')) || []; } catch (e) {}
  _knSeenIdsByKart = currentIdsByKart;   // commit now, regardless of what gets fetched below — see note above
  let ids = [...changed].filter((x) => x != null && !Number.isNaN(x));
  if (!_knBaselined){
    _knBaselined = true;
    if (ids.length > 12){ console.log(`[notes] baseline: ${ids.length} kart(s) differ from DB — leaving the backlog to the heavy sync`); return 0; }
  }
  if (ids.length > 40){
    // Persisting at a similar size cycle after cycle means the diff itself isn't converging — capture
    // concrete evidence (not another guess) so the actual mismatch is visible instead of inferred.
    console.log(`[notes] diff anomaly: ${ids.length} kart(s) flagged (dbNoId=${dbNoId.length}) — capping to protect bandwidth`);
    if (++_knAnomalyStreak >= 3 && !_knAnomalyDiag){
      _knAnomalyDiag = true;
      let dbActiveDebug = [];
      try { dbActiveDebug = (await sb('rf_kart_notes?active=eq.true&select=rf_kart_id,note,rf_kart_note_id')) || []; } catch (e) {}
      const sample = ids.slice(0, 3).map((kartId) => {
        const dbRow = dbActiveDebug.find((n) => Number(n.rf_kart_id) === kartId);
        const pageRows = idx.filter((b) => Number(b.rfKartId) === kartId);
        return { kartId, db: dbRow ? { note: dbRow.note, rf_kart_note_id: dbRow.rf_kart_note_id } : null,
                  page: pageRows.map((b) => ({ kartNoteId: b.kartNoteId, note: b.note, archived: b.archived })) };
      });
      try { await rfDebug('notes_diff_anomaly', 0, `diff not converging after ${_knAnomalyStreak} cycles — sample below`, JSON.stringify(sample, null, 2)); } catch (e) {}
      console.log('[notes] diff anomaly sample:', JSON.stringify(sample));
    }
  } else _knAnomalyStreak = 0;
  const CAP = 12;
  if (ids.length > CAP){ const take = []; for (let i = 0; i < CAP; i++) take.push(ids[(_knChangedCursor + i) % ids.length]); _knChangedCursor = (_knChangedCursor + CAP) % ids.length; ids = take; }
  if (!ids.length) return 0;
  let touched = 0, i2 = 0;
  async function w(){ while (i2 < ids.length){ const id = ids[i2++]; await readKartNotes(id); touched++; } }
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => w()));
  return touched;
}
let _knAnomalyStreak = 0, _knAnomalyDiag = false;

let _notifBackoffUntil = 0, _notifMiss = 0;
async function notesFromNotifications(){
  if (Date.now() < _notifBackoffUntil) return null;   // page proven unreadable recently -> don't refetch every cycle
  let html;
  try { const r = await rf('/en/administration/garage/notifications'); html = await r.text(); }
  catch (e){ return null; }
  if (/name=["']password["']|\/auth\/login/i.test(html || '')) throw new Error('session expired');
  const rows = parseNotificationsList(html);
  if (!rows.length){
    if (!_notifDiagDone){ _notifDiagDone = true; try { await rfDebug('notifications_page_html', 0, 'notifications page returned no parseable rows — wire the real (AJAX?) source from this', html); } catch (e) {} }
    if (++_notifMiss >= 3) _notifBackoffUntil = Date.now() + 5 * 60 * 1000;   // stop hammering a client-rendered table
    return null;
  }
  _notifMiss = 0;
  // kart NUMBER -> rf_id (+ type) from the fleet, to translate the list's "Kart" column into an rf id.
  let byNum = new Map();
  try {
    const ks = (await sb('rf_karts?select=rf_id,name,type')) || [];
    for (const k of ks){ if (k.name == null) continue; const key = String(k.name).trim(); if (!byNum.has(key)) byNum.set(key, []); byNum.get(key).push(k); }
  } catch (e){ return null; }
  if (!byNum.size) return null;

  const toEpoch = (iso) => { const t = Date.parse(iso); return isNaN(t) ? 0 : t; };
  const pickKart = (r) => {
    const cands = byNum.get(String(r.kartNumber || '').trim()) || [];
    if (cands.length <= 1) return cands[0];
    if (r.kartType){ const want = r.kartType.toLowerCase().replace(/\s*track\s*/, '').trim(); return cands.find((c) => (c.type || '').toLowerCase().includes(want)) || cands[0]; }
    return cands[0];
  };
  const newest = rows.reduce((m, r) => Math.max(m, toEpoch(r.dateIso)), 0);
  const liveIds = new Set(rows.map((r) => r.notifId).filter((x) => x != null));   // notification_ids currently active on RaceFacer

  const changed = new Set();

  // --- DELETES: DB says active, but the id isn't on the current list any more -> re-fetch to prune. ---
  // Gated on having parsed some ids (so a parse that missed ids can't nuke everything). Bounded per cycle.
  if (liveIds.size){
    try {
      const active = (await sb('rf_kart_notes?active=eq.true&rf_notification_id=not.is.null&select=rf_kart_id,rf_notification_id')) || [];
      const gone = [];
      for (const n of active){ if (n.rf_notification_id != null && !liveIds.has(Number(n.rf_notification_id)) && n.rf_kart_id != null) gone.push(n.rf_kart_id); }
      const goneKarts = [...new Set(gone)];
      // Bound the per-cycle re-fetch so a pathological/paginated list can't cause a fetch storm; rotate
      // through any overflow so a real delete is still caught within a cycle or two.
      const CAP = 20;
      let take = goneKarts;
      if (goneKarts.length > CAP){ take = []; for (let i = 0; i < CAP; i++) take.push(goneKarts[(_goneCursor + i) % goneKarts.length]); _goneCursor = (_goneCursor + CAP) % goneKarts.length; }
      for (const id of take) changed.add(id);
    } catch (e){ /* delete-diff is best-effort; adds below still run */ }
  }

  // --- ADDS: a note newer than the high-water mark -> pull that kart. First read just sets the mark. ---
  if (!_notifHighWater){ _notifHighWater = newest; }
  else {
    for (const r of rows){
      if (toEpoch(r.dateIso) <= _notifHighWater) continue;
      const pick = pickKart(r);
      if (pick && pick.rf_id != null) changed.add(pick.rf_id);
    }
  }
  _notifHighWater = Math.max(_notifHighWater, newest);

  if (!changed.size) return 0;
  const ids = [...changed]; let touched = 0, idx = 0;
  async function w(){ while (idx < ids.length){ const id = ids[idx++]; await readKartNotes(id); touched++; } }
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => w()));
  return touched;
}
async function notesFast(garageFlags, opts) {
  const site = SITE;   // lowercased module const (see line ~18) — never the raw env, or notes get written under 'SYDNEY' and the app's site='sydney' query can't see them

  // The fleet's kart ids (from rf_karts). This is what we rotate through.
  let fleet = [];
  try { fleet = ((await sb('rf_karts?select=rf_id&order=rf_id')) || []).map((r) => r.rf_id).filter((x) => x != null); }
  catch (e) { console.error(`[notes-fast] read fleet: ${e.message}`); return 0; }
  if (!fleet.length) return 0;

  // Karts that already have an open note in the DB — always re-checked so an edit or the last
  // note being deleted syncs immediately.
  let dbActive = [];
  try { dbActive = (await sb('rf_kart_notes?active=eq.true&select=rf_kart_id')) || []; } catch (e) {}
  const dbFlag = new Set(dbActive.map((r) => r.rf_kart_id).filter((x) => x != null));

  // NOTE: the former `flagsOnly` fast path is GONE. It was built on the garage-list note-flag heuristic
  // (parseGarageStatuses' broad icon/title match), which proved false-positive on this venue's markup:
  // "flagged but not active in DB" stayed permanently non-empty, so it re-fetched the same 12 karts every
  // cycle forever (~144 wasted GET/min) and starved status. Fast note-adds are now driven by
  // notesFromNotifications (ONE request/cycle) in index.js's notesLoop, with the periodic global
  // Kart Notes page sweep as the authoritative backstop. This function remains for the legacy
  // STATUS_ONLY/NOTES_ONLY spawned modes only.
  const sawFlags = !!(statusFast && statusFast._sawFlags);
  const toCheck = new Set();
  if (sawFlags) {
    // Authoritative list-flags => fetch ONLY karts whose note state CHANGED since the DB was written:
    //   • flagged on the list but NOT in the DB  -> a NEW note appeared -> fetch + write it.
    //   • in the DB but NO LONGER flagged        -> the note was CLEARED -> fetch + prune it.
    // Karts flagged in BOTH are unchanged and skipped, so a stable fleet costs ZERO detail fetches —
    // that's what makes a fast poll cheap. (A note EDITED in place keeps its flag; the ~15min full
    // sweep reconciles those.) A missed flag just lands a kart in the "cleared" set and re-fetches it;
    // the fetch re-reads the REAL notes, so nothing is ever wrongly pruned.
    if (garageFlags) for (const id of garageFlags) if (!dbFlag.has(id)) toCheck.add(id);   // new note
    for (const id of dbFlag) if (!(garageFlags && garageFlags.has(id))) toCheck.add(id);    // cleared
    // ALSO re-check EVERY kart the DB believes still has an OPEN note, every cycle. A note deleted or
    // resolved in RaceFacer (repair punched in) clears it but often leaves the list-flag, so it wouldn't
    // show in the flag diff above — re-checking all open-note karts catches those in ~one poll. This set
    // is bounded (only karts that currently have a note), and the fetch loop below runs it concurrently.
    for (const id of dbFlag) toCheck.add(id);
  } else {
    // No note indicator on the list this cycle: always re-check DB-tracked open notes (catches edits +
    // clears + in-place resolves). Add a rotating batch to CATCH NEW notes too — but only when we don't
    // already have an authoritative add-signal (the notifications-list path). opts.noRotate suppresses the
    // rotation so we don't double-fetch and blow the bandwidth cap when the list is already telling us.
    for (const id of dbFlag) toCheck.add(id);
    if (!(opts && opts.noRotate)) {
      const BATCH = parseInt(process.env.NOTES_FAST_BATCH, 10) || 24;
      for (let i = 0; i < BATCH && i < fleet.length; i++) toCheck.add(fleet[(_noteCursor + i) % fleet.length]);
      _noteCursor = (_noteCursor + BATCH) % fleet.length;
    }
  }

  let ids = [...toCheck];
  if (!ids.length) return 0;
  // Fetch concurrently (bounded) rather than one-at-a-time with sleeps — a delete/resolve should clear in
  // ~one poll, not drip out over several seconds. readKartNotes never throws.
  const CONC = Math.max(2, Math.min(10, parseInt(process.env.NOTES_CONCURRENCY, 10) || 8));
  let touched = 0, idx = 0;
  async function worker(){ while (idx < ids.length){ const id = ids[idx++]; await readKartNotes(id); touched++; } }
  await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, () => worker()));
  return touched;
}

/* FULL-FLEET NOTES SWEEP — parallel, for the worker's persistent in-process loop.
   Fetches every kart's detail page with a small worker pool (default 8 concurrent) over ONE
   logged-in session, so the whole fleet's notes refresh in ~6-8s. syncKartNotes only writes
   when a note actually changed, so a quiet sweep costs zero realtime messages.
   Aborts if a third of requests error (RaceFacer struggling) — the next sweep retries. */
async function sweepNotesAll({ concurrency = 8 } = {}) {
  const site = SITE;   // lowercased module const (see line ~18) — never the raw env, or notes get written under 'SYDNEY' and the app's site='sydney' query can't see them
  const fleet = ((await sb('rf_karts?select=rf_id&order=rf_id')) || []).map((r) => r.rf_id).filter((x) => x != null);
  if (!fleet.length) return 0;
  let i = 0, touched = 0, errors = 0;
  async function workerFn() {
    while (i < fleet.length) {
      const id = fleet[i++];
      try {
        const dj = await rfJson(`/ajax/garage/kart-details?id=${id}`);
        await syncKartNotes(id, site, activeNoteMap(id, (dj && dj.html) || ''));
        touched++;
      } catch (e) {
        errors++;
        if (errors > Math.max(10, fleet.length * 0.3)) throw new Error(`sweep aborted after ${errors} errors: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, fleet.length) }, () => workerFn()));
  return touched;
}

// FAST PATH: read OK / Damaged / For-maintenance straight off the garage LIST pages
// (one per kart type, fetched in parallel — ~5 requests for the whole fleet) instead of
// hitting all ~190 karts individually. Only updates karts already in rf_karts (so it's
// always an UPDATE — never a partial insert), and only the status fields.
// statusFast source selection. The old path fanned out ~6 concurrent garage list-page HTML fetches every
// cycle — the single biggest steady load on the small self-hosted RaceFacer box (~120 GET/min), which is
// per-IP throughput-bound: request-budget analysis showed status queuing at the box behind our own volume
// (status on its own session and notes on the shared session went slow in the SAME second, ruling out
// session- and client-level serialization; the undici Agent is uncapped, so our 6 fetches genuinely ran
// in parallel and queued server-side). /ajax/kart/karts-info returns kart records — each carrying id +
// kart_status_id, the SAME 1/2/3 (OK/DAMAGED/FOR MAINTENANCE) domain (see RF_STATUS_ID in
// rf_push_repairs.js) — so the whole fleet's status can arrive in ONE JSON request. The unscoped call is
// unproven on this box (the pusher only ever calls it ?kart_id=-scoped, which returned ONE type-group of
// 76), so it's probed and validated, with automatic fallback to the garage pages:
//   • parse must yield >= ~60% of the known fleet (a scoped/partial response falls back),
//   • the FIRST successful parse is validated against the DB's current status_codes — if >30% of the
//     fleet "disagrees", kart_status_id doesn't mean live status on this build -> fall back,
//   • repeated fetch errors back off to the garage pages and re-probe later.
// STATUS_VIA_KARTS_INFO=0 disables the new path entirely.
let _kiMode = null;            // null = unprobed, 'karts-info' = proven, 'garage-pages' = fallback
let _kiFails = 0, _kiRetryAt = 0, _kiValidated = false;
async function statusFast() {
  // WRITE-ON-CHANGE: read each kart's CURRENT status_code, and only write back the karts whose
  // status actually flipped this cycle. Re-writing all ~190 karts every cycle (even unchanged)
  // would fire a Supabase realtime message + egress per kart per cycle — on a ~10s always-on loop
  // that's millions of messages/day for no reason. Only changed rows broadcast; the rest are skipped.
  const cur = new Map(), curType = new Map();
  try { const f = (await sb('rf_karts?select=rf_id,status_code,type')) || []; for (const r of f) if (r.rf_id != null){ cur.set(r.rf_id, r.status_code); curType.set(r.rf_id, r.type); } }
  catch (e) { console.error(`[fast] couldn't read fleet: ${e.message}`); return 0; }
  if (!cur.size) return 0;                             // nothing known yet — the full sync will populate it

  const rows = [], seen = new Set(), now = new Date().toISOString();
  const noteFlags = new Set();   // karts the garage list shows as having an open note (garage-page path only)
  let scanned = 0, viaKI = false;

  // ---- primary: ONE karts-info JSON request ------------------------------------------------------
  const kiAllowed = process.env.STATUS_VIA_KARTS_INFO !== '0'
    && (_kiMode === 'karts-info' || _kiMode === null || Date.now() >= _kiRetryAt);
  if (kiAllowed) {
    try {
      const j = await rfJson('/ajax/kart/karts-info', 2, statusJar());
      const groups = (j && (j.kart_names || j.karts || j.karts_info)) || {};
      const recs = [];
      for (const g in groups){ const arr = groups[g]; if (Array.isArray(arr)) for (const x of arr){ if (x && x.id != null && x.kart_status_id != null) recs.push(x); } }
      if (!recs.length && Array.isArray(j)) for (const x of j){ if (x && x.id != null && x.kart_status_id != null) recs.push(x); }
      if (recs.length >= cur.size * 0.6) {
        // one-time semantic validation: kart_status_id must broadly AGREE with the DB's current
        // status_codes (which the garage pages populated). Mass disagreement = wrong field meaning.
        if (!_kiValidated) {
          let agree = 0, known = 0;
          for (const x of recs){ const id = Number(x.id); if (!cur.has(id) || cur.get(id) == null) continue; known++; if (Number(x.kart_status_id) === Number(cur.get(id))) agree++; }
          if (known >= 20 && agree < known * 0.7) {
            _kiMode = 'garage-pages'; _kiRetryAt = Date.now() + 6 * 3600000;   // wrong semantics won't fix itself soon
            console.log(`[fast] karts-info kart_status_id disagrees with ${known - agree}/${known} known statuses — NOT a live-status field on this build; staying on garage pages`);
          } else { _kiValidated = true; }
        }
        if (_kiValidated) {
          if (_kiMode !== 'karts-info') { _kiMode = 'karts-info'; console.log(`[fast] status source: karts-info — ${recs.length} karts in ONE request (was ~6 garage pages/cycle)`); }
          _kiFails = 0; viaKI = true;
          for (const x of recs) {
            const rfId = Number(x.id), sc = Number(x.kart_status_id);
            if (!Number.isFinite(rfId) || !cur.has(rfId) || seen.has(rfId)) continue;
            seen.add(rfId); scanned++;
            if (sc !== 1 && sc !== 2 && sc !== 3) continue;      // unknown status id — skip, never guess
            if (cur.get(rfId) === sc) continue;                  // unchanged: no write, no broadcast
            rows.push({ rf_id: rfId, status: (sc === 2 ? 'DAMAGED' : sc === 3 ? 'FOR MAINTENANCE' : 'OK'), status_code: sc, fetched_at: now });
            // NOTE: no `type` write on this path — karts-info's kart_type_id is numeric with no
            // name/site map in this codebase; track-type moves are owned by the heavy sync's
            // enumerate/syncKart pass (page-derived, authoritative).
          }
        }
      } else {
        _kiMode = 'garage-pages'; _kiRetryAt = Date.now() + 3600000;   // scoped/partial — re-probe hourly
        console.log(`[fast] karts-info returned ${recs.length} record(s) vs fleet ${cur.size} — scoped response; falling back to garage pages (re-probe in 1h)`);
      }
    } catch (e) {
      if (++_kiFails >= 3) { _kiMode = 'garage-pages'; _kiRetryAt = Date.now() + 600000; _kiFails = 0;
        console.log(`[fast] karts-info failing (${(e.message || '').slice(0, 80)}) — falling back to garage pages (re-probe in 10m)`); }
    }
  }

  // ---- fallback: the ~6 garage list-page fetches (site-filtered, on the status session) ----------
  if (!viaKI) {
    const uuids = Object.keys(KART_TYPES).filter((u) => (KART_TYPES[u].site || 'sydney') === SITE);
    const sj = statusJar();
    const lists = await Promise.all(uuids.map(async (uuid) => {
      try { const html = await (await rf(`/en/administration/garage/garage?kart_type_uuid=${uuid}`, { jar: sj })).text(); return parseGarageStatuses(html); }
      catch (e) { return []; }                          // a page that fails this cycle just gets skipped; the next cycle/heavy covers it
    }));
    for (let _li = 0; _li < lists.length; _li++) {
      const pageType = (KART_TYPES[uuids[_li]] && KART_TYPES[uuids[_li]].type) || null;   // the track type this page represents
      for (const k of lists[_li]) {
        if (!k.rfId || k.statusCode == null || !cur.has(k.rfId) || seen.has(k.rfId)) continue;
        seen.add(k.rfId); scanned++;
        // parseGarageStatuses may expose a note indicator under any of these names; harmless if absent.
        if (k.hasNote || k.hasNotes || k.noteActive || k.note || k.notes_count > 0) noteFlags.add(k.rfId);
        const statusChanged = cur.get(k.rfId) !== k.statusCode;
        const typeChanged = pageType != null && curType.get(k.rfId) !== pageType;   // kart moved to another track type
        if (!statusChanged && !typeChanged) continue;   // nothing changed this cycle: do not write, do not broadcast
        const _row = { rf_id: k.rfId, status: k.status, status_code: k.statusCode, fetched_at: now };
        if (pageType != null) _row.type = pageType;     // land the current track type in the same fast write
        rows.push(_row);
      }
    }
  }

  for (let i = 0; i < rows.length; i += 100) {
    try { await sb('rf_karts?on_conflict=rf_id', { method: 'POST', prefer: 'resolution=merge-duplicates', body: rows.slice(i, i + 100) }); }
    catch (e) { console.error(`[fast] status upsert failed: ${e.message}`); }
  }
  // one tiny row carries the "last polled" timestamp so freshness is tracked without stamping every kart
  try { await sb('rf_sync_state?on_conflict=k', { method: 'POST', prefer: 'resolution=merge-duplicates', body: [{ k: 'last_status', v: now, at: now }] }); } catch (e) {}
  if (rows.length) console.log(`[fast] ${rows.length} status change(s) of ${scanned} scanned${viaKI ? ' (karts-info)' : ''}.`);
  statusFast._noteFlags = noteFlags;                  // note-flags only exist on the garage-page path now
  statusFast._sawFlags = noteFlags.size > 0;          // did the parser actually expose note info this cycle?
  return rows.length;
}

async function main() {
  if (!RF_USER || !RF_PASS || !SB_URL || !SB_KEY) throw new Error('missing required env vars');
  await login();

  // NOTES_ONLY mode: just the rotating notes sweep. Status is handled by the worker's in-process
  // poller now, so this loop is dedicated to catching note add/edit/delete across the fleet fast.
  if (process.env.NOTES_ONLY === '1') {
    let notes = 0;
    try { notes = await notesFast(null); } catch (e) { console.error('[notes-fast]', e.message); }
    if (notes) console.log(`[notes] swept ${notes} kart(s).`);
    return;
  }

  // STATUS_ONLY mode (legacy fallback if the in-process poller isn't used): refresh
  // OK/Damaged/Maintenance AND run the fast notes pass in one spawned cycle.
  if (process.env.STATUS_ONLY === '1') {
    const n = await statusFast();
    let notes = 0;
    if (process.env.NOTES_FAST !== '0') {
      try { notes = await notesFast(statusFast._noteFlags); } catch (e) { console.error('[notes-fast]', e.message); }
    }
    await refreshLiveTracks();                 // keep "live now" fresh on the fast runner
    console.log(`[status] refreshed ${n} karts${notes ? `, notes for ${notes}` : ''}.`);
    return;
  }

  // Run the heavy (full) sync only every HEAVY_INTERVAL_MS; every other cycle is a quick status refresh.
  let lastHeavy = 0, haveFleet = false;
  try { const st = await sb('rf_sync_state?k=eq.last_heavy&select=v'); if (st && st[0] && st[0].v) lastHeavy = Date.parse(st[0].v) || 0; } catch (e) {}
  try { const f = await sb('rf_karts?select=rf_id&limit=1'); haveFleet = !!(f && f.length); } catch (e) {}
  const doHeavy = !haveFleet || (Date.now() - lastHeavy >= HEAVY_INTERVAL_MS);

  if (!doHeavy) {
    const n = await statusFast();
    await refreshLiveTracks();                 // keep "live now" fresh between heavy passes
    const due = Math.max(0, Math.round((HEAVY_INTERVAL_MS - (Date.now() - lastHeavy)) / 1000));
    console.log(`[fast] status refreshed for ${n} karts; full sync due in ~${due}s.`);
    return;
  }

  // ----- full sync: enumerate everything + repairs/parts/notes + prune + reconcile -----
  try { await syncTracks(); } catch (e) { console.log('[tracks] sync error:', e.message); }   // current track layout -> tracks table
  const idMap = await enumerateKarts();           // Map: rf_id -> { site, type }
  console.log(`Syncing ${idMap.size} karts...`);
  try { await statusFast(); } catch (e) {}        // refresh OK/Damaged up-front so a status flip isn't stuck behind the whole pass
  // Repairs: incremental most runs (stops at the stable tail), FULL once an hour to catch edits to old
  // repairs deep in the list. The hourly gate uses rf_sync_state so it survives the per-run child spawn.
  let repairsFull = false;
  try { const st = await sb('rf_sync_state?k=eq.last_repairs_full&select=v'); const last = (st && st[0] && st[0].v) ? (Date.parse(st[0].v) || 0) : 0; repairsFull = (Date.now() - last >= 60 * 60 * 1000); } catch (e) { repairsFull = true; }
  let repairsByKart = new Map();
  try { repairsByKart = await syncAllRepairs({ fullSweep: repairsFull }); } // whole-fleet damage list -> rf_repairs / rf_repair_parts (+ map for reconcile)
  catch (e) { console.error('[repairs] full-fleet sync failed:', e.message); }

  // Per-kart detail/parts sync (km/hours/cost/brand/model + parts_history) is EXPENSIVE — 230 karts x 2
  // RaceFacer fetches — and its data changes slowly, so it runs on its OWN ~30min cadence, NOT every
  // heavy run. That's the key to keeping status/notes un-starved: the frequent heavy runs now cost almost
  // nothing on RaceFacer (incremental repairs is ~1 page), and this heavy per-kart burst only lands
  // occasionally. Status is served by the main loop, so throttling this doesn't affect status freshness.
  let doKartDetails = !haveFleet;
  try { const st = await sb('rf_sync_state?k=eq.last_kartdetails&select=v'); const last = (st && st[0] && st[0].v) ? (Date.parse(st[0].v) || 0) : 0; if (Date.now() - last >= KART_DETAILS_INTERVAL_MS) doKartDetails = true; }
  catch (e) { doKartDetails = true; }

  let perKart = [], pruned = 0;
  if (doKartDetails) {
    // Full parallel per-kart sync + prune. Bounded worker pool, no inter-kart sleep -> ~15-25s. Concurrency
    // matches sweepNotesAll's proven profile. (Heavy child skips per-kart NOTES via HEAVY_SKIP_KART_NOTES —
    // see syncKart — so this is just details + parts.)
    const skipIds = new Set();
    const entries = [...idMap.entries()];
    let _ki = 0;
    const KART_CONC = Math.max(2, Math.min(8, parseInt(process.env.HEAVY_KART_CONCURRENCY, 10) || 6));
    async function _kartWorker(){
      while (_ki < entries.length){
        const [id, meta] = entries[_ki++];
        try { const k = await syncKart(id, meta, repairsByKart); if (k && k.skipped) skipIds.add(id); else if (k) perKart.push(k); }
        catch (e) { console.error(`kart ${id}: ${e.message}`); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(KART_CONC, entries.length) }, () => _kartWorker()));
    if (skipIds.size) console.log(`[skip] ${skipIds.size} non-numeric-named karts (George/Late/test) excluded.`);
    const keepIds = [...idMap.keys()].filter((id) => !skipIds.has(id));   // real karts only (incl. ones that transiently failed)
    pruned = await pruneStale(keepIds);
    if (pruned) console.log(`[prune] removed ${pruned} stale/ghost karts no longer listed under any type.`);
  } else {
    // Skip the expensive per-kart RaceFacer loop this run. reconcile only needs each kart's LABEL and its
    // REPAIRS, both of which we already have (repairs from syncAllRepairs; labels from the DB) — so build
    // the reconcile input directly, with zero per-kart RaceFacer fetches. kart details/parts_history just
    // stay as the last detail-run left them (slow-changing; not what status/notes latency depends on).
    let nameMap = new Map();
    try { for (const k of (await sb('rf_karts?select=rf_id,name,label')) || []) nameMap.set(Number(k.rf_id), k); } catch (e) {}
    for (const [kid, reps] of repairsByKart) { const m = nameMap.get(Number(kid)); if (!m) continue; perKart.push({ id: kid, name: m.name, label: m.label, repairs: reps }); }
    console.log(`[heavy] per-kart detail sync skipped this run (own ~${Math.round(KART_DETAILS_INTERVAL_MS / 60000)}min cadence); reconciling ${perKart.length} kart(s) from already-fetched repairs.`);
  }
  const aliases = await refreshAliases(perKart.flatMap((k) => k.repairs.flatMap((r) => (r.parts || []).map((p) => p.name))));
  const n = await reconcileToday(perKart, aliases);
  const now = new Date().toISOString();
  const stateRows = [{ k: 'last_sync', v: now, at: now }, { k: 'last_heavy', v: now, at: now }];
  if (doKartDetails) stateRows.push({ k: 'last_kartdetails', v: now, at: now });   // reset the ~30min per-kart-detail clock
  if (repairsFull) stateRows.push({ k: 'last_repairs_full', v: now, at: now });   // reset the hourly full-repairs clock
  await sb('rf_sync_state?on_conflict=k', { method: 'POST', prefer: 'resolution=merge-duplicates', body: stateRows });
  console.log(`Done. ${perKart.length} karts synced, ${pruned} ghosts removed, ${n} discrepancies flagged for today.`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { login, loginStatus, rfJson, enumerateKarts, syncKart, statusFast, reconcileToday, logTrackSegments, refreshLiveTracks, sweepNotesAll, notesFast, notesFromNotifications, notesFromKartNotesPage, getKartNoteIndex, readKartNotes, _kniExtractRaw };
