import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { findDebtorById, toConfirmationJson, toObjectId } from '@/lib/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; confirmationId: string }> };

const STATUSES = ['pending', 'confirmed', 'rejected'] as const;

/**
 * PATCH /api/debtors/:id/confirmations/:confirmationId — chủ nợ đánh dấu.
 *
 * `confirmed` = đã thấy tiền trong sao kê; `rejected` = không thấy / sai số
 * tiền. Chỉ đổi trạng thái lời khai, KHÔNG tự chốt kỳ — chốt vẫn là thao tác
 * riêng để tổng nợ luôn tính lại từ entries.
 */
export const PATCH = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id, confirmationId } = await context.params;
  const debtor = await findDebtorById(id);
  const body = await readJson(request);

  if (!STATUSES.includes(body.status as (typeof STATUSES)[number])) {
    throw new ApiError(400, 'INVALID_STATUS', "status phải là 'pending', 'confirmed' hoặc 'rejected'");
  }
  const status = body.status as (typeof STATUSES)[number];

  const { confirmations } = await getCollections();
  const now = new Date();
  const result = await confirmations.findOneAndUpdate(
    { _id: toObjectId(confirmationId), debtorId: debtor._id },
    { $set: { status, resolvedAt: status === 'pending' ? null : now } },
    { returnDocument: 'after' },
  );

  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lời báo này');

  return json({ confirmation: toConfirmationJson(result) });
});
