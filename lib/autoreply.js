// AI 자동 답변 · 관리자 휴대폰 알림(10/1) — 검토팀 채팅(chat)에 검토자가 질문을 올리면
//   1) 관리자 기기에 알림(lib/push.js) 2) AI가 관리자 말투로 답(lib/ai.js) — 부재 중(away)이면 바로, 아니면 N분(min) 동안 관리자 글이 없을 때(fallback)
//   관리자가 정해야 하는 질문은 짧은 보류 답(ai.kind 'hold' — 「…확인하고 답드릴게요!」) + 관리자에게 알림 · 질문이 아니면 답하지 않음(skip)
//   자동 답변 문서: chat/m_<시각 36진수>_ai<무작위>_<정유정 hex> = {kind:'chat', name:'정유정', by_name:'정유정', text, tag:'ai', ai:{kind, model}, re:<질문 id>, ts, at}
//     — 서버만 씀(화면 저장은 app/api/docs cleanChat이 tag 'ai'를 버림) · 화면에 「🤖 자동 답변」
//   같은 질문에 두 번 답하지 않게 kv 'ai_done:<질문 id>'를 먼저 차지한(kvClaim) 쪽만 답한다(인스턴스 여러 개 · 동시 sweep).
//   설정 kv 'ai_cfg' {away, fallback, min(5~60분)} · 시간당 한도 kv 'ai_count:<한국 시각 YYYYMMDDHH>'(AI_MAX_PER_HOUR, 기본 20 — 초안 포함)
//   부르는 곳: app/api/docs(채팅 저장 뒤 onChatWrite · 채팅 읽기 뒤 sweep — 둘 다 응답을 보낸 뒤 after로) · app/api/ai(설정 · 초안)
import { listDocs, setDoc, kvGet, kvSet, kvClaim, kvDel, reviewers, hexOf } from './store.js';
import { ADMIN_NAME, aiEnabled, generate, isQuestion, adminNamesOf, chatMsgs } from './ai.js';
import { sendToAdmins } from './push.js';

const CFG_KEY = 'ai_cfg';
export const CFG_DEFAULT = Object.freeze({ away: false, fallback: true, min: 10 });
const DONE = 'ai_done:';
const FAIL = 'ai_fail:';
const SWEEP_EVERY_MS = 20_000;       // 인스턴스마다 20초에 한 번까지
const WINDOW_MS = 24 * 3600_000;     // 24시간 안의 질문만
const KEEP_MS = WINDOW_MS + 3600_000;
const RELOAD_MS = 30 * 60_000;       // 최근 채팅은 30분마다 새로 다 읽음(이어 읽기에서 놓친 것 방지)
const OVERLAP_MS = 60_000;           // 이어 읽기 겹침(app/api/docs SINCE_OVERLAP_MS와 같게)
const MAX_PER_SWEEP = 3;
const MAX_FAILS = 3;
const RETRY_MS = 60_000;             // 실패한 질문은 1분 뒤에 다시

// 라우트 번들이 달라도 한 프로세스 안에서는 같은 상태를 쓴다
const fresh = () => ({ lastSweep: 0, chat: { map: new Map(), cursor: null, loadedAt: 0 }, done: new Map(), failAt: new Map(), pushed: new Map() });
const G = globalThis.__nrAi || (globalThis.__nrAi = fresh());

// 시험용 시계 · 상태 비우기
let nowFn = () => Date.now();
export function __setNow(fn) { nowFn = typeof fn === 'function' ? fn : () => Date.now(); }
export function __reset() { Object.assign(G, fresh()); }
const now = () => nowFn();
const iso = (t = now()) => new Date(t).toISOString();
// 로그에는 오류 코드만(글 내용 · 키 없음). 저장소 오류는 RPC 이름 · HTTP 상태가 든 메시지
const errCode = e => (e && (e.code || (e.name === 'StoreError' ? String(e.message).slice(0, 200) : e.name))) || 'error';

