#!/usr/bin/env node
// 검토 창구 본문 HTML(아티팩트 게시본과 같은 파일) 하나 → public/review.html (온전한 HTML 문서)
//
//   node scripts/build_page.mjs <본문.html> [--out public/review.html] [--no-exit] [--cdn]
//
// 하는 일 (앱 로직은 건드리지 않는다)
//   1. 앞의 아티팩트 껍데기(doctype · <head>의 charset/viewport/리셋 style · <body>)를 걷고,
//      doctype · <html lang="ko"> · charset · viewport · noindex · CSP · 제목을 갖춘 문서 하나로 다시 짠다.
//      껍데기의 리셋 style과 본문 앞머리의 <title>/<link>/<style>은 순서 그대로 <head>로 옮긴다(화면 동일).
//   2. 엑셀 라이브러리(xlsx-js-style 1.2.0) CDN 주소 → /vendor/xlsx.bundle.js (같은 서버, 해시 확인).
//      파일이 없으면 CDN에서 받아 해시를 맞춰 보고 저장한다. 받을 수 없거나 --cdn이면 CDN 주소를 그대로 둔다.
//   3. shim(/shim.js — window.claude 대역)을 앱 스크립트 바로 앞에 넣는다.
//   4. 문자열 치환(PATCHES) — 치환마다 정확히 정해진 횟수만 맞는지 확인하고, 아니면 멈춘다.
//   5. 인라인 앱 스크립트의 sha256을 계산해 <meta http-equiv="Content-Security-Policy">에 넣는다.
//   6. (9/30) DATA.build.id(화면 판 번호)를 <meta name="nr-build">로 넣는다 — Vercel 빌드 때 scripts/fetch_page.mjs가 읽어
//      public/version.json을 만들고, 열어 둔 화면이 그 파일로 새 판을 알아챈다(「지금 업데이트」 안내).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'public', 'review.html');
const VENDOR_FILE = path.join(ROOT, 'public', 'vendor', 'xlsx.bundle.js');
const VENDOR_URL = '/vendor/xlsx.bundle.js';
const SHIM_URL = '/shim.js';
const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
// npm xlsx-js-style@1.2.0 dist/xlsx.bundle.js (npm 묶음 · jsDelivr 사본이 같은 해시)
const XLSX_SRI = 'sha384-OUW9euuUyxyHcAhTqbhI+Iyb8LMssXt/cpz0yXhs9UWG2/R/uaWdakx/4cfww7Vb';
const DEFAULT_TITLE = '전략지도 데이터 검토 창구';

// 웹앱에서 틀리는 아티팩트 전용 문구만 고친다. count = 본문에서 정확히 몇 번 나와야 하는지(기본 1).
// 새 판에서 문구가 바뀌어 개수가 안 맞으면 빌드가 멈춘다 → 이 목록을 그 판에 맞게 고친다.
// (7판 본문에는 claude.ai 전용 안내 문구가 없어 비어 있다. 아래 ARTIFACT_WORDS 경고를 참고.)
const PATCHES = [
  // { find: 'claude.ai에 저장됩니다', replace: '검토 서버에 저장됩니다', why: '저장 위치 안내' },
];

// 머리 오른쪽 위 「로그아웃」(세션 쿠키 지우기) — 치환 한 곳 + 스타일. --no-exit이면 넣지 않는다.
// 9/30: 「나가기」 → 「로그아웃」 · 크게 · 테두리 · 첫 줄(탭 줄) 오른쪽에 자리를 비워 탭과 겹치지 않게
const EXIT_PATCH = {
  find: '<header class="top">',
  replace: '<header class="top">\n    <a class="nr-exit" href="/api/logout" title="로그아웃 — 다른 검토자 코드로 들어갈 때도 먼저 로그아웃">로그아웃</a>',
  why: '로그아웃 버튼',
};
const EXIT_CSS = '.nr-exit{position:absolute;top:12px;right:16px;z-index:3;display:inline-flex;align-items:center;padding:7px 16px;border:2px solid var(--line-strong);border-radius:10px;background:var(--surface);color:var(--ink);font-size:14.5px;font-weight:700;line-height:1.25;text-decoration:none;box-shadow:0 1px 0 var(--line)}'
  + '.nr-exit:hover,.nr-exit:focus-visible{border-color:var(--accent);color:var(--accent)}'
  + 'header.top>.top-row:first-of-type{padding-right:124px}'
  + '@media (max-width:640px){header.top>.top-row:first-of-type{padding-right:0;padding-top:44px}}';

