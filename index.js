/* HK Workshop runner — entry point.

   IMPORTANT: RaceFacer (103.166.146.163) uses a self-signed TLS certificate, and
   Node's global fetch (undici) ignores the https.Agent option — so without the line
   below, every RaceFacer request throws "fetch failed". This runner only talks to
   Supabase (valid cert) and RaceFacer, so disabling strict TLS process-wide is safe.
   (Node will print a one-line "insecure TLS" warning on boot — that's expected.) */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { startRepairPusher } = require('./rf_push_repairs');

// Optional: pass your "re-scrape one kart" function to land repairs in rf_repairs
// with their real RaceFacer id immediately. Leave empty otherwise.
startRepairPusher(/* scrapeKartRepairs */);

if (process.env.PORT) {
  require('http')
    .createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hk-workshop runner ok\n'); })
    .listen(process.env.PORT, () => console.log('[runner] health endpoint on :' + process.env.PORT));
}

setInterval(() => {}, 1 << 30); // keep the process alive (Background Worker mode)
process.on('unhandledRejection', (e) => console.error('[runner] unhandledRejection', e && e.message ? e.message : e));
