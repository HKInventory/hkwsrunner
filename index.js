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
startRepairPusher(/* scrapeKartRepairs */);   // optional: pass a per-kart re-scrape fn if you have one

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
const STATUS_POLL = Math.max(2, parseInt(process.env.STATUS_POLL_SEC   || '8', 10)) * 1000;
const NOTES_CONC  = Math.max(2, Math.min(12, parseInt(process.env.NOTES_CONCURRENCY || '8', 10)));
// FAST notes pass cadence: fetch detail pages ONLY for karts with note activity this cycle (see
// notesSweeper). Cheap, so it can run often — a new/cleared note lands in ~one cycle.
const NOTES_FAST  = Math.max(5, parseInt(process.env.NOTES_FAST_SEC || '12', 10)) * 1000;
// Safety-net FULL sweep every ~15min catches the rare change the targeted pass can't see. Expressed
// as "every N fast ticks" so it scales with NOTES_FAST. Env override in seconds.
const FULL_SWEEP_EVERY = Math.max(5, Math.round(Math.max(60, parseInt(process.env.NOTES_FULL_SWEEP_SEC || '900', 10)) * 1000 / NOTES_FAST));

// ONE login shared by the status poller and the notes sweeper (same module = same cookie jar).
// The promise-guard stops both loops logging in at the same moment; an auth error resets it so
// the next call re-authenticates.
let _loginP = null;
function ensureLogin(){ if (!_loginP) _loginP = sync.login().then(() => { log('RaceFacer session up'); }); return _loginP.catch((e) => { _loginP = null; throw e; }); }
function dropLogin(){ _loginP = null; }
function sleep(ms){ return new Promise((r) => setTimeout(r, ms)); }

// STATUS: ~5 list pages per poll, whole fleet, every STATUS_POLL. Write-on-change.
async function statusPoller(){
  let fails = 0;
  while (!stopping){
    const t0 = Date.now();
    try {
      await ensureLogin();
      const changed = await sync.statusFast();
      if (typeof sync.refreshLiveTracks === 'function') { try { await sync.refreshLiveTracks(); } catch (e) {} }
      fails = 0;
      if (changed) log(`status: ${changed} kart(s) changed`);
    } catch (e){
      fails++;
      if (/login|session|401|403/i.test(e.message || '')) dropLogin();
      if (fails <= 3 || fails % 10 === 0) log(`status poll error (${fails}): ${e.message}`);
      if (fails > 3) await sleep(Math.min(30000, fails * 1000));   // back off if RaceFacer is unhappy
    }
    const spent = Date.now() - t0;
    await sleep(Math.max(0, STATUS_POLL - spent));
  }
}

// NOTES (fast + targeted): on every tick, notesFast() fetches detail pages ONLY for karts with note
// activity this cycle — every kart the DB thinks has an open note (so an EDIT or the LAST note being
// cleared syncs at once, and a note cleared in RaceFacer is pruned) PLUS any kart the garage LIST page
// (parsed for free by the status poller) newly flags as having a note. When the list exposes note-flags
// a quiet fleet costs ~zero requests and a new note lands in ~one tick (~12s); when it doesn't, notesFast
// rotates a small batch so brand-new notes are still caught. A FULL parallel sweep every ~15min is a
// cheap safety net for the rare change neither path sees. syncKartNotes writes only on change, so a
// quiet cycle costs zero realtime messages.
async function notesSweeper(){
  let fails = 0, ticks = 0;
  await sleep(4000);                              // let the status poller establish the session + first flags
  while (!stopping){
    const t0 = Date.now();
    try {
      await ensureLogin();
      const flags = sync.statusFast && sync.statusFast._noteFlags;   // note-flags from the latest status pass (free)
      const touched = await sync.notesFast(flags);
      if ((++ticks % FULL_SWEEP_EVERY) === 0) {
        try { await sync.sweepNotesAll({ concurrency: NOTES_CONC }); }
        catch (e) { log(`notes full-sweep skipped: ${e.message}`); if (/login|session|401|403/i.test(e.message || '')) dropLogin(); }
      }
      fails = 0;
      if (touched && (ticks % 25 === 1)) log(`notes fast: ${touched} kart(s) checked${sync.statusFast && sync.statusFast._sawFlags ? ' (list-flagged)' : ' (rotating)'}`);
    } catch (e){
      fails++;
      if (/login|session|401|403/i.test(e.message || '')) dropLogin();
      log(`notes fast error (${fails}): ${e.message}`);
      await sleep(Math.min(30000, 2000 * fails)); // RaceFacer struggling -> ease off, then resume
    }
    const spent = Date.now() - t0;
    await sleep(Math.max(0, NOTES_FAST - spent));
  }
}

// ---- HEAVY sync loop (spawn racefacer-sync.js; own process + login is fine at this cadence) ----
const SCRIPT     = path.join(__dirname, 'racefacer-sync.js');
const HEAVY_GAP  = Math.max(60,  parseInt(process.env.HEAVY_GAP_SEC     || '120', 10)) * 1000;
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

log(`combined worker up · site=${SITE} · pusher live · status ~${STATUS_POLL / 1000}s · notes sweep concurrency ${NOTES_CONC} · full-sync ~${HEAVY_GAP / 1000}s`);

// SESSIONS: poll RaceFacer session-management on the SAME shared login, so the app + HK AI
// know which karts are in which session (and their time windows). Write-on-change; prunes to 7 days.
async function sessionsPoller(){
  const sessions = require('./rf_sessions');
  const SESS_POLL = Math.max(10, parseInt(process.env.RF_SESS_POLL_SEC || '20', 10)) * 1000;
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

// Status + notes: persistent in-process loops sharing ONE RaceFacer session.
statusPoller().catch((e) => log(`status poller crashed: ${e.message}`));
notesSweeper().catch((e) => log(`notes sweeper crashed: ${e.message}`));
sessionsPoller().catch((e) => log(`sessions poller crashed: ${e.message}`));

// Heavy: full reconcile (repairs, parts, prune, reconcile) in its own spawned process.
const heavyLoop = loop('heavy', HEAVY_GAP, { STATUS_ONLY: '', NOTES_ONLY: '', HEAVY_INTERVAL_SEC: '60' });
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
