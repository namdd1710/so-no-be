import { verifyAdminPassword } from '@/lib/admin-account';
import {
  clearFailures,
  clientIp,
  fail,
  failureCount,
  isAllowedOrigin,
  isRateLimited,
  json,
  readJson,
  recordFailure,
  route,
} from '@/lib/http';
import { sessionCookie, signSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Chặn 5 lần đăng nhập sai / 15 phút / IP (BRIEF §9). */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

export const POST = route(async (request: Request) => {
  if (!isAllowedOrigin(request)) {
    return fail(403, 'BAD_ORIGIN', 'Yêu cầu không đến từ ứng dụng hợp lệ');
  }

  const key = `login:${clientIp(request)}`;
  const gate = isRateLimited(key, MAX_FAILURES, WINDOW_MS);
  if (gate.limited) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfter / 60));
    return fail(429, 'TOO_MANY_ATTEMPTS', `Sai mật khẩu quá nhiều lần. Thử lại sau ${minutes} phút.`, {
      retryAfter: gate.retryAfter,
    });
  }

  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return fail(400, 'MISSING_PASSWORD', 'Vui lòng nhập mật khẩu');

  if (!(await verifyAdminPassword(password))) {
    recordFailure(key, WINDOW_MS);
    const used = failureCount(key, WINDOW_MS);
    if (used >= MAX_FAILURES) {
      return fail(429, 'TOO_MANY_ATTEMPTS', 'Sai mật khẩu quá nhiều lần. Thử lại sau 15 phút.', {
        retryAfter: Math.ceil(WINDOW_MS / 1000),
      });
    }
    return fail(401, 'INVALID_CREDENTIALS', 'Mật khẩu không đúng', { remainingAttempts: MAX_FAILURES - used });
  }

  const session = await signSession();
  if (!session) return fail(500, 'CONFIG_ERROR', 'SESSION_SECRET chưa được cấu hình (cần tối thiểu 16 ký tự)');

  clearFailures(key);
  return json({ ok: true, expiresAt: session.expiresAt }, { headers: { 'Set-Cookie': sessionCookie(session.token) } });
});
