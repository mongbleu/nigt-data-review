// GET  /api/push → 관리자만: {publicKey(알림 서명 공개 키 · base64url — 화면 pushManager.subscribe의 applicationServerKey), count(알림 받는 기기 수)}
// POST /api/push {action:'subscribe', sub:{endpoint, keys:{p256dh, auth}}} → {ok:true, count} (같은 기기면 바꿈 · 최대 10대)
//      {action:'unsubscribe', endpoint} → {ok:true, count} · {action:'test'} → 관리자 기기 모두에 시험 알림 → {ok:true, sent}
//   모두 관리자만(알림은 관리자 기기로만 감). 받는 쪽은 public/sw.js · 보내기 · 기기 관리는 lib/push.js
import { sessionFromRequest } from '../../../lib/auth.js';
import { json, readJson } from '../../../lib/http.js';
import { publicKey, subCount, subscribe, unsubscribe, sendToAdmins } from '../../../lib/push.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;   // 시험 알림: 기기마다 10초까지 기다림

export async function GET(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  if (s.role !== 'adm') return json({ error: 'forbidden' }, 403);
  try {
    const [key, count] = await Promise.all([publicKey(), subCount()]);
    return json({ publicKey: key, count });
  } catch (e) {
    console.error('[GET /api/push] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}

export async function POST(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  if (s.role !== 'adm') return json({ error: 'forbidden' }, 403);
  const { data, res } = await readJson(request);
  if (res) return res;
  try {
    if (data.action === 'subscribe') {
      const count = await subscribe(data.sub, s.name);
      if (count === null) return json({ error: 'invalid_sub' }, 400);
      return json({ ok: true, count });
    }
    if (data.action === 'unsubscribe') {
      if (typeof data.endpoint !== 'string' || !data.endpoint || data.endpoint.length > 1000) return json({ error: 'invalid_endpoint' }, 400);
      return json({ ok: true, count: await unsubscribe(data.endpoint) });
    }
    if (data.action === 'test') {
      const sent = await sendToAdmins({ title: '🔔 알림 시험', body: '휴대폰 알림이 잘 와요. 검토자가 채팅에 질문하면 이렇게 알려 드려요.', tag: 'test', url: '/' });
      return json({ ok: true, sent });
    }
  } catch (e) {
    console.error('[POST /api/push] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
  return json({ error: 'invalid_action' }, 400);
}
