import { isRecoveryEnabled, verifyRecoveryKey } from '@/lib/auth';
import { setAdminPassword } from '@/lib/admin-account';
import {
  clientIp,
  fail,
  isAllowedOrigin,
  isRateLimited,
  json,
  readJson,
  recordFailure,
  route,
} from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/password — đổi mật khẩu admin khi quên.
 *
 * Bắt buộc: `recoveryKey` phải trùng value của env `ADMIN_RECOVERY_KEY`
 * (biến do bạn tự đặt) + `newPassword` hợp lệ. Không cần đăng nhập — vì đây
 * chính là đường dùng khi đã quên mật khẩu.
 *
 * Mật khẩu mới được băm scrypt và lưu vào Mongo (`settings.passwordHash`),
 * nên đổi được ngay trên production mà không phải redeploy.
 */

/** 5 lần thử sai / 15 phút / IP — khoá cũng là một bí mật. */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export const POST = route(async (request: Request) => {
  if (!isAllowedOrigin(request)) {
    return fail(403, 'BAD_ORIGIN', 'Yêu cầu không đến từ ứng dụng hợp lệ');
  }

  if (!isRecoveryEnabled()) {
    return fail(503, 'RECOVERY_DISABLED', 'Chưa cấu hình ADMIN_RECOVERY_KEY nên không thể đổi mật khẩu');
  }

  const key = `reset:${clientIp(request)}`;
  const gate = isRateLimited(key, MAX_ATTEMPTS, WINDOW_MS);
  if (gate.limited) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfter / 60));
    return fail(429, 'TOO_MANY_ATTEMPTS', `Sai quá nhiều lần. Thử lại sau ${minutes} phút.`, {
      retryAfter: gate.retryAfter,
    });
  }

  const body = await readJson(request);
  const recoveryKey = typeof body.recoveryKey === 'string' ? body.recoveryKey : '';
  if (!recoveryKey) return fail(400, 'MISSING_RECOVERY_KEY', 'Vui lòng nhập khoá khôi phục');

  if (!verifyRecoveryKey(recoveryKey)) {
    recordFailure(key, WINDOW_MS);
    return fail(401, 'INVALID_RECOVERY_KEY', 'Khoá khôi phục không đúng');
  }

  const result = await setAdminPassword(body.newPassword, 'recovery-key');
  if (!result.ok) return fail(400, 'INVALID_NEW_PASSWORD', result.message);

  return json({ ok: true, message: 'Đã đổi mật khẩu. Hãy đăng nhập lại bằng mật khẩu mới.' });
});
