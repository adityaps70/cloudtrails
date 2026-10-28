// Cloud Trails Worker: serves the website, the public booking API (/api/*) and the admin panel (/admin).

import { ensureSchema, getSettings, nowISO, logEvent } from './db.js';
import { getConfig, availability, createBooking, bookingStatus, customerUpload, publicQr } from './public.js';
import { handleAdmin } from './admin.js';
import { purgeBookingDocs } from './storage.js';
import { json, HttpError } from './util.js';

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const self = new URL(request.url).origin;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin === self || list.includes(origin)) return origin;
  if (env.ALLOW_LOCALHOST === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function withCors(response, origin) {
  if (!origin) return response;
  const r = new Response(response.body, response);
  r.headers.set('access-control-allow-origin', origin);
  r.headers.set('vary', 'origin');
  return r;
}

function errorResponse(e) {
  if (e instanceof HttpError) return json({ ok: false, error: e.message, ...(e.extra || {}) }, e.status);
  console.error(e && e.stack || e);
  return json({ ok: false, error: 'Something went wrong on our side. Please try again, or call us on +91 82579 29949.' }, 500);
}

const ADMIN_HEADERS = {
  'x-robots-tag': 'noindex, nofollow',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: origin ? {
          'access-control-allow-origin': origin,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
          vary: 'origin',
        } : {},
      });
    }
    // Writes are only accepted from our own pages.
    if (request.method === 'POST' && request.headers.get('origin') && !origin) return json({ ok: false, error: 'Origin not allowed.' }, 403);
    let res;
    try {
      await ensureSchema(env);
      res = await publicRoute(request, env, ctx, url);
    } catch (e) { res = errorResponse(e); }
    return withCors(res, origin);
  }

  if (p.startsWith('/admin/api/')) {
    try {
      await ensureSchema(env);
      return await handleAdmin(request, env, url);
    } catch (e) { return errorResponse(e); }
  }

  if (p === '/admin') return Response.redirect(url.origin + '/admin/', 301);
  if (p.startsWith('/admin/')) {
    const res = await env.ASSETS.fetch(request);
    const r = new Response(res.body, res);
    for (const [k, v] of Object.entries(ADMIN_HEADERS)) r.headers.set(k, v);
    return r;
  }

  // Never serve project files that aren't part of the website (backup for .assetsignore).
  if (/^\/(worker|tests|migrations|node_modules|\.git|\.github|\.wrangler)(\/|$)|^\/(wrangler\.jsonc|package(-lock)?\.json|README\.md|_config\.yml|\.assetsignore|\.gitignore|\.dev\.vars.*)$/.test(p)) {
    return new Response('Not found', { status: 404 });
  }
  return env.ASSETS.fetch(request);
}

async function publicRoute(request, env, ctx, url) {
  const p = url.pathname, m = request.method;
  if (p === '/api/health') return json({ ok: true, time: nowISO() });
  if (p === '/api/config' && m === 'GET') return getConfig(env);
  if (p === '/api/availability' && m === 'GET') return availability(env, url);
  if (p === '/api/qr' && m === 'GET') return publicQr(env, request);
  if (p === '/api/bookings' && m === 'POST') return createBooking(request, env, ctx);
  let mm;
  if ((mm = p.match(/^\/api\/bookings\/(CT-[A-Z0-9]{6})$/)) && m === 'GET') return bookingStatus(env, mm[1], url.searchParams.get('t'));
  if ((mm = p.match(/^\/api\/bookings\/(CT-[A-Z0-9]{6})\/files$/)) && m === 'POST') return customerUpload(request, env, mm[1], url.searchParams.get('t'));
  throw new HttpError(404, 'Not found.');
}

/** Daily clean-up: delete documents of finished bookings after the retention period. */
export async function purgeOldDocuments(env) {
  await ensureSchema(env);
  const s = await getSettings(env);
  const days = Math.max(1, Number(s.doc_retention_days) || 30);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM bookings WHERE docs_purged_at IS NULL AND status IN ('completed','cancelled','rejected') AND updated_at < ? LIMIT 50`).bind(cutoff).all();
  let n = 0;
  for (const r of results || []) {
    const c = await purgeBookingDocs(env, r.id);
    await logEvent(env, r.id, 'system', 'docs_purged', `${c} file(s) deleted after ${days} days`);
    n++;
  }
  return n;
}

export default {
  fetch(request, env, ctx) {
    return route(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(purgeOldDocuments(env));
  },
};
