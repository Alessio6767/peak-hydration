const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./lib/api');

const ROOT = __dirname;
const PORT = process.env.PORT || 4137;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const MAX_BODY = 100 * 1024;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const query = Object.fromEntries(url.searchParams);
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > MAX_BODY) { res.writeHead(413); res.end('Payload too large'); req.destroy(); }
      });
      req.on('end', () => {
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* handled by validation */ }
        api.handle(req, res, pathname, query, body);
      });
    } else {
      api.handle(req, res, pathname, query, null);
    }
    return;
  }

  let p = pathname;
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  // Never serve the datastore or server code.
  if (!file.startsWith(ROOT) || p.startsWith('/data') || p.startsWith('/lib') || p === '/server.js') {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('serving on ' + PORT));
