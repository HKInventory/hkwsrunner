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

// ---- 2 + 3. the RaceFacer -> app sync loops (spawn racefacer-sync.js) ------
const SCRIPT     = path.join(__dirname, 'racefacer-sync.js');
const STATUS_GAP = Math.max(5,   parseInt(process.env.STATUS_GAP_SEC    || '5',   10)) * 1000;
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

log(`combined worker up · site=${SITE} · pusher live · status ~${STATUS_GAP / 1000}s · full-sync gap ~${HEAVY_GAP / 1000}s`);

const statusLoop = loop('status', STATUS_GAP, { STATUS_ONLY: '1' });
// Force each heavy child to run the full pass: HEAVY_INTERVAL_SEC is clamped to 60s inside
// racefacer-sync.js and is always < time-since-last-heavy, so the gate opens every cycle.
const heavyLoop  = loop('heavy',  HEAVY_GAP,  { STATUS_ONLY: '', HEAVY_INTERVAL_SEC: '60' });

statusLoop.start(2000);   // let the pusher's realtime socket connect first
heavyLoop.start(6000);    // stagger so the first RaceFacer logins don't collide

function shutdown(sig){
  if (stopping) return;
  stopping = true;
  log(`${sig} received — stopping sync loops`);
  statusLoop.stop(); heavyLoop.stop();
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('[worker] unhandledRejection', e && e.message ? e.message : e));
