// Admin sign-in: one password (Worker secret ADMIN_PASSWORD), a signed session cookie, and login throttling.

import { HttpError, b64url, fromB64url, timingSafeEqual, clientIp } from './util.js';

const COOKIE = 'ct_admin';
const SESSION_HOURS = 12;
const MAX_FAILS = 8;          // per IP
const FAIL_WINDOW_MS = 15 * 60 * 1000;

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || ('ct-session::' + (env.ADMIN_PASSWORD || ''));
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env, payload) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(body));
  return body + '.' + b64url(new Uint8Array(sig));
}

/** Short-lived signed token for a customer who found their booking by phone + date of birth. */
export async function signBookingAccess(env, ref, hours = 24) {
  return sign(env, { k: 'bk', ref, exp: Date.now() + hours * 3600 * 1000 });
}

export async function verifyBookingAccess(env, ref, token) {
  const p = await verify(env, token);
  return !!p && p.k === 'bk' && p.ref === ref;
}

async function verify(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), new TextEncoder().encode(body));
  } catch { return null; }
  if (!ok) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function readCookie(request, name) {
  const h = request.headers.get('cookie') || '';
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return '';
}

function cookieHeader(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function adminConfigured(env) {
  return Boolean(env.ADMIN_PASSWORD && String(env.ADMIN_PASSWORD).length >= 8);
}

export async function requireAdmin(request, env) {
  if (!adminConfigured(env)) throw new HttpError(503, 'Admin is not set up yet: add the ADMIN_PASSWORD secret in Cloudflare.');
  const session = await verify(env, readCookie(request, COOKIE));
  if (!session) throw new HttpError(401, 'Please sign in.');
  // Changes must come from the admin page itself (CSRF guard on top of SameSite=Strict).
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Bad origin.');
    if (request.headers.get('x-ct-admin') !== '1') throw new HttpError(403, 'Missing admin header.');
  }
  return session;
}

export async function login(request, env) {
  if (!adminConfigured(env)) throw new HttpError(503, 'Admin is not set up yet: add the ADMIN_PASSWORD secret (8+ characters) in Cloudflare.');
  const ip = clientIp(request);
  const since = Date.now() - FAIL_WINDOW_MS;
  await env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(since).run();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at >= ?').bind(ip, since).first();
  if ((row?.n || 0) >= MAX_FAILS) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');

  let password = '';
  try { password = String((await request.json()).password || ''); } catch {}
  if (!password || !timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    await env.DB.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(ip, Date.now()).run();
    throw new HttpError(401, 'Wrong password.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const token = await sign(env, { sub: 'admin', exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  return cookieHeader(request, token, SESSION_HOURS * 3600);
}

export function logoutCookie(request) {
  return cookieHeader(request, '', 0);
}
