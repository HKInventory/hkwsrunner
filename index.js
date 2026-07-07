/* HK Workshop runner — entry point.
   Works as a Render Background Worker OR a Web Service (free).
   - Always: drains the repair/note queues into RaceFacer every 45s.
   - If PORT is set (Web Service): also serves a tiny health page so an uptime
     pinger can keep the free instance awake. */
const { startRepairPusher } = require('./rf_push_repairs');

// If you already have a "re-scrape one kart" function in another module, pass it
// here so repairs land in rf_repairs with their real RaceFacer id immediately.
// Otherwise leave it out — the app shows the repair right away and your existing
// sync will pick up the real row on its next pass.
startRepairPusher(/* scrapeKartRepairs */);

if (process.env.PORT) {
  require('http')
    .createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hk-workshop runner ok\n'); })
    .listen(process.env.PORT, () => console.log('[runner] health endpoint on :' + process.env.PORT));
}

// keep the process alive even with no HTTP server (Background Worker mode)
setInterval(() => {}, 1 << 30);
process.on('unhandledRejection', (e) => console.error('[runner] unhandledRejection', e && e.message ? e.message : e));
