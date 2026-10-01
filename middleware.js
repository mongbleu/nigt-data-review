// Edge 미들웨어 — 공개 경로 외 전부 보호. Web Crypto만 사용.
//   인증됨:  /  → public/review.html 을 그대로 보낸다(정적 파일 rewrite — 서버리스 응답 한도와 무관)
//   미인증:  페이지는 /login 으로 303, /api/* 는 401 JSON. /review.html 직접 접근도 같다.
import { NextResponse } from 'next/server';
import { roleFromRequest } from './lib/auth.js';

// /api/logout은 세션이 이미 만료된 상태에서도 로그인 화면으로 보내야 하므로 공개
// 9/30: 📱 앱 설치(홈 화면에 추가) — 설치 정보(manifest)와 아이콘은 로그인 전에도 읽혀야 함(브라우저가 쿠키 없이 가져감)
// 10/1: 서비스 워커(/sw.js — 휴대폰 알림 전용)도 공개 — 브라우저가 로그인과 무관하게 업데이트를 확인하고, 리디렉트되면 등록이 깨진다
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/logout', '/favicon.ico', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/sw.js']);
const PAGE = '/review.html';

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_next/')) {
    if (pathname === '/apple-touch-icon-precomposed.png') return NextResponse.rewrite(new URL('/apple-touch-icon.png', request.url));
    return NextResponse.next();
  }

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
