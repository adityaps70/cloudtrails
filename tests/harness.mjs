// Local stand-ins for Cloudflare D1, KV and the static-assets binding, so the Worker can be tested with plain Node
// (node:sqlite, Node 22+). `node tests/harness.mjs` starts a dev server on http://localhost:8787.

import { DatabaseSync } from 'node:sqlite';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a))); }
  _p() { return this.db.prepare(this.sql); }
  async first(col) { const r = this._p().get(...this.args); if (!r) return null; const o = { ...r }; return col ? o[col] : o; }
  async all() { return { results: this._p().all(...this.args).map((r) => ({ ...r })), success: true }; }
  async run() {
    const info = this._p().run(...this.args);
    return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: info.changes } };
  }
}

export class D1Shim {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(/^\s*(select)/i.test(s.sql) ? await s.all() : await s.run()); return out; }
  async exec(sql) { this.db.exec(sql); }
}

export class KVShim {
  constructor() { this.map = new Map(); }
  async put(k, v, opts) { this.map.set(k, { v: v instanceof ArrayBuffer ? new Uint8Array(v) : v, meta: opts?.metadata }); }
  async get(k, type) {
    const e = this.map.get(k);
    if (!e) return null;
    if (type === 'arrayBuffer') { const u = e.v instanceof Uint8Array ? e.v : new TextEncoder().encode(String(e.v)); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); }
    return e.v;
  }
  async delete(k) { this.map.delete(k); }
}

let ignoreText = '';
try { ignoreText = readFileSync(path.join(ROOT, '.assetsignore'), 'utf8'); } catch {}
const ignored = ignoreText.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

export const AssetsShim = {
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const rel = p.replace(/^\/+/, '');
    const top = rel.split('/')[0];
    if (ignored.some((g) => g === top || g === rel || (g.endsWith('*') && top.startsWith(g.slice(0, -1))))) return new Response('Not found', { status: 404 });
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) return new Response('Not found', { status: 404 });
    try {
      const s = await stat(file);
      if (s.isDirectory()) return Response.redirect(url.origin + p + '/', 307);
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
    } catch {
      // Like Cloudflare's html_handling, try "<path>.html"
      try { return new Response(await readFile(file + '.html'), { headers: { 'content-type': TYPES['.html'] } }); } catch {}
      return new Response('Not found', { status: 404 });
    }
  },
};

export function makeEnv(extra = {}) {
  return { DB: new D1Shim(), DOCS: new KVShim(), ASSETS: AssetsShim, ADMIN_PASSWORD: 'test-password-123', ALLOWED_ORIGINS: 'https://cloudtrails.in', ALLOW_LOCALHOST: '1', ...extra };
}

export const ctx = { waitUntil() {}, passThroughOnException() {} };

// Dev server
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const worker = (await import('../worker/index.js')).default;
  const env = makeEnv({ ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'test-password-123' });
  const port = Number(process.env.PORT || 8787);
  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' });
    try {
      const r = await worker.fetch(request, env, ctx);
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const setCookie = r.headers.getSetCookie?.();
      if (setCookie?.length) headers['set-cookie'] = setCookie;
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error(e); res.writeHead(500); res.end('error');
    }
  }).listen(port, () => console.log(`Cloud Trails dev server on http://localhost:${port}`));
}
