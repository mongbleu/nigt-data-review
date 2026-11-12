// 미니게임(베타) 서버 시험 — 메모리 모드(STORE=memory) 개발 서버를 띄우고, 실제 로그인 경로(/api/login)로 쿠키를 받아 /api/docs game · profile을 확인한다.
//   실행: node tests/game_api.mjs   (npm ci 뒤 · 바깥 네트워크 · 실제 DB 안 씀 · 포트는 PORT 환경변수, 기본 3917)
//   비밀값 · 접속 코드는 시험마다 무작위로 만들고 어디에도 남기지 않는다. 사람 이름은 가명(검토자A · 검토자B · 검토자C · 관리자).
//   24시간 만료는 시험 전용 시계(tests/clock_preload.mjs — 서버의 Date.now를 앞으로 돌림)로 확인한다.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewerCode } from '../lib/auth.js';
import { mgResult, MG_OPEN_MAX, MG_ASK_TTL } from '../lib/minigame.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3917;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 시험용 값(무작위)
const SECRET = randomBytes(24).toString('hex');
const ACCESS = 'view-' + randomBytes(8).toString('hex');
const A = '검토자A', B = '검토자B', C = '검토자C', ADM = '관리자';
const ROSTER = [{ n: A, i: 'aa', r: 'rv' }, { n: B, i: 'bb', r: 'rv' }, { n: C, i: 'cc', r: 'rv' }, { n: ADM, i: 'gg', r: 'adm' }];
const TMP = mkdtempSync(join(tmpdir(), 'nr-game-'));
const CLOCK = join(TMP, 'clock');
writeFileSync(CLOCK, '0');

