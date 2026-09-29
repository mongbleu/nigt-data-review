// GET /api/session → {role: 'rev' | 'adm'}
import { roleFromRequest } from '../../../lib/auth.js';
import { json } from '../../../lib/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const role = await roleFromRequest(request);
  if (!role) return json({ error: 'unauthorized' }, 401);
  return json({ role });
}
