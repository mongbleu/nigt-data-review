// 저장소 — env STORE로 선택: 'supabase'(기본) | 'memory'(로컬 시험 전용)
// supabase: PostgREST RPC(public.nr_list_docs · public.nr_set_doc)를 fetch로 호출 (supabase-js 미사용).
//           비밀값(APP_SECRET)은 서버에서만 쓴다. 표는 PostgREST에 노출되지 않는 nr_review 스키마에 있다.
// DATA(데이터 요소)는 페이지(public/review.html)에 들어 있으므로 DB에는 검토 문서만 둔다.

// time(9/30): 검토 시간 — 검토자마다 문서 1개(t_<이름 UTF-8 hex>), 기기별 · 날짜별 초. 읽기·쓰기 권한은 app/api/docs가 거른다.
// profile(9/29 밤): 검토자 캐릭터 — 검토자마다 문서 1개(p_<이름 UTF-8 hex>) {char, color}. 모두 읽음 · 자기 것만 씀(app/api/docs).
// chat(9/30): 검토팀 채팅 — 메시지마다 문서 1개(m_<시각 36진수>_<무작위>_<이름 UTF-8 hex>). 검토자 · 관리자만 읽고 씀 · 자기 메시지만(관리자는 지우기만 남의 것도).
export const COLLS = ['reviews', 'answers', 'config', 'time', 'profile', 'chat'];
// 저장 이력(doc_history)에 남기지 않는 컬렉션 — 잦거나(검토 시간 · 채팅) 꾸밈(캐릭터). 지운 채팅 글이 이력에 남지 않게.
const NO_HISTORY = ['time', 'profile', 'chat'];
export const hexOf = name => Array.from(new TextEncoder().encode(String(name || '')), b => b.toString(16).padStart(2, '0')).join('');
// hex → 이름(UTF-8이 아니거나 비면 null) — 채팅 id 끝의 작성자
export function nameOfHex(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2}){1,120}$/.test(hex)) return null;
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hex.match(/../g), x => parseInt(x, 16)));
    return s && s.length <= 40 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
  } catch { return null; }
}
// 검토 시간 문서 id — 로그인 이름(한글)을 UTF-8 hex로 (예: 홍길동 → t_ed998d…). 화면(frag8_game tmId)도 같은 식
export function timeIdOf(name) {
  return 't_' + hexOf(name);
}
// 캐릭터 문서 id — p_<이름 UTF-8 hex>. 화면(frag8_rank pidOf)도 같은 식
export function profileIdOf(name) {
  return 'p_' + hexOf(name);
}

export class StoreError extends Error {
  constructor(message) { super(message); this.name = 'StoreError'; }
}

// 라우트 번들이 달라도 한 프로세스 안에서는 같은 상태를 쓰도록 globalThis에 둔다
const G = globalThis.__nrStore || (globalThis.__nrStore = {
  docs: new Map(),   // memory 모드: 'coll/id' -> {coll, id, body, by_name, updated_at}
  history: [],       // memory 모드: 저장 이력 흉내
  lastStamp: 0,
  kv: new Map(),     // memory 모드: 서버 전용 키-값 key -> {value, at} (10/1)
});
if (!G.kv) G.kv = new Map();   // 개발 서버 다시 읽기 — 예전 상태에 kv가 없을 때

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
    if (!NO_HISTORY.includes(coll)) G.history.push({ coll, id, body: rec.body, by_name: rec.by_name, at });
    return { ok: true, at };
  }
  const r = await rpc('nr_set_doc', { p_coll: coll, p_id: id, p_body: body, p_by: byName ?? null });
  if (!r || r.ok !== true) throw new StoreError('nr_set_doc did not confirm the write');
  return { ok: true, at: r.at };
}

