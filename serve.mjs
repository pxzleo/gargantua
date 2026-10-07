#!/usr/bin/env node
// Zero-dependency static server:  node serve.mjs [port] [host]   (default 8086, 0.0.0.0 = reachable on the LAN)
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
let port = Number(process.argv[2] || process.env.PORT || 8086);
const host = process.argv[3] || process.env.HOST || '0.0.0.0';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); return; }
    const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) { // audio seeking
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = Number(s) || 0, end = e ? Number(e) : st.size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
});

// If the port is taken (EADDRINUSE), try the next ones automatically.
let tries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && tries < 20) {
    console.log(`端口 ${port} 已被占用，尝试 ${port + 1} …`);
    port += 1; tries += 1;
    setTimeout(() => server.listen(port, host), 50);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});
server.on('listening', () => {
  console.log(`GARGANTUA → http://localhost:${port}/`);
  if (host === '0.0.0.0' || host === '::') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  LAN    → http://${a.address}:${port}/`);
      }
    }
  }
});
server.listen(port, host);
