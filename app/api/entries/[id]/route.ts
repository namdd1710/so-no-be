import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { checkEntryWritable, todayInTimeZone, watermarkOf } from '@/lib/ledger';
import { toObjectId } from '@/lib/service';
import { parseAmount, parseEntryDate, parseString } from '@/lib/validate';
import type { EntryDoc } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

async function loadEntry(id: string) {
  const { entries, settlements } = await getCollections();
  const entry = await entries.findOne({ _id: toObjectId(id), deletedAt: null });
  if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy khoản này');
  const settlementDocs = await settlements
    .find({ debtorId: entry.debtorId })
    .project<{ periodEnd: string; status: 'active' | 'void' }>({ periodEnd: 1, status: 1 })
    .toArray();
  return { entry, watermark: watermarkOf(settlementDocs), entries };
}

/** PATCH /api/entries/:id — sửa khoản (chặn nếu thuộc kỳ đã chốt). */
export const PATCH = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const { entry, watermark, entries } = await loadEntry(id);

  if (watermark !== null && entry.date <= watermark) {
    throw new ApiError(
      409,
      'LOCKED_PERIOD',
      `Khoản ngày ${entry.date} thuộc kỳ đã chốt (đến ${watermark}). Huỷ chốt kỳ ${watermark} để sửa.`,
    );
  }

  const body = await readJson(request);
  const today = todayInTimeZone();
  const update: Partial<EntryDoc> = { updatedAt: new Date() };

  if ('date' in body) {
    const date = parseEntryDate(body.date, today);
    const guard = checkEntryWritable(date, watermark);
    if (!guard.ok) throw new ApiError(409, guard.code, guard.message);
    update.date = date;
  }
  if ('category' in body) update.category = parseString(body.category, { field: 'Danh mục', max: 60, required: true });
  if ('amount' in body) {
    const amount = parseAmount(body.amount);
    if (amount === 0) throw new ApiError(400, 'INVALID_AMOUNT', 'Số tiền không được bằng 0');
    update.amount = amount;
  }
  if ('note' in body) update.note = parseString(body.note, { field: 'Ghi chú', max: 500 });

  const result = await entries.findOneAndUpdate({ _id: entry._id, deletedAt: null }, { $set: update }, { returnDocument: 'after' });
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy khoản này');

  return json({
    entry: {
      id: result._id.toString(),
      date: result.date,
      category: result.category,
      amount: result.amount,
      note: result.note ?? '',
      editable: true,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    },
  });
});

/** DELETE /api/entries/:id — soft delete (chặn nếu thuộc kỳ đã chốt). */
export const DELETE = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const { entry, watermark, entries } = await loadEntry(id);

  if (watermark !== null && entry.date <= watermark) {
    throw new ApiError(
      409,
      'LOCKED_PERIOD',
      `Khoản ngày ${entry.date} thuộc kỳ đã chốt (đến ${watermark}). Huỷ chốt kỳ ${watermark} để xoá.`,
    );
  }

  const now = new Date();
  await entries.updateOne({ _id: entry._id, deletedAt: null }, { $set: { deletedAt: now, updatedAt: now } });

  return json({ ok: true, deletedId: entry._id.toString() });
});
