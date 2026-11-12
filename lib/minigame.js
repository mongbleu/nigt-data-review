// mg_rules.js — 미니게임(베타) 공통 규칙. 서버(lib/minigame.js)와 화면(n_game.js)이 같은 코드를 쓴다.
//   서버: 이 파일을 그대로 lib/minigame.js로 복사(ES module export).
//   화면: 빌드 때 'export ' 낱말만 지워 앱 스크립트 안에 넣는다(전역 함수 · 상수가 됨 — 이름은 모두 MG_ / mg 로 시작).
//
// 문서: coll 'game', id g_<시각 36진수>_<무작위 4~8자> — body:
//   kind:'game', g:'omok'|'rps'|'react'|'quiz', mode:'fun'|'bet', stake: 0(fun) | 1~3(bet)
//   a: 신청한 사람 실명(흑 · 먼저), b: 받은 사람 실명, st:'ask'|'play'|'no'|'cancel', ts: 만든 시각(ms), t1: 수락 시각(ms), seed: 정수(퀴즈 문제 · 순서)
//   mv: [[x,y], …]   오목 수(짝수 번째 = a 흑, 홀수 번째 = b 백)
//   ra, rb: ['r'|'p'|'s', …]   가위바위보 판마다 고른 것(서버가 읽을 때 상대가 아직 안 고른 판의 내 수는 '?'로 가림)
//   sa, sb: {v, t}   반응속도(v = 평균 ms, 작을수록 이김) · 퀴즈(v = 맞힌 수, t = 걸린 ms — 같으면 빠른 쪽)
//   rs: 'a'|'b'   기권한 쪽
//   ap: {at, by, eids:[…]}   배팅 결과를 관리자가 실제 담당에 적용한 기록(베타에서는 기본 꺼짐)
//
// 행동(POST body.act) — 서버가 검사하고 바꿀 칸만 patch한다(동시에 둘이 써도 서로 덮지 않게 a · b 칸을 나눔):
//   new {g, mode, stake, b}   · accept / decline (b만, st ask) · cancel (a만, st ask)
//   move {x, y} (오목) · pick {p} (가위바위보) · score {v, t} (반응속도 · 퀴즈) · resign · apply {eids} (관리자만)

export const MG_GAMES = ['omok', 'rps', 'react', 'quiz'];
export const MG_GAME_NM = { omok: '오목', rps: '가위바위보(3판 2선승)', react: '반응속도 대결', quiz: '데이터 요소 퀴즈' };
export const MG_MODES = ['fun', 'bet'];
export const MG_MODE_NM = { fun: '심심풀이', bet: '배팅' };
export const MG_STAKE_MAX = 3;
export const MG_N = 15;                         // 오목 판 15×15
export const MG_ASK_TTL = 24 * 3600 * 1000;     // 신청은 24시간 뒤 만료
export const MG_OPEN_MAX = 5;                   // 한 사람이 동시에 걸어 둘 수 있는 판(신청 중 + 진행 중)
export const MG_RPS_WIN = 2, MG_RPS_MAX = 9;     // 2판 먼저 이기면 승 · 비김 포함 9판이 지나면 앞선 쪽(같으면 무승부)
export const MG_REACT_TRIES = 5, MG_REACT_MIN = 80, MG_REACT_MAX = 3000;
export const MG_QUIZ_N = 5, MG_QUIZ_MAX_MS = 600000;
export const MG_ID_RE = /^g_[0-9a-z]{6,10}_[0-9a-z]{4,8}$/;

export const mgSide = (b, name) => (b && name ? (b.a === name ? 'a' : b.b === name ? 'b' : null) : null);
export const mgOther = s => (s === 'a' ? 'b' : 'a');
export const mgExpired = (b, now) => !!b && b.st === 'ask' && (now - (Number(b.ts) || 0)) > MG_ASK_TTL;

// ---------- 오목
export function mgBoard(mv){
  const B = Array.from({length: MG_N}, () => Array(MG_N).fill(0));   // 0 빈칸 · 1 흑(a) · 2 백(b)
  (mv || []).forEach(([x, y], i) => { if (B[y] && B[y][x] === 0) B[y][x] = i % 2 === 0 ? 1 : 2; });
  return B;
}
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const at = (B, x, y) => (x < 0 || y < 0 || x >= MG_N || y >= MG_N ? -1 : B[y][x]);   // -1 = 판 밖
// (x,y)를 지나는 한 방향 줄의 같은 돌 수
function runLen(B, x, y, dx, dy, c){
  let n = 1;
  for (let k = 1; at(B, x + dx * k, y + dy * k) === c; k++) n++;
  for (let k = 1; at(B, x - dx * k, y - dy * k) === c; k++) n++;
  return n;
}
export function mgFive(B, x, y){ const c = B[y][x]; return !!c && DIRS.some(([dx, dy]) => runLen(B, x, y, dx, dy, c) >= 5); }
// 열린 3: 그 방향 칸 -4~+4를 문자열로 만들어 「돌 하나만 더 두면 양쪽이 열린 4(.XXXX.)가 되는」 자리가 있는지
function openThree(B, x, y, dx, dy, c){
  const cell = k => { const v = at(B, x + dx * k, y + dy * k); return v === c ? 'X' : v === 0 ? '.' : 'O'; };
  for (let k = -4; k <= 4; k++){
    if (k === 0 || cell(k) !== '.') continue;
    // k에 하나 더 두었다고 보고 0을 지나는 「.XXXX.」가 생기는지
    const line = []; for (let j = -5; j <= 5; j++) line.push(j === k ? 'X' : cell(j));
    const sLine = line.join('');
    for (let st = 0; st + 6 <= sLine.length; st++){
      const w = sLine.slice(st, st + 6), from = st - 5;   // w[0]의 상대 위치
      if (w === '.XXXX.' && from + 1 <= 0 && 0 <= from + 4) return true;
    }
  }
  return false;
}
// 흑(1)만 쌍삼 금지 — 다섯을 만드는 수는 허용
export function mgForbidden(mv, x, y){
  if ((mv || []).length % 2 !== 0) return false;
  const B = mgBoard(mv); if (B[y][x] !== 0) return false;
  B[y][x] = 1;
  if (mgFive(B, x, y)) return false;
  let n = 0; for (const [dx, dy] of DIRS) if (openThree(B, x, y, dx, dy, 1)) n++;
  return n >= 2;
}
export function mgOmokCheck(mv, x, y){
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MG_N || y >= MG_N) return 'bad_cell';
  const B = mgBoard(mv); if (B[y][x] !== 0) return 'taken';
  if (mgForbidden(mv, x, y)) return 'forbidden';
  return null;
}