// ---------- 9/30 바뀐 칸만 합치는 저장 — 화면이 고친 칸(paths)만 그 순간의 DB 문서에 합친다(관리자 판정 ↔ 검토자 입력이 서로 덮어쓰지 않게)
// paths: 'verdict'(맨 위 칸) 또는 'a.h4'(한 단계 아래 칸). 보낸 몸체에 그 칸이 없으면 지움. 저장자 · 시각 칸은 보낸 값으로.
// supabase: RPC public.nr_patch_doc(문서를 for update로 잠그고 합침 — 같은 규칙) · memory: applyPaths
export const PATH_RE = /^[A-Za-z0-9_\-]{1,40}(\.[A-Za-z0-9_\-]{1,80})?$/;
const KEEP_KEYS = ['by_name', 'by', 'at', 'src', 'imported_by', 'rv_name'];
const own = (o, k) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k);
export function applyPaths(cur, body, paths) {
  if (!cur) return structuredClone(body);
  const out = structuredClone(cur);
  for (const p of paths) {
    if (typeof p !== 'string' || !PATH_RE.test(p)) continue;
    const [k, j] = p.split('.');
    if (j === undefined) { if (own(body, k)) out[k] = structuredClone(body[k]); else delete out[k]; continue; }
    const v = own(body[k], j) ? body[k][j] : undefined;
    if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) { if (v === undefined) continue; out[k] = {}; }
    if (v === undefined) delete out[k][j]; else out[k][j] = structuredClone(v);
  }
  for (const k of KEEP_KEYS) if (own(body, k)) out[k] = structuredClone(body[k]);
  return out;
}
// {ok:true, at, body(합친 문서)}
export async function patchDoc(coll, id, body, paths, byName) {
  if (!COLLS.includes(coll)) throw new StoreError('invalid collection');
  if (storeMode() === 'memory') {
    const key = `${coll}/${id}`, cur = G.docs.get(key);
    const merged = applyPaths(cur ? cur.body : null, body, paths);
    const at = memStamp();
    const rec = { coll, id, body: merged, by_name: byName ?? null, updated_at: at };
    G.docs.set(key, rec);
    if (!NO_HISTORY.includes(coll)) G.history.push({ coll, id, body: merged, by_name: rec.by_name, at });
    return { ok: true, at, body: structuredClone(merged) };
  }
  const r = await rpc('nr_patch_doc', { p_coll: coll, p_id: id, p_body: body, p_paths: paths, p_by: byName ?? null });
  if (!r || r.ok !== true) throw new StoreError('nr_patch_doc did not confirm the write');
  return { ok: true, at: r.at, body: r.body };
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

// ---------- 9/29 저녁: DB 매일 자동 백업 — Supabase Cron(pg_cron)이 매일 23:55(한국 시각) nr_review.take_backup()으로 그날 문서 전체를 떠 둠(30일 보관)
// 관리 탭(관리자)이 /api/backups로 목록 · 날짜별 내려받기. supabase: RPC public.nr_list_backups(p_secret) · nr_get_backup(p_secret, p_day)
// memory(로컬 시험): 부를 때마다 지금 문서로 「오늘」 백업 한 개를 만들어 보여 줌
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' });
function memBackup() {
  const docs = [...G.docs.values()].sort((a, b) => (a.coll + '/' + a.id < b.coll + '/' + b.id ? -1 : 1))
    .map(d => ({ coll: d.coll, id: d.id, body: structuredClone(d.body), by_name: d.by_name, updated_at: d.updated_at }));
  const counts = {};
  for (const d of docs) counts[d.coll] = (counts[d.coll] || 0) + 1;
  return { day: KST_DAY.format(new Date()), taken_at: new Date().toISOString(), counts, bytes: new TextEncoder().encode(JSON.stringify(docs)).length, docs };
}
// [{day, taken_at, counts, bytes}] — 최근 날짜부터
export async function listBackups() {
  if (storeMode() === 'memory') { const { docs, ...meta } = memBackup(); return docs.length ? [meta] : []; }
  const rows = await rpc('nr_list_backups', {});
  if (!Array.isArray(rows)) throw new StoreError('nr_list_backups returned a non-array');
  return rows;
}
// {day, taken_at, counts, bytes, docs:[{coll, id, body, by_name, updated_at}]} 또는 null
export async function getBackup(day) {
  if (!DAY_RE.test(String(day || ''))) throw new StoreError('invalid day');
  if (storeMode() === 'memory') { const b = memBackup(); return b.day === day && b.docs.length ? b : null; }
  const r = await rpc('nr_get_backup', { p_day: day }, 20_000);
  return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
}

// ---------- 10/1 서버 전용 키-값(nr_review.kv) — AI 자동 답변 설정(ai_cfg) · 휴대폰 알림 서명 키(push_vapid) · 알림 받는 기기(push_subs)
//   · 같은 질문에 두 번 답하지 않게 먼저 차지하는 표시(ai_done:<질문 id>) · 시간당 한도(ai_count:<한국 시각 YYYYMMDDHH>) 등.
//   config 컬렉션은 로그인한 사람이면 모두 읽으므로 비밀값 · 설정은 여기에 둔다(/api/docs로는 읽을 수 없음 — 서버 코드만 씀).
//   supabase: RPC public.nr_kv_get · nr_kv_set · nr_kv_claim(없을 때만 넣음 — 먼저 넣은 쪽만 true) · nr_kv_del (supabase/migration_ai.sql)
//   memory(로컬 시험): G.kv
export const KV_KEY_RE = /^[a-z0-9_:.-]{1,120}$/;
const KV_MAX_BYTES = 64 * 1024;
function kvCheck(key, value) {
  if (typeof key !== 'string' || !KV_KEY_RE.test(key)) throw new StoreError('invalid kv key');
  if (value === undefined) return;
  if (value === null) throw new StoreError('kv value required');
  if (new TextEncoder().encode(JSON.stringify(value)).length > KV_MAX_BYTES) throw new StoreError('kv value too large');
}
// 값(JSON) 또는 null
export async function kvGet(key) {
  kvCheck(key);
  if (storeMode() === 'memory') { const e = G.kv.get(key); return e ? structuredClone(e.value) : null; }
  const r = await rpc('nr_kv_get', { p_key: key });
  return r === undefined ? null : r;
}
// {ok:true, at} — 있으면 바꿈
export async function kvSet(key, value) {
  kvCheck(key, value);
  if (storeMode() === 'memory') { const at = memStamp(); G.kv.set(key, { value: structuredClone(value), at }); return { ok: true, at }; }
  const r = await rpc('nr_kv_set', { p_key: key, p_value: value });
  if (!r || r.ok !== true) throw new StoreError('nr_kv_set did not confirm the write');
  return { ok: true, at: r.at };
}
// 없을 때만 넣는다 → 넣었으면 true(먼저 차지함) · 이미 있으면 false
export async function kvClaim(key, value) {
  kvCheck(key, value);
  if (storeMode() === 'memory') {
    if (G.kv.has(key)) return false;   // 확인과 넣기 사이에 await가 없어 한 프로세스 안에서는 원자적
    G.kv.set(key, { value: structuredClone(value), at: memStamp() });
    return true;
  }
  return (await rpc('nr_kv_claim', { p_key: key, p_value: value })) === true;
}
// 지웠으면 true
export async function kvDel(key) {
  kvCheck(key);
  if (storeMode() === 'memory') return G.kv.delete(key);
  return (await rpc('nr_kv_del', { p_key: key })) === true;
}

// ---------- 10/1 AI 답 참고 자료 ai_ctx.json(말투 · 예시 · 검토 안내 · 용어 · FAQ · 요소 카드 — 사람 이름 없음) — 10분 보관
//   supabase: 비공개 파일(nr_review.assets)을 nr_asset_info · nr_get_asset으로 받아 이어 붙이고 sha256 확인(scripts/fetch_page.mjs와 같은 방식)
//   memory(로컬 시험): 환경변수 NR_AI_CTX(파일 경로)의 JSON · 없으면 빈 자료. 못 읽으면 빈 자료(AI는 근거가 없으니 보류 답을 냄)
const AI_CTX_ASSET = 'ai_ctx.json';
const AI_CTX_TTL_MS = 10 * 60_000;
const AI_CTX_RETRY_MS = 60_000;
const sha256Hex = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
async function readAiContext() {
  if (storeMode() === 'memory') {
    const file = process.env.NR_AI_CTX;
    if (!file) return {};
    const fs = await import('node:fs/promises');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  const info = await rpc('nr_asset_info', { p_name: AI_CTX_ASSET });
  const n = info && Number(info.parts);
  if (!n) return {};
  if (!(n > 0 && n <= 200)) throw new StoreError('ai_ctx.json: invalid part count');
  const parts = await Promise.all(Array.from({ length: n }, (_, i) => rpc('nr_get_asset', { p_name: AI_CTX_ASSET, p_part: i }, 20_000)));
  if (parts.some(p => typeof p !== 'string')) throw new StoreError('ai_ctx.json: missing part');
  const text = parts.join('');
  if (info.sha256 && (await sha256Hex(text)) !== info.sha256) throw new StoreError('ai_ctx.json: sha256 mismatch');
  return JSON.parse(text);
}
export async function aiContext() {
  const C = globalThis.__nrAiCtx || (globalThis.__nrAiCtx = { at: 0, value: null, ttl: AI_CTX_TTL_MS });
  if (C.value && Date.now() - C.at < C.ttl) return C.value;
  try {
    const v = await readAiContext();
    C.value = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    C.ttl = AI_CTX_TTL_MS;
  } catch (e) {
    console.error('[store] ai_ctx.json을 읽지 못했습니다:', e && (e.name === 'SyntaxError' ? 'invalid JSON' : e.message));
    if (!C.value) C.value = {};
    C.ttl = AI_CTX_RETRY_MS;   // 1분 뒤 다시 시도(그동안은 예전 자료 · 없으면 빈 자료)
  }
  C.at = Date.now();
  return C.value;
}
