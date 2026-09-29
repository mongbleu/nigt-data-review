// POST /api/login — 공용 접속코드 확인 → 서명 쿠키 설정 → / 로 303
import { authSecret, codeMatches, signSession, sessionCookie } from '../../../lib/auth.js';
import { seeOther } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FAIL_DELAY_MS = 500;

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

export async function POST(request) {
  const code = (await readCode(request)).trim().slice(0, 256);
  const secret = authSecret();
  const accessCode = process.env.ACCESS_CODE || '';
  const adminCode = process.env.ADMIN_CODE || '';
  if (!secret || (!accessCode && !adminCode)) {
    console.error('[login] AUTH_SECRET(16자 이상)과 ACCESS_CODE/ADMIN_CODE를 설정해야 합니다');
    return seeOther('/login?e=2');
  }
  // 두 코드를 항상 모두 비교 (응답 시간으로 구분되지 않게)
  const [isAdm, isRev] = await Promise.all([codeMatches(code, adminCode), codeMatches(code, accessCode)]);
  const role = isAdm ? 'adm' : isRev ? 'rev' : null;
  if (!role) {
    await new Promise(r => setTimeout(r, FAIL_DELAY_MS));
    return seeOther('/login?e=1');
  }
  return seeOther('/', { 'Set-Cookie': sessionCookie(await signSession(role, secret)) });
}

export async function GET() {
  return seeOther('/login');
}
