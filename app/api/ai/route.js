// GET  /api/ai → 관리자: {enabled(ANTHROPIC_API_KEY 있음), model, cfg:{away, fallback, min}, push:{count}, credit} · 검토자: {away} · 그 밖(보기 전용): 403 forbidden
//   credit(10/1) = 남은 AI 크레딧 짧은 요약(lib/usage.js creditOf — 화면 위쪽 알림 줄) · 읽지 못하면 null
// POST /api/ai {action:'cfg', away?, fallback?, min?(5~60분)} → 관리자만 → {ok:true, cfg}
//   away = 부재 중(질문이 오면 바로 자동 답변) · fallback = 관리자 글이 min분 동안 없으면 자동 답변(기본 켬 · 10분)
// POST /api/ai {action:'draft', qid} → 관리자만 → {ok:true, kind:'answer'|'hold'|'skip', text(300자까지)} — 채팅에 올리지 않음(관리자가 고쳐서 보통 채팅 저장으로 보냄)
// 10/1 GET  /api/ai?view=usage → 관리자만 → {enabled, model, usage, push:{count}}(lib/usage.js summarize — 충전한 5달러에서 줄어든 남은 크레딧 · 관리 탭 「🤖 AI 크레딧」 막대)
// 10/1 POST /api/ai {action:'budget', usd, krw?} → 관리자만 → 「충전했어요」(usd 5): 기준 금액 · 지금 시각부터 다시 줄어듦 → {ok:true, usage, …}
//   503 ai_disabled(키 없음) · 404 not_found · 429 rate_limited(인스턴스마다 3초에 한 번 · 시간당 한도) · 502 ai_failed
// 동작은 lib/autoreply.js(자동 답변 · 설정 · 초안) · lib/ai.js(Claude 호출 · 이름 가리기 · 크레딧 알림) · lib/push.js(휴대폰 알림)
import { sessionFromRequest } from '../../../lib/auth.js';
import { json, readJson } from '../../../lib/http.js';
import { aiEnabled, aiModel, creditNow } from '../../../lib/ai.js';
import { getCfg, setCfg, cfgPatch, makeDraft } from '../../../lib/autoreply.js';
import { subCount } from '../../../lib/push.js';
import { kvGet, kvSet } from '../../../lib/store.js';
import { budgetPatch, normBudget, creditOf } from '../../../lib/usage.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DRAFT_GAP_MS = 3000;
// 채팅 글 id 모양(app/api/docs CHAT_ID_RE와 같게)
const QID_RE = /^m_[0-9a-z]{6,10}_[0-9a-z]{3,10}_(?:[0-9a-f]{2}){1,30}$/;
const R = globalThis.__nrAiRoute || (globalThis.__nrAiRoute = { lastDraft: 0 });
const BUDGET_KEY = 'ai_budget';

// 10/1 남은 크레딧 — 기준(kv ai_budget, 없으면 5달러 · 기록 전체) · 폰 알림 받는 기기 수(0이면 화면에 「폰 알림 꺼짐」)
async function usageView() {
  const [usage, count] = await Promise.all([creditNow(), subCount()]);
  return { enabled: aiEnabled(), model: aiModel(), usage, push: { count } };
}

export async function GET(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  if (s.role !== 'adm' && s.role !== 'rv') return json({ error: 'forbidden' }, 403);
  const view = new URL(request.url).searchParams.get('view');
  if (view === 'usage') {
    if (s.role !== 'adm') return json({ error: 'forbidden' }, 403);
    try { return json(await usageView()); }
    catch (e) { console.error('[GET /api/ai] usage failed:', e && e.message); return json({ error: 'store_unavailable' }, 502); }
  }
  try {
    if (s.role === 'rv') return json({ away: (await getCfg()).away });
    const credit = creditNow().then(creditOf).catch(e => { console.error('[GET /api/ai] credit failed:', e && (e.code || e.message)); return null; });
    const [cfg, count, cr] = await Promise.all([getCfg(), subCount(), credit]);
    const enabled = aiEnabled();
    return json({ enabled, model: enabled ? aiModel() : null, cfg, push: { count }, credit: cr });
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

  if (data.action === 'budget') {
    const patch = budgetPatch(data);
    if (!patch) return json({ error: 'invalid_budget' }, 400);
    try {
      const cur = normBudget(await kvGet(BUDGET_KEY));
      await kvSet(BUDGET_KEY, { usd: patch.usd, krw: patch.krw ?? cur.krw, at: new Date().toISOString(), by: s.name });
      return json({ ok: true, ...(await usageView()) });
    } catch (e) {
      console.error('[POST /api/ai] budget failed:', e && e.message);
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