// ---------- 설정
function normCfg(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    away: typeof o.away === 'boolean' ? o.away : CFG_DEFAULT.away,
    fallback: typeof o.fallback === 'boolean' ? o.fallback : CFG_DEFAULT.fallback,
    min: Number.isInteger(o.min) && o.min >= 5 && o.min <= 60 ? o.min : CFG_DEFAULT.min,
  };
}
export async function getCfg() {
  return normCfg(await kvGet(CFG_KEY));
}
// 화면이 보낸 값 → 바꿀 칸만 {away?, fallback?, min?} · 틀리면 null (min은 5~60 정수 — "10" 같은 숫자 글자도 받음)
export function cfgPatch(input) {
  const o = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const k of ['away', 'fallback']) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') return null;
    out[k] = o[k];
  }
  if (o.min !== undefined) {
    const n = typeof o.min === 'string' && o.min.trim() !== '' ? Number(o.min) : o.min;
    if (!Number.isInteger(n) || n < 5 || n > 60) return null;
    out.min = n;
  }
  return out;
}
export async function setCfg(patch, byName = null) {
  const next = normCfg({ ...(await getCfg()), ...patch });
  await kvSet(CFG_KEY, { ...next, at: new Date().toISOString(), by: typeof byName === 'string' ? byName.slice(0, 40) : null });
  return next;
}

// 관리자 이름들(정유정 + 명단의 adm) — 명단을 못 읽으면 정유정만
export async function adminNames() {
  try { return adminNamesOf(await reviewers()); } catch { return adminNamesOf([]); }
}

