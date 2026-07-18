#!/usr/bin/env node
/*
 * HK Workshop — COMBINED Render worker (both sync directions in one service).
 * ------------------------------------------------------------------------
 * This single process replaces BOTH the old GitHub sync workflows AND runs the
 * app->RaceFacer pusher, so you only pay for one Render Background Worker.
 *
 * It runs three things at once:
 *   1. PUSHER (persistent)  — app -> RaceFacer. Fires on Supabase realtime the
 *      instant you save a repair/note/status; pushes to RaceFacer in ~1.5-3s.
 *      (from rf_push_repairs.js)
 *   2. STATUS loop (~5s)     — RaceFacer -> app. Fast OK/Damaged/Maintenance +
 *      note add/delete detection. Spawns racefacer-sync.js with STATUS_ONLY=1.
 *   3. HEAVY loop (~2min)    — RaceFacer -> app. Full sync: repairs, parts, notes,
 *      prune, reconcile. Spawns racefacer-sync.js with the full pass enabled.
 *
 * The two sync loops SPAWN racefacer-sync.js as short-lived child processes (fresh
 * RaceFacer login each cycle, no memory growth, a stuck child is killed on timeout).
 * The pusher runs in THIS process because it must hold a persistent realtime socket.
 *
 * The pusher and the sync don't fight: the pusher is bursty and quick, the sync is a
 * steady poll. If they ever collide they briefly take turns (~1-2s), never a stall.
 *
 * Env (same as before): RF_USER, RF_PASS, SB_URL, SB_SERVICE_KEY, SITE
 *   plus optional tuning:
 *     STATUS_GAP_SEC     pause between status cycles   (default 5,   min 5)
 *     HEAVY_GAP_SEC      pause between full syncs       (default 120, min 60)
 *     CYCLE_TIMEOUT_SEC  kill a stuck sync child after  (default 600, min 120)
 */
'use strict';

// RaceFacer uses a self-signed cert; Node's global fetch ignores https.Agent, so relax
// strict TLS process-wide. This process only talks to Supabase (valid cert) and RaceFacer.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');

// ---- 1. start the app -> RaceFacer pusher (persistent, realtime-driven) ----
const { startRepairPusher } = require('./rf_push_repairs');
// scrape = post-push read-back. After the pusher creates/clears a note in RaceFacer we immediately
// read THAT kart's notes back into Supabase, so the real note (with its RF id) lands within a second
// or two and the app's "syncing…" clears at once — no waiting on a sweep, no dupes. readKartNotes
// never throws, so a read-back hiccup can't mark a successful push as failed.
startRepairPusher((kartId) => require('./racefacer-sync').readKartNotes(kartId));

// ---- 1b. RiMO Germany WFM poller (live online / SOC / BMS per kart) --------
try { require('./rimo').startRimo(); } catch (e) { console.error('[rimo] failed to start:', e.message || e); }

// ---- 1c. HK AI (answers ai_queue questions via the Anthropic API; key in env) --------
try { require('./hkai').startAI(); } catch (e) { console.error('[ai] failed to start:', e.message || e); }

// ---- PERSISTENT STATUS POLLER (in-process, no re-spawn/re-login) -----------
// Status changes must feel instant. Spawning a fresh racefacer-sync.js each cycle re-logs into
// RaceFacer (~1-2s handshake) EVERY time, which caps how fast we can go. So status runs here,
// in-process: log in ONCE, then hit the ~5 garage list pages on a tight loop and write only the
// karts whose status flipped. ~5 requests/cycle is well within what RaceFacer tolerates.
const sync = require('./racefacer-sync');
// BANDWIDTH: the notes sweep re-fetches EVERY kart's detail page each pass. With a 1s pause it ran a
// full ~200-kart sweep roughly every 8s, 24/7 — ~25 RaceFacer requests/sec (each carrying the big
// session cookie) around the clock, which is a sustained ~500MB/hr outbound drain independent of races.
// Notes change a few times a day and the ~5min heavy pass also syncs them, so a long gap is plenty.
// These are DEFAULTS ONLY — the same env vars still override for instant tuning without a redeploy.
const STATUS_POLL = Math.max(2, parseInt(process.env.STATUS_POLL_SEC   || '3', 10)) * 1000;   // status = 5 cheap list pages -> poll tight; independent of notes now
const NOTES_CONC  = Math.max(2, Math.min(12, parseInt(process.env.NOTES_CONCURRENCY || '8', 10)));
// Notes now run in their OWN loop, at a cadence that depends on whether we have a cheap change-signal:
//   • list-flagged  -> a stable fleet costs ~0 detail fetches, so we can poll fast (a new note lands in ~1 interval)
//   • rotating      -> NO signal, so every cycle blind-fetches a batch; keep this gentler to respect the ~105GB/mo
//                      outbound cap (fast blind rotation across ~190 karts would blow it). This path is the reason
//                      note-adds are slow; the real fix is a working signal (see notesFromNotifications).
const NOTES_POLL        = Math.max(2, parseInt(process.env.NOTES_POLL_SEC        || '20', 10)) * 1000;
const NOTES_POLL_ROTATE = Math.max(5, parseInt(process.env.NOTES_POLL_ROTATE_SEC || '20', 10)) * 1000;
// Safety-net FULL sweep on a wall-clock timer (catches the rare change no targeted pass can see, e.g. a note
// edited in place whose list-flag never changes).
const NOTES_FULL_SWEEP_MS = Math.max(60, parseInt(process.env.NOTES_FULL_SWEEP_SEC || '1800', 10)) * 1000;

