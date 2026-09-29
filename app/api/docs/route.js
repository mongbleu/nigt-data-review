// GET  /api/docs?coll=reviews|answers|config|time[&since=<cursor>] → {docs:[{id, body, by_name, updated_at}], cursor}
// POST /api/docs {coll, id, body} → {ok:true, at}   (보기 전용 403 read_only · 검토자는 담당 요소만 — 아니면 403 not_assigned)
// POST paths(9/30, reviews만): 고친 칸 목록 → 서버가 그 순간의 DB 문서에 그 칸만 합침(응답에 합친 문서 body). 검토자는 관리 칸(판정 · 근거 요약 · 요청 문장 …)을 못 바꿈
// time(9/30 검토 시간): 문서 id = t_<로그인 이름 UTF-8 hex>. 쓰기 = 자기 문서만(서버가 모양을 다시 만듦) · 읽기 = 관리자 전체 / 검토자 자기 것 / 보기 전용 없음
import { sessionFromRequest, WRITE_ROLES } from '../../../lib/auth.js';
import { COLLS, listDocs, setDoc, patchDoc, ownerOf, timeIdOf, PATH_RE } from '../../../lib/store.js';
import { json } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_\-]{1,80}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 관리 칸(정유정 몫) — 검토자 저장에서는 받지 않고 DB 값을 둔다
const ADMIN_KEYS = ['verdict', 'evid', 'req', 'dec', 'spn', 'flags', 'flagnote', 'sugg', 'ptype'];
const DEV_RE = /^[A-Za-z0-9_\-]{1,40}$/;

// 받은 몸체를 믿지 않고 다시 만든다: 기기 12대 · 기기마다 60일 · 하루 0~86400초
function cleanTime(body, name) {
  const dev = body && typeof body.dev === 'object' && !Array.isArray(body.dev) ? body.dev : null;
  if (!dev) return null;
  const out = {};
  for (const [k, v] of Object.entries(dev).slice(0, 12)) {
    if (!DEV_RE.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const days = {};
    const src = v.days && typeof v.days === 'object' && !Array.isArray(v.days) ? v.days : {};
    for (const [dy, s] of Object.entries(src).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-60)) {
      const n = Math.round(Number(s));
      if (DAY_RE.test(dy) && Number.isFinite(n) && n >= 0 && n <= 86400) days[dy] = n;
    }
    out[k] = { days, at: typeof v.at === 'string' ? v.at.slice(0, 40) : null, paused: v.paused === true };
  }
  return { kind: 'time', name, dev: out, at: new Date().toISOString(), by_name: name };
}
const MAX_BODY_BYTES = 64 * 1024;
// since 조회는 이 만큼 겹쳐서 다시 보낸다 — 커밋 순서와 updated_at 순서가 어긋나도 놓치지 않게
const SINCE_OVERLAP_MS = 60_000;

export async function GET(request) {
  const sess = await sessionFromRequest(request);
  if (!sess) return json({ error: 'unauthorized' }, 401);
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
    let docs = await listDocs(coll, sinceMs == null ? null : new Date(sinceMs - SINCE_OVERLAP_MS).toISOString());
    // 검토 시간: 관리자만 전체 · 검토자는 자기 문서만 · 보기 전용은 없음
    if (coll === 'time' && sess.role !== 'adm') {
      const own = sess.role === 'rv' && sess.name ? timeIdOf(sess.name) : null;
      docs = own ? docs.filter(d => d.id === own) : [];
    }
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
  const sess = await sessionFromRequest(request);
  if (!sess) return json({ error: 'unauthorized' }, 401);
  const role = sess.role;
  // 보기 전용(공용 코드 · 예전 공용 쿠키)은 저장 못 함
  if (!WRITE_ROLES.has(role)) return json({ error: 'read_only' }, 403);

  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return json({ error: 'unsupported_media_type' }, 415);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES * 4) return json({ error: 'too_large' }, 413);

  let raw;
  try { raw = await request.text(); } catch { return json({ error: 'bad_request' }, 400); }
  if (raw.length > MAX_BODY_BYTES * 4) return json({ error: 'too_large' }, 413);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }

  const { coll, id } = payload && typeof payload === 'object' ? payload : {};
  let body = payload && typeof payload === 'object' ? payload.body : null;
  if (!COLLS.includes(coll)) return json({ error: 'invalid_coll' }, 400);
  if (typeof id !== 'string' || !ID_RE.test(id)) return json({ error: 'invalid_id' }, 400);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_body' }, 400);
  let paths = null;
  if (payload.paths !== undefined && payload.paths !== null) {
    if (coll !== 'reviews' || !Array.isArray(payload.paths) || payload.paths.length > 600 || !payload.paths.every(p => typeof p === 'string' && PATH_RE.test(p))) return json({ error: 'invalid_paths' }, 400);
    paths = [...new Set(payload.paths)];
  }
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);
  if ((coll === 'config' || coll === 'answers') && role !== 'adm') return json({ error: 'forbidden' }, 403);
  // 검토 시간: 로그인한 사람 자기 문서(time/t_<이름 hex>)만 — 몸체는 서버가 다시 만든다
  if (coll === 'time') {
    if (!sess.name || id !== timeIdOf(sess.name)) return json({ error: 'forbidden' }, 403);
    body = cleanTime(body, sess.name);
    if (!body) return json({ error: 'invalid_body' }, 400);
  }
  // 검토자: 자기 담당 요소 문서(reviews/e_<요소ID>)만, 저장자 이름은 로그인한 이름으로
  else if (role === 'rv') {
    const m = /^e_([A-E]-\d{3})$/.exec(id);
    if (coll !== 'reviews' || !m) return json({ error: 'forbidden' }, 403);
    let owner;
    try { owner = await ownerOf(m[1]); } catch (e) { console.error('[POST /api/docs] owner lookup failed:', e && e.message); return json({ error: 'store_unavailable' }, 502); }
    if (!owner || owner !== sess.name) return json({ error: 'not_assigned' }, 403);
    body.by_name = sess.name;
    body.rv_name = sess.name;
    // 관리 칸은 받지 않음: 통째 저장도 「검토자 칸만 바꿈」으로 바꿔 DB의 판정 · 요청 문장을 지킨다
    if (!paths) paths = Object.keys(body);
    paths = paths.filter(p => !ADMIN_KEYS.includes(p.split('.')[0]));
    for (const k of ADMIN_KEYS) delete body[k];
  }

  if (typeof body.by_name !== 'string' || !body.by_name) body.by_name = sess.name || null;   // 9/30: 저장자 이름이 비면 로그인 이름
  const byName = typeof body.by_name === 'string' ? body.by_name.slice(0, 80) : null;
  try {
    const r = paths ? await patchDoc(coll, id, body, paths, byName) : await setDoc(coll, id, body, byName);
    return json(r.body ? { ok: true, at: r.at, body: r.body } : { ok: true, at: r.at });
  } catch (e) {
    console.error('[POST /api/docs] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}