// ---------- 검사
let pass = 0, failN = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ok  ', msg); }
  else { failN++; console.log('  FAIL', msg, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function expectErr(r, status, code, msg) { ok(r.status === status && r.json && r.json.error === code, `${msg} → ${status} ${code}`, { status: r.status, json: r.json }); }
function expectOk(r, msg) { ok(r.status === 200 && r.json && r.json.ok === true, `${msg} → 200`, { status: r.status, json: r.json }); return r.json && r.json.body; }

// ---------- HTTP
async function login(code) {
  const res = await fetch(`${BASE}/api/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code }) });
  const sc = res.headers.get('set-cookie') || '';
  const m = /nr_s=([^;]+)/.exec(sc);
  if (res.status !== 303 || !m || !m[1]) throw new Error('login failed: ' + res.status + ' ' + res.headers.get('location'));
  return 'nr_s=' + m[1];
}
async function call(cookie, method, path, payload) {
  const init = { method, headers: { Accept: 'application/json', Cookie: cookie } };
  if (payload !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(payload); }
  const res = await fetch(BASE + path, init);
  let json = null;
  try { json = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, json };
}
const post = (ck, coll, id, body) => call(ck, 'POST', '/api/docs', { coll, id, body });
const list = async (ck, coll, since) => { const r = await call(ck, 'GET', `/api/docs?coll=${coll}` + (since ? `&since=${encodeURIComponent(since)}` : '')); return r.json && Array.isArray(r.json.docs) ? r.json : { docs: [], cursor: null, status: r.status }; };
const one = async (ck, id) => ((await list(ck, 'game')).docs.find(d => d.id === id) || {}).body;
const game = (ck, id, act, extra = {}) => post(ck, 'game', id, { act, ...extra });
let seq = 0;
const newId = () => 'g_' + Date.now().toString(36) + '_' + (randomBytes(3).toString('hex') + (seq++).toString(36)).slice(0, 8);
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function setClock(ms) { writeFileSync(CLOCK, String(ms)); await sleep(150); }

// ---------- 서버
let server = null, madePage = false;
const PAGE = join(ROOT, 'public', 'review.html');
async function startServer() {
  if (!existsSync(PAGE)) { writeFileSync(PAGE, '<!doctype html><title>시험</title><p>시험용 빈 화면</p>\n'); madePage = true; }   // next.config.mjs가 이 파일을 요구함
  const env = { ...process.env };
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY']) delete env[k];
  Object.assign(env, {
    STORE: 'memory', AUTH_SECRET: SECRET, APP_SECRET: 'app-' + SECRET, ACCESS_CODE: ACCESS, ADMIN_CODE: 'adm-' + randomBytes(8).toString('hex'),
    NR_REVIEWERS: JSON.stringify(ROSTER), NR_ALLOC: '{}', NEXT_TELEMETRY_DISABLED: '1', NR_TEST_CLOCK_FILE: CLOCK,
    NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --import ${join(ROOT, 'tests', 'clock_preload.mjs')}`.trim(),
  });
  server = spawn(process.execPath, [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    if (server.exitCode !== null) throw new Error('dev server exited:\n' + log.slice(-2000));
    try { const r = await fetch(`${BASE}/login`, { redirect: 'manual' }); if (r.status === 200) return () => log; } catch { /* 아직 */ }
  }
  throw new Error('dev server did not start:\n' + log.slice(-2000));
}
function stopServer() {
  if (server && server.exitCode === null) { try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* 이미 끝남 */ } } }
  if (madePage) { try { unlinkSync(PAGE); } catch { /* 없음 */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 없음 */ }
}

// ---------- 시험
async function main() {
  const getLog = await startServer();
  console.log('dev server ready on', BASE);
  const code = r => reviewerCode(r.n, r.i, '1', SECRET);
  const [ckA, ckB, ckC, ckG, ckV] = await Promise.all([...ROSTER.map(async r => login(await code(r))), login(ACCESS)]);
  const S = await Promise.all([ckA, ckG, ckV].map(ck => call(ck, 'GET', '/api/session')));
  ok(S[0].json.role === 'rv' && S[0].json.name === A && S[1].json.role === 'adm' && S[1].json.name === ADM && S[2].json.role === 'view', 'login: 검토자 · 관리자 · 보기 전용 세션');

  console.log('\n[기본 검사]');
  expectErr(await game(ckA, 'bad id', 'new'), 400, 'invalid_id', 'id 모양(ID_RE)');
  expectErr(await game(ckA, 'g_short_ab', 'new'), 400, 'invalid_id', 'id 모양(MG_ID_RE)');
  expectErr(await game(ckA, newId(), 'jump'), 400, 'invalid_act', '모르는 act');
  expectErr(await post(ckA, 'game', newId(), {}), 400, 'invalid_act', 'act 없음');
  expectErr(await game(ckA, newId(), 'new', { g: 'chess', mode: 'fun', stake: 0, b: B }), 400, 'invalid_game', '없는 게임');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'all-in', stake: 0, b: B }), 400, 'invalid_mode', '없는 방식');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'fun', stake: 2, b: B }), 400, 'invalid_stake', '심심풀이에 stake 2');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'bet', stake: 0, b: B }), 400, 'invalid_stake', '배팅 stake 0');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'bet', stake: 4, b: B }), 400, 'invalid_stake', '배팅 stake 4');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'bet', stake: 1.5, b: B }), 400, 'invalid_stake', '배팅 stake 1.5');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'fun', stake: 0, b: A }), 400, 'invalid_opponent', '자기 자신에게 신청');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'fun', stake: 0, b: '없는사람' }), 400, 'invalid_opponent', '명단에 없는 사람');
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'fun', stake: 0 }), 400, 'invalid_opponent', '상대 없음');
  expectErr(await game(ckA, newId(), 'accept'), 404, 'not_found', '없는 판 수락');
  expectErr(await call(ckA, 'POST', '/api/docs', { coll: 'game', id: newId(), body: { act: 'resign' }, paths: ['rs'] }), 400, 'invalid_paths', 'game에 paths');

  console.log('\n[오목 — 신청 · 수락 · 차례 · 자리 · 쌍삼 · 다섯]');
  const g1 = newId();
  let b = expectOk(await game(ckA, g1, 'new', { g: 'omok', mode: 'fun', stake: 0, b: B, a: C, st: 'play', seed: 5, mv: [[0, 0]], ts: 1 }), 'A → B 오목 신청(가짜 칸 섞음)');
  ok(b && b.kind === 'game' && b.g === 'omok' && b.mode === 'fun' && b.stake === 0 && b.a === A && b.b === B && b.st === 'ask' && !b.mv && b.by_name === A, '서버가 만든 문서(a = 로그인 이름 · st ask · 보낸 mv 무시)', b);
  ok(b && Number.isInteger(b.seed) && b.seed >= 1 && b.seed <= 2 ** 31 - 1 && Math.abs(b.ts - Date.now()) < 60_000, 'seed 정수 · ts 서버 시각', b && { seed: b.seed, ts: b.ts });
  expectErr(await game(ckA, g1, 'new', { g: 'omok', mode: 'fun', stake: 0, b: B }), 409, 'exists', '같은 id로 다시 신청');
  expectErr(await game(ckB, g1, 'move', { x: 7, y: 7 }), 409, 'state', '수락 전 수');
  expectErr(await game(ckA, g1, 'accept'), 403, 'wrong_side', 'a가 수락');
  expectErr(await game(ckC, g1, 'accept'), 403, 'not_player', '참가자 아닌 사람이 수락');
  expectErr(await game(ckG, g1, 'move', { x: 0, y: 0 }), 403, 'not_player', '관리자(참가자 아님)가 수');
  b = expectOk(await game(ckB, g1, 'accept'), 'B 수락');
  ok(b && b.st === 'play' && typeof b.t1 === 'number' && b.by_name === B, 'st play · t1', b);
  expectErr(await game(ckB, g1, 'accept'), 409, 'state', '다시 수락');
  expectErr(await game(ckB, g1, 'move', { x: 7, y: 7 }), 409, 'not_your_turn', '백이 먼저 둠');
  b = expectOk(await game(ckA, g1, 'move', { x: 5, y: 7, st: 'no', rs: 'b' }), 'A (5,7) — 가짜 칸 섞음');
  ok(b && eq(b.mv, [[5, 7]]) && b.st === 'play' && !b.rs, '바꾼 칸은 mv만', b);
  expectErr(await game(ckA, g1, 'move', { x: 6, y: 7 }), 409, 'not_your_turn', '흑이 두 번');
  expectErr(await game(ckB, g1, 'move', { x: 5, y: 7 }), 409, 'taken', '둔 자리');
  expectErr(await game(ckB, g1, 'move', { x: 15, y: 0 }), 409, 'bad_cell', '판 밖(15,0)');
  expectErr(await game(ckB, g1, 'move', { x: -1, y: 0 }), 409, 'bad_cell', '판 밖(-1,0)');
  expectErr(await game(ckB, g1, 'move', { x: '1', y: 1 }), 409, 'bad_cell', '숫자 아닌 x');
  expectErr(await game(ckB, g1, 'pick', { p: 'r' }), 400, 'wrong_game', '오목에 pick');
  // 흑: (5,7)(6,7) · (7,5)(7,6) → (7,7) 쌍삼 금지 / 백은 y=14에 한 칸씩 띄어 둠
  const seqMoves = [[B, 0, 14], [A, 6, 7], [B, 2, 14], [A, 7, 5], [B, 4, 14], [A, 7, 6], [B, 6, 14]];
  for (const [who, x, y] of seqMoves) expectOk(await game(who === A ? ckA : ckB, g1, 'move', { x, y }), `${who === A ? 'A' : 'B'} (${x},${y})`);
  expectErr(await game(ckA, g1, 'move', { x: 7, y: 7 }), 409, 'forbidden', '흑 (7,7) 쌍삼');
  const win = [[A, 9, 0], [B, 8, 14], [A, 10, 0], [B, 10, 14], [A, 11, 0], [B, 12, 14], [A, 12, 0], [B, 14, 14], [A, 13, 0]];
  for (const [who, x, y] of win) b = expectOk(await game(who === A ? ckA : ckB, g1, 'move', { x, y }), `${who === A ? 'A' : 'B'} (${x},${y})`);
  ok(b && b.mv.length === 17 && eq(mgResult(b), { done: true, win: 'a', why: 'five' }), '흑 다섯 → A 승', b && mgResult(b));
  expectErr(await game(ckB, g1, 'move', { x: 0, y: 0 }), 409, 'done', '끝난 판에 수');
  expectErr(await game(ckB, g1, 'resign'), 409, 'done', '끝난 판에 기권');
  const seenC = await one(ckC, g1);
  ok(seenC && seenC.mv.length === 17, '구경(검토자C)도 판을 읽음');

  console.log('\n[가위바위보 — 가림 · 동시에 내기]');
  const g2 = newId();
  expectOk(await game(ckA, g2, 'new', { g: 'rps', mode: 'fun', b: B }), 'A → B 가위바위보(stake 생략)');
  expectErr(await game(ckA, g2, 'pick', { p: 'r' }), 409, 'state', '수락 전 pick');
  expectOk(await game(ckB, g2, 'accept'), 'B 수락');
  b = expectOk(await game(ckA, g2, 'pick', { p: 'r' }), 'A 1판 r');
  ok(b && eq(b.ra, ['r']) && !(b.rb && b.rb.length), 'A 응답: 내 것 보임', b);
  ok(eq((await one(ckB, g2)).ra, ['?']), 'B가 읽으면 A의 1판은 ?');
  ok(eq((await one(ckC, g2)).ra, ['r']) && eq((await one(ckG, g2)).ra, ['r']), '구경(검토자C · 관리자)은 가리지 않음');
  expectErr(await game(ckA, g2, 'pick', { p: 'x' }), 400, 'invalid_pick', '없는 손');
  expectErr(await game(ckA, g2, 'pick', { p: 'p' }), 409, 'wait', 'B가 내기 전 A가 또 냄');
  expectErr(await game(ckA, g2, 'move', { x: 1, y: 1 }), 400, 'wrong_game', '가위바위보에 move');
  b = expectOk(await game(ckB, g2, 'pick', { p: 's' }), 'B 1판 s');
  ok(b && eq(b.ra, ['r']) && eq(b.rb, ['s']), 'B 응답: 둘 다 낸 판은 보임', b);
  // 2판: B가 먼저 → A에게는 B 2판이 ?
  expectOk(await game(ckB, g2, 'pick', { p: 'p' }), 'B 2판 p(먼저)');
  let va = await one(ckA, g2), vb = await one(ckB, g2);
  ok(eq(va.rb, ['s', '?']) && eq(va.ra, ['r']), 'A가 읽으면 B 2판은 ?', va);
  ok(eq(vb.rb, ['s', 'p']) && eq(vb.ra, ['r']), 'B 자기 것은 보임', vb);
  expectOk(await game(ckA, g2, 'pick', { p: 'p' }), 'A 2판 p(비김)');
  // 3판: 동시에
  const [ra3, rb3] = await Promise.all([game(ckA, g2, 'pick', { p: 'p' }), game(ckB, g2, 'pick', { p: 'r' })]);
  expectOk(ra3, 'A 3판 p(동시)'); expectOk(rb3, 'B 3판 r(동시)');
  va = await one(ckA, g2); vb = await one(ckC, g2);
  ok(eq(vb.ra, ['r', 'p', 'p']) && eq(vb.rb, ['s', 'p', 'r']), '동시에 낸 두 손이 모두 남음(서로 안 덮음)', vb);
  ok(eq(mgResult(va), { done: true, win: 'a', why: 'rps' }), 'A 2승 → A 승', mgResult(va));
  expectErr(await game(ckB, g2, 'pick', { p: 'r' }), 409, 'done', '끝난 판에 pick');

  console.log('\n[반응속도 · 퀴즈 — 점수]');
  const g3 = newId();
  expectOk(await game(ckA, g3, 'new', { g: 'react', mode: 'fun', stake: 0, b: B }), 'A → B 반응속도');
  expectOk(await game(ckB, g3, 'accept'), 'B 수락');
  expectErr(await game(ckA, g3, 'move', { x: 1, y: 1 }), 400, 'wrong_game', '반응속도에 move');
  expectErr(await game(ckB, g3, 'score', { v: 50, t: 100 }), 400, 'invalid_score', 'v 80ms 미만');
  expectErr(await game(ckB, g3, 'score', { v: 250.5, t: 100 }), 400, 'invalid_score', 'v 소수');
  expectErr(await game(ckB, g3, 'score', { v: '300', t: 100 }), 400, 'invalid_score', 'v 문자열');
  expectErr(await game(ckB, g3, 'score', { v: 300 }), 400, 'invalid_score', 't 없음');
  const [s1, s2] = await Promise.all([game(ckA, g3, 'score', { v: 250, t: 1250 }), game(ckB, g3, 'score', { v: 300, t: 1500 })]);
  expectOk(s1, 'A 250ms(동시)'); expectOk(s2, 'B 300ms(동시)');
  b = await one(ckC, g3);
  ok(b.sa && b.sa.v === 250 && b.sa.t === 1250 && typeof b.sa.at === 'number' && b.sb && b.sb.v === 300, 'sa · sb 둘 다 남음({v, t, at})', b);
  ok(eq(mgResult(b), { done: true, win: 'a', why: 'score' }), '빠른 A 승');
  expectErr(await game(ckA, g3, 'score', { v: 200, t: 100 }), 409, 'done', '끝난 뒤 다시 점수');
  const g4 = newId();
  expectOk(await game(ckB, g4, 'new', { g: 'quiz', mode: 'fun', stake: 0, b: A }), 'B → A 퀴즈');
  expectOk(await game(ckA, g4, 'accept'), 'A 수락');
  expectErr(await game(ckA, g4, 'score', { v: 6, t: 1000 }), 400, 'invalid_score', '퀴즈 v 6(최대 5)');
  expectErr(await game(ckA, g4, 'score', { v: 3, t: 600001 }), 400, 'invalid_score', '퀴즈 t 10분 넘음');
  expectOk(await game(ckA, g4, 'score', { v: 4, t: 9000 }), 'A 4개 9초');
  expectErr(await game(ckA, g4, 'score', { v: 5, t: 100 }), 409, 'done', '내 점수 다시');
  ok(mgResult(await one(ckA, g4)).done === false, '한 사람만 내면 아직');
  b = expectOk(await game(ckB, g4, 'score', { v: 4, t: 8000 }), 'B 4개 8초');
  ok(eq(mgResult(b), { done: true, win: 'a', why: 'score' }), '같은 수 → 빠른 B(a 쪽 = 신청한 B) 승', mgResult(b));

  console.log('\n[기권 · 거절 · 취소]');
  const g5 = newId();
  expectOk(await game(ckA, g5, 'new', { g: 'omok', mode: 'fun', stake: 0, b: B }), 'A → B 오목');
  expectErr(await game(ckA, g5, 'resign'), 409, 'state', '수락 전 기권');
  expectOk(await game(ckB, g5, 'accept'), 'B 수락');
  expectOk(await game(ckA, g5, 'move', { x: 7, y: 7 }), 'A (7,7)');
  expectErr(await game(ckC, g5, 'resign'), 403, 'not_player', '참가자 아닌 사람이 기권');
  b = expectOk(await game(ckB, g5, 'resign'), 'B 기권');
  ok(b && b.rs === 'b' && eq(mgResult(b), { done: true, win: 'a', why: 'resign' }), 'rs b → A 승', b);
  expectErr(await game(ckA, g5, 'resign'), 409, 'done', '끝난 판에 기권');
  const g6 = newId();
  expectOk(await game(ckA, g6, 'new', { g: 'omok', mode: 'fun', stake: 0, b: B }), 'A → B 오목(거절할 판)');
  expectErr(await game(ckA, g6, 'decline'), 403, 'wrong_side', 'a가 거절');
  expectErr(await game(ckB, g6, 'cancel'), 403, 'wrong_side', 'b가 취소');
  b = expectOk(await game(ckB, g6, 'decline'), 'B 거절');
  ok(b && b.st === 'no', 'st no');
  expectErr(await game(ckB, g6, 'accept'), 409, 'state', '거절한 판 수락');
  expectErr(await game(ckA, g6, 'cancel'), 409, 'state', '거절된 판 취소');
  const g7 = newId();
  expectOk(await game(ckA, g7, 'new', { g: 'rps', mode: 'fun', stake: 0, b: B }), 'A → B 가위바위보(취소할 판)');
  b = expectOk(await game(ckA, g7, 'cancel'), 'A 취소');
  ok(b && b.st === 'cancel', 'st cancel');
  expectErr(await game(ckB, g7, 'accept'), 409, 'state', '취소된 판 수락');
  expectErr(await game(ckB, g7, 'decline'), 409, 'state', '취소된 판 거절');

  console.log('\n[배팅 · 관리자 적용]');
  const g8 = newId();
  b = expectOk(await game(ckA, g8, 'new', { g: 'react', mode: 'bet', stake: 2, b: B }), 'A → B 반응속도 배팅 2');
  ok(b && b.mode === 'bet' && b.stake === 2, 'mode bet · stake 2');
  expectOk(await game(ckB, g8, 'accept'), 'B 수락');
  expectErr(await game(ckG, g8, 'apply', { eids: ['A-001', 'B-002'] }), 409, 'not_done', '끝나기 전 적용');
  expectOk(await game(ckA, g8, 'score', { v: 200, t: 1000 }), 'A 200ms');
  expectOk(await game(ckB, g8, 'score', { v: 300, t: 1000 }), 'B 300ms');
  expectErr(await game(ckB, g8, 'apply', { eids: ['A-001', 'B-002'] }), 403, 'admin_only', '참가자(검토자)가 적용');
  expectErr(await game(ckC, g8, 'apply', { eids: ['A-001', 'B-002'] }), 403, 'admin_only', '구경 검토자가 적용');
  expectErr(await game(ckG, g8, 'apply', { eids: ['A-001'] }), 400, 'invalid_eids', '요소 수 ≠ stake');
  expectErr(await game(ckG, g8, 'apply', { eids: ['A-001', 'A-001'] }), 400, 'invalid_eids', '같은 요소 두 번');
  expectErr(await game(ckG, g8, 'apply', { eids: ['A-1', 'B-002'] }), 400, 'invalid_eids', '요소 id 모양');
  expectErr(await game(ckG, g8, 'apply', { eids: ['F-001', 'B-002'] }), 400, 'invalid_eids', '없는 부문 F');
  expectErr(await game(ckG, g8, 'apply', { eids: 'A-001,B-002' }), 400, 'invalid_eids', '배열 아님');
  b = expectOk(await game(ckG, g8, 'apply', { eids: ['A-001', 'B-002'] }), '관리자 적용');
  ok(b && b.ap && b.ap.by === ADM && eq(b.ap.eids, ['A-001', 'B-002']) && !Number.isNaN(Date.parse(b.ap.at)) && b.sa.v === 200, 'ap {at, by, eids} · 다른 칸 그대로', b && b.ap);
  expectErr(await game(ckG, g8, 'apply', { eids: ['C-003', 'D-004'] }), 409, 'applied', '두 번 적용');
  expectErr(await game(ckG, g3, 'apply', { eids: [] }), 409, 'not_bet', '심심풀이 판에 적용');
  const g9 = newId();
  expectOk(await game(ckG, g9, 'new', { g: 'react', mode: 'bet', stake: 1, b: A }), '관리자 → A 배팅 1(비길 판)');
  expectOk(await game(ckA, g9, 'accept'), 'A 수락');
  await Promise.all([game(ckG, g9, 'score', { v: 222, t: 1 }), game(ckA, g9, 'score', { v: 222, t: 2 })]);
  ok(mgResult(await one(ckA, g9)).win === 'd', '같은 ms → 비김');
  expectErr(await game(ckG, g9, 'apply', { eids: ['E-010'] }), 409, 'draw', '비긴 판에 적용');

  console.log('\n[읽기 권한 · since]');
  const cur = (await list(ckA, 'game')).cursor, gs = newId();
  expectOk(await game(ckA, gs, 'new', { g: 'omok', mode: 'fun', stake: 0, b: C }), 'A → C 새 판(since 확인용)');
  const since = await list(ckA, 'game', cur);
  ok(typeof cur === 'string' && since.docs.some(d => d.id === gs) && typeof since.cursor === 'string' && since.cursor >= cur, 'since 이어 읽기에 새 판이 옴', since.docs.length);
  const vg = await call(ckV, 'GET', '/api/docs?coll=game');
  ok(vg.status === 200 && eq(vg.json.docs, []), '보기 전용 GET game → []', vg.json);
  expectErr(await game(ckV, newId(), 'new', { g: 'omok', mode: 'fun', stake: 0, b: A }), 403, 'read_only', '보기 전용 POST game');

  console.log('\n[걸어 둔 판 한도 · 24시간 만료]');
  const now0 = Date.now();
  const openOf = (docs, who) => docs.filter(d => (d.body.a === who || d.body.b === who) && ((d.body.st === 'ask' && now0 - d.body.ts <= MG_ASK_TTL) || (d.body.st === 'play' && !mgResult(d.body).done)));
  let open = openOf((await list(ckA, 'game')).docs, A);
  for (const d of open) if (d.body.st === 'ask' && d.body.a === A) await game(ckA, d.id, 'cancel');   // 앞 시험에서 남은 신청 정리
  open = openOf((await list(ckA, 'game')).docs, A);
  ok(open.length === 0, 'A가 걸어 둔 판 0개에서 시작', open.map(d => d.id));
  const lim = [];
  for (let i = 0; i < MG_OPEN_MAX; i++) { const id = newId(); lim.push(id); expectOk(await game(ckA, id, 'new', { g: 'omok', mode: 'fun', stake: 0, b: C }), `A → C 신청 ${i + 1}`); }
  expectErr(await game(ckA, newId(), 'new', { g: 'omok', mode: 'fun', stake: 0, b: B }), 409, 'limit', `A ${MG_OPEN_MAX + 1}번째 신청`);
  expectErr(await game(ckC, newId(), 'new', { g: 'omok', mode: 'fun', stake: 0, b: B }), 409, 'limit', '받은 신청도 한도에 셈(C)');
  expectOk(await game(ckC, lim[0], 'accept'), 'C가 하나 수락(진행 중도 셈)');
  expectErr(await game(ckA, newId(), 'new', { g: 'rps', mode: 'fun', stake: 0, b: B }), 409, 'limit', '진행 중 1 + 신청 4 = 한도');
  expectOk(await game(ckA, lim[1], 'cancel'), 'A가 하나 취소');
  const freed = newId();
  expectOk(await game(ckA, freed, 'new', { g: 'rps', mode: 'fun', stake: 0, b: B }), '취소하면 다시 신청됨');
  // 서버 시계를 25시간 앞으로
  await setClock(MG_ASK_TTL + 3600_000);
  expectErr(await game(ckC, lim[2], 'accept'), 409, 'expired', '24시간 지난 신청 수락');
  expectErr(await game(ckB, freed, 'accept'), 409, 'expired', '24시간 지난 신청 수락(B)');
  b = expectOk(await game(ckC, lim[3], 'decline'), '만료된 신청도 거절은 됨');
  ok(b && b.st === 'no', 'st no');
  expectOk(await game(ckA, newId(), 'new', { g: 'omok', mode: 'fun', stake: 0, b: B }), '만료된 신청은 한도에서 빠짐');
  expectOk(await game(ckA, lim[0], 'move', { x: 7, y: 7 }), '진행 중인 판은 만료 없음');
  await setClock(0);

  console.log('\n[별명(profile nick)]');
  const pA = 'p_' + hex(A), pB = 'p_' + hex(B), pC = 'p_' + hex(C);
  expectOk(await post(ckA, 'profile', pA, { char: 'greenie', color: 'c1' }), 'A 캐릭터만(예전 방식)');
  let pv = (await list(ckA, 'profile')).docs.find(d => d.id === pA).body;
  ok(pv.char === 'greenie' && pv.color === 'c1' && !('nick' in pv) && pv.name === A, '캐릭터 저장 · 별명 없음', pv);
  b = expectOk(await post(ckA, 'profile', pA, { nick: '  Green Tea ' }), 'A 별명만');
  ok(b && b.nick === 'Green Tea' && b.char === 'greenie' && b.color === 'c1' && b.kind === 'profile', '응답 body = 합쳐 만든 문서(화면 사본이 캐릭터를 잃지 않음)', b);
  pv = (await list(ckB, 'profile')).docs.find(d => d.id === pA).body;
  ok(pv.nick === 'Green Tea' && pv.char === 'greenie' && pv.color === 'c1', '별명 앞뒤 공백 정리 · 캐릭터 남음', pv);
  expectOk(await post(ckA, 'profile', pA, { char: 'boss', color: 'c2' }), 'A 캐릭터만 바꿈');
  pv = (await list(ckA, 'profile')).docs.find(d => d.id === pA).body;
  ok(pv.nick === 'Green Tea' && pv.char === 'boss' && pv.color === 'c2', '별명 남음', pv);
  expectOk(await post(ckA, 'profile', pA, { char: 'gomgom', color: 'c3', nick: 'Green Tea', kind: 'x', name: B, by_name: B }), 'A 둘 다(같은 별명 · 가짜 칸)');
  pv = (await list(ckA, 'profile')).docs.find(d => d.id === pA).body;
  ok(pv.char === 'gomgom' && pv.nick === 'Green Tea' && pv.name === A && pv.by_name === A && pv.kind === 'profile', '이름 · 저장자는 서버 값', pv);
  expectErr(await post(ckB, 'profile', pB, { nick: 'greentea' }), 409, 'nick_taken', '다른 사람 별명(대소문자 · 공백 무시)');
  expectErr(await post(ckB, 'profile', pB, { nick: 'GREEN TEA' }), 409, 'nick_taken', '다른 사람 별명(대문자)');
  expectErr(await post(ckB, 'profile', pB, { nick: '검토자 a' }), 409, 'nick_taken', '다른 사람 실명');
  expectErr(await post(ckB, 'profile', pB, { nick: '관리자' }), 409, 'nick_taken', '관리자 실명');
  expectOk(await post(ckB, 'profile', pB, { nick: '검토자 b' }), '자기 실명(공백 · 소문자)은 됨');
  expectErr(await post(ckB, 'profile', pB, { nick: 'a'.repeat(13) }), 400, 'invalid_nick', '13자');
  expectErr(await post(ckB, 'profile', pB, { nick: 'ab<c' }), 400, 'invalid_nick', '허용 안 되는 글자 <');
  expectErr(await post(ckB, 'profile', pB, { nick: '별🎮' }), 400, 'invalid_nick', '이모지');
  expectErr(await post(ckB, 'profile', pB, { nick: 'a  b' }), 400, 'invalid_nick', '두 칸 띄움');
  expectErr(await post(ckB, 'profile', pB, { nick: 123 }), 400, 'invalid_nick', '숫자형');
  expectOk(await post(ckB, 'profile', pB, { nick: 'ㅋㅋ 곰-1_.' }), '자모 · 숫자 · _ . - 허용');
  expectOk(await post(ckB, 'profile', pB, { nick: '가'.repeat(12) }), '12자');
  expectErr(await post(ckB, 'profile', pB, {}), 400, 'invalid_body', '빈 몸체');
  expectErr(await post(ckB, 'profile', pB, { char: 'dragon', color: 'c1' }), 400, 'invalid_body', '없는 캐릭터만');
  expectErr(await post(ckB, 'profile', pA, { nick: 'x' }), 403, 'forbidden', '남의 profile');
  expectOk(await post(ckA, 'profile', pA, { nick: '' }), 'A 별명 지움(빈 글)');
  pv = (await list(ckA, 'profile')).docs.find(d => d.id === pA).body;
  ok(!('nick' in pv) && pv.char === 'gomgom', '별명 없어짐 · 캐릭터 남음', pv);
  expectOk(await post(ckB, 'profile', pB, { nick: 'Green Tea' }), 'A가 지운 별명은 B가 쓸 수 있음');
  expectOk(await post(ckB, 'profile', pB, { nick: null }), 'B 별명 지움(null)');
  pv = (await list(ckB, 'profile')).docs.find(d => d.id === pB).body;
  ok(!('nick' in pv) && !('char' in pv), 'B: 별명 · 캐릭터 모두 없음', pv);
  expectOk(await post(ckC, 'profile', pC, { nick: '씨' }), 'C 처음부터 별명만');
  pv = (await list(ckV, 'profile')).docs.find(d => d.id === pC).body;
  ok(pv.nick === '씨' && !('char' in pv), '보기 전용도 별명을 읽음(순위)', pv);

  return getLog;
}

let getLog = null;
try {
  getLog = await main();
} catch (e) {
  failN++;
  console.error('시험 중단:', e && e.stack || e);
} finally {
  stopServer();
}
if (failN && getLog) console.log('\n--- 서버 로그(끝 부분) ---\n' + getLog().slice(-3000));
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
