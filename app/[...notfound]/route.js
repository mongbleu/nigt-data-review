// 없는 주소 — 한국어 404 (API 경로는 JSON). public/ 파일과 다른 라우트가 먼저 처리된다.
import { notFoundHtml, PLAIN_CSP } from '../../lib/page.js';
import { html, json } from '../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notFound(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/api' || pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
  return html(notFoundHtml(), 404, { 'Content-Security-Policy': PLAIN_CSP });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