// 웹앱에 남으면 어색한 말 — 빌드 끝에 위치를 보여 준다(멈추지는 않음). DATA 안은 보지 않는다.
const ARTIFACT_WORDS = /claude\.ai|아티팩트|artifact|Claude 계정|claude 계정/gi;

// ---------------------------------------------------------------- 인자
function parseArgs(argv) {
  const o = { input: null, out: DEFAULT_OUT, exit: true, cdn: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = path.resolve(argv[++i] || '');
    else if (a === '--no-exit') o.exit = false;
    else if (a === '--cdn') o.cdn = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`모르는 옵션: ${a}`);
    else if (!o.input) o.input = path.resolve(a);
    else throw new Error(`본문 파일은 하나만: ${a}`);
  }
  return o;
}

const fail = (msg) => { throw new Error(msg); };
const sha = (alg, data) => crypto.createHash(alg).update(data).digest('base64');
const countOf = (s, sub) => (sub ? s.split(sub).length - 1 : 0);

// ---------------------------------------------------------------- 1. 껍데기 걷기
function stripShell(src) {
  // 브라우저도 줄바꿈을 LF로 맞춘 뒤 읽는다 — CSP 해시가 브라우저 계산과 같아지게 먼저 맞춘다
  let s = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const shellStyles = [];
  let title = null;
  const eat = (re) => {
    const m = s.match(re);
    if (!m) return null;
    s = s.slice(m[0].length);
    return m;
  };
  eat(/^\s*<!doctype[^>]*>/i);
  eat(/^\s*<html\b[^>]*>/i);
  const head = eat(/^\s*<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
  if (head) {
    const inner = head[1];
    for (const m of inner.matchAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>|<link\b[^>]*>/gi)) shellStyles.push(m[0]);
    const t = inner.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
    if (t) title = t[1].trim();
    const rest = inner
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>|<link\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
      .replace(/<meta\b[^>]*>/gi, '')
      .trim();
    if (rest) fail(`껍데기 <head>에 모르는 내용이 있습니다: ${rest.slice(0, 120)}`);
  }
  eat(/^\s*<body\b[^>]*>/i);
  s = s.replace(/<\/body\s*>\s*(<\/html\s*>)?\s*$/i, '').replace(/<\/html\s*>\s*$/i, '');
  return { body: s, shellStyles, title };
}

// 본문 앞머리의 <title> · <link> · <style> · <meta> · 주석을 떼어 <head>로 옮긴다(순서 유지)
function splitHeadish(body) {
  const moved = [];
  let title = null;
  let s = body;
  for (;;) {
    const m = s.match(/^\s*(<title\b[^>]*>[\s\S]*?<\/title\s*>|<link\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<meta\b[^>]*>|<!--[\s\S]*?-->)/i);
    if (!m) break;
    const tag = m[1];
    s = s.slice(m[0].length);
    if (/^<title/i.test(tag)) title = tag.replace(/^<title\b[^>]*>|<\/title\s*>$/gi, '').trim();
    else if (/^<meta/i.test(tag)) continue; // charset·viewport는 새로 쓴다
    else moved.push(tag);
  }
  return { headish: moved, title, markup: s.replace(/^\s+/, '') };
}

// ---------------------------------------------------------------- 스크립트 찾기
function scanScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i) || [])[1] || null;
    const type = ((attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '').toLowerCase();
    const executable = !src && (!type || /^(text|application)\/(javascript|ecmascript)$/.test(type) || type === 'module');
    out.push({ start: m.index, end: m.index + m[0].length, full: m[0], attrs, src, type, text: m[2], executable });
  }
  return out;
}

