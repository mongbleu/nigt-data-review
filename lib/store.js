// 저장소 — env STORE로 선택: 'supabase'(기본) | 'memory'(로컬 시험 전용)
// supabase: PostgREST RPC(public.nr_list_docs · public.nr_set_doc)를 fetch로 호출 (supabase-js 미사용).
//           비밀값(APP_SECRET)은 서버에서만 쓴다. 표는 PostgREST에 노출되지 않는 nr_review 스키마에 있다.
// DATA(데이터 요소)는 페이지(public/review.html)에 들어 있으므로 DB에는 검토 문서만 둔다.

export const COLLS = ['reviews', 'answers', 'config'];

export class StoreError extends Error {
  constructor(message) { super(message); this.name = 'StoreError'; }
}

// 라우트 번들이 달라도 한 프로세스 안에서는 같은 상태를 쓰도록 globalThis에 둔다
const G = globalThis.__nrStore || (globalThis.__nrStore = {
  docs: new Map(),   // memory 모드: 'coll/id' -> {coll, id, body, by_name, updated_at}
  history: [],       // memory 모드: 저장 이력 흉내
  lastStamp: 0,
});

function storeMode() {
  const m = (process.env.STORE || 'supabase').trim().toLowerCase();
  if (m === 'supabase' || m === 'memory') return m;
  throw new StoreError(`STORE must be "supabase" or "memory" (got "${m}")`);
}

// ---------- supabase (PostgREST RPC)
async function rpc(fn, args, timeoutMs = 10_000) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY, secret = process.env.APP_SECRET;
  if (!base || !key || !secret) throw new StoreError('SUPABASE_URL / SUPABASE_ANON_KEY / APP_SECRET is not configured');
  const headers = { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' };
  // 레거시 anon 키(JWT)는 Authorization에도 넣는다. 새 publishable 키(sb_…)는 JWT가 아니라서 넣지 않는다.
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_secret: secret, ...args }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new StoreError(`rpc ${fn}: request failed (${e && e.name})`);
  }
  const text = await res.text();
  if (!res.ok) throw new StoreError(`rpc ${fn}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new StoreError(`rpc ${fn}: invalid JSON response`);
  }
}

// ---------- memory
function memStamp() {
  let t = Date.now();
  if (t <= G.lastStamp) t = G.lastStamp + 1; // 같은 밀리초 저장도 순서가 보이게
  G.lastStamp = t;
  return new Date(t).toISOString();
}

// ---------- 공개 API
// [{id, body, by_name, updated_at}] — sinceIso가 있으면 그 뒤에 바뀐 것만
export async function listDocs(coll, sinceIso = null) {
  if (!COLLS.includes(coll)) throw new StoreError('invalid collection');
  if (storeMode() === 'memory') {
    const since = sinceIso ? Date.parse(sinceIso) : null;
    const out = [];
    for (const d of G.docs.values()) {
      if (d.coll !== coll) continue;
      if (since != null && !(Date.parse(d.updated_at) > since)) continue;
      out.push({ id: d.id, body: d.body, by_name: d.by_name, updated_at: d.updated_at });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const args = { p_coll: coll };
  if (sinceIso) args.p_since = sinceIso;
  const rows = await rpc('nr_list_docs', args);
  if (!Array.isArray(rows)) throw new StoreError('nr_list_docs returned a non-array');
  return rows;
}

// {ok:true, at}
export async function setDoc(coll, id, body, byName) {
  if (!COLLS.includes(coll)) throw new StoreError('invalid collection');
  if (storeMode() === 'memory') {
    const at = memStamp();
    const rec = { coll, id, body: structuredClone(body), by_name: byName ?? null, updated_at: at };
    G.docs.set(`${coll}/${id}`, rec);
    G.history.push({ coll, id, body: rec.body, by_name: rec.by_name, at });
    return { ok: true, at };
  }
  const r = await rpc('nr_set_doc', { p_coll: coll, p_id: id, p_body: body, p_by: byName ?? null });
  if (!r || r.ok !== true) throw new StoreError('nr_set_doc did not confirm the write');
  return { ok: true, at: r.at };
}
