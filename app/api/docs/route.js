// GET  /api/docs?coll=reviews|answers|config|time|profile|chat|game[&since=<cursor>] → {docs:[{id, body, by_name, updated_at}], cursor}
// POST /api/docs {coll, id, body} → {ok:true, at}   (보기 전용 403 read_only · 검토자는 담당 요소만 — 아니면 403 not_assigned)
// POST paths(9/30, reviews만): 고친 칸 목록 → 서버가 그 순간의 DB 문서에 그 칸만 합침(응답에 합친 문서 body). 검토자는 관리 칸(판정 · 근거 요약 · 요청 문장 …)을 못 바꿈
// time(9/30 검토 시간): 문서 id = t_<로그인 이름 UTF-8 hex>. 쓰기 = 자기 문서만(서버가 모양을 다시 만듦) · 읽기 = 관리자 전체 / 검토자 자기 것 / 보기 전용 없음
// profile(9/29 밤 검토자 캐릭터): 문서 id = p_<로그인 이름 UTF-8 hex>. 쓰기 = 자기 문서만(캐릭터 · 테두리 색 · 별명만 받아 서버가 지금 문서에 합쳐 다시 만듦) · 읽기 = 모두(순위에 보임)
//   별명(nick, 미니게임 베타): 1~12자 한글 · 영문 · 숫자 · 공백 · _ . - / ''·null = 지움 / 다른 사람 실명 · 별명과 겹치면 409 nick_taken(대소문자 · 공백 무시)
// game(미니게임 베타): 문서 id = g_<시각 36진수>_<무작위>(lib/minigame.js MG_ID_RE). 읽기 = 검토자 · 관리자(보기 전용은 빈 목록)
//   · 가위바위보는 참가자에게 상대가 나보다 더 낸 판을 '?'로 가려 보냄. 쓰기 = body {act, …}만 — 서버가 검사하고 바꿀 칸만 patch(응답 body = 합친 문서, 같은 가림)
// chat(9/30 검토팀 채팅): 문서 id = m_<시각 36진수>_<무작위>_<작성자 이름 UTF-8 hex>. 읽기 · 쓰기 = 검토자 · 관리자만(보기 전용은 빈 목록 · 403)
//   쓰기 = 자기 메시지만(글 · 응원/질문 표시 · 답하는 글 id만 받아 서버가 다시 만들고 시각은 서버 시각) · 지우기 = {del:true}(관리자는 남의 메시지도 지우기만)
//   처음 읽을 때는 최근 CHAT_KEEP개만 보낸다(이어 읽기는 바뀐 것만)
//   10/1 AI 자동 답변 · 관리자 휴대폰 알림(lib/autoreply.js) — 응답을 보낸 뒤(after)에 돈다: 검토자 채팅 저장 → onChatWrite(질문이면 알림 · 부재 중이면 자동 답변)
//   · 채팅 읽기(검토자 · 관리자) → sweep(답 없는 질문 — 부재 중 · N분 지남 — 에 자동 답변, 인스턴스마다 20초에 한 번). 자동 답변 글(tag 'ai')은 서버만 씀
import { after } from 'next/server';
import { randomInt } from 'node:crypto';
import { sessionFromRequest, WRITE_ROLES } from '../../../lib/auth.js';
import { COLLS, listDocs, getDoc, setDoc, patchDoc, ownerOf, timeIdOf, profileIdOf, hexOf, nameOfHex, PATH_RE, reviewers } from '../../../lib/store.js';
import { MG_GAMES, MG_MODES, MG_STAKE_MAX, MG_OPEN_MAX, MG_RPS_MAX, MG_ID_RE, mgSide, mgExpired, mgOmokCheck, mgResult, mgTurn, mgCanPick, mgScoreOk } from '../../../lib/minigame.js';
import { json } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;   // 10/1 응답 뒤 자동 답변(AI 호출 30초까지)이 끝날 시간

// 10/1 응답을 보낸 뒤에 돌릴 일(Next after) — 요청 밖(단위 시험)이면 그냥 뒤에서 돌림. 실패는 로그만. 자동 답변 모듈은 필요할 때만 불러옴
const autoreply = () => import('../../../lib/autoreply.js');
function later(task) {
  const run = () => Promise.resolve().then(task).catch(e => console.error('[api/docs] 뒤처리 실패:', e && (e.code || e.message)));
  try { after(run); } catch { void run(); }
}

