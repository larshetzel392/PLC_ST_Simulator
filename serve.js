#!/usr/bin/env node
// Lokaler Server für den ST Prüfstand:  node serve.js [port]
//   /                 Oberfläche (wird bei Änderungen an src/ oder web/ neu gebaut)
//   /api/files        .st/.sttest-Dateien im Projektordner
//   /api/file/<name>  Datei lesen (GET) oder speichern (PUT)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const DIST = path.join(ROOT, 'dist', 'ST-Pruefstand.html');
const WATCH = ['src', 'web', 'build.js'];

function newestMtime() {
  let t = 0;
  for (const w of WATCH) {
    const p = path.join(ROOT, w);
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) t = Math.max(t, fs.statSync(path.join(p, f)).mtimeMs);
    else t = Math.max(t, st.mtimeMs);
  }
  return t;
}
function ensureBuilt() {
  const built = fs.existsSync(DIST) ? fs.statSync(DIST).mtimeMs : 0;
  if (newestMtime() > built) {
    execFileSync(process.execPath, [path.join(ROOT, 'build.js')], { stdio: 'inherit' });
  }
}

// Nur .st/.sttest im Projektordner und in examples/, keine Pfade nach außen
function listFiles() {
  const out = [];
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (/\.(st|sttest)$/i.test(e.name)) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(ROOT, 0);
  return out.sort();
}
function safePath(name) {
  if (!/\.(st|sttest)$/i.test(name)) return null;
  const p = path.resolve(ROOT, name);
  if (!p.startsWith(ROOT + path.sep)) return null;
  return p;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      ensureBuilt();
      return send(200, fs.readFileSync(DIST), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/files' && req.method === 'GET') return send(200, JSON.stringify(listFiles()), 'application/json');
    if (url.pathname.startsWith('/api/file/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/file/'.length));
      const p = safePath(name);
      if (!p) return send(400, 'Nur .st- und .sttest-Dateien im Projektordner');
      if (req.method === 'GET') {
        if (!fs.existsSync(p)) return send(404, 'Datei nicht gefunden');
        return send(200, fs.readFileSync(p, 'utf8'));
      }
      if (req.method === 'PUT') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
        req.on('end', () => {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, body, 'utf8');
          console.log(`gespeichert: ${name}`);
          send(200, 'ok');
        });
        return;
      }
    }
    send(404, 'Nicht gefunden');
  } catch (e) {
    console.error(e);
    send(500, String(e.message || e));
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} ist belegt – anderen Port angeben: node serve.js 8081`); process.exit(1); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  ensureBuilt();
  console.log(`ST Prüfstand läuft auf http://localhost:${PORT}`);
});
