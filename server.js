const http  = require('http');
const https = require('https');

const PORT    = 3000;
const API_KEY = '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'; // paste your Groq key here

http.createServer((req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST' || req.url !== '/api/ai') {
    res.writeHead(404); res.end('Not found'); return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {

    const payload = Buffer.from(body);

    const options = {
      hostname: 'api.groq.com',
      path:     '/openai/v1/chat/completions',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${API_KEY}`,
        'Content-Length': payload.length,
      },
    };

    const proxyReq = https.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      res.writeHead(502); res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.write(payload);
    proxyReq.end();
  });

}).listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));