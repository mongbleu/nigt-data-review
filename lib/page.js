// 로그인 · 404 화면 (서버 렌더링 단순 HTML). 검토 화면은 public/review.html(정적 파일)이다.
import { escapeHtml } from './http.js';

export const PLAIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const PLAIN_CSS = `
:root{--ground:#F2F4F1;--surface:#FFFFFF;--ink:#1B2A30;--muted:#5B686C;--line:#D7DDD7;--line-strong:#BCC6BF;--accent:#1E6B66;--accent-ink:#FFFFFF;--fix:#AD3F3B;--fix-soft:#F6E1DF;--shadow:0 1px 2px rgba(20,40,40,.06),0 4px 14px rgba(20,40,40,.06)}
@media (prefers-color-scheme: dark){:root{--ground:#0F1513;--surface:#161E1B;--ink:#E3EAE6;--muted:#A2AFAA;--line:#29342F;--line-strong:#3A4842;--accent:#5DB2A7;--accent-ink:#0C1412;--fix:#E58B85;--fix-soft:#3A1E1C;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 18px rgba(0,0,0,.25)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px 16px;background:var(--ground);color:var(--ink);font:14px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:24px 22px;box-shadow:var(--shadow);display:grid;gap:16px}
h1{margin:0;font-size:19px;font-weight:700;letter-spacing:-.01em}
p{margin:0}
form{display:grid;gap:10px}
label{font-size:13px;color:var(--muted)}
input{width:100%;font:inherit;color:inherit;padding:9px 11px;border:1px solid var(--line-strong);border-radius:8px;background:var(--ground)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{font:inherit;font-weight:600;padding:9px 12px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer}
.err{font-size:13px;color:var(--fix);background:var(--fix-soft);border-radius:8px;padding:7px 10px}
.small{font-size:12.5px;color:var(--muted)}
a{color:var(--accent)}
`;

function plainPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
<style>${PLAIN_CSS}</style>
</head>
<body>
<main>
${bodyHtml}
</main>
</body>
</html>
`;
}

export const SITE_TITLE = '전략지도 데이터 검토 창구';

export function loginHtml(errorCode) {
  const msg = errorCode === '1' ? '접속 코드가 맞지 않습니다'
    : errorCode === '2' ? '서버 설정이 끝나지 않았습니다. 정유정에게 알려 주세요.'
    : '';
  return plainPage(SITE_TITLE, `<h1>${SITE_TITLE}</h1>
<form method="post" action="/api/login">
<label for="code">접속 코드</label>
<input id="code" name="code" type="password" autocomplete="current-password" required autofocus aria-describedby="hint${msg ? ' err" aria-invalid="true' : ''}">
<p class="small" id="hint">메일로 받은 검토자 코드(8자리 숫자 + 이름 이니셜, 예: 12345678abc)를 넣어 주세요.</p>
${msg ? `<p class="err" id="err" role="alert">${escapeHtml(msg)}</p>\n` : ''}<button type="submit">들어가기</button>
</form>`);
}

export function notFoundHtml() {
  return plainPage(SITE_TITLE, `<h1>페이지를 찾을 수 없습니다</h1>
<p class="small"><a href="/">검토 창구로 돌아가기</a></p>`);
}
