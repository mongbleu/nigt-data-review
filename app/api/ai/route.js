// GET  /api/ai → 관리자: {enabled(ANTHROPIC_API_KEY 있음), model, cfg:{away, fallback, min}, push:{count}} · 검토자: {away} · 그 밖(보기 전용): 403 forbidden
// POST /api/ai {action:'cfg', away?, fallback?, min?(5~60분)} → 관리자만 → {ok:true, cfg}
//   away = 부재 중(질문이 오면 바로 자동 답변) · fallback = 관리자 글이 min분 동안 없으면 자동 답변(기본 켬 · 10분)
// POST /api/ai {action:'draft', qid} → 관리자만 → {ok:true, kind:'answer'|'hold'|'skip', text(300자까지)} — 채팅에 올리지 않음(관리자가 고쳐서 보통 채팅 저장으로 보냄)
//   503 ai_disabled(키 없음) · 404 not_found · 429 rate_limited(인스턴스마다 3초에 한 번 · 시간당 한도) · 502 ai_failed
// 동작은 lib/autoreply.js(자동 답변 · 설정 · 초안) · lib/ai.js(Claude 호출 · 이름 가리기) · lib/push.js(휴대폰 알림)
import { sessionFromRequest } from '../../../lib/auth.js';
import { json, readJson } from '../../../lib/http.js';
import { aiEnabled, aiModel } from '../../../lib/ai.js';
import { getCfg, setCfg, cfgPatch, makeDraft } from '../../../lib/autoreply.js';
import { subCount } from '../../../lib/push.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DRAFT_GAP_MS = 3000;
// 채팅 글 id 모양(app/api/docs CHAT_ID_RE와 같게)
const QID_RE = /^m_[0-9a-z]{6,10}_[0-9a-z]{3,10}_(?:[0-9a-f]{2}){1,30}$/;
const R = globalThis.__nrAiRoute || (globalThis.__nrAiRoute = { lastDraft: 0 });

export async function GET(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  if (s.role !== 'adm' && s.role !== 'rv') return json({ error: 'forbidden' }, 403);
  try {
    if (s.role === 'rv') return json({ away: (await getCfg()).away });
    const [cfg, count] = await Promise.all([getCfg(), subCount()]);
    const enabled = aiEnabled();
    return json({ enabled, model: enabled ? aiModel() : null, cfg, push: { count } });
  } catch (e) {
    console.error('[GET /api/ai] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}

export async function POST(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  if (s.role !== 'adm') return json({ error: 'forbidden' }, 403);
  const { data, res } = await readJson(request);
  if (res) return res;

  if (data.action === 'cfg') {
    const patch = cfgPatch(data);
    if (!patch) return json({ error: 'invalid_cfg' }, 400);
    try {
      return json({ ok: true, cfg: await setCfg(patch, s.name) });
    } catch (e) {
      console.error('[POST /api/ai] cfg failed:', e && e.message);
      return json({ error: 'store_unavailable' }, 502);
    }
  }

  if (data.action === 'draft') {
    if (!aiEnabled()) return json({ error: 'ai_disabled' }, 503);
    const t = Date.now();
    if (t - R.lastDraft < DRAFT_GAP_MS) return json({ error: 'rate_limited' }, 429);
    R.lastDraft = t;
    if (typeof data.qid !== 'string' || !QID_RE.test(data.qid)) return json({ error: 'not_found' }, 404);
    try {
      const r = await makeDraft(data.qid);
      return json({ ok: true, kind: r.kind, text: r.text });
    } catch (e) {
      const code = e && e.code;
      if (code === 'not_found') return json({ error: 'not_found' }, 404);
      if (code === 'rate_limited') return json({ error: 'rate_limited' }, 429);
      if (code === 'ai_failed') return json({ error: 'ai_failed' }, 502);
      console.error('[POST /api/ai] draft failed:', e && e.message);
      return json({ error: 'store_unavailable' }, 502);
    }
  }

  return json({ error: 'invalid_action' }, 400);
}
