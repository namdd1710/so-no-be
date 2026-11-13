import { isValidAccessCodeShape, normalizeAccessCode } from '@/lib/access-code';
import { clientIp, fail, json, route, takeRateLimit } from '@/lib/http';
import { findDebtorByCode, listPaymentQrs } from '@/lib/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ code: string }> };

const LIMIT = 20;
const WINDOW_MS = 60 * 1000;

/**
 * GET /api/public/:code/payment-qrs — tất cả ảnh QR nhận tiền đang bật.
 *
 * Chỉ trả ảnh + tên ngân hàng/số tài khoản để con nợ quét; không lộ gì khác.
 */
export const GET = route<Context>(async (request, context) => {
  const limit = takeRateLimit(`public-qrs:${clientIp(request)}`, LIMIT, WINDOW_MS);
  if (limit.limited) {
    return fail(429, 'TOO_MANY_REQUESTS', 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.', {
      retryAfter: limit.retryAfter,
    });
  }

  const { code } = await context.params;
  const normalized = normalizeAccessCode(code);
  if (!isValidAccessCodeShape(normalized)) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  const debtor = await findDebtorByCode(normalized);
  if (!debtor) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  const paymentQrs = await listPaymentQrs(true);
  return json({
    paymentQrs: paymentQrs.map((qr) => ({
      id: qr.id,
      bankName: qr.bankName,
      accountName: qr.accountName,
      accountNumber: qr.accountNumber,
      note: qr.note,
      image: qr.image,
    })),
  });
});
