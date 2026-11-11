import { fail, isAllowedOrigin, json, route } from '@/lib/http';
import { clearedSessionCookie } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (request: Request) => {
  if (!isAllowedOrigin(request)) return fail(403, 'BAD_ORIGIN', 'Yêu cầu không đến từ ứng dụng hợp lệ');
  return json({ ok: true }, { headers: { 'Set-Cookie': clearedSessionCookie() } });
});
