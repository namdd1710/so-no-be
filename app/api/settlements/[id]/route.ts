import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { toObjectId } from '@/lib/service';
import { parseString } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/settlements/:id/void — huỷ chốt (BRIEF §5.4).
 *
 * Settlement chuyển sang `status: 'void'` + `voidReason`; KHÔNG xoá bản ghi.
 * `W` tự lùi về settlement active trước đó vì W luôn tính lại từ dữ liệu.
 */
export const POST = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const body = await readJson(request);
  const reason = parseString(body.reason, { field: 'Lý do', max: 200 }) || 'Huỷ chốt';

  const { settlements } = await getCollections();
  const settlement = await settlements.findOne({ _id: toObjectId(id) });
  if (!settlement) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lần chốt này');
  if (settlement.status !== 'active') throw new ApiError(409, 'ALREADY_VOID', 'Lần chốt này đã được huỷ trước đó');

  // Chỉ huỷ được lần chốt GẦN NHẤT để lịch sử luôn liền mạch.
  const newer = await settlements.findOne(
    { debtorId: settlement.debtorId, status: 'active', periodEnd: { $gt: settlement.periodEnd } },
    { projection: { _id: 1, periodEnd: 1 } },
  );
  if (newer) {
    throw new ApiError(
      409,
      'NOT_LATEST_SETTLEMENT',
      `Phải huỷ lần chốt gần nhất (${newer.periodEnd}) trước khi huỷ kỳ ${settlement.periodEnd}.`,
    );
  }

  const voidedAt = new Date();
  await settlements.updateOne(
    { _id: settlement._id, status: 'active' },
    { $set: { status: 'void', voidReason: reason, voidedAt } },
  );

  const remaining = await settlements
    .find({ debtorId: settlement.debtorId, status: 'active' })
    .sort({ periodEnd: -1 })
    .limit(1)
    .toArray();

  return json({
    ok: true,
    voidedId: settlement._id.toString(),
    watermark: remaining[0]?.periodEnd ?? null,
  });
});
