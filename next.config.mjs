import { existsSync } from 'node:fs';

// 검토 화면(public/review.html)은 scripts/build_page.mjs가 본문 HTML에서 만든다. 없으면 빌드를 멈춘다.
if (!existsSync(new URL('./public/review.html', import.meta.url))) {
  throw new Error('public/review.html이 없습니다 — 먼저 `node scripts/build_page.mjs <본문.html>`을 실행하세요.');
}

const PAGE_HEADERS = [
  // 브라우저는 보관해도 되지만 매번 서버에 확인(304) — 새 판이 바로 보이고, 공용 캐시에는 남지 않는다
  { key: 'Cache-Control', value: 'private, no-cache' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // 로컬 시험·배포 준비용 파일은 서버리스 번들에서 뺀다
  outputFileTracingExcludes: { '*': ['./tests/**/*', './supabase/**/*', './scripts/**/*'] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      { source: '/', headers: PAGE_HEADERS },
      { source: '/review.html', headers: PAGE_HEADERS },
    ];
  },
};

export default nextConfig;
