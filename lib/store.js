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

// ---------- 설정(검토자 명단 · 배정) — 로그인 · 저장 권한 확인용
// supabase: RPC public.nr_get_setting(p_secret, p_key) — 허용된 key만(reviewers · alloc · code_ver)
// memory(로컬 시험): 환경변수 NR_REVIEWERS · NR_ALLOC · NR_CODE_VER (JSON 문자열)
export const SETTING_KEYS = ['reviewers', 'alloc', 'code_ver'];
const SETTING_TTL_MS = 60_000;
const settingCache = globalThis.__nrSettings || (globalThis.__nrSettings = new Map()); // key -> {at, value}

export async function getSetting(key) {
  if (!SETTING_KEYS.includes(key)) throw new StoreError('invalid setting key');
  const hit = settingCache.get(key);
  if (hit && Date.now() - hit.at < SETTING_TTL_MS) return hit.value;
  let raw;
  if (storeMode() === 'memory') raw = process.env['NR_' + key.toUpperCase()] ?? null;
  else raw = await rpc('nr_get_setting', { p_key: key });
  let value = raw;
  if (typeof raw === 'string' && key !== 'code_ver') {
    try { value = JSON.parse(raw); } catch { throw new StoreError(`setting ${key}: invalid JSON`); }
  }
  settingCache.set(key, { at: Date.now(), value });
  return value;
}

// 검토자 명단: [{n: 이름, i: 이니셜, r: 'rv'|'adm'|'view'}]
export async function reviewers() {
  const v = await getSetting('reviewers');
  return Array.isArray(v) ? v.filter(x => x && typeof x.n === 'string' && typeof x.i === 'string') : [];
}
export async function codeVersion() {
  const v = await getSetting('code_ver');
  return typeof v === 'string' && v ? v : '1';
}

// 요소 담당자: 관리자가 화면에서 바꾼 담당(config/assign의 el) → 없으면 기본 배정(settings alloc)
export async function ownerOf(eid) {
  const alloc = (await getSetting('alloc')) || {};
  let over = null;
  try {
    const c = globalThis.__nrAssign;
    let el = c && Date.now() - c.at < 15_000 ? c.el : null;   // 15초 캐시(관리자가 담당을 바꾸면 늦어도 15초 뒤 반영)
    if (!el) {
      const cfg = (await listDocs('config')).find(d => d.id === 'assign');
      el = cfg && cfg.body && cfg.body.el && typeof cfg.body.el === 'object' ? cfg.body.el : {};
      globalThis.__nrAssign = { at: Date.now(), el };
    }
    over = el[eid];
  } catch { /* 담당 변경을 못 읽으면 기본 배정으로 */ }
  return (typeof over === 'string' && over) || (typeof alloc[eid] === 'string' ? alloc[eid] : null);
}
