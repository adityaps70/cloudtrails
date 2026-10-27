// Private document storage. Uses an R2 bucket bound as FILES when one is configured,
// otherwise the KV namespace bound as DOCS. Files are only ever served through the Worker.

import { nowISO } from './db.js';
import { randomHex } from './util.js';

export async function putFile(env, { bookingId, kind, mime, bytes }) {
  const id = randomHex(16);
  const key = 'f/' + id;
  if (env.FILES) await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
  else if (env.DOCS) await env.DOCS.put(key, bytes, { metadata: { mime } });
  else throw new Error('No file storage is bound (add the DOCS KV namespace or FILES R2 bucket).');
  await env.DB.prepare('INSERT INTO files (id, booking_id, kind, mime, size, created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, bookingId ?? null, kind, mime, bytes.byteLength, nowISO()).run();
  return id;
}

export async function getFile(env, id) {
  const row = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  if (!row) return null;
  const key = 'f/' + id;
  let body = null;
  if (env.FILES) {
    const obj = await env.FILES.get(key);
    body = obj ? await obj.arrayBuffer() : null;
  }
  if (!body && env.DOCS) body = await env.DOCS.get(key, 'arrayBuffer');
  if (!body) return null;
  return { row, body };
}

export async function deleteFile(env, id) {
  const key = 'f/' + id;
  if (env.FILES) await env.FILES.delete(key);
  if (env.DOCS) await env.DOCS.delete(key);
  await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
}

/** Deletes every document of a booking except its signature (kept as the record of consent). */
export async function purgeBookingDocs(env, bookingId) {
  const { results } = await env.DB.prepare("SELECT id FROM files WHERE booking_id = ? AND kind != 'signature'").bind(bookingId).all();
  for (const r of results || []) await deleteFile(env, r.id);
  await env.DB.prepare('UPDATE bookings SET docs_purged_at = ?, updated_at = ? WHERE id = ?').bind(nowISO(), nowISO(), bookingId).run();
  return (results || []).length;
}
