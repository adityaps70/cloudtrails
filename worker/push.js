// Web Push for the admin app: a notification on the owner's phone for every new booking.
// Standards: VAPID (RFC 8292) and aes128gcm message encryption (RFC 8291), using only WebCrypto.
// The VAPID key pair is made on first use and kept in the private KV store (never sent to the browser
// except the public half).

import { b64url, fromB64url } from './util.js';
import { nowISO } from './db.js';

const KV_KEY = 'push:vapid-keys';
const enc = new TextEncoder();

// Push services the admin app may subscribe through (Apple, Google/Chrome, Mozilla, Microsoft).
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

/** The app's VAPID keys: { publicKey (base64url raw P-256 point), privateJwk }. */
export async function vapidKeys(env) {
  const saved = await env.DOCS.get(KV_KEY);
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = {
    publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
  };
  await env.DOCS.put(KV_KEY, JSON.stringify(keys));
  return JSON.parse(await env.DOCS.get(KV_KEY)); // if two requests raced, both use whichever was stored
}

async function vapidAuth(env, endpoint) {
  const keys = await vapidKeys(env);
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:help@cloudtrails.in',
  })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

/** Encrypt a payload for one subscription (RFC 8291, aes128gcm). Returns the request body. */
export async function encryptPayload(p256dh, authSecret, plaintext, { salt, serverKeys } = {}) {
  const uaPublic = fromB64url(p256dh);
  const auth = fromB64url(authSecret);
  const local = serverKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(auth, ecdhSecret);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = concat(typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext, new Uint8Array([2])); // 0x02 = last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, body));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** Send one notification to one subscription row. Returns the push service's HTTP status. */
export async function sendPush(env, sub, message) {
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(env, sub.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'high',
    },
    body,
  });
  return res.status;
}

/** Notify every subscribed admin device. Drops subscriptions the push service says are gone. */
export async function notifyAdmins(env, message) {
  const { results } = await env.DB.prepare('SELECT * FROM push_subs').all();
  let sent = 0, failed = 0;
  await Promise.all((results || []).map(async (sub) => {
    let status = 0;
    try { status = await sendPush(env, sub, message); } catch { status = 0; }
    if (status >= 200 && status < 300) {
      sent++;
      await env.DB.prepare('UPDATE push_subs SET last_ok_at = ? WHERE id = ?').bind(nowISO(), sub.id).run();
    } else {
      failed++;
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id).run();
    }
  }));
  return { sent, failed, devices: (results || []).length };
}

function when(s) {
  const d = new Date(String(s).replace(' ', 'T') + ':00Z');
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) + ' ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

export function newBookingMessage(b) {
  return {
    title: `New booking ${b.ref}`,
    body: `${b.name} · ${b.vehicle_name}\n${when(b.start_at)} → ${when(b.end_at)} · ₹${Number(b.total || 0).toLocaleString('en-IN')}`,
    url: `/admin/#/booking/${b.id}`,
    tag: b.ref,
  };
}
