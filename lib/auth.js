// 세션 쿠키 서명·검증 — Web Crypto만 사용 (Edge 미들웨어와 Node 라우트 모두에서 동작).
// 쿠키 nr_s = base64url(JSON{r:'rev'|'adm', exp}) + '.' + base64url(HMAC-SHA256(AUTH_SECRET, 앞부분))

export const COOKIE_NAME = 'nr_s';
export const MAX_AGE_SEC = 14 * 24 * 60 * 60; // 14일
const MIN_SECRET_LEN = 16;
const ROLES = new Set(['rev', 'adm']);

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

export async function signSession(role, secret = authSecret(), nowMs = Date.now()) {
  if (!secret) throw new Error('AUTH_SECRET is not configured');
  if (!ROLES.has(role)) throw new Error('invalid role');
  const payload = b64urlEncode(enc.encode(JSON.stringify({ r: role, exp: Math.floor(nowMs / 1000) + MAX_AGE_SEC })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

// 유효하면 'rev' | 'adm', 아니면 null
export async function verifySession(value, secret = authSecret(), nowMs = Date.now()) {
  if (!secret || typeof value !== 'string' || value.length > 512) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const payload = value.slice(0, dot), sigPart = value.slice(dot + 1);
  if (!B64URL.test(payload) || !B64URL.test(sigPart)) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sigPart), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(b64urlDecode(payload)));
    if (!data || !ROLES.has(data.r) || typeof data.exp !== 'number' || data.exp * 1000 <= nowMs) return null;
    return data.r;
  } catch {
    return null;
  }
}

// NextRequest(미들웨어·라우트 공통)에서 역할 읽기
export async function roleFromRequest(request) {
  const v = request.cookies && request.cookies.get ? request.cookies.get(COOKIE_NAME) : null;
  return verifySession(v ? v.value : null);
}

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

export function sessionCookie(value) {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; Secure; SameSite=Lax`;
}
export function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
