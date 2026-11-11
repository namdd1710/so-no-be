import { getCollections, withTransaction } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { checkSettlement, todayInTimeZone, watermarkOf } from '@/lib/ledger';
import { findDebtorById } from '@/lib/service';
import { parseString } from '@/lib/validate';
import type { SettlementDoc } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/debtors/:id/settle?periodEnd=YYYY-MM-DD — xem trước kỳ sẽ chốt.
 * Không ghi gì cả, dùng cho dialog "Chốt đã thanh toán".
 */
export const GET = route<Context>(async (request, context) => {
  await requireAdmin(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);
  const url = new URL(request.url);
  const today = todayInTimeZone();
  const periodEnd = parseString(url.searchParams.get('periodEnd'), { field: 'Ngày chốt', max: 10, required: true });

  const { entries, settlements } = await getCollections();
  const [existing, rows] = await Promise.all([
    settlements
      .find({ debtorId: debtor._id })
      .project<{ periodEnd: string; status: 'active' | 'void' }>({ periodEnd: 1, status: 1 })
      .toArray(),
    entries
      .find({ debtorId: debtor._id, deletedAt: null, date: { $lte: periodEnd } })
      .project<{ date: string; amount: number }>({ date: 1, amount: 1 })
      .toArray(),
  ]);

  const check = checkSettlement(rows, existing, periodEnd, today);
  if (!check.ok) {
    return json({
      ok: false,
      periodStart: watermarkOf(existing),
      periodEnd,
      amount: 0,
      entryCount: 0,
      dayCount: 0,
      code: check.code,
      message: check.message,
    });
  }

  return json({ ...check, today });
});

/**
 * POST /api/debtors/:id/settle — chốt đã thanh toán (BRIEF §5.2).
 *
 * Chạy trong transaction: đọc lại W, tính tổng, insert settlement.
 * Nếu W đã đổi so với lúc mở dialog (`expectedWatermark`) → từ chối, yêu cầu tải lại.
 * KHÔNG xoá khoản nào — settlement chỉ là mốc thời gian.
 */
export const POST = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);

  const body = await readJson(request);
  const today = todayInTimeZone();
  const periodEndRaw = parseString(body.periodEnd, { field: 'Ngày chốt', max: 10, required: true });

  const expectedRaw = body.expectedWatermark;
  const expectedWatermark =
    expectedRaw === null || expectedRaw === undefined ? undefined : parseString(expectedRaw, { field: 'Mốc chốt', max: 10 });

  if (periodEndRaw > today) throw new ApiError(400, 'FUTURE_DATE', 'Ngày chốt không được ở tương lai');

  const settlement = await withTransaction(async (session) => {
    const { entries, settlements } = await getCollections();
    const options = session ? { session } : {};

    const existing = await settlements
      .find({ debtorId: debtor._id }, options)
      .project<{ periodEnd: string; status: 'active' | 'void' }>({ periodEnd: 1, status: 1 })
      .toArray();
    const watermark = watermarkOf(existing);

    // Optimistic concurrency: W phải giống lúc mở dialog.
    if (expectedWatermark !== undefined && expectedWatermark !== (watermark ?? '')) {
      throw new ApiError(409, 'STALE_WATERMARK', 'Sổ đã thay đổi. Vui lòng tải lại trang rồi chốt lại.');
    }

    const rows = await entries
      .find({ debtorId: debtor._id, deletedAt: null, date: { $lte: periodEndRaw } }, options)
      .project<{ date: string; amount: number }>({ date: 1, amount: 1 })
      .toArray();

    const check = checkSettlement(rows, existing, periodEndRaw, today);
    if (!check.ok) throw new ApiError(409, check.code, check.message);

    const doc: Omit<SettlementDoc, '_id'> = {
      debtorId: debtor._id,
      periodStart: check.periodStart,
      periodEnd: check.periodEnd,
      amount: check.amount,
      entryCount: check.entryCount,
      status: 'active',
      voidReason: null,
      createdAt: new Date(),
      voidedAt: null,
    };
    const result = await settlements.insertOne(doc as SettlementDoc, options);
    return { settlement: { ...doc, _id: result.insertedId } as SettlementDoc, dayCount: check.dayCount };
  });

  return json(
    {
      settlement: {
        id: settlement.settlement._id.toString(),
        periodStart: settlement.settlement.periodStart,
        periodEnd: settlement.settlement.periodEnd,
        amount: settlement.settlement.amount,
        entryCount: settlement.settlement.entryCount,
        dayCount: settlement.dayCount,
        status: settlement.settlement.status,
        voidReason: null,
        createdAt: settlement.settlement.createdAt.toISOString(),
        voidedAt: null,
      },
    },
    { status: 201 },
  );
});