// ---------- 시간당 한도 (자동 답변 + 초안)
const maxPerHour = () => {
  const n = Number.parseInt(process.env.AI_MAX_PER_HOUR ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : 20;
};
const hourOf = t => new Date(t + 9 * 3600_000).toISOString().slice(0, 13).replace(/\D/g, '');   // 한국 시각 YYYYMMDDHH(일광 절약 없음)
const used = async hour => Number(await kvGet('ai_count:' + hour)) || 0;
// 이번 시간 한도에서 n개 가져가기 → 가져간 수(0 = 다 씀). 읽고 쓰기라 같은 순간 여러 곳에서 부르면 조금 넘칠 수 있다
export async function takeQuota(n = 1) {
  const hour = hourOf(now());
  const cur = await used(hour);
  const k = Math.max(0, Math.min(n, maxPerHour() - cur));
  if (k > 0) await kvSet('ai_count:' + hour, cur + k);
  return k;
}
async function notifyCapOnce() {
  const hour = hourOf(now());
  try {
    if (await kvClaim('ai_capnote:' + hour, { at: iso() })) {
      await push({ title: '⚠️ 자동 답변 한도', body: `이번 한 시간 자동 답변 ${maxPerHour()}건을 다 썼어요. 새 질문은 직접 확인해 주세요.`, tag: 'ai-cap-' + hour, url: '/' });
    }
  } catch (e) {
    console.error('[autoreply] 한도 알림 실패:', errCode(e));
  }
}

// ---------- 알림
const clip = (s, n) => {
  const a = Array.from(String(s || '').replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('');
};
async function push(payload) {
  try { return await sendToAdmins(payload); } catch (e) { console.error('[autoreply] 알림 실패:', errCode(e)); return 0; }
}

// ---------- 최근 채팅(25시간) — 인스턴스 안에 두고 바뀐 것만 더 읽는다(sweep이 20초마다 전체 채팅을 받지 않게)
async function recentChat() {
  const t = now(), C = G.chat;
  let since;
  if (!C.cursor || t - C.loadedAt > RELOAD_MS) {
    C.map = new Map();
    C.loadedAt = t;
    since = iso(t - KEEP_MS);
    C.cursor = null;
  } else {
    since = iso(Date.parse(C.cursor) - OVERLAP_MS);
  }
  const docs = await listDocs('chat', since);
  for (const d of docs) {
    C.map.set(d.id, d);
    if (!C.cursor || Date.parse(d.updated_at) > Date.parse(C.cursor)) C.cursor = d.updated_at;
  }
  if (!C.cursor) C.cursor = since;
  for (const [id, d] of C.map) if (!(Number(d.body && d.body.ts) >= t - KEEP_MS)) C.map.delete(id);
  return chatMsgs([...C.map.values()]);
}

// 이미 답이 있는 질문: 답글(자동 답변 포함)이 달렸거나 · 질문 뒤에 관리자가 (자동 답변이 아닌) 글을 씀(채팅을 봤다고 봄)
function answered(q, msgs, admins) {
  return msgs.some(m => m.id !== q.id && !m.del && admins.has(m.name) && (m.re === q.id || (m.tag !== 'ai' && m.ts > q.ts)));
}

// 자동 답변 문서 id — m_<시각 36진수>_ai<무작위 6자>_<정유정 hex> (app/api/docs CHAT_ID_RE에 맞음)
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function aiMsgId(t = now()) {
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => B36[b % 36]).join('');
  return `m_${Math.floor(t).toString(36)}_ai${rnd}_${hexOf(ADMIN_NAME)}`;
}

// 차지한 질문 하나에 답 → 'answer' | 'hold' | 'skip' | 'failed'
async function answerOne(q, msgs) {
  let r;
  try {
    r = await generate({ q, msgs, mode: 'auto' });
    if (r.kind === 'skip') return 'skip';   // 표시는 그대로(다시 묻지 않음)
    const t = now();
    const body = { kind: 'chat', name: ADMIN_NAME, by_name: ADMIN_NAME, text: r.text, tag: 'ai', ai: { kind: r.kind, model: r.model }, re: q.id, ts: t, at: iso(t) };
    await setDoc('chat', aiMsgId(t), body, ADMIN_NAME);
  } catch (e) {
    await failed(q, e);
    return 'failed';
  }
  // 알림은 저장 뒤 — 알림이 실패해도 답은 그대로
  await push(r.kind === 'hold'
    ? { title: '⏸ 확인이 필요한 질문', body: `${q.name ? q.name + ': ' : ''}${clip(q.text, 80)}`, tag: 'hold-' + q.id, url: '/' }
    : { title: '🤖 자동 답변 보냄', body: clip(q.text, 80), tag: 'ai-' + q.id, url: '/' });
  return r.kind;
}

// 실패: 표시를 풀어 다음 sweep이 다시 시도 · 3번째 실패면 표시를 두고(더 시도하지 않음) 관리자에게 알림
async function failed(q, e) {
  console.error('[autoreply] 자동 답변 실패:', errCode(e));
  G.failAt.set(q.id, now());
  let n = MAX_FAILS;   // 횟수를 못 세면 더 시도하지 않는다
  try {
    const f = await kvGet(FAIL + q.id);
    n = (Number(f && f.n) || 0) + 1;
    await kvSet(FAIL + q.id, { n, at: iso() });
  } catch (x) {
    console.error('[autoreply] 실패 횟수 저장 실패:', errCode(x));
  }
  if (n >= MAX_FAILS) {
    await push({ title: '⚠️ 자동 답변 실패', body: '직접 확인해 주세요', tag: 'fail-' + q.id, url: '/' });
    return;
  }
  try { await kvDel(DONE + q.id); } catch (x) { console.error('[autoreply] 표시 풀기 실패:', errCode(x)); }
}

// 질문 여러 개: 먼저 차지(kvClaim) → 차지한 만큼 한도 → 넘친 것은 표시를 풀고 한도 알림 → 나머지 동시에 답
async function runBatch(qs, msgs) {
  const t = now();
  const out = [];
  const claims = await Promise.all(qs.map(q => kvClaim(DONE + q.id, { at: iso(t) }).catch(e => { console.error('[autoreply] 표시 실패:', errCode(e)); return null; })));
  const mine = [];
  qs.forEach((q, i) => {
    if (claims[i] === true) { mine.push(q); return; }
    if (claims[i] === false) G.done.set(q.id, t);   // 다른 곳이 이미 차지함
    out.push({ id: q.id, result: claims[i] === false ? 'taken' : 'error' });
  });
  if (!mine.length) return out;
  let k;
  try { k = await takeQuota(mine.length); } catch (e) { console.error('[autoreply] 한도 확인 실패:', errCode(e)); k = -1; }
  if (k < mine.length) {
    const back = mine.splice(Math.max(k, 0));
    await Promise.all(back.map(q => kvDel(DONE + q.id).catch(e => console.error('[autoreply] 표시 풀기 실패:', errCode(e)))));
    if (k >= 0) await notifyCapOnce();
    out.push(...back.map(q => ({ id: q.id, result: k >= 0 ? 'capped' : 'error' })));
  }
  const res = await Promise.all(mine.map(q => answerOne(q, msgs)));
  mine.forEach((q, i) => {
    if (res[i] !== 'failed') G.done.set(q.id, t);
    out.push({ id: q.id, result: res[i] });
  });
  return out;
}

function prune(t) {
  for (const [k, at] of G.done) if (at < t - KEEP_MS) G.done.delete(k);
  for (const [k, at] of G.failAt) if (at < t - 3600_000) G.failAt.delete(k);
  for (const [k, at] of G.pushed) if (at < t - 3600_000) G.pushed.delete(k);
}

// ---------- 질문 하나 지금 처리(부재 중 — 질문이 들어온 바로 뒤) → 'answer' | 'hold' | 'skip' | 'failed' | 'taken' | 'capped' | 'none' | 'disabled' | 'error'
export async function processQuestion(qid) {
  if (!aiEnabled()) return 'disabled';
  const [msgs, admins] = await Promise.all([recentChat(), adminNames()]);
  const q = msgs.find(m => m.id === qid);
  if (!q || admins.has(q.name) || !isQuestion(q) || answered(q, msgs, admins)) return 'none';
  const [r] = await runBatch([q], msgs);
  return r.result;
}

// ---------- 채팅 저장 뒤(app/api/docs POST · 검토자 글) — 질문이면 관리자에게 알림 · 부재 중이면 바로 자동 답변
export async function onChatWrite(id, body) {
  if (!body || body.del || typeof body.text !== 'string') return 'none';
  const admins = await adminNames();
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name || admins.has(name) || !isQuestion(body)) return 'none';
  if (G.pushed.has(id)) return 'dup';
  G.pushed.set(id, now());
  const [cfg] = await Promise.all([getCfg(), push({ title: '❓ 새 질문', body: `${name}: ${clip(body.text, 80)}`, tag: 'q-' + id, url: '/' })]);
  if (cfg.away && aiEnabled()) return processQuestion(id);
  return 'pushed';
}

