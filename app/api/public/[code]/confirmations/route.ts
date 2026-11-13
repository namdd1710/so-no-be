import { isValidAccessCodeShape, normalizeAccessCode } from '@/lib/access-code';
import { getCollections } from '@/lib/db';
import { clientIp, fail, json, readJson, route, takeRateLimit } from '@/lib/http';
import { findDebtorByCode } from '@/lib/service';
import { parseString } from '@/lib/validate';
import type { ConfirmationDoc } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ code: string }> };

const LIMIT = 5;
const WINDOW_MS = 60 * 1000;

/**
 * POST /api/public/:code/confirmations — con nợ báo "tôi đã chuyển khoản".
 *
 * Chỉ tạo một lời khai chờ chủ nợ kiểm tra; KHÔNG tự trừ nợ, không tạo
 * settlement. Số tiền và ghi chú là của người khai, chủ nợ đối chiếu sao kê.
 */
export const POST = route<Context>(async (request, context) => {
  const limit = takeRateLimit(`public-confirm:${clientIp(request)}`, LIMIT, WINDOW_MS);
  if (limit.limited) {
    return fail(429, 'TOO_MANY_REQUESTS', 'Bạn báo hơi nhiều lần, thử lại sau ít phút.', {
      retryAfter: limit.retryAfter,
    });
  }

  const { code } = await context.params;
  const normalized = normalizeAccessCode(code);
  if (!isValidAccessCodeShape(normalized)) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  const debtor = await findDebtorByCode(normalized);
  if (!debtor) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  const body = await readJson(request);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail(400, 'INVALID_AMOUNT', 'Số tiền đã chuyển không hợp lệ');
  }
  if (amount > 1_000_000_000) {
    return fail(400, 'INVALID_AMOUNT', 'Số tiền quá lớn, vui lòng kiểm tra lại');
  }

  const note = parseString(body.note, { field: 'Lời nhắn', max: 200 });
  const now = new Date();

  const { confirmations } = await getCollections();
  const result = await confirmations.insertOne({
    debtorId: debtor._id,
    amount: Math.round(amount),
    note,
    status: 'pending',
    reply: '',
    declaredAt: now,
    resolvedAt: null,
  } as ConfirmationDoc);

  return json(
    {
      ok: true,
      id: result.insertedId.toString(),
      declaredAt: now.toISOString(),
      message: 'Đã ghi nhận. Chủ nợ sẽ kiểm tra và xác nhận.',
    },
    { status: 201 },
  );
});
