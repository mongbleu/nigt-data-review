// GET /api/codes → 관리자(adm)만: 검토자별 접속 코드 목록 [{name, ini, role, code}]
//   코드는 서버 비밀값으로 그때그때 계산한다(어디에도 저장하지 않음). 메일로 검토자에게 전달하는 용도.
import { sessionFromRequest, reviewerCode } from '../../../lib/auth.js';
import { reviewers, codeVersion } from '../../../lib/store.js';
import { json } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  if (s.role !== 'adm') return json({ error: 'forbidden' }, 403);
  try {
    const [list, ver] = await Promise.all([reviewers(), codeVersion()]);
    const codes = [];
    for (const x of list) codes.push({ name: x.n, ini: x.i, role: x.r || 'rv', code: await reviewerCode(x.n, x.i, ver) });
    return json({ ver, codes });
  } catch (e) {
    console.error('[GET /api/codes] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}
