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

// 10/1 JSON 요청 몸체(/api/ai · /api/push) — application/json만 · 크기 한도 · 객체만 → {data} 또는 {res: 오류 응답}
export async function readJson(request, maxBytes = 16 * 1024) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return { res: json({ error: 'unsupported_media_type' }, 415) };
  if (Number(request.headers.get('content-length') || 0) > maxBytes) return { res: json({ error: 'too_large' }, 413) };
  let raw;
  try { raw = await request.text(); } catch { return { res: json({ error: 'bad_request' }, 400) }; }
  if (raw.length > maxBytes) return { res: json({ error: 'too_large' }, 413) };
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return { data };
  } catch { /* 아래 */ }
  return { res: json({ error: 'invalid_json' }, 400) };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
