/* HK Workshop runner — entry point.

   IMPORTANT: RaceFacer (103.166.146.163) uses a self-signed TLS certificate, and
   Node's global fetch (undici) ignores the https.Agent option — so without the line
   below, every RaceFacer request throws "fetch failed". This runner only talks to
   Supabase (valid cert) and RaceFacer, so disabling strict TLS process-wide is safe.
   (Node will print a one-line "insecure TLS" warning on boot — that's expected.) */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { startRepairPusher, dumpDamagePage } = require('./rf_push_repairs');

// Optional: pass your "re-scrape one kart" function to land repairs in rf_repairs
// with their real RaceFacer id immediately. Leave empty otherwise.
startRepairPusher(/* scrapeKartRepairs */);

/* ---------------------------------------------------------------------------
   HTTP: health check + a token-guarded debug dump.

     /                       -> "hk-workshop runner ok"
     /debug/parts?token=...  -> what the parts parser actually extracted (JSON)
     /debug/damage?token=... -> the RAW HTML of RaceFacer's Add-damage page

   These routes exist to settle the empty-warehouse problem. The parts <select> has
   never parsed reliably and guessing at its markup burns rounds; open the route once,
   send the HTML, and the parser can be made exact.

   Set DEBUG_TOKEN in Render -> Environment. Without it the routes 404, because the
   dump is an authenticated RaceFacer page.  Optional &kart=26 picks the kart.
--------------------------------------------------------------------------- */
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || '';

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
}

if (process.env.PORT) {
  require('http')
    .createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return notFound(res); }
      const path = url.pathname;

      if (path === '/' || path === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('hk-workshop runner ok\n');
      }

      if (path === '/debug/damage' || path === '/debug/parts') {
        // No token configured => the route simply does not exist.
        if (!DEBUG_TOKEN || url.searchParams.get('token') !== DEBUG_TOKEN) return notFound(res);
        const kart = url.searchParams.get('kart') || 26;
        try {
          const out = await dumpDamagePage(kart);
          if (path === '/debug/parts') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              kart,
              kart_type_id: out.kart_type_id,
              users_found: out.users,
              parts_found: out.parsedParts.length,
              parts: out.parsedParts
            }, null, 2));
          }
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(out.html);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('debug failed: ' + (e && e.message ? e.message : e) + '\n');
        }
      }

      return notFound(res);
    })
    .listen(process.env.PORT, () => {
      console.log('[runner] health endpoint on :' + process.env.PORT);
      console.log('[runner] debug routes ' + (DEBUG_TOKEN ? 'ENABLED (DEBUG_TOKEN set)' : 'disabled — set DEBUG_TOKEN to enable'));
    });
}

setInterval(() => {}, 1 << 30); // keep the process alive (Background Worker mode)
process.on('unhandledRejection', (e) => console.error('[runner] unhandledRejection', e && e.message ? e.message : e));