// ---------------------------------------------------------------- 2. 엑셀 라이브러리
async function ensureVendor(useCdn) {
  if (useCdn) return { mode: 'cdn', note: '--cdn 옵션' };
  try {
    const buf = await fs.readFile(VENDOR_FILE);
    const got = 'sha384-' + sha('sha384', buf);
    if (got !== XLSX_SRI) fail(`${path.relative(ROOT, VENDOR_FILE)} 해시가 다릅니다 (${got}). 지우고 다시 실행하면 새로 받습니다.`);
    return { mode: 'vendor', bytes: buf.length };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    const res = await fetch(XLSX_CDN, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = 'sha384-' + sha('sha384', buf);
    if (got !== XLSX_SRI) throw new Error(`해시 불일치 ${got}`);
    await fs.mkdir(path.dirname(VENDOR_FILE), { recursive: true });
    await fs.writeFile(VENDOR_FILE, buf);
    return { mode: 'vendor', bytes: buf.length, note: 'CDN에서 새로 받음' };
  } catch (e) {
    return { mode: 'cdn', note: `내려받기 실패(${e.message}) — CDN 주소 유지` };
  }
}

// ---------------------------------------------------------------- shim 대조
// public/shim.js가 구현한 window.claude 범위. 앱 스크립트가 이 밖의 것을 부르면 경고한다(새 판 점검용).
const SHIM_API = {
  use: ['db', 'user', 'downloads'],
  db: ['collection', 'doc'],
  ref: ['onSnapshot', 'set', 'refresh'],    // db.collection(c).* · db.doc(p).*   (refresh — 9/30 채팅: 지금 한 번 더 읽기)
  user: ['id', 'can', 'isOwner', 'canEdit', 'name', 'role'],
  downloads: ['save'],
};
export function shimCoverage(js) {
  const warn = [];
  const uses = [...js.matchAll(/\.use\(\s*['"]([\w-]+)['"]\s*\)/g)].map(m => m[1]);
  for (const u of new Set(uses)) if (!SHIM_API.use.includes(u)) warn.push(`shim에 없는 window.claude.use('${u}')`);
  for (const m of js.matchAll(/(?<![\w$.])db\.(\w+)\(/g)) if (!SHIM_API.db.includes(m[1])) warn.push(`shim에 없는 db.${m[1]}()`);
  for (const m of js.matchAll(/(?<![\w$.])db\.(collection|doc)\((?:[^()]|\([^()]*\))*\)\.(\w+)/g)) if (!SHIM_API.ref.includes(m[2])) warn.push(`shim에 없는 db.${m[1]}(…).${m[2]}()`);
  // use('user') · use('downloads')를 받은 변수 이름을 찾아 그 메서드를 본다
  const bound = { user: new Set(['userNs', 'uNs']), downloads: new Set(['downloads']) };
  for (const m of js.matchAll(/\[\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*await\s+Promise\.all\(\[\s*\w+\.use\('(\w+)'\)\s*,\s*\w+\.use\('(\w+)'\)\s*,\s*\w+\.use\('(\w+)'\)/g)) {
    for (let i = 0; i < 3; i++) if (bound[m[4 + i]]) bound[m[4 + i]].add(m[1 + i]);
  }
  for (const [ns, names] of Object.entries(bound)) {
    for (const v of names) {
      for (const m of js.matchAll(new RegExp(`(?<![\\w$.])${v}\\.(\\w+)\\(`, 'g'))) if (!SHIM_API[ns].includes(m[1])) warn.push(`shim에 없는 ${ns}.${m[1]}()`);
    }
  }
  if (!uses.length) warn.push('앱 스크립트에서 window.claude.use(…)를 찾지 못했습니다 — 저장이 되는지 꼭 시험하세요.');
  return [...new Set(warn)];
}

// ---------------------------------------------------------------- 본체
export async function buildPage(opts) {
  const src = await fs.readFile(opts.input, 'utf8');
  const shell = stripShell(src);
  const split = splitHeadish(shell.body);
  let markup = split.markup;
  const title = split.title || shell.title || DEFAULT_TITLE;
  if (!/<div\s+class="app"/.test(markup.slice(0, 2000))) fail('본문 마크업이 <div class="app">으로 시작하지 않습니다 — 본문 파일이 맞는지 확인하세요.');

  // 4. 문자열 치환 (DATA 블록 밖에서만 센다)
  const applied = [];
  const patches = [...PATCHES, ...(opts.exit ? [EXIT_PATCH] : [])];
  {
    const scripts = scanScripts(markup);
    const dataBlocks = scripts.filter(x => /\bid\s*=\s*["']data["']/.test(x.attrs));
    if (dataBlocks.length !== 1) fail(`<script id="data"> 블록이 ${dataBlocks.length}개입니다 (1개여야 함).`);
    const d = dataBlocks[0];
    let before = markup.slice(0, d.start), after = markup.slice(d.end);
    for (const p of patches) {
      const want = p.count ?? 1;
      const n = countOf(before, p.find) + countOf(after, p.find);
      if (n !== want) fail(`치환 「${p.why}」: ${JSON.stringify(p.find).slice(0, 80)} 이(가) ${n}번 나옵니다 (${want}번이어야 함). scripts/build_page.mjs의 PATCHES를 이 판에 맞게 고치세요.`);
      before = before.split(p.find).join(p.replace);
      after = after.split(p.find).join(p.replace);
      applied.push(`${p.why} ×${want}`);
    }
    markup = before + d.full + after;
  }

  // DATA 확인 (건드리지 않고 읽어만 본다)
  let scripts = scanScripts(markup);
  const dataBlock = scripts.find(x => /\bid\s*=\s*["']data["']/.test(x.attrs));
  let items = null, buildId = null;
  try {
    const data = JSON.parse(dataBlock.text);
    items = Array.isArray(data.items) ? data.items.length : null;
    const b = data.build && typeof data.build === 'object' ? data.build.id : null;
    if (typeof b === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(b)) buildId = b;
  } catch (e) {
    fail(`DATA JSON을 읽지 못했습니다: ${e.message}`);
  }
  if (!items) fail('DATA.items가 비어 있습니다.');

  // 2. 엑셀 라이브러리 태그
  const xlsxTags = scripts.filter(x => x.src && /xlsx/i.test(x.src));
  if (xlsxTags.length !== 1 || xlsxTags[0].src !== XLSX_CDN) {
    fail(`엑셀 라이브러리 태그가 예상과 다릅니다: ${JSON.stringify(xlsxTags.map(x => x.src))} (기대: ${XLSX_CDN} 1개)`);
  }
  const vendor = await ensureVendor(opts.cdn);
  const xlsxTag = vendor.mode === 'vendor'
    ? `<script src="${VENDOR_URL}" integrity="${XLSX_SRI}"></script>`
    : `<script src="${XLSX_CDN}" integrity="${XLSX_SRI}" crossorigin="anonymous"></script>`;
  markup = markup.slice(0, xlsxTags[0].start) + xlsxTag + markup.slice(xlsxTags[0].end);

  // 3. shim — 앱 스크립트(window.claude를 쓰는 인라인 스크립트) 바로 앞
  scripts = scanScripts(markup);
  const inline = scripts.filter(x => x.executable);
  if (!inline.length) fail('인라인 앱 스크립트를 찾지 못했습니다.');
  const users = inline.filter(x => /window\.claude/.test(x.text));
  const app = users[0] || inline[inline.length - 1];
  if (users.length > 1) fail(`window.claude를 쓰는 인라인 스크립트가 ${users.length}개입니다 — shim 위치를 정할 수 없습니다.`);
  if (scripts.some(x => x.src === SHIM_URL)) fail('본문에 이미 /shim.js가 있습니다.');
  if (app.start < dataBlock.start) fail('앱 스크립트가 DATA 블록보다 앞에 있습니다.');
  markup = markup.slice(0, app.start) + `<script src="${SHIM_URL}"></script>\n` + markup.slice(app.start);

  // 5. CSP — 인라인 실행 스크립트 해시
  scripts = scanScripts(markup);
  const hashes = scripts.filter(x => x.executable).map(x => `'sha256-${sha('sha256', Buffer.from(x.text, 'utf8'))}'`);
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}${vendor.mode === 'cdn' ? ' https://cdn.jsdelivr.net' : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

  const headParts = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<meta name="robots" content="noindex, nofollow">',
    ...(buildId ? [`<meta name="nr-build" content="${buildId}">`] : []),
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    // 9/30: 📱 앱 설치(홈 화면에 추가) — manifest · 아이콘(로그인 전에도 읽힘 — middleware 공개 경로) · lib/page.js APP_HEAD와 같은 내용
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<meta name="theme-color" content="#1E6B66">',
    '<link rel="icon" href="/icon-192.png" type="image/png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="데이터 검토">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
    `<title>${title}</title>`,
    ...shell.shellStyles,
    ...split.headish,
    ...(opts.exit ? [`<style>${EXIT_CSS}</style>`] : []),
  ];
  const html = `<!doctype html>\n<html lang="ko">\n<head>\n${headParts.join('\n')}\n</head>\n<body>\n${markup.replace(/\s+$/, '')}\n</body>\n</html>\n`;

  // 마지막 점검
  const final = scanScripts(html);
  const iData = final.findIndex(x => /\bid\s*=\s*["']data["']/.test(x.attrs));
  const iX = final.findIndex(x => x.src === VENDOR_URL || x.src === XLSX_CDN);
  const iShim = final.findIndex(x => x.src === SHIM_URL);
  const iApp = final.findIndex(x => x.executable && x.start > final[iShim].start);
  if (!(iData >= 0 && iData < iX && iX < iShim && iApp === iShim + 1)) fail(`스크립트 순서 이상: data ${iData}, xlsx ${iX}, shim ${iShim}, app ${iApp}`);
  const skeleton = final.reduceRight((s, x) => s.slice(0, x.start) + '<script></script>' + s.slice(x.end), html); // 스크립트 안의 문자열은 빼고 센다
  if (countOf(skeleton, '<!doctype html>') !== 1 || countOf(skeleton, '<html') !== 1 || countOf(skeleton, '<body>') !== 1 || countOf(skeleton, '</body>') !== 1) fail('문서 골격이 하나가 아닙니다.');

  const warnings = [...shimCoverage(app.text)];
  const outside = html.slice(0, final[iData].start) + html.slice(final[iData].end);
  for (const m of outside.matchAll(ARTIFACT_WORDS)) {
    warnings.push(`아티팩트 전용일 수 있는 말: …${outside.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}…`);
  }
  if (vendor.mode === 'cdn') warnings.push(`엑셀 라이브러리를 CDN에서 읽습니다 (${vendor.note}). CDN이 막힌 PC에서는 엑셀 대신 CSV로 내려받습니다.`);

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, html, 'utf8');
  return {
    out: opts.out,
    bytes: Buffer.byteLength(html, 'utf8'),
    items,
    build: buildId,
    title,
    xlsx: vendor.mode,
    xlsx_note: vendor.note || null,
    patches: applied,
    script_hashes: hashes,
    sha256: crypto.createHash('sha256').update(html).digest('hex'),
    warnings,
  };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.help || !opts.input) {
    console.log('사용: node scripts/build_page.mjs <본문.html> [--out public/review.html] [--no-exit] [--cdn]');
    process.exit(opts.help ? 0 : 2);
  }
  buildPage(opts).then(r => {
    console.log(`만듦: ${path.relative(process.cwd(), r.out) || r.out}`);
    console.log(`  크기 ${(r.bytes / 1048576).toFixed(2)}MB (${r.bytes} bytes) · 데이터 요소 ${r.items}개 · 제목 「${r.title}」 · 화면 판 ${r.build || '(없음)'}`);
    console.log(`  엑셀 라이브러리: ${r.xlsx === 'vendor' ? '같은 서버(/vendor/xlsx.bundle.js)' : 'CDN'}${r.xlsx_note ? ` — ${r.xlsx_note}` : ''}`);
    console.log(`  치환: ${r.patches.length ? r.patches.join(', ') : '없음'}`);
    console.log(`  CSP 스크립트 해시 ${r.script_hashes.length}개 · sha256 ${r.sha256.slice(0, 16)}…`);
    for (const w of r.warnings) console.log(`  주의: ${w}`);
    console.log('다음: npm run build (로컬 확인) 또는 바로 재배포');
  }).catch(e => {
    console.error(`실패: ${e.message}`);
    process.exit(1);
  });
}
