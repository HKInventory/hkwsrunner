/* HK Workshop — RaceFacer SESSIONS sync (rf_sessions.js)
 * ------------------------------------------------------
 * Mirrors RaceFacer session-management into Supabase so the app + HK AI can answer
 * "which karts were in the 10:00 session" and scope BMS cell history to a session window.
 *
 * Flow (every RF_SESS_POLL_SEC, default 20s; shares the persistent RaceFacer session
 * owned by index.js — caller ensures login and passes racefacer-sync's rfJson):
 *   1. GET the day's schedule            -> extract session UUIDs (defensive parse)
 *   2. GET detail for interesting UUIDs  -> /ajax/session-management/session?type=session&uuid=..&sub_track_id=..
 *      (this response shape is CONFIRMED from a live capture: session_data{label,status,
 *       scheduled_time_string,track_configuration,sub_track_id,runs.data[{client_name,kart,
 *       kart_id,fleet_management_id,total_laps,best_lap,average_lap_time,last_lap,length,status}]})
 *   3. Upsert rf_sessions + rf_session_runs (content-hashed — write only on change)
 *   4. Every ~6h: prune rf_sessions / rf_session_runs / rimo_bms_history older than 7 days
 *
 * Bandwidth: fetches from RaceFacer are inbound (free on Render); Supabase writes are
 * change-detected, so a quiet schedule costs ~nothing.
 *
 * Env: RF_SESS_POLL_SEC (20), RF_SUB_TRACKS ("4" — comma list), RF_SESS_SCHEDULE_PATH
 *      (override if the schedule endpoint differs), SESSIONS=off kill switch.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SB_URL = process.env.SUPABASE_URL || process.env.SB_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SB_SERVICE_KEY;
const supa = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;
const SITE = (process.env.SITE || 'sydney').trim().toLowerCase();
const SUB_TRACKS = String(process.env.RF_SUB_TRACKS || '1,2,3,4,5,6').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = s => crypto.createHash('sha1').update(String(s)).digest('base64').slice(0, 20);

let _schedPath = process.env.RF_SESS_SCHEDULE_PATH || null;   // learned once, reused
let _sessHash = {};            // uuid -> content hash of last write
let _doneFinished = {};        // uuid -> true once a FINISHED session has been stored (never refetch)
let _seenOnce = {};            // uuid -> true once we've detail-fetched it at least once (skip refetching upcoming sessions)
let _subTrackFor = {};         // uuid -> the sub_track_id that actually returned this session (avoid re-scanning all 6)
let _lastPrune = 0;
let _schedLogged = false, _failLogged = 0;
let _trackCounts = {}, _trackCountSig = '';   // diagnostic: sessions returned per sub-track
let _trackSeenSig = '';                        // diagnostic: distinct track_configuration values written

function todayStr(){
  // RaceFacer runs on venue-local dates; Sydney.
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // YYYY-MM-DD
}

/* Recursively collect anything in the schedule JSON that looks like a session
   (an object carrying a UUID). Shape-agnostic on purpose — we only need the UUIDs
   (+ sub_track_id/status when present); ALL real fields come from the detail call,
   whose shape is confirmed. */
