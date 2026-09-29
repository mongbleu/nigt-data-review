// GET /login — 서버 렌더링 단순 HTML (한국어)
import { loginHtml, PLAIN_CSP } from '../../lib/page.js';
import { html } from '../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const e = new URL(request.url).searchParams.get('e');
  return html(loginHtml(e), 200, { 'Content-Security-Policy': PLAIN_CSP });
}
