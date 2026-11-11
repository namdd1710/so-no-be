import { getSession, json, route } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Dùng cho FE kiểm tra session còn hiệu lực (server-side hoặc /api proxy). */
export const GET = route(async (request: Request) => {
  const session = await getSession(request);
  return json({
    authenticated: Boolean(session),
    expiresAt: session?.exp ?? null,
  });
});
