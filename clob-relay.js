/**
 * clob-relay.js — Polymarket CLOB order relay
 *
 * Runs on your LOCAL machine (where VPN is active, not geo-blocked).
 * Render backend sends pre-signed order payloads + headers here.
 * This relay forwards them verbatim to clob.polymarket.com/order.
 *
 * Usage:
 *   node clob-relay.js [port]          (default port: 7823)
 *
 * Then set CLOB Proxy URL in bot settings to:
 *   http://<your-ngrok-url>            (if using ngrok to expose it)
 *   http://localhost:7823              (if Render can reach your machine directly)
 *
 * Expose with ngrok:
 *   npx ngrok http 7823
 *   → copy the https://xxxx.ngrok-free.app URL into CLOB Proxy URL setting
 */

const http = require('http');
const https = require('https');

const PORT = parseInt(process.argv[2] || process.env.PORT || '7823', 10);
const CLOB_HOST = 'clob.polymarket.com';

const server = http.createServer((req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, relay: 'clob-relay', target: CLOB_HOST }));
    return;
  }

  // Only relay POST /order (and optionally /orders)
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    // Forward headers verbatim — includes CLOB L2 HMAC auth headers
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders['host'];           // replace with target host
    delete forwardHeaders['bypass-tunnel-reminder']; // strip localtunnel header
    forwardHeaders['host'] = CLOB_HOST;
    forwardHeaders['content-length'] = Buffer.byteLength(body).toString();

    // Build target URL: relay path + query string
    const targetPath = req.url; // e.g. /order?geo_block_token=...

    const options = {
      hostname: CLOB_HOST,
      port: 443,
      path: targetPath,
      method: 'POST',
      headers: forwardHeaders,
    };

    console.log(`[relay] → POST https://${CLOB_HOST}${targetPath} (${body.length} bytes)`);

    const proxyReq = https.request(options, (proxyRes) => {
      let responseBody = '';
      proxyRes.on('data', chunk => { responseBody += chunk; });
      proxyRes.on('end', () => {
        console.log(`[relay] ← ${proxyRes.statusCode} ${responseBody.slice(0, 120)}`);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(responseBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[relay] Error forwarding to CLOB:`, err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'relay_error', message: err.message }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`[clob-relay] Listening on port ${PORT}`);
  console.log(`[clob-relay] Forwarding POSTs to https://${CLOB_HOST}`);
  console.log(`[clob-relay] Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Run: npx localtunnel --port ' + PORT + ' --subdomain polybot-relay');
  console.log('  2. URL will be: https://polybot-relay.loca.lt');
  console.log('  3. Paste into Settings → Advanced → CLOB Proxy URL');
  console.log('  4. Save settings and restart the bot');
});
