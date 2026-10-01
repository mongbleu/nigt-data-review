// 관리자 휴대폰 알림(웹 푸시 · 10/1) — 검토자가 채팅에 질문을 올렸을 때 · 자동 답변을 보냈거나 확인이 필요할 때 관리자 기기에 알림.
//   서명 키(VAPID)는 처음 쓸 때 만들어 kv 'push_vapid'에 둔다(비공개 키는 서버 밖으로 나가지 않음 — 화면에는 공개 키만). 동시에 만들어도 먼저 넣은 쪽 키를 씀(kvClaim).
//   알림 받는 기기 = kv 'push_subs' — 최대 10대 [{endpoint, keys:{p256dh, auth}, name, at}]. 없어진 기기(404 · 410)는 보낼 때 지운다.
//   받는 쪽 = public/sw.js(서비스 워커)가 {title, body, tag, url}을 알림으로 띄움. 알림 서비스 주소(endpoint)는 로그에 남기지 않는다.
import webpush from 'web-push';
import { kvGet, kvSet, kvClaim } from './store.js';

const VAPID_KEY = 'push_vapid';
const SUBS_KEY = 'push_subs';
export const MAX_SUBS = 10;
const DEFAULT_SUBJECT = 'https://nigt-data-review.vercel.app';
const VAPID_TTL_MS = 10 * 60_000;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const SEND_OPTS = { TTL: 12 * 3600, urgency: 'high', timeout: 10_000 };   // 기기가 꺼져 있으면 12시간까지 보관

// 라우트 번들이 달라도 한 프로세스 안에서는 같은 키 캐시를 쓴다
const P = globalThis.__nrPush || (globalThis.__nrPush = { vapid: null });

// 시험용: 실제 보내기 대신 쓸 함수 (sub, payloadString, options) → Promise. 비우면 web-push로 되돌림
const realSend = (sub, data, opts) => webpush.sendNotification(sub, data, opts);
let sender = realSend;
export function __setSender(fn) { sender = typeof fn === 'function' ? fn : realSend; }

const okVapid = v => !!v && typeof v === 'object' && typeof v.publicKey === 'string' && typeof v.privateKey === 'string' && B64URL_RE.test(v.publicKey) && B64URL_RE.test(v.privateKey);
// {publicKey, privateKey, subject}
export async function vapidKeys() {
  if (P.vapid && Date.now() - P.vapid.at < VAPID_TTL_MS) return P.vapid.value;
  let v = await kvGet(VAPID_KEY);
  if (!v) {
    const k = webpush.generateVAPIDKeys();
    const fresh = { publicKey: k.publicKey, privateKey: k.privateKey, subject: DEFAULT_SUBJECT, at: new Date().toISOString() };
    v = (await kvClaim(VAPID_KEY, fresh)) ? fresh : await kvGet(VAPID_KEY);
  }
  if (!okVapid(v)) throw new Error('push_vapid is invalid');
  P.vapid = { at: Date.now(), value: v };
  return v;
}
export async function publicKey() {
  return (await vapidKeys()).publicKey;
}
const subjectOf = v => (process.env.VAPID_SUBJECT || '').trim() || (typeof v.subject === 'string' && v.subject) || DEFAULT_SUBJECT;

// 알림 서비스 주소: https · 1000자까지 · 도메인 이름만(IP · localhost 거절)
function okEndpoint(s) {
  if (typeof s !== 'string' || !s || s.length > 1000) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return h.includes('.') && !h.startsWith('[') && !/^[\d.]+$/.test(h) && h !== 'localhost' && !h.endsWith('.localhost');
}
const b64url = s => (typeof s === 'string' ? s.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');
// 브라우저 PushSubscription.toJSON() 모양 → {endpoint, keys:{p256dh, auth}} 또는 null
export function cleanSub(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  if (!okEndpoint(endpoint)) return null;
  const k = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
  const p256dh = b64url(k.p256dh), auth = b64url(k.auth);
  if (!B64URL_RE.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) return null;   // 65바이트 → 87자
  if (!B64URL_RE.test(auth) || auth.length < 16 || auth.length > 50) return null;          // 16바이트 → 22자
  return { endpoint, keys: { p256dh, auth } };
}

export async function listSubs() {
  const v = await kvGet(SUBS_KEY);
  return (Array.isArray(v) ? v : []).filter(x => x && cleanSub(x)).slice(-MAX_SUBS);
}
export async function subCount() {
  return (await listSubs()).length;
}
// 기기 등록(같은 주소면 바꿈 · 11대째면 가장 먼저 등록한 기기를 뺌) → 기기 수 · 모양이 틀리면 null
//   kv 한 칸을 읽고 쓰므로 두 기기가 같은 순간에 등록하면 하나가 빠질 수 있다(드묾 — 다시 켜면 됨)
export async function subscribe(sub, name) {
  const s = cleanSub(sub);
  if (!s) return null;
  const list = (await listSubs()).filter(x => x.endpoint !== s.endpoint);
  list.push({ ...s, name: typeof name === 'string' ? name.slice(0, 40) : null, at: new Date().toISOString() });
  const keep = list.slice(-MAX_SUBS);
  await kvSet(SUBS_KEY, keep);
  return keep.length;
}
// 기기 빼기 → 남은 기기 수
export async function unsubscribe(endpoint) {
  const list = await listSubs();
  const keep = list.filter(x => x.endpoint !== endpoint);
  if (keep.length !== list.length) await kvSet(SUBS_KEY, keep);
  return keep.length;
}

const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
function cleanPayload(p) {
  const o = p && typeof p === 'object' ? p : {};
  const url = typeof o.url === 'string' && o.url.startsWith('/') && !o.url.startsWith('//') ? o.url.slice(0, 200) : '/';
  return { title: line(o.title, 80) || '데이터 검토', body: line(o.body, 240), tag: line(o.tag, 120), url };
}

// 관리자 기기 모두에 보내기 → 보낸 수. 없어진 기기(404 · 410)는 명단에서 지움
export async function sendToAdmins(payload) {
  const subs = await listSubs();
  if (!subs.length) return 0;
  const v = await vapidKeys();
  const data = JSON.stringify(cleanPayload(payload));
  const opts = { ...SEND_OPTS, vapidDetails: { subject: subjectOf(v), publicKey: v.publicKey, privateKey: v.privateKey } };
  const res = await Promise.allSettled(subs.map(s => sender({ endpoint: s.endpoint, keys: s.keys }, data, opts)));
  const gone = new Set();
  let sent = 0;
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') { sent++; return; }
    const st = r.reason && r.reason.statusCode;
    if (st === 404 || st === 410) gone.add(subs[i].endpoint);
    else console.error('[push] 보내기 실패:', st || (r.reason && r.reason.name) || 'error');
  });
  if (gone.size) {
    try {
      const cur = await listSubs();
      const keep = cur.filter(x => !gone.has(x.endpoint));
      if (keep.length !== cur.length) await kvSet(SUBS_KEY, keep);
    } catch (e) {
      console.error('[push] 없어진 기기를 지우지 못했습니다:', e && e.message);
    }
  }
  return sent;
}
