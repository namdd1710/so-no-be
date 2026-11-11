import { pingDatabase } from '@/lib/db';
import { json, route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/health — kiểm tra service + kết nối Mongo (dùng khi deploy). */
export const GET = route(async () => {
  const db = await pingDatabase();
  return json(
    { ok: db, db, time: new Date().toISOString() },
    { status: db ? 200 : 503 },
  );
});
