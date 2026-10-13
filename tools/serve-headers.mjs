// Serves dist/ with the headers from vercel.json, to check the security policy locally: node tools/serve-headers.mjs [port]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
const conf = JSON.parse(readFileSync('vercel.json', 'utf8'));
const headers = Object.fromEntries(conf.headers[0].headers.map(h => [h.key, h.value]));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
createServer((req, res) => {
  const path = req.url.split(/[?#]/)[0];
  const file = resolve(conf.outputDirectory, '.' + (path.endsWith('/') ? path + 'index.html' : path));
  try { const body = readFileSync(file); res.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404, headers); res.end('not found'); }
}).listen(+(process.argv[2] || 8766), '127.0.0.1');
