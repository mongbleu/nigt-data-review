// 응답 공통 헤더·헬퍼 (Node 라우트 핸들러용)

export const NO_STORE = 'no-store';

const BASE_HEADERS = {
  'Cache-Control': NO_STORE,
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

export function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', ...extra },
  });
}

// 상대 경로 Location으로 303 (호스트 헤더에 의존하지 않음)
export function seeOther(location, extra = {}) {
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: location, ...extra } });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
