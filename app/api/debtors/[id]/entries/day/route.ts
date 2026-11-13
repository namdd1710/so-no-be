import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { checkEntryWritable, todayInTimeZone, watermarkOf } from '@/lib/ledger';
import { findDebtorById } from '@/lib/service';
import { parseEntryDate } from '@/lib/validate';
import type { EntryDoc, EntryType } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * PATCH /api/debtors/:id/entries/day — sửa ở cấp NGÀY.
 *
 * Body: `{ fromDate, toDate, entryType?, startDate? }`
 * - Dời mọi khoản đang ở `fromDate` sang `toDate`.
 * - Nếu ngày chỉ có đúng một khoản thì đổi được cả loại: `entryType: 'range'`
 *   (kèm `startDate`) hoặc `'single'` (xoá khoảng).
 *
 * Cả ngày đi và ngày đến đều phải nằm ngoài kỳ đã chốt, nếu không sẽ từ chối
 * toàn bộ thay vì dời được một nửa.
 */
export const PATCH = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);

  const body = await readJson(request);
  const today = todayInTimeZone();
  const fromDate = parseEntryDate(body.fromDate, today);
  const toDate = parseEntryDate(body.toDate ?? body.fromDate, today);

  const changesType = 'entryType' in body;
  if (fromDate === toDate && !changesType) {
    throw new ApiError(400, 'NOTHING_TO_UPDATE', 'Không có thay đổi nào: ngày mới trùng ngày cũ');
  }

  const { entries, settlements } = await getCollections();
  const settlementDocs = await settlements
    .find({ debtorId: debtor._id })
    .project<{ periodEnd: string; status: 'active' | 'void' }>({ periodEnd: 1, status: 1 })
    .toArray();
  const watermark = watermarkOf(settlementDocs);

  for (const date of new Set([fromDate, toDate])) {
    const guard = checkEntryWritable(date, watermark);
    if (!guard.ok) throw new ApiError(409, guard.code, guard.message);
  }

  const docs = await entries.find({ debtorId: debtor._id, date: fromDate, deletedAt: null }).toArray();
  if (docs.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Ngày này không có khoản nào để sửa');

  const now = new Date();
  const update: Partial<EntryDoc> = { date: toDate, updatedAt: now };

  if (changesType) {
    if (docs.length !== 1) {
      throw new ApiError(
        400,
        'TYPE_NEEDS_SINGLE',
        'Ngày này có nhiều khoản nên chỉ dời được ngày, không đổi được loại',
      );
    }
    const entryType = body.entryType;
    if (entryType !== 'single' && entryType !== 'range') {
      throw new ApiError(400, 'INVALID_ENTRY_TYPE', "entryType phải là 'single' hoặc 'range'");
    }
    if (entryType === 'range') {
      const startDate = parseEntryDate(body.startDate ?? fromDate, today);
      if (startDate > toDate) {
        throw new ApiError(400, 'INVALID_RANGE', 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc');
      }
      const guard = checkEntryWritable(startDate, watermark);
      if (!guard.ok) throw new ApiError(409, guard.code, guard.message);
      update.entryType = 'range' as EntryType;
      update.startDate = startDate;
    } else {
      update.entryType = 'single' as EntryType;
      update.startDate = null;
    }
  }

  const result = await entries.updateMany(
    { debtorId: debtor._id, date: fromDate, deletedAt: null },
    { $set: update },
  );

  return json({
    moved: result.modifiedCount,
    fromDate,
    toDate,
    entryType: update.entryType ?? (docs[0]?.entryType ?? 'single'),
    startDate: update.startDate !== undefined ? update.startDate : (docs[0]?.startDate ?? null),
  });
});