// ---------- 채팅 읽은 뒤(app/api/docs GET) — 답 없는 질문 찾기: 부재 중이면 모두, 아니면 N분 지난 것(fallback). 한 번에 3개까지
//   → {ran, why?, results?:[{id, result}]}. force = 20초 간격 무시(시험용)
export async function sweep({ force = false } = {}) {
  if (!aiEnabled()) return { ran: false, why: 'disabled' };
  const t = now();
  if (!force && t - G.lastSweep < SWEEP_EVERY_MS) return { ran: false, why: 'throttled' };
  G.lastSweep = t;
  const cfg = await getCfg();
  if (!cfg.away && !cfg.fallback) return { ran: false, why: 'off' };
  const [msgs, admins] = await Promise.all([recentChat(), adminNames()]);
  prune(t);
  const due = msgs.filter(q => q.ts > t - WINDOW_MS && !admins.has(q.name) && isQuestion(q)
    && !G.done.has(q.id) && !((G.failAt.get(q.id) || 0) > t - RETRY_MS)
    && (cfg.away || (cfg.fallback && t - q.ts >= cfg.min * 60_000))
    && !answered(q, msgs, admins)).slice(0, MAX_PER_SWEEP);
  if (!due.length) return { ran: true, results: [] };
  if ((await used(hourOf(t))) >= maxPerHour()) {
    await notifyCapOnce();
    return { ran: true, results: due.map(q => ({ id: q.id, result: 'capped' })) };
  }
  return { ran: true, results: await runBatch(due, msgs) };
}

// ---------- 초안(/api/ai draft · 관리자) → {kind, text}. 채팅에 올리지 않는다. 오류 code: not_found · rate_limited(시간당 한도) · ai_failed
export class DraftError extends Error {
  constructor(code) { super(code); this.name = 'DraftError'; this.code = code; }
}
export async function makeDraft(qid) {
  const msgs = chatMsgs(await listDocs('chat'));   // 오래된 질문일 수도 있어 전체를 읽음
  const q = msgs.find(m => m.id === qid && !m.del);
  if (!q) throw new DraftError('not_found');
  if (!(await takeQuota(1))) throw new DraftError('rate_limited');
  try {
    const r = await generate({ q, msgs, mode: 'draft' });
    return { kind: r.kind, text: r.text };
  } catch (e) {
    console.error('[autoreply] 초안 실패:', errCode(e));
    throw new DraftError('ai_failed');
  }
}
