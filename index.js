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

// ---- PERSISTENT STATUS POLLER (in-process, no re-spawn/re-login) -----------
// Status changes must feel instant. Spawning a fresh racefacer-sync.js each cycle re-logs into
// RaceFacer (~1-2s handshake) EVERY time, which caps how fast we can go. So status runs here,
// in-process: log in ONCE, then hit the ~5 garage list pages on a tight loop and write only the
// karts whose status flipped. ~5 requests/cycle is well within what RaceFacer tolerates.
const sync = require('./racefacer-sync');
const STATUS_POLL = Math.max(2, parseInt(process.env.STATUS_POLL_SEC   || '2', 10)) * 1000;
const NOTES_CONC  = Math.max(2, Math.min(12, parseInt(process.env.NOTES_CONCURRENCY || '8', 10)));
const NOTES_PAUSE = Math.max(1, parseInt(process.env.NOTES_GAP_SEC     || '2', 10)) * 1000;

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

// NOTES: parallel full-fleet sweep (~6-8s for 211 karts at concurrency 8) on the SAME session —
// no per-cycle login. A note added/edited/deleted in RaceFacer lands in the app within one
// sweep + pause, i.e. well under 10s. syncKartNotes writes only on change, so realtime cost of a
// quiet sweep is zero.
async function notesSweeper(){
  let fails = 0, sweeps = 0;
  await sleep(4000);                              // let the status poller establish the session first
  while (!stopping){
    const t0 = Date.now();
    try {
      await ensureLogin();
      await sync.sweepNotesAll({ concurrency: NOTES_CONC });
      fails = 0; sweeps++;
      const secs = (Date.now() - t0) / 1000;
      if (sweeps % 50 === 1 || secs > 12) log(`notes sweep #${sweeps}: ${secs.toFixed(1)}s (concurrency ${NOTES_CONC})`);
    } catch (e){
      fails++;
      if (/login|session|401|403/i.test(e.message || '')) dropLogin();
      log(`notes sweep error (${fails}): ${e.message}`);
      await sleep(Math.min(30000, 2000 * fails)); // RaceFacer struggling -> ease off, then resume
    }
    await sleep(NOTES_PAUSE);
  }
}

// ---- HEAVY sync loop (spawn racefacer-sync.js; own process + login is fine at this cadence) ----
const SCRIPT     = path.join(__dirname, 'racefacer-sync.js');
const HEAVY_GAP  = Math.max(60,  parseInt(process.env.HEAVY_GAP_SEC     || '120', 10)) * 1000;
const TIMEOUT_MS = Math.max(120, parseInt(process.env.CYCLE_TIMEOUT_SEC || '600', 10)) * 1000;
const SITE       = process.env.SITE || 'sydney';

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

// Status + notes: persistent in-process loops sharing ONE RaceFacer session.
statusPoller().catch((e) => log(`status poller crashed: ${e.message}`));
notesSweeper().catch((e) => log(`notes sweeper crashed: ${e.message}`));

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