function collectSessions(node, out, depth){
  if (!node || depth > 8) return;
  if (Array.isArray(node)){ for (const x of node) collectSessions(x, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  const uuid = typeof node.uuid === 'string' && UUID_RE.test(node.uuid) ? node.uuid : null;
  if (uuid && !out.some(s => s.uuid === uuid)){
    out.push({
      uuid,
      status: String(node.status || node.session_status || ''),
      sub_track_id: Number(node.sub_track_id) || null,
      when: String(node.scheduled_time_string || node.schedule_time || node.scheduled_time || node.time || ''),
    });
  }
  for (const k in node) if (node[k] && typeof node[k] === 'object') collectSessions(node[k], out, depth + 1);
}

async function fetchSchedule(rfJson, date){
  const candidates = _schedPath ? [_schedPath] : [
    '/ajax/session-management/sessions-schedule?date={d}&sub_track_id={st}',
    '/ajax/session-management/sessions-schedule?date={d}',
    '/ajax/session-management/sessions-schedule?date={d}&session_page=karting',
    '/ajax/sessions-schedule?date={d}&sub_track_id={st}',
    '/ajax/sessions-schedule?date={d}',
  ];
  for (const tmpl of candidates){
    // Poll EVERY sub-track and COMBINE — different tracks (Adult, Intermediate, Junior…) have
    // different sub_track_ids, so returning on the first track's hit misses all the others.
    // De-dupe by uuid across tracks.
    const seen = {}, combined = [];
    let anyHit = false;
    // This RaceFacer build returns EVERY session regardless of sub_track_id (confirmed live: the
    // per-sub-track counts are identical across 1-6), so one fetch gets the whole schedule — scanning
    // all six was 6x the requests for the same data, every 20s. Fetch a single sub-track by default; set
    // RF_SESS_SUBTRACK_SCAN=1 to restore the full scan if a venue genuinely splits sessions per track.
    const scanAll = process.env.RF_SESS_SUBTRACK_SCAN === '1';
    const tracks = tmpl.includes('{st}') ? (scanAll ? SUB_TRACKS : [SUB_TRACKS[0]]) : [null];
    for (const st of tracks){
      const path = tmpl.replace('{d}', date).replace('{st}', String(st));
      try {
        const j = await rfJson(path, 1);
        if (!j) continue;
        const out = [];
        collectSessions(j, out, 0);
        _trackCounts[st == null ? 'all' : st] = out.length;   // diagnostic: sessions returned per sub-track
        if (out.length){
          anyHit = true;
          if (!_schedLogged){ _schedLogged = true; console.log(`[sessions] schedule top-level keys: ${Object.keys(j).slice(0, 12).join(',')}`); }
          for (const s of out){ const id = s.uuid || s.rf_session_id || JSON.stringify(s).slice(0, 40); if (!seen[id]){ seen[id] = true; combined.push(s); } }
        }
      } catch (e) { /* try next track */ }
    }
    if (anyHit){
      if (!_schedPath){ _schedPath = tmpl; console.log(`[sessions] schedule endpoint locked: ${tmpl} (${combined.length} sessions across ${tracks.length} track(s))`); }
      // Log the per-sub-track breakdown whenever it changes — this reveals if e.g. only sub_track 4
      // ever returns sessions (endpoint ignores sub_track_id → Adult never arrives) vs. each track
      // returning its own. Throttled to changes so it isn't spammy.
      const sig = JSON.stringify(_trackCounts);
      if (sig !== _trackCountSig){ _trackCountSig = sig; console.log(`[sessions] per-sub-track counts: ${sig}`); }
      return combined;
    }
  }
  if (_failLogged++ < 3) console.log(`[sessions] could not find the schedule endpoint for ${date} — paste the sessions-schedule Response and set RF_SESS_SCHEDULE_PATH`);
  return [];
}

function parseLapMins(runs){
  let m = 0;
  for (const r of runs) { const n = Number(r.length); if (Number.isFinite(n) && n > m) m = n; }
  return m || 10;   // slot_time on the page is 10 min
}

async function fetchDetail(rfJson, uuid, subTrack){
  // The schedule endpoint returns every session under every sub_track_id, so a session's "own"
  // sub_track_id from the schedule can be wrong — and the detail endpoint returns 0 runs when queried
  // under the wrong track. That produced "0 karts" / missing Adult races. So: try the hinted track
  // first, then the rest, and return the response that actually has karts (fall back to a label-only
  // response if none do, so genuinely-empty slots still register).
  // Try the sub_track that worked LAST time for this uuid first (cached), then the schedule's hint, then
  // the rest — and stop the moment we find karts. Once resolved, steady-state is ONE fetch per session.
  const first = _subTrackFor[uuid] || subTrack;
  const order = first ? [first].concat(SUB_TRACKS.filter(x => x !== first)) : SUB_TRACKS;
  let fallback = null, fallbackSt = null;
  for (const st of order){
    try {
      const j = await rfJson(`/ajax/session-management/session?type=session&uuid=${uuid}&sub_track_id=${st}`, 1);
      const sd = j && (j.session_data || j.session || j.data);
      if (sd && (sd.uuid || sd.label || sd.runs)){
        const nRuns = ((sd.runs && (sd.runs.data || sd.runs)) || []).length;
        if (nRuns > 0){ _subTrackFor[uuid] = st; return sd; }   // real karts — cache this track, done
        if (!fallback){ fallback = sd; fallbackSt = st; }        // remember an empty view in case no track has karts
      }
    } catch (e) { /* try next sub-track */ }
  }
  if (fallbackSt != null) _subTrackFor[uuid] = fallbackSt;   // cache even an empty hit, so we don't rescan all six
  return fallback;
}

function rowsFromDetail(sd, uuid){
  const runsIn = (sd.runs && (sd.runs.data || sd.runs)) || [];
  const runs = Array.isArray(runsIn) ? runsIn : [];
  const startStr = sd.scheduled_time_string || sd.scheduled_time || '';
  // "2026-07-14 17:00:00" is venue-local (Sydney) — attach the offset via Intl round-trip.
  let scheduled_at = null, ends_at = null;
  if (startStr){
    const m = String(startStr).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m){
      // Interpret as Australia/Sydney wall time: find the UTC instant whose Sydney rendering matches.
      const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      for (const offH of [10, 11, 9]){   // AEST/AEDT candidates
        const t = guess - offH * 3600000;
        const back = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
        if (back === `${m[1]}-${m[2]}-${m[3]}, ${m[4]}:${m[5]}`){ scheduled_at = new Date(t).toISOString(); break; }
      }
      if (!scheduled_at) scheduled_at = new Date(guess - 10 * 3600000).toISOString();
      ends_at = new Date(Date.parse(scheduled_at) + (parseLapMins(runs) + 3) * 60000).toISOString();   // +3 min buffer
    }
  }
  const sess = {
    uuid,
    rf_session_id: Number(sd.id) || null,
    label: String(sd.label || sd.name || ''),
    status: String(sd.status || ''),
    track: String(sd.track_configuration || sd.track || ''),
    sub_track_id: Number(sd.sub_track_id) || null,
    scheduled_at, ends_at,
    site: SITE,
    updated_at: new Date().toISOString(),
  };
  const runRows = [];
  for (const r of runs){
    const rid = Number(r.id || r.run_id); if (!Number.isFinite(rid)) continue;
    const kart = r.kart != null ? r.kart : (r.kart_label != null ? r.kart_label : r.kart_no);
    runRows.push({
      run_id: rid,
      session_uuid: uuid,
      client_name: String(r.client_name || r.client || r.name || ''),
      kart_no: String(kart != null ? kart : ''),
      rf_kart_id: Number(r.kart_id) || null,
      fleet_management_id: (r.fleet_management_id != null ? String(r.fleet_management_id) : null),
      total_laps: Number(r.total_laps) || 0,
      best_lap: String(r.best_lap || ''),
      avg_lap: String(r.average_lap_time || r.avg_lap || ''),
      last_lap: String(r.last_lap || ''),
      status: String(r.status || ''),
      updated_at: new Date().toISOString(),
    });
  }
  return { sess, runRows };
}

async function pruneOld(){
  if (Date.now() - _lastPrune < 6 * 3600000) return;
  _lastPrune = Date.now();
  // Self-heal stuck sessions: any row still marked in_progress but scheduled well in the past never
  // got a finished-status update (RaceFacer's finished string doesn't match /finish|complete|closed|
  // ended/ and we only re-sync today's schedule). Left alone they make the RiMO BMS logger think a
  // race is live and log its karts 24/7. Flip them so nothing treats them as running. Cheap: only
  // matches the handful of genuinely-stuck rows.
  try {
    const staleCut = new Date(Date.now() - 3 * 3600000).toISOString();
    const { data: healed } = await supa.from('rf_sessions')
      .update({ status: 'ended', updated_at: new Date().toISOString() })
      .eq('status', 'in_progress').lt('scheduled_at', staleCut).select('uuid');
    if (healed && healed.length) console.log(`[sessions] self-healed ${healed.length} stuck in_progress session(s) → ended`);
  } catch (e) { /* non-fatal */ }
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  try {
    const { data: old } = await supa.from('rf_sessions').select('uuid').lt('scheduled_at', cutoff).limit(500);
    const uuids = (old || []).map(s => s.uuid);
    if (uuids.length){
      await supa.from('rf_session_runs').delete().in('session_uuid', uuids);
      await supa.from('rf_sessions').delete().in('uuid', uuids);
    }
    await supa.from('rimo_bms_history').delete().lt('at', cutoff);
    console.log(`[sessions] 7-day prune done (${uuids.length} old sessions, BMS history < ${cutoff.slice(0, 10)})`);
  } catch (e) { console.error('[sessions] prune:', e.message || e); }
}

async function syncSessions(rfJson){
  if (!supa || process.env.SESSIONS === 'off') return;
  const date = todayStr();
  const list = await fetchSchedule(rfJson, date);
  if (!list.length) return;
  const now = Date.now();
  // Which sessions deserve a detail fetch THIS cycle — kept minimal so we're not hammering RaceFacer:
  //   • IN-PROGRESS sessions -> always (their karts/laps change live).
  //   • Sessions we've never fetched -> once (to store label/time; upcoming slots have no karts yet).
  //   • Upcoming sessions we've already stored -> SKIP until they go in-progress. Re-fetching every 20s
  //     did nothing (no karts assigned until a session starts) and was the bulk of the request storm.
  //   • Finished -> never (cached in _doneFinished).
  const wanted = list.filter(s => {
    if (_doneFinished[s.uuid]) return false;
    const st = (s.status || '').toLowerCase();
    if (st.includes('progress')) return true;   // live -> refresh every cycle
    if (!_seenOnce[s.uuid]) return true;          // first sighting -> fetch once to store its label/time
    return false;                                  // upcoming & already stored -> nothing changes until it starts
  }).slice(0, 25);
  let wrote = 0, fetched = 0;
  for (const s of wanted){
    const sd = await fetchDetail(rfJson, s.uuid, s.sub_track_id);
    _seenOnce[s.uuid] = true;   // mark attempted so an upcoming slot isn't re-fetched every cycle
    fetched++;
    if (!sd) continue;
    const { sess, runRows } = rowsFromDetail(sd, s.uuid);
    const h = sha(JSON.stringify(sess) + JSON.stringify(runRows));
    // "Finished" = RaceFacer says so OR the scheduled end time has passed and it's no longer live.
    // The status-word check alone misses RaceFacer's real finished string, so past races never got
    // marked done — they kept occupying the per-cycle fetch window and starved later sessions (some
    // finished/chequered races then never landed). The time fallback fixes that. We deliberately do
    // NOT mark a session done while it's still in_progress past its end time (a race that ran long)
    // so we keep syncing until its status actually clears.
    const stLc = (sess.status || '').toLowerCase();
    const endPassed = sess.ends_at && Date.parse(sess.ends_at) < (Date.now() - 5 * 60000);
    const finished = /finish|complete|closed|ended|done/i.test(stLc) || (endPassed && !stLc.includes('progress'));
    if (_sessHash[s.uuid] === h){ if (finished) _doneFinished[s.uuid] = true; continue; }
    _sessHash[s.uuid] = h;
    const { error: e1 } = await supa.from('rf_sessions').upsert(sess, { onConflict: 'uuid' });
    if (e1){ if (!/relation|does not exist/i.test(e1.message)) console.error('[sessions] upsert:', e1.message); return; }
    if (runRows.length){
      const { error: e2 } = await supa.from('rf_session_runs').upsert(runRows, { onConflict: 'run_id' });
      if (e2) console.error('[sessions] runs upsert:', e2.message);
    }
    if (finished) _doneFinished[s.uuid] = true;
    wrote++;
  }
  if (wrote || fetched) console.log(`[sessions] ${wrote} written / ${fetched} detail-fetched (${list.length} on today's schedule; only live + first-seen are fetched)`);
  // Diagnostic: which track_configuration values are actually present in what we fetched today.
  // If this only ever shows Intermediate, Adult sessions aren't coming back from RaceFacer at all
  // (schedule/detail endpoint or sub_track_id issue), not an app-display problem.
  try {
    const { data: today } = await supa.from('rf_sessions')
      .select('track').gte('scheduled_at', new Date(Date.now() - 18 * 3600000).toISOString());
    const tracks = Array.from(new Set((today || []).map(r => (r.track || '?').trim()).filter(Boolean))).sort();
    const sig = tracks.join('|');
    if (sig && sig !== _trackSeenSig){ _trackSeenSig = sig; console.log(`[sessions] distinct tracks stored (last 18h): ${tracks.join(', ')}`); }
  } catch (e) { /* diagnostic only */ }
  await pruneOld();
}

module.exports = { syncSessions };
