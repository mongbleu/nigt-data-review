// 세션 쿠키 서명·검증 · 검토자별 접속 코드 — Web Crypto만 사용 (Edge 미들웨어와 Node 라우트 모두에서 동작).
// 쿠키 nr_s = base64url(JSON{r, n, exp}) + '.' + base64url(HMAC-SHA256(AUTH_SECRET, 앞부분))
//   r: 'adm'(관리 — 정유정) · 'rv'(검토자 — 담당 요소만 저장) · 'view'(보기 전용) · 'rev'(예전 공용 코드 쿠키 — 보기 전용으로 취급)
//   n: 검토자 이름('rv' · 'adm'), 공용 코드면 없음
// 검토자 코드 = 8자리 숫자 + 이니셜 소문자. 숫자 = HMAC-SHA256(AUTH_SECRET, 'nr-code|<판>|<이름>')의 앞 6바이트 mod 10^8
//   → 서버 비밀값을 모르면 코드를 만들 수 없고, 코드 목록은 관리자(adm) 세션의 /api/codes에서만 보인다. 판(code_ver)을 바꾸면 모든 코드가 바뀐다.

export const COOKIE_NAME = 'nr_s';
export const MAX_AGE_SEC = 14 * 24 * 60 * 60; // 14일
const MIN_SECRET_LEN = 16;
const ROLES = new Set(['rev', 'adm', 'rv', 'view']);
export const WRITE_ROLES = new Set(['adm', 'rv']);

const enc = new TextEncoder();
const dec = new TextDecoder();

export function authSecret() {
  const s = process.env.AUTH_SECRET;
  if (typeof s === 'string' && s.length >= MIN_SECRET_LEN) return s;
  // AUTH_SECRET을 따로 두지 않았으면 APP_SECRET에서 파생(접속 쿠키 서명용 — APP_SECRET을 바꾸면 모두 다시 로그인)
  const a = process.env.APP_SECRET;
  return typeof a === 'string' && a.length >= MIN_SECRET_LEN ? `nr-auth-cookie|${a}` : null;
}

let keyCache = { secret: null, key: null };
async function hmacKey(secret) {
  if (keyCache.secret === secret && keyCache.key) return keyCache.key;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  keyCache = { secret, key };
  return key;
}

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const B64URL = /^[A-Za-z0-9_-]+$/;

export async function signSession(role, name = null, secret = authSecret(), nowMs = Date.now()) {
  if (!secret) throw new Error('AUTH_SECRET is not configured');
  if (!ROLES.has(role)) throw new Error('invalid role');
  const data = { r: role, exp: Math.floor(nowMs / 1000) + MAX_AGE_SEC };
  if (typeof name === 'string' && name) data.n = name.slice(0, 40);
  const payload = b64urlEncode(enc.encode(JSON.stringify(data)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

// 유효하면 {role, name}, 아니면 null
export async function verifySession(value, secret = authSecret(), nowMs = Date.now()) {
  if (!secret || typeof value !== 'string' || value.length > 768) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const payload = value.slice(0, dot), sigPart = value.slice(dot + 1);
  if (!B64URL.test(payload) || !B64URL.test(sigPart)) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sigPart), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(b64urlDecode(payload)));
    if (!data || !ROLES.has(data.r) || typeof data.exp !== 'number' || data.exp * 1000 <= nowMs) return null;
    return { role: data.r, name: typeof data.n === 'string' ? data.n : null };
  } catch {
    return null;
  }
}

// NextRequest(미들웨어·라우트 공통)에서 세션 읽기 → {role, name} | null
export async function sessionFromRequest(request) {
  const v = request.cookies && request.cookies.get ? request.cookies.get(COOKIE_NAME) : null;
  return verifySession(v ? v.value : null);
}
// 예전 이름(미들웨어 등) — 참/거짓 판단용으로 세션 객체를 그대로 돌려준다
export const roleFromRequest = sessionFromRequest;

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
// 길이·내용과 무관하게 같은 시간으로 비교 (둘 다 SHA-256 후 XOR 누적)
export async function codeMatches(input, expected) {
  if (typeof expected !== 'string' || expected.length === 0 || typeof input !== 'string') return false;
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && input.length > 0;
}

// 검토자 코드: 8자리 숫자 + 이니셜(소문자 2~5자)
export const CODE_RE = /^(\d{8})([a-z]{2,5})$/;
export async function reviewerCode(name, ini, ver = '1', secret = authSecret()) {
  if (!secret) throw new Error('AUTH_SECRET is not configured');
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`nr-code|${ver}|${name}`)));
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + sig[i];
  return String(n % 100000000).padStart(8, '0') + String(ini).toLowerCase();
}
// 입력 코드 정리: 앞뒤 공백·가운데 공백/하이픈 제거, 영문은 소문자로
export function normalizeCode(input) {
  return String(input || '').trim().replace(/[\s-]+/g, '').toLowerCase();
}

export function sessionCookie(value) {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; Secure; SameSite=Lax`;
}
export function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
