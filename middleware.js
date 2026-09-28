// Edge 미들웨어 — 공개 경로 외 전부 보호. Web Crypto만 사용.
//   인증됨:  /  → public/review.html 을 그대로 보낸다(정적 파일 rewrite — 서버리스 응답 한도와 무관)
//   미인증:  페이지는 /login 으로 303, /api/* 는 401 JSON. /review.html 직접 접근도 같다.
import { NextResponse } from 'next/server';
import { roleFromRequest } from './lib/auth.js';

// /api/logout은 세션이 이미 만료된 상태에서도 로그인 화면으로 보내야 하므로 공개
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/logout', '/favicon.ico']);
const PAGE = '/review.html';

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_next/')) return NextResponse.next();

  const role = await roleFromRequest(request);
  if (role) {
    if (pathname === '/') return NextResponse.rewrite(new URL(PAGE, request.url));
    return NextResponse.next();
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } },
    );
  }
  const res = NextResponse.redirect(new URL('/login', request.url), 303);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export const config = {
  matcher: ['/((?!_next/|favicon.ico).*)'],
};