// ONE login shared by the status poller and the notes sweeper (same module = same cookie jar).
// The promise-guard stops both loops logging in at the same moment; an auth error resets it so
// the next call re-authenticates.
let _loginP = null;
function ensureLogin(){ if (!_loginP) _loginP = sync.login().then(() => { log('RaceFacer session up'); }); return _loginP.catch((e) => { _loginP = null; throw e; }); }
function dropLogin(){ _loginP = null; }
function sleep(ms){ return new Promise((r) => setTimeout(r, ms)); }

// STATUS loop — tight and independent. Just the ~5 garage list pages + write-changed status. This no
// longer waits on notes, so a status flip in RaceFacer reaches the app in ~one STATUS_POLL (~3s) no
// matter what the notes loop is doing. statusFast() also parses per-kart note-flags off the SAME pages
// (free) and stashes them on statusFast._noteFlags for the notes loop to consume. refreshLiveTracks
// (session-schedule fetch + track writes) is comparatively slow and only changes minute-to-minute, so it
// runs on its own ~15s cadence rather than padding every status cycle.
const LIVE_TRACKS_MS = Math.max(8000, (parseInt(process.env.LIVE_TRACKS_SEC || '15', 10)) * 1000);
let _lastLiveTracks = 0;
async function statusLoop(){
  let fails = 0;
  while (!stopping){
    const t0 = Date.now();
    try {
      await ensureLogin();
      const changed = await sync.statusFast();
      if (changed) log(`status: ${changed} kart(s) changed`);
      if (typeof sync.refreshLiveTracks === 'function' && Date.now() - _lastLiveTracks >= LIVE_TRACKS_MS) {
        _lastLiveTracks = Date.now();
        try { await sync.refreshLiveTracks(); } catch (e) {}
      }
      fails = 0;
    } catch (e){
      fails++;
      if (/login|session|401|403/i.test(e.message || '')) dropLogin();
      if (fails <= 3 || fails % 10 === 0) log(`status poll error (${fails}): ${e.message}`);
      if (fails > 3) await sleep(Math.min(30000, fails * 1000));   // back off if RaceFacer is unhappy
    }
    // INSTRUMENTATION: a status cycle should take ~1s (7 cheap list pages). If it's routinely much longer
    // than the poll interval, RaceFacer is contended (usually by the heavy child mid-sweep) — that IS the
    // status-latency symptom, logged here so a capture localizes it instead of us inferring it.
    const _dt = Date.now() - t0;
    if (_dt > 4000) log(`status cycle SLOW: ${_dt}ms (poll ${STATUS_POLL}ms) — RaceFacer contended`);
    await sleep(Math.max(0, STATUS_POLL - (Date.now() - t0)));
  }
}