const ID_RE = /^[A-Za-z0-9_\-]{1,80}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 관리 칸(관리자 몫) — 검토자 저장에서는 받지 않고 DB 값을 둔다
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
// 캐릭터: 정해진 값만(그린이 · 곰곰이 · 본부장님 × 테두리 6색) — 그 밖의 칸은 버린다
// 별명(nick, 미니게임 베타): 캐릭터 · 색과 따로 또는 같이 받음 — 지금 문서에 합쳐 다시 만든다(별명만 바꿔도 캐릭터가, 캐릭터만 바꿔도 별명이 남음)
const CHAR_IDS = ['greenie', 'gomgom', 'boss'];
const COLOR_IDS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const NICK_MAX = 12;
const NICK_RE = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _.\-]+$/;
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nickKey = s => String(s || '').replace(/\s+/g, '').toLowerCase();   // 겹침 비교: 대소문자 · 공백 무시
// 별명 정리 → {nick: 문자열 | null(지움)} 또는 {error}
function cleanNick(v) {
  if (v === null) return { nick: null };
  if (typeof v !== 'string') return { error: 'invalid_nick' };
  const s = v.normalize('NFC').trim();
  if (!s) return { nick: null };
  if (s.length > NICK_MAX || !NICK_RE.test(s) || s.includes('  ')) return { error: 'invalid_nick' };
  return { nick: s };
}
// prev = 지금 문서 body · roster = 검토자 명단 · docs = profile 문서 전체 → {body} 또는 {error, status}
function cleanProfile(body, name, prev, roster, docs, id) {
  const hasCC = CHAR_IDS.includes(body.char) && COLOR_IDS.includes(body.color);
  const hasNick = hasKey(body, 'nick');
  if (!hasCC && !hasNick) return { error: 'invalid_body', status: 400 };
  const p = prev && typeof prev === 'object' ? prev : {};
  const out = { kind: 'profile', name };
  if (hasCC) { out.char = body.char; out.color = body.color; }
  else if (CHAR_IDS.includes(p.char) && COLOR_IDS.includes(p.color)) { out.char = p.char; out.color = p.color; }
  let nick = typeof p.nick === 'string' && p.nick ? p.nick : null;
  if (hasNick) {
    const r = cleanNick(body.nick);
    if (r.error) return { error: r.error, status: 400 };
    nick = r.nick;
    if (nick) {
      const k = nickKey(nick);
      // 다른 사람 실명(명단) · 다른 사람 별명과 겹치면 안 됨 — 자기 실명은 됨
      if (roster.some(x => x.n !== name && nickKey(x.n) === k)) return { error: 'nick_taken', status: 409 };
      if (docs.some(d => d.id !== id && d.body && typeof d.body.nick === 'string' && nickKey(d.body.nick) === k)) return { error: 'nick_taken', status: 409 };
    }
  }
  if (nick) out.nick = nick;
  out.at = new Date().toISOString();
  out.by_name = name;
  return { body: out };
}
// 채팅: 글 300자 · 표시(응원 · 질문) · 답하는 글 id — 그 밖의 칸은 버린다. 이름 · 시각 · 저장자는 서버가 채움
const CHAT_ID_RE = /^m_([0-9a-z]{6,10})_([0-9a-z]{3,10})_((?:[0-9a-f]{2}){1,30})$/;
const CHAT_TAGS = ['cheer', 'q'];
const CHAT_MAX_TEXT = 300;
const CHAT_KEEP = 300;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
function cleanChat(body, id, author, byName, del) {
  const at = new Date().toISOString();
  if (del) {
    const ts = Number(body.ts);
    return { kind: 'chat', name: author, text: '', tag: '', ts: Number.isFinite(ts) && ts > 0 ? Math.round(ts) : Date.now(), del: true, at, by_name: byName };
  }
  const text = (typeof body.text === 'string' ? body.text : '').replace(/\r\n?/g, '\n').replace(CTRL_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text || text.length > CHAT_MAX_TEXT) return null;
  const out = { kind: 'chat', name: author, text, tag: CHAT_TAGS.includes(body.tag) ? body.tag : '', ts: Date.now(), at, by_name: byName };
  if (typeof body.re === 'string' && body.re !== id && CHAT_ID_RE.test(body.re)) out.re = body.re;
  return out;
}
const chatTs = d => { const t = d && d.body && Number(d.body.ts); return Number.isFinite(t) ? t : 0; };
const MAX_BODY_BYTES = 64 * 1024;
// since 조회는 이 만큼 겹쳐서 다시 보낸다 — 커밋 순서와 updated_at 순서가 어긋나도 놓치지 않게
const SINCE_OVERLAP_MS = 60_000;

