// GET /api/session → {role: 'adm'|'rv'|'view', name}
import { sessionFromRequest } from '../../../lib/auth.js';
import { json } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const s = await sessionFromRequest(request);
  if (!s) return json({ error: 'unauthorized' }, 401);
  return json({ role: s.role === 'rev' ? 'view' : s.role, name: s.name || null });
}