// NOTES loop — independent of status. Each cycle:
//   1. notesFromNotifications() — ONE fetch of the global notifications list -> detects notes ADDED in
//      RaceFacer fleet-wide and pulls only those karts' details. Authoritative + cheap (1 request), so a
//      new note lands in ~one interval WITHOUT blind rotation. Returns null if it can't read the list
//      (then we fall back to the flag/rotate path, and it self-logs the page once so we can wire it exactly).
//   2. notesFast(flags) — flag-diff for adds/clears when the list exposes note-flags; otherwise a gentle
//      rotating fallback. Also re-checks DB-open notes so an in-place resolve clears fast.
// Cadence adapts: fast when we have a cheap signal (notifications list or list-flags), gentle when we're
// blind-rotating, so we never breach the outbound bandwidth cap chasing notes.
let _lastNotesMode = null, _lastSweepAt = Date.now();
async function notesLoop(){
  let fails = 0, ticks = 0;
  await sleep(1500);   // let statusLoop populate note-flags on its first pass
  while (!stopping){
    const t0 = Date.now();
    let haveSignal = false;
    try {
      await ensureLogin();
      // 1) authoritative fleet-wide detector — handles ADDS *and* DELETES in one cheap request.
      //    Prefer the global Kart Notes page (real, parseable, and also backfills kart_note_id); fall back
      //    to the notifications list if that page can't be read.
      let viaList = null, listSrc = null;
      if (typeof sync.notesFromKartNotesPage === 'function') {
        try { viaList = await sync.notesFromKartNotesPage(); if (viaList != null) listSrc = 'kart-notes-page'; }
        catch (e) { viaList = null; log(`notes-page error: ${e.message}`); if (/login|session|401|403/i.test(e.message || '')) dropLogin(); }
      }
      if (viaList == null && typeof sync.notesFromNotifications === 'function') {
        try { viaList = await sync.notesFromNotifications(); if (viaList != null) listSrc = 'notifications-list'; }
        catch (e) { viaList = null; log(`notes-list error: ${e.message}`); if (/login|session|401|403/i.test(e.message || '')) dropLogin(); }
      }
      // 2) fallback ONLY when neither list could be read — flag-diff for adds/clears, else gentle rotation.
      //    When a list works it already covers adds+deletes, so we skip this entirely (cheaper + faster).
      let touched = 0;
      if (viaList == null) {
        try { touched = await sync.notesFast(sync.statusFast && sync.statusFast._noteFlags); }
        catch (e) { log(`notes error: ${e.message}`); if (/login|session|401|403/i.test(e.message || '')) dropLogin(); }
      }

      const flagged = !!(sync.statusFast && sync.statusFast._sawFlags);
      haveSignal = (viaList != null) || flagged;
      const mode = listSrc || (flagged ? 'list-flagged' : 'rotating');
      if (mode !== _lastNotesMode) { _lastNotesMode = mode; log(`notes detection mode: ${mode}`); }
      ticks++;
      if (viaList) log(`notes: ${viaList} kart(s) changed & synced (${mode})`);
      else if (touched && (ticks % 15 === 0)) log(`notes: ${touched} kart(s) re-synced (${mode})`);

      // wall-clock safety-net full sweep
      if (Date.now() - _lastSweepAt >= NOTES_FULL_SWEEP_MS) {
        _lastSweepAt = Date.now();
        try { await sync.sweepNotesAll({ concurrency: NOTES_CONC }); }
        catch (e) { log(`notes full-sweep skipped: ${e.message}`); if (/login|session|401|403/i.test(e.message || '')) dropLogin(); }
      }
      fails = 0;
    } catch (e){
      fails++;
      if (/login|session|401|403/i.test(e.message || '')) dropLogin();
      if (fails <= 3 || fails % 10 === 0) log(`notes poll error (${fails}): ${e.message}`);
      if (fails > 3) await sleep(Math.min(30000, fails * 1000));
    }
    // INSTRUMENTATION: same idea as statusLoop — a converged notes cycle is one page fetch + a couple of
    // small DB reads. If it's routinely many seconds, the box is contended (or the 15min full sweep is
    // running). This is what stretches the effective note-detection interval well past NOTES_POLL and
    // makes note add/delete feel slow even when the poll interval is short.
    const _dt = Date.now() - t0;
    if (_dt > 6000) log(`notes cycle SLOW: ${_dt}ms — RaceFacer contended or full-sweep running`);
    const interval = haveSignal ? NOTES_POLL : NOTES_POLL_ROTATE;
    await sleep(Math.max(0, interval - (Date.now() - t0)));
  }
}

// ---- HEAVY sync loop (spawn racefacer-sync.js; own process + login is fine at this cadence) ----
const SCRIPT     = path.join(__dirname, 'racefacer-sync.js');
// HEAVY_GAP is the pause AFTER a heavy child exits before the next spawns. Each heavy run pins the small
// self-hosted RaceFacer box for ~60-120s (230 karts × 150ms sleep + a 39-page repairs fetch), so at the
// old 120s gap a heavy sync was active roughly HALF the time — starving the in-process status/notes loops
// that share that same box and making status latency swing from ~2s (quiet) to 8-13s (heavy running).
// Repairs/parts/prune/reconcile (all the heavy child does that the fast loops don't) are NOT
// latency-sensitive, so running them every ~5min instead of ~2min barely affects freshness while roughly
// halving the window in which status/notes are contended. Override with HEAVY_GAP_SEC if needed.
const HEAVY_GAP  = Math.max(60,  parseInt(process.env.HEAVY_GAP_SEC     || '600', 10)) * 1000;
const TIMEOUT_MS = Math.max(120, parseInt(process.env.CYCLE_TIMEOUT_SEC || '600', 10)) * 1000;
const SITE       = (process.env.SITE || 'sydney').trim().toLowerCase();

