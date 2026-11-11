import { isValidAccessCodeShape, normalizeAccessCode } from '@/lib/access-code';
import { clientIp, fail, json, route, takeRateLimit } from '@/lib/http';
import { loadPublicLedger } from '@/lib/service';
import { parseLedgerQuery } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ code: string }> };

/** 20 request / phút / IP cho toàn bộ trang công khai (BRIEF §9). */
const LIMIT = 20;
const WINDOW_MS = 60 * 1000;

/**
 * GET /api/public/:code — dữ liệu công khai CHỈ ĐỌC của một con nợ.
 * Không trả SĐT, ghi chú nội bộ hay mã của người khác.
 */
export const GET = route<Context>(async (request, context) => {
  const limit = takeRateLimit(`public:${clientIp(request)}`, LIMIT, WINDOW_MS);
  if (limit.limited) {
    return fail(429, 'TOO_MANY_REQUESTS', 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.', {
      retryAfter: limit.retryAfter,
    });
  }

  const { code } = await context.params;
  const normalized = normalizeAccessCode(code);

  // 404 giống nhau cho mọi trường hợp: không xác nhận mã có tồn tại hay không.
  if (!isValidAccessCodeShape(normalized)) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  const url = new URL(request.url);
  try {
    const q = parseLedgerQuery(url.searchParams);
    const ledger = await loadPublicLedger(normalized, q);
    return json(ledger);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');
    throw error;
  }
});