// ---------- 가위바위보
const BEATS = { r: 's', s: 'p', p: 'r' };
export function mgRpsScore(ra, rb){
  ra = ra || []; rb = rb || [];
  const n = Math.min(ra.length, rb.length); let a = 0, b = 0, played = 0;
  for (let i = 0; i < n; i++){
    if (ra[i] === '?' || rb[i] === '?') break;
    played++;
    if (BEATS[ra[i]] === rb[i]) a++; else if (BEATS[rb[i]] === ra[i]) b++;
    if (a >= MG_RPS_WIN || b >= MG_RPS_WIN) break;
  }
  return { a, b, played };
}

// ---------- 결과(서버 · 화면 같은 판단)
//   {done, win:'a'|'b'|'d'|null, why:'five'|'full'|'resign'|'rps'|'score'|null}
export function mgResult(b){
  if (!b || b.st !== 'play') return { done: false, win: null, why: null };
  if (b.rs === 'a' || b.rs === 'b') return { done: true, win: mgOther(b.rs), why: 'resign' };
  if (b.g === 'omok'){
    const mv = b.mv || []; if (!mv.length) return { done: false, win: null, why: null };
    const B = mgBoard(mv), [x, y] = mv[mv.length - 1];
    if (mgFive(B, x, y)) return { done: true, win: (mv.length - 1) % 2 === 0 ? 'a' : 'b', why: 'five' };
    if (mv.length >= MG_N * MG_N) return { done: true, win: 'd', why: 'full' };
    return { done: false, win: null, why: null };
  }
  if (b.g === 'rps'){
    const r = mgRpsScore(b.ra, b.rb);
    if (r.a >= MG_RPS_WIN) return { done: true, win: 'a', why: 'rps' };
    if (r.b >= MG_RPS_WIN) return { done: true, win: 'b', why: 'rps' };
    if (r.played >= MG_RPS_MAX) return { done: true, win: r.a > r.b ? 'a' : r.b > r.a ? 'b' : 'd', why: 'rps' };
    return { done: false, win: null, why: null };
  }
  if (b.g === 'react' || b.g === 'quiz'){
    const A = b.sa, Bb = b.sb;
    if (!A || !Bb) return { done: false, win: null, why: null };
    let w;
    if (b.g === 'react') w = A.v < Bb.v ? 'a' : Bb.v < A.v ? 'b' : 'd';
    else w = A.v > Bb.v ? 'a' : Bb.v > A.v ? 'b' : (A.t < Bb.t ? 'a' : Bb.t < A.t ? 'b' : 'd');
    return { done: true, win: w, why: 'score' };
  }
  return { done: false, win: null, why: null };
}

// 지금 누가 둘 차례인가(오목) / 내가 지금 낼 수 있나(가위바위보) — 화면 안내용
export function mgTurn(b){ return b && b.g === 'omok' ? ((b.mv || []).length % 2 === 0 ? 'a' : 'b') : null; }
export function mgCanPick(b, side){
  const own = (b[side === 'a' ? 'ra' : 'rb'] || []).length, oth = (b[side === 'a' ? 'rb' : 'ra'] || []).length;
  return own <= oth;
}
// 점수 범위 검사(반응속도 · 퀴즈)
export function mgScoreOk(g, v, t){
  if (!Number.isFinite(v) || !Number.isFinite(t)) return false;
  if (g === 'react') return Number.isInteger(v) && v >= MG_REACT_MIN && v <= MG_REACT_MAX && t >= 0;
  if (g === 'quiz') return Number.isInteger(v) && v >= 0 && v <= MG_QUIZ_N && t >= 0 && t <= MG_QUIZ_MAX_MS;
  return false;
}
// 같은 seed → 같은 순서(퀴즈 문제 고르기 · 보기 섞기). mulberry32
export function mgRand(seed){
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// 배팅 결과: 진 사람이 이긴 사람의 담당 데이터 요소 stake개를 넘겨받음(가상 장부 · 관리자 스위치가 켜졌을 때만 실제 적용)
export function mgBetOutcome(b){
  const r = mgResult(b);
  if (!b || b.mode !== 'bet' || !r.done || r.win === 'd') return null;
  const W = r.win === 'a' ? b.a : b.b, L = r.win === 'a' ? b.b : b.a;
  return { winner: W, loser: L, n: Math.max(1, Math.min(MG_STAKE_MAX, Number(b.stake) || 1)) };
}
