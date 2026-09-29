// GET /api/backups            → 관리자(adm)만: DB 매일 자동 백업 목록 {schedule, keep_days, backups:[{day, taken_at, counts, bytes}]}
// GET /api/backups?day=YYYY-MM-DD → 그날 백업을 화면 「백업(JSON)」과 같은 모양으로 내려받기 — 「내보내기 · 가져오기」의 가져오기에 올리면 되살림
//   백업은 Supabase Cron이 매일 23:55(한국 시각)에 뜬다(nr_review.take_backup · 30일 보관 — supabase/migration_backup.sql)
import { sessionFromRequest } from '../../../lib/auth.js';
import { listBackups, getBackup, DAY_RE, COLLS } from '../../../lib/store.js';
import { json } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCHEDULE = '매일 23:55 (한국 시각)';
const KEEP_DAYS = 30;

export async function GET(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  if (s.role !== 'adm') return json({ error: 'forbidden' }, 403);
  const day = new URL(request.url).searchParams.get('day');
  try {
    if (!day) return json({ schedule: SCHEDULE, keep_days: KEEP_DAYS, backups: await listBackups() });
    if (!DAY_RE.test(day)) return json({ error: 'invalid_day' }, 400);
    const b = await getBackup(day);
    if (!b) return json({ error: 'not_found' }, 404);
    const docs = (Array.isArray(b.docs) ? b.docs : []).filter(d => d && COLLS.includes(d.coll) && typeof d.id === 'string').map(d => ({ coll: d.coll, id: d.id, body: d.body }));
    const counts = Object.fromEntries(COLLS.map(c => [c, docs.filter(d => d.coll === c).length]));
    const out = {
      app: 'nr-review', format: 1, kind: 'all', made_at: b.taken_at, made_by: `DB 자동 백업(${SCHEDULE})`, source: 'server-daily', day: b.day, counts,
      note: `검토 창구 DB 자동 백업 ${b.day} — 「내보내기 · 가져오기」 탭 가져오기에 올리면 합쳐집니다. 그날 상태로 되돌리려면 「창구가 더 새로워도 덮어쓰기」를 고르고 되올립니다(그 뒤에 새로 생긴 문서는 그대로).`,
      docs,
    };
    const name = `검토창구_DB자동백업_${day.slice(2).replace(/-/g, '')}.json`;
    return json(out, 200, { 'Content-Disposition': `attachment; filename="nr_db_backup_${day}.json"; filename*=UTF-8''${encodeURIComponent(name)}` });
  } catch (e) {
    console.error('[GET /api/backups] failed:', e && e.message);
    return json({ error: 'store_unavailable' }, 502);
  }
}
