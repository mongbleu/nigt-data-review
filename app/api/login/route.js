// POST /api/login — 접속 코드 확인 → 서명 쿠키 설정 → / 로 303
//   검토자 코드(8자리 숫자 + 이니셜): 그 검토자로 로그인(담당 요소만 저장) · 관리자 코드(ADMIN_CODE): 정유정 · 공용 코드(ACCESS_CODE): 보기 전용
import { authSecret, codeMatches, signSession, sessionCookie, reviewerCode, normalizeCode, CODE_RE } from '../../../lib/auth.js';
import { reviewers, codeVersion } from '../../../lib/store.js';
import { seeOther } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FAIL_DELAY_MS = 500;
const ADMIN_NAME = '정유정';
// 9/29: 환경변수·입력의 앞뒤 공백은 떼고, 공용·관리자 코드는 대소문자 · 가운데 공백 · 하이픈 차이도 같은 코드로 본다
const clean = s => String(s || '').trim();
const loose = s => clean(s).replace(/[\s-]+/g, '').toLowerCase();

async function readCode(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  try {
    if (ct.startsWith('application/x-www-form-urlencoded') || ct.startsWith('multipart/form-data')) {
      const form = await request.formData();
      return String(form.get('code') ?? '');
    }
    if (ct.startsWith('application/json')) {
      const b = await request.json();
      return String((b && b.code) ?? '');
    }
  } catch {
    // 형식이 깨진 요청은 틀린 코드로 처리
  }
  return '';
}

// 검토자 코드면 {role, name}, 아니면 null (이니셜로 사람을 찾고 코드 전체를 같은 시간 비교)
async function matchReviewer(code, secret) {
  const m = CODE_RE.exec(normalizeCode(code));
  if (!m) return null;
  let list = [], ver = '1';
  try { [list, ver] = await Promise.all([reviewers(), codeVersion()]); } catch (e) { console.error('[login] 검토자 명단을 읽지 못했습니다:', e && e.message); return null; }
  const who = list.find(x => String(x.i).toLowerCase() === m[2]);
  if (!who) return null;
  const expected = await reviewerCode(who.n, who.i, ver, secret);
  if (!(await codeMatches(m[1] + m[2], expected))) return null;
  const role = who.r === 'adm' ? 'adm' : who.r === 'view' ? 'view' : 'rv';
  return { role, name: who.n };
}

export async function POST(request) {
  const raw = (await readCode(request)).trim().slice(0, 256);
  const secret = authSecret();
  const accessCode = clean(process.env.ACCESS_CODE);
  const adminCode = clean(process.env.ADMIN_CODE);
  if (!secret) {
    console.error('[login] AUTH_SECRET(16자 이상) 또는 APP_SECRET을 설정해야 합니다');
    return seeOther('/login?e=2');
  }
  // 세 가지를 모두 비교 (응답 시간으로 구분되지 않게)
  const [rv, isAdm, isView, admL, viewL] = await Promise.all([matchReviewer(raw, secret), codeMatches(raw, adminCode), codeMatches(raw, accessCode),
    codeMatches(loose(raw), loose(adminCode)), codeMatches(loose(raw), loose(accessCode))]);
  const adm = isAdm || admL, view = isView || viewL;
  const who = rv || (adm ? { role: 'adm', name: ADMIN_NAME } : view ? { role: 'view', name: null } : null);
  if (!who) {
    // 진단용(값은 남기지 않음): 환경변수가 있는지 · 앞뒤 공백이 있었는지 · 검토자 코드 모양인지
    console.warn('[login] 코드 불일치', JSON.stringify({ admin_set: !!adminCode, access_set: !!accessCode,
      admin_env_had_space: (process.env.ADMIN_CODE || '') !== adminCode, access_env_had_space: (process.env.ACCESS_CODE || '') !== accessCode,
      reviewer_like: CODE_RE.test(normalizeCode(raw)), input_empty: !raw }));
    await new Promise(r => setTimeout(r, FAIL_DELAY_MS));
    return seeOther('/login?e=1');
  }
  return seeOther('/', { 'Set-Cookie': sessionCookie(await signSession(who.role, who.name, secret)) });
}

export async function GET() {
  return seeOther('/login');
}