// ---------- 미니게임(베타) — 문서 모양 · 규칙은 lib/minigame.js(화면과 같은 코드)
const GAME_ACTS = ['new', 'accept', 'decline', 'cancel', 'move', 'pick', 'score', 'resign', 'apply'];
const PLAY_ACTS = ['move', 'pick', 'score', 'resign'];
const RPS_PICKS = ['r', 'p', 's'];
const EID_RE = /^[A-E]-\d{3}$/;
const fail = (error, status) => json({ error }, status);
// 가위바위보: 읽는 사람이 참가자면 상대가 나보다 더 낸 판을 '?'로 가린 사본(구경하는 사람 · 다른 게임은 그대로)
function gameView(body, name) {
  if (!body || body.g !== 'rps') return body;
  const side = mgSide(body, name);
  if (!side) return body;
  const mk = side === 'a' ? 'ra' : 'rb', ok = side === 'a' ? 'rb' : 'ra';
  const mine = Array.isArray(body[mk]) ? body[mk].length : 0;
  const oth = Array.isArray(body[ok]) ? body[ok] : [];
  if (oth.length <= mine) return body;
  return { ...body, [ok]: oth.map((p, i) => (i < mine ? p : '?')) };
}
// 지금 걸려 있는 판(신청 중 · 진행 중) — 한 사람 MG_OPEN_MAX판까지
const gameOpen = (b, now) => !!b && ((b.st === 'ask' && !mgExpired(b, now)) || (b.st === 'play' && !mgResult(b).done));

