// AI 크레딧(10/1) — Claude 호출마다 남긴 토큰(lib/store.js aiUsageAdd → nr_review.ai_usage)을 요금표로 달러로 바꿔
//   충전한 5달러(기준 금액)에서 줄어든 남은 크레딧을 만든다 — 관리 탭 「🤖 AI 크레딧」 막대 · 거의 다 쓰면 폰 알림(lib/ai.js creditAlert).
//   기준(kv ai_budget {usd, krw, at, by})은 관리 탭 「충전했어요」로 다시 잡는다 — 그 시각부터 다시 5달러에서 줄어든다.
//   추정치: 요금표 × 토큰 수(입력 · 출력 · 캐시 쓰기 · 캐시 읽기). 실제 잔액은 Claude Console → Billing.

// 달러 / 백만 토큰 — Claude 요금표(platform.claude.com/docs/en/about-claude/pricing, 10/1 확인). 캐시 쓰기는 5분 보관 값(프롬프트 캐시 기본)
export const PRICES = [
  { id: 'claude-sonnet-5-5', re: /^claude-sonnet-5-5($|-)/, in: 2, out: 10, cw: 2.5, cr: 0.2 },
  { id: 'claude-opus-5-5', re: /^claude-opus-5-5($|-)/, in: 4, out: 20, cw: 5, cr: 0.2 },
  { id: 'claude-fable-5-1', re: /^claude-fable-5-1($|-)/, in: 10, out: 50, cw: 12.5, cr: 0.25 },
  { id: 'claude-haiku-4-5', re: /^claude-haiku-4-5($|-)/, in: 1, out: 5, cw: 1.25, cr: 0.1 },
];
export const BUDGET_DEFAULT = { usd: 5, krw: 1350, at: null };   // 5달러 · 1달러 = 1,350원(9/30 종가 1,352.8원) · 기준 시각 없음 = 기록 전체
export const LOW_PCT = 20;   // 남은 크레딧이 기준의 20%(5달러면 1달러)보다 적으면 「거의 다 씀」 — 폰 알림 · 관리자 위쪽 알림 줄

export function priceOf(model) {
  return PRICES.find(p => p.re.test(String(model || ''))) || null;
}
const n0 = v => (Number.isFinite(+v) && +v > 0 ? Math.round(+v) : 0);
// 토큰 {in, out, cw, cr} → 달러(요금을 모르는 모델이면 null)
export function costOf(model, t) {
  const p = priceOf(model);
  if (!p) return null;
  return (n0(t.in) * p.in + n0(t.out) * p.out + n0(t.cw) * p.cw + n0(t.cr) * p.cr) / 1e6;
}

// 기준 금액 바꾸기(관리 탭 「충전했어요」 = 5달러) 입력 → {usd, krw?} 또는 null(틀린 값)
export function budgetPatch(input) {
  if (!input || typeof input !== 'object') return null;
  const usd = Number(input.usd);
  if (!Number.isFinite(usd) || usd < 0 || usd > 10000) return null;
  const out = { usd: Math.round(usd * 10000) / 10000 };
  if (input.krw !== undefined && input.krw !== null && input.krw !== '') {
    const krw = Number(input.krw);
    if (!Number.isFinite(krw) || krw < 100 || krw > 10000) return null;
    out.krw = Math.round(krw * 100) / 100;
  }
  return out;
}
export function normBudget(b) {
  const o = b && typeof b === 'object' ? b : {};
  const usd = Number.isFinite(+o.usd) && +o.usd >= 0 ? +o.usd : BUDGET_DEFAULT.usd;
  const krw = Number.isFinite(+o.krw) && +o.krw >= 100 ? +o.krw : BUDGET_DEFAULT.krw;
  const at = typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) ? new Date(o.at).toISOString() : null;
  return { usd, krw, at, by: typeof o.by === 'string' ? o.by.slice(0, 40) : null };
}
// 기준마다 다른 열쇠 — 알림을 기준(충전)마다 한 번씩 보내려고. 기준 시각(밀리초 숫자) · 기준이 없으면 '0'
export function creditKey(b) {
  const t = b && b.at ? Date.parse(b.at) : NaN;
  return Number.isFinite(t) ? String(t) : '0';
}

const r6 = v => Math.round(v * 1e6) / 1e6;
const blank = () => ({ calls: 0, ok: 0, fail: 0, answer: 0, hold: 0, skip: 0, draft: 0, in: 0, out: 0, cw: 0, cr: 0, usd: 0, unpriced: 0 });
function addRow(acc, r, usd) {
  acc.calls += n0(r.calls); acc.ok += n0(r.ok); acc.fail += n0(r.fail);
  if (r.mode === 'draft') acc.draft += n0(r.calls);
  else { acc.answer += n0(r.answer); acc.hold += n0(r.hold); acc.skip += n0(r.skip); }
  acc.in += n0(r.in); acc.out += n0(r.out); acc.cw += n0(r.cw); acc.cr += n0(r.cr);
  if (usd === null) acc.unpriced += n0(r.calls); else acc.usd += usd;
}
const fin = a => Object.assign(a, { usd: r6(a.usd) });

// rows = aiUsageSummary(기준 시각).rows — [{model, mode, after, calls, ok, fail, answer, hold, skip, in, out, cw, cr}](day는 쓰지 않음)
//   real = Claude가 「크레딧 부족」으로 거절한 적이 이 기준 뒤에 있음(lib/ai.js) → 추정과 상관없이 0 · empty
export function summarize({ rows, budget, now = Date.now(), model = null, real = false }) {
  const b = normBudget(budget);
  const total = blank(), after = blank();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const usd = costOf(r.model, r);
    addRow(total, r, usd);
    if (r.after) addRow(after, r, usd);
  }
  fin(total); fin(after);
  const pr = priceOf(model);
  const spent = after.usd;
  const remaining = real ? 0 : r6(Math.max(0, b.usd - spent));
  const pct = b.usd > 0 ? Math.max(0, Math.min(100, (remaining / b.usd) * 100)) : 0;
  const level = remaining <= 0 ? 'empty' : pct < LOW_PCT ? 'low' : 'ok';
  return {
    base: { usd: b.usd, krw: b.krw, at: b.at, by: b.by, default: !b.at, key: creditKey(b) },
    spent_usd: r6(spent), remaining_usd: remaining, remaining_pct: Math.round(pct * 10) / 10, level,
    low_pct: LOW_PCT, low_usd: r6((b.usd * LOW_PCT) / 100), real_empty: !!real,
    after, total,
    price: pr ? { id: pr.id, in: pr.in, out: pr.out, cw: pr.cw, cr: pr.cr } : null,
    unpriced_calls: total.unpriced,
    now: new Date(now).toISOString(),
  };
}
// 짧은 요약(GET /api/ai 관리자 응답 → 화면 위쪽 알림 줄): 남은 달러 · 기준 달러 · % · 단계 · 알림 기준 달러 · 환율 · 기준 열쇠 · Claude가 부족하다고 함
export function creditOf(u) {
  return { usd: u.remaining_usd, base: u.base.usd, pct: u.remaining_pct, level: u.level, low: u.low_usd, krw: u.base.krw, key: u.base.key, real: u.real_empty };
}
