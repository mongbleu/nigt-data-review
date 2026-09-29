// fetch_page — Vercel 빌드 때 검토 화면 파일을 받아 public/ 에 놓는다(배포 파일을 작게 유지).
//   1. public/review.html : Supabase nr_review.assets 에서 조각을 받아 이어 붙이고 sha256 확인 (APP_SECRET 필요)
//   2. public/vendor/xlsx.bundle.js : jsDelivr 에서 받아 sha384(SRI) 확인
// 이미 있는 파일은 건드리지 않는다(로컬 빌드). 환경변수가 없으면 「설정 필요」 안내 페이지를 만들고 빌드는 계속한다.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(ROOT, 'public', 'review.html');
const VENDOR = path.join(ROOT, 'public', 'vendor', 'xlsx.bundle.js');
const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
const XLSX_SRI = 'sha384-OUW9euuUyxyHcAhTqbhI+Iyb8LMssXt/cpz0yXhs9UWG2/R/uaWdakx/4cfww7Vb';
const ASSET = 'review.html';

const exists = p => fs.access(p).then(() => true, () => false);
const hash = (alg, buf, enc = 'hex') => createHash(alg).update(buf).digest(enc);

async function rpc(fn, args) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_ANON_KEY || '';
  const headers = { 'content-type': 'application/json', apikey: key };
  if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;   // 옛 anon(JWT) 키일 때만
  const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${fn} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function placeholder(why) {
  await fs.mkdir(path.dirname(PAGE), { recursive: true });
  await fs.writeFile(PAGE, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>검토 창구 — 설정 필요</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.6"><h1 style="font-size:20px">검토 창구 준비 중</h1>` +
    `<p>관리자가 환경변수 설정을 마친 뒤 다시 배포하면 검토 화면이 열립니다.</p><p style="color:#666;font-size:13px">${why}</p></body></html>`);
  console.log(`fetch_page: 안내 페이지를 만듦 — ${why}`);
}

async function page() {
  if (await exists(PAGE)) { console.log('fetch_page: public/review.html 있음 — 그대로 씀'); return; }
  const miss = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APP_SECRET'].filter(k => !process.env[k]);
  if (miss.length) return placeholder(`빠진 환경변수: ${miss.join(', ')}`);
  const secret = process.env.APP_SECRET;
  const info = await rpc('nr_asset_info', { p_secret: secret, p_name: ASSET });
  if (!info || !info.parts) throw new Error('Supabase에 검토 화면 파일이 없습니다(nr_review.assets).');
  const parts = [];
  for (let i = 0; i < info.parts; i++) {
    const t = await rpc('nr_get_asset', { p_secret: secret, p_name: ASSET, p_part: i });
    if (typeof t !== 'string') throw new Error(`조각 ${i} 없음`);
    parts.push(t);
  }
  const buf = Buffer.from(parts.join(''), 'utf8');
  const got = hash('sha256', buf);
  if (info.sha256 && got !== info.sha256) throw new Error(`review.html sha256 불일치 (${got} ≠ ${info.sha256}) — 올리기가 끝나지 않았거나 파일이 바뀜`);
  await fs.mkdir(path.dirname(PAGE), { recursive: true });
  await fs.writeFile(PAGE, buf);
  console.log(`fetch_page: review.html ${buf.length} bytes · 조각 ${info.parts}개 · sha256 ${got.slice(0, 16)}… (${info.sha256 ? '확인됨' : '기준값 없음'})`);
}

async function vendor() {
  if (await exists(VENDOR)) { console.log('fetch_page: vendor/xlsx.bundle.js 있음 — 그대로 씀'); return; }
  const r = await fetch(XLSX_CDN);
  if (!r.ok) throw new Error(`xlsx 라이브러리 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = 'sha384-' + hash('sha384', buf, 'base64');
  if (got !== XLSX_SRI) throw new Error(`xlsx 라이브러리 해시 불일치 (${got})`);
  await fs.mkdir(path.dirname(VENDOR), { recursive: true });
  await fs.writeFile(VENDOR, buf);
  console.log(`fetch_page: vendor/xlsx.bundle.js ${buf.length} bytes (SRI 확인)`);
}

await vendor();
await page();
