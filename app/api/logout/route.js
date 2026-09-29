// GET /api/logout — 쿠키 삭제 → /login
import { clearedSessionCookie } from '../../../lib/auth.js';
import { seeOther } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return seeOther('/login', { 'Set-Cookie': clearedSessionCookie() });
}