let stopping = false;
function ts(){ return new Date().toISOString().replace('T', ' ').replace(/\..+/, ''); }
function log(m){ console.log(`[worker ${ts()}] ${m}`); }

// One self-rescheduling loop: spawn racefacer-sync.js with extra env, kill a stuck
// cycle, then wait `gapMs` AFTER it ends before the next (fixed delay => no overlap).
function loop(tag, gapMs, extraEnv){
  let n = 0, fails = 0, timer = null;
  function run(){
    if (stopping) return;
    const id = ++n, t0 = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
    const killer = setTimeout(() => { log(`${tag} #${id} exceeded ${TIMEOUT_MS / 1000}s — killing`); child.kill('SIGKILL'); }, TIMEOUT_MS);
    function done(code, sig, err){
      clearTimeout(killer);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (err)             { fails++; log(`${tag} #${id} spawn error: ${err.message} — fails ${fails}`); }
      else if (code === 0) { /* quiet on success; the child logs its own summary */ }
      else                 { fails++; log(`${tag} #${id} FAILED code ${code}${sig ? ' ' + sig : ''} (${secs}s) — fails ${fails}`); }
      if (!stopping) timer = setTimeout(run, gapMs);
    }
    child.once('exit',  (code, sig) => done(code, sig, null));
    child.once('error', (e)         => done(null, null, e));
  }
  return { start(delay){ timer = setTimeout(run, delay || 0); }, stop(){ clearTimeout(timer); } };
}

log(`combined worker up · site=${SITE} · pusher live · status ~${STATUS_POLL / 1000}s · notes ~${NOTES_POLL / 1000}s (flagged) / ~${NOTES_POLL_ROTATE / 1000}s (rotating) · full-sync ~${HEAVY_GAP / 1000}s · build=kni-fix-2026-07-18j`);

// SESSIONS: poll RaceFacer session-management on the SAME shared login, so the app + HK AI
// know which karts are in which session (and their time windows). Write-on-change; prunes to 7 days.
async function sessionsPoller(){
  const sessions = require('./rf_sessions');
  // Sessions run ~10 min and a session's kart roster is fixed once it starts, so 20s polling was
  // overkill and piled onto the RaceFacer contention. 60s still catches a session starting well within
  // its run and keeps the live roster/laps fresh enough. Tune with RF_SESS_POLL_SEC.
  const SESS_POLL = Math.max(10, parseInt(process.env.RF_SESS_POLL_SEC || '60', 10)) * 1000;
  let fails = 0;
  await sleep(6000);                                // let the status poller establish the session first
  while (!stopping){
    const t0 = Date.now();
    try {
      await ensureLogin();
      await sessions.syncSessions(sync.rfJson);
      fails = 0;
    } catch (e){
      fails++;
      if (/login|session|401|403/i.test(e.message || '')) dropLogin();
      if (fails <= 3 || fails % 10 === 0) log(`sessions poll error (${fails}): ${e.message}`);
      if (fails > 3) await sleep(Math.min(30000, fails * 1000));
    }
    await sleep(Math.max(0, SESS_POLL - (Date.now() - t0)));
  }
}

// Status + notes: independent in-process loops sharing ONE RaceFacer session. Status polls tight (~3s)
// so a status flip reaches the app fast regardless of what notes are doing; notes run on their own cadence.
statusLoop().catch((e) => log(`status poller crashed: ${e.message}`));
notesLoop().catch((e) => log(`notes poller crashed: ${e.message}`));
sessionsPoller().catch((e) => log(`sessions poller crashed: ${e.message}`));

// Heavy: full reconcile (repairs, parts, prune, reconcile) in its own spawned process.
// HEAVY_SKIP_KART_NOTES: the heavy child's per-kart loop used to fetch kart-notes for all ~230 karts
// every run (a third fetch per kart, on top of details + parts) — but the in-process notesLoop and its
// full sweep already own notes, so that was ~230 redundant RaceFacer requests per heavy run, needlessly
// lengthening the window in which the shared box is pinned and status is starved. Skip it in the heavy
// child; notes stay owned by notesLoop (+ its periodic sweepNotesAll backstop).
const heavyLoop = loop('heavy', HEAVY_GAP, { STATUS_ONLY: '', NOTES_ONLY: '', HEAVY_INTERVAL_SEC: '60', HEAVY_SKIP_KART_NOTES: '1' });
heavyLoop.start(9000);   // stagger so the first RaceFacer logins don't collide

function shutdown(sig){
  if (stopping) return;
  stopping = true;
  log(`${sig} received — stopping sync loops`);
  heavyLoop.stop();
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('[worker] unhandledRejection', e && e.message ? e.message : e));
