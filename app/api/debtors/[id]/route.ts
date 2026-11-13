import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { findDebtorById, loadLedger } from '@/lib/service';
import { parseBooleanish, parseLedgerQuery, parseString } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** GET /api/debtors/:id — sổ của một con nợ (status/month/from/to/page). */
export const GET = route<Context>(async (request, context) => {
  await requireAdmin(request);
  const { id } = await context.params;
  const url = new URL(request.url);
  const q = parseLedgerQuery(url.searchParams);
  return json(await loadLedger(id, q));
});

/**
 * DELETE /api/debtors/:id — xoá HẲN con nợ kèm toàn bộ khoản và lịch sử chốt.
 *
 * Không thể hoàn tác: đây là thao tác xoá thật, khác với lưu trữ (`archived: true`)
 * chỉ ẩn khỏi danh sách và giữ nguyên dữ liệu.
 */
export const DELETE = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);
  const { debtors, entries, settlements } = await getCollections();

  const [entryResult, settlementResult] = await Promise.all([
    entries.deleteMany({ debtorId: debtor._id }),
    settlements.deleteMany({ debtorId: debtor._id }),
  ]);
  await debtors.deleteOne({ _id: debtor._id });

  return json({
    ok: true,
    deleted: { entries: entryResult.deletedCount, settlements: settlementResult.deletedCount },
  });
});

/** PATCH /api/debtors/:id — sửa tên/SĐT/ghi chú hoặc lưu trữ. KHÔNG đổi accessCode. */
export const PATCH = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);
  const body = await readJson(request);

  if ('accessCode' in body) {
    throw new ApiError(400, 'ACCESS_CODE_IMMUTABLE', 'Mã truy cập là cố định, không thể đổi');
  }

  const update: Record<string, unknown> = {};

  if ('name' in body) update.name = parseString(body.name, { field: 'Tên con nợ', max: 80, required: true });
  if ('phone' in body) {
    const phone = parseString(body.phone, { field: 'Số điện thoại', max: 30 });
    update.phone = phone || null;
  }
  if ('note' in body) {
    const note = parseString(body.note, { field: 'Ghi chú', max: 500 });
    update.note = note || null;
  }

  const archived = parseBooleanish(body.archived);
  if (archived !== null) {
    update.active = !archived;
    update.archivedAt = archived ? new Date() : null;
  }

  if (Object.keys(update).length === 0) {
    throw new ApiError(400, 'NOTHING_TO_UPDATE', 'Không có thay đổi nào');
  }

  const { debtors } = await getCollections();
  const result = await debtors.findOneAndUpdate({ _id: debtor._id }, { $set: update }, { returnDocument: 'after' });
  const updated = result ?? { ...debtor, ...update };

  return json({
    debtor: {
      id: debtor._id.toString(),
      name: (updated.name as string) ?? debtor.name,
      phone: (updated.phone as string | null) ?? null,
      note: (updated.note as string | null) ?? null,
      accessCode: debtor.accessCode,
      active: (updated.active as boolean) ?? debtor.active,
      archivedAt: (updated.archivedAt as Date | null)?.toISOString?.() ?? null,
    },
  });
});
