// GET  /api/docs?coll=reviews|answers|config[&since=<cursor>] → {docs:[{id, body, by_name, updated_at}], cursor}
// POST /api/docs {coll, id, body} → {ok:true, at}
import { roleFromRequest } from '../../../lib/auth.js';
import { COLLS, listDocs, setDoc } from '../../../lib/store.js';
import { json } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_\-]{1,80}$/;
const MAX_BODY_BYTES = 64 * 1024;
// since 조회는 이 만큼 겹쳐서 다시 보낸다 — 커밋 순서와 updated_at 순서가 어긋나도 놓치지 않게
const SINCE_OVERLAP_MS = 60_000;

export async function GET(request) {
  if (!(await roleFromRequest(request))) return json({ error: 'unauthorized' }, 401);
  const params = new URL(request.url).searchParams;
  const coll = params.get('coll');
  if (!COLLS.includes(coll)) return json({ error: 'invalid_coll' }, 400);

  const sinceRaw = params.get('since');
  let sinceMs = null;
  if (sinceRaw) {
    sinceMs = sinceRaw.length <= 64 ? Date.parse(sinceRaw) : NaN;
    if (!Number.isFinite(sinceMs)) return json({ error: 'invalid_since' }, 400);
  }
  try {
    const docs = await listDocs(coll, sinceMs == null ? null : new Date(sinceMs - SINCE_OVERLAP_MS).toISOString());
    // cursor = 지금까지 본 가장 늦은 updated_at (되돌아가지 않음)
    let cursor = sinceRaw || null, cursorMs = sinceMs ?? -Infinity;
    for (const d of docs) {
      const t = Date.parse(d.updated_at);
      if (t > cursorMs) { cursorMs = t; cursor = d.updated_at; }
    }
    return json({ docs, cursor });
  } catch (e) {
    console.error('[GET /api/docs] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}

export async function POST(request) {
  const role = await roleFromRequest(request);
  if (!role) return json({ error: 'unauthorized' }, 401);

  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return json({ error: 'unsupported_media_type' }, 415);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES * 4) return json({ error: 'too_large' }, 413);

  let raw;
  try { raw = await request.text(); } catch { return json({ error: 'bad_request' }, 400); }
  if (raw.length > MAX_BODY_BYTES * 4) return json({ error: 'too_large' }, 413);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }

  const { coll, id, body } = payload && typeof payload === 'object' ? payload : {};
  if (!COLLS.includes(coll)) return json({ error: 'invalid_coll' }, 400);
  if (typeof id !== 'string' || !ID_RE.test(id)) return json({ error: 'invalid_id' }, 400);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_body' }, 400);
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);
  if (coll === 'config' && role !== 'adm') return json({ error: 'forbidden' }, 403);

  const byName = typeof body.by_name === 'string' ? body.by_name.slice(0, 80) : null;
  try {
    const r = await setDoc(coll, id, body, byName);
    return json({ ok: true, at: r.at });
  } catch (e) {
    console.error('[POST /api/docs] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}