// POST coll=game: body = {act, …}. 받은 칸은 믿지 않고 서버가 저장할 칸을 만든다 → 새 판은 setDoc, 나머지는 바꾼 칸만 patchDoc
//   a 쪽 칸(ra · sa)과 b 쪽 칸(rb · sb)이 따로라 두 사람이 같은 순간에 내도 서로 덮지 않음
async function postGame(sess, id, input) {
  const me = sess.name;
  if (!me) return fail('forbidden', 403);
  if (!MG_ID_RE.test(id)) return fail('invalid_id', 400);
  const act = input.act;
  if (!GAME_ACTS.includes(act)) return fail('invalid_act', 400);
  const now = Date.now();

  // 새 판: 신청한 사람 = a(흑 · 먼저) · 받는 사람 b = 명단의 검토자 · 관리자(자기 자신 안 됨)
  if (act === 'new') {
    const { g, mode, b } = input;
    if (!MG_GAMES.includes(g)) return fail('invalid_game', 400);
    if (!MG_MODES.includes(mode)) return fail('invalid_mode', 400);
    let stake = 0;
    if (mode === 'fun') { if (input.stake != null && input.stake !== 0) return fail('invalid_stake', 400); }
    else { stake = input.stake; if (!Number.isInteger(stake) || stake < 1 || stake > MG_STAKE_MAX) return fail('invalid_stake', 400); }
    let roster, docs;
    try { [roster, docs] = await Promise.all([reviewers(), listDocs('game')]); }
    catch (e) { console.error('[POST /api/docs] game read failed:', e && e.message); return fail('store_unavailable', 502); }
    const players = roster.filter(x => x.r !== 'view').map(x => x.n);   // 로그인과 같게: 'view'가 아니면 검토자 · 관리자
    if (typeof b !== 'string' || b === me || !players.includes(b)) return fail('invalid_opponent', 400);
    if (docs.some(d => d.id === id)) return fail('exists', 409);
    if (docs.filter(d => d.body && (d.body.a === me || d.body.b === me) && gameOpen(d.body, now)).length >= MG_OPEN_MAX) return fail('limit', 409);
    const doc = { kind: 'game', g, mode, stake, a: me, b, st: 'ask', ts: now, seed: randomInt(1, 2 ** 31), by_name: me };
    try {
      const r = await setDoc('game', id, doc, me);
      return json({ ok: true, at: r.at, body: gameView(doc, me) });
    } catch (e) { console.error('[POST /api/docs] game write failed:', e && e.message); return fail('store_unavailable', 502); }
  }

  let cur;
  try { cur = await getDoc('game', id); }
  catch (e) { console.error('[POST /api/docs] game read failed:', e && e.message); return fail('store_unavailable', 502); }
  if (!cur || !cur.body || cur.body.kind !== 'game') return fail('not_found', 404);
  const G = cur.body;   // 가리지 않은 지금 문서로 판단
  const side = mgSide(G, me);
  if (act === 'apply') { if (sess.role !== 'adm') return fail('admin_only', 403); }   // 적용은 관리자만(참가자여도)
  else if (!side) return fail('not_player', 403);
  if (PLAY_ACTS.includes(act)) {
    if (G.st !== 'play') return fail('state', 409);
    if (mgResult(G).done) return fail('done', 409);
  }

  let patch;
  if (act === 'accept' || act === 'decline' || act === 'cancel') {
    if (side !== (act === 'cancel' ? 'a' : 'b')) return fail('wrong_side', 403);
    if (G.st !== 'ask') return fail('state', 409);
    if (act === 'accept' && mgExpired(G, now)) return fail('expired', 409);
    patch = act === 'accept' ? { st: 'play', t1: now } : { st: act === 'decline' ? 'no' : 'cancel' };
  } else if (act === 'move') {
    if (G.g !== 'omok') return fail('wrong_game', 400);
    if (mgTurn(G) !== side) return fail('not_your_turn', 409);
    const mv = Array.isArray(G.mv) ? G.mv : [];
    const bad = mgOmokCheck(mv, input.x, input.y);   // 'bad_cell' | 'taken' | 'forbidden'(흑 쌍삼)
    if (bad) return fail(bad, 409);
    patch = { mv: [...mv, [input.x, input.y]] };
  } else if (act === 'pick') {
    if (G.g !== 'rps') return fail('wrong_game', 400);
    if (!RPS_PICKS.includes(input.p)) return fail('invalid_pick', 400);
    const k = side === 'a' ? 'ra' : 'rb';
    const own = Array.isArray(G[k]) ? G[k] : [];
    if (!mgCanPick(G, side)) return fail('wait', 409);   // 상대가 이번 판을 낼 때까지
    if (own.length >= MG_RPS_MAX) return fail('done', 409);
    patch = { [k]: [...own, input.p] };
  } else if (act === 'score') {
    if (G.g !== 'react' && G.g !== 'quiz') return fail('wrong_game', 400);
    const k = side === 'a' ? 'sa' : 'sb';
    if (G[k]) return fail('done', 409);
    if (!mgScoreOk(G.g, input.v, input.t)) return fail('invalid_score', 400);
    patch = { [k]: { v: input.v, t: input.t, at: now } };
  } else if (act === 'resign') {
    patch = { rs: side };
  } else {   // apply — 관리자: 배팅 결과를 실제 담당에 적용한 기록
    if (G.mode !== 'bet') return fail('not_bet', 409);
    const res = mgResult(G);
    if (!res.done) return fail('not_done', 409);
    if (res.win === 'd') return fail('draw', 409);
    if (G.ap) return fail('applied', 409);
    const eids = input.eids;
    if (!Array.isArray(eids) || eids.length !== Number(G.stake) || !eids.every(e => typeof e === 'string' && EID_RE.test(e)) || new Set(eids).size !== eids.length) return fail('invalid_eids', 400);
    patch = { ap: { at: new Date(now).toISOString(), by: me, eids: [...eids] } };
  }

  const paths = Object.keys(patch);
  patch.by_name = me;   // 저장자(by_name)는 patchDoc이 늘 덮어씀
  try {
    const r = await patchDoc('game', id, patch, paths, me);
    return json({ ok: true, at: r.at, body: gameView(r.body, me) });
  } catch (e) { console.error('[POST /api/docs] game write failed:', e && e.message); return fail('store_unavailable', 502); }
}

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
    // 채팅: 검토자 · 관리자만. 처음 읽을 때는 최근 CHAT_KEEP개만
    if (coll === 'chat') {
      if (!WRITE_ROLES.has(sess.role)) docs = [];
      else {
        if (sinceMs == null && docs.length > CHAT_KEEP) docs = docs.slice().sort((a, b) => chatTs(b) - chatTs(a)).slice(0, CHAT_KEEP);
        later(async () => (await autoreply()).sweep());   // 10/1 답 없는 질문에 자동 답변(응답 뒤)
      }
    }
    // 미니게임: 검토자 · 관리자만. 가위바위보는 읽는 참가자에게 상대가 더 낸 판을 '?'로(사본 — 저장된 문서는 그대로)
    if (coll === 'game') {
      docs = WRITE_ROLES.has(sess.role) ? docs.map(d => { const v = gameView(d.body, sess.name); return v === d.body ? d : { ...d, body: v }; }) : [];
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
  // 미니게임(베타): 몸체는 행동 {act, …}만 — 서버가 검사해 판 문서를 만들고 바꿀 칸만 합친다(검토자 분기보다 먼저)
  if (coll === 'game') return postGame(sess, id, body);
  // 검토 시간: 로그인한 사람 자기 문서(time/t_<이름 hex>)만 — 몸체는 서버가 다시 만든다
  if (coll === 'time') {
    if (!sess.name || id !== timeIdOf(sess.name)) return json({ error: 'forbidden' }, 403);
    body = cleanTime(body, sess.name);
    if (!body) return json({ error: 'invalid_body' }, 400);
  }
  // 캐릭터 · 별명: 로그인한 사람 자기 문서(profile/p_<이름 hex>)만 — 지금 문서에 합쳐 서버가 다시 만든다
  else if (coll === 'profile') {
    if (!sess.name || id !== profileIdOf(sess.name)) return json({ error: 'forbidden' }, 403);
    if (paths) return json({ error: 'invalid_paths' }, 400);
    let docs, roster = [];
    try { [docs, roster] = await Promise.all([listDocs('profile'), hasKey(body, 'nick') ? reviewers() : []]); }
    catch (e) { console.error('[POST /api/docs] profile read failed:', e && e.message); return json({ error: 'store_unavailable' }, 502); }
    const prev = docs.find(d => d.id === id);
    const r = cleanProfile(body, sess.name, prev && prev.body, roster, docs, id);
    if (r.error) return json({ error: r.error }, r.status);
    body = r.body;
  }
  // 채팅: 자기 메시지(id 끝 = 로그인 이름 hex)만 — 관리자는 남의 메시지를 지우기({del:true})만. 몸체는 서버가 다시 만든다
  else if (coll === 'chat') {
    if (paths) return json({ error: 'invalid_paths' }, 400);
    const m = CHAT_ID_RE.exec(id);
    if (!m) return json({ error: 'invalid_id' }, 400);
    const del = body.del === true;
    const own = !!sess.name && m[3] === hexOf(sess.name);
    if (!own && !(del && role === 'adm')) return json({ error: 'forbidden' }, 403);
    const author = own ? sess.name : nameOfHex(m[3]);
    if (!author) return json({ error: 'invalid_id' }, 400);
    body = cleanChat(body, id, author, sess.name || author, del);
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
    // 10/1 검토자 채팅 글 → 질문이면 관리자 휴대폰 알림 · 부재 중이면 자동 답변(응답 뒤)
    if (coll === 'chat' && role !== 'adm' && !body.del) later(async () => (await autoreply()).onChatWrite(id, body));
    // profile은 합쳐 만든 문서를 돌려줌 — 별명만 보내도 화면 사본(shim)이 캐릭터를 잃지 않게
    const saved = r.body || (coll === 'profile' ? body : null);
    return json(saved ? { ok: true, at: r.at, body: saved } : { ok: true, at: r.at });
  } catch (e) {
    console.error('[POST /api/docs] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}
