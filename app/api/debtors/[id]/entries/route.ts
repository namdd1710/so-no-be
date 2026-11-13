import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { MAX_RANGE_DAYS, checkEntryWritable, dateRangeList, daysInRange, todayInTimeZone, watermarkOf } from '@/lib/ledger';
import { findDebtorById, loadLedger, toObjectId } from '@/lib/service';
import { parseAmount, parseEntryDate, parseLedgerQuery, parseQuantity, parseString } from '@/lib/validate';
import type { EntryDoc, EntryType } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** GET /api/debtors/:id/entries — sổ entries (status/month/from/to/page). */
export const GET = route<Context>(async (request, context) => {
  await requireAdmin(request);
  const { id } = await context.params;
  const url = new URL(request.url);
  const q = parseLedgerQuery(url.searchParams);
  return json(await loadLedger(id, q));
});

/**
 * POST /api/debtors/:id/entries — thêm khoản phát sinh.
 *
 * Hai chế độ:
 * - một ngày: `{ date, ... }`
 * - khoảng ngày: `{ fromDate, toDate, ... }` → tạo MỖI NGÀY một bản ghi
 *   (ví dụ ăn cơm 01/10 → 11/11), tất cả cùng đơn giá/số lượng.
 *
 * Tiền: client gửi `unitAmount` (đơn giá ×1) + `quantity`; server tự tính
 * `amount = unitAmount × quantity` và lưu cả ba. Client cũ chỉ gửi `amount`
 * thì coi như đơn giá = amount, số lượng = 1.
 */
export const POST = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);

  const body = await readJson(request);
  const today = todayInTimeZone();

  // ----- ngày: một ngày hay một khoảng -----
  const hasFrom = body.fromDate !== undefined && body.fromDate !== null && body.fromDate !== '';
  const hasTo = body.toDate !== undefined && body.toDate !== null && body.toDate !== '';
  const isRange = hasFrom || hasTo;

  const fromRaw = isRange ? (hasFrom ? body.fromDate : body.toDate) : body.date;
  const toRaw = isRange ? (hasTo ? body.toDate : body.fromDate) : body.date;

  const from = parseEntryDate(fromRaw, today);
  const to = parseEntryDate(toRaw, today);
  if (from > to) throw new ApiError(400, 'INVALID_RANGE', 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc');

  if (isRange && daysInRange(from, to) > MAX_RANGE_DAYS) {
    throw new ApiError(400, 'RANGE_TOO_LONG', `Một lần chỉ thêm được tối đa ${MAX_RANGE_DAYS} ngày`);
  }
  const dates = isRange ? dateRangeList(from, to) : [from];

  // ----- tiền: đơn giá × số lượng -----
  const category = parseString(body.category, { field: 'Danh mục', max: 60, required: true });
  const quantity = parseQuantity(body.quantity);
  const unitAmount = parseAmount('unitAmount' in body ? body.unitAmount : body.amount);
  const amount = parseAmount(unitAmount * quantity);
  const note = parseString(body.note, { field: 'Ghi chú', max: 500 });

  if (amount === 0) throw new ApiError(400, 'INVALID_AMOUNT', 'Số tiền không được bằng 0');

  const { entries, settlements } = await getCollections();
  const settlementDocs = await settlements
    .find({ debtorId: debtor._id })
    .project<{ periodEnd: string; status: 'active' | 'void' }>({ periodEnd: 1, status: 1 })
    .toArray();
  const watermark = watermarkOf(settlementDocs);

  // Cả khoảng phải nằm ngoài kỳ đã chốt, không thì từ chối luôn thay vì ghi một nửa.
  const lockedDate = dates.find((date) => !checkEntryWritable(date, watermark).ok);
  if (lockedDate) {
    throw new ApiError(
      409,
      'LOCKED_PERIOD',
      `Khoản ngày ${lockedDate} thuộc kỳ đã chốt (đến ${watermark}). Huỷ chốt kỳ ${watermark} để thêm.`,
    );
  }

  // Phân biệt khoản thêm lẻ và khoản sinh ra từ khoảng ngày.
  const entryType: EntryType = isRange ? 'range' : 'single';

  const now = new Date();
  const docs: Omit<EntryDoc, '_id'>[] = dates.map((date) => ({
    debtorId: toObjectId(id),
    date,
    category,
    amount,
    unitAmount,
    quantity,
    entryType,
    note,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));

  const result = await entries.insertMany(docs as EntryDoc[]);
  const created = dates.map((date, index) => ({
    id: result.insertedIds[index]!.toString(),
    date,
    category,
    amount,
    unitAmount,
    quantity,
    entryType,
    note,
    editable: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }));

  return json(
    {
      // `entry` giữ nguyên cho client cũ; `entries` cho trường hợp khoảng ngày.
      entry: created[0],
      entries: created,
      createdCount: created.length,
      createdTotal: amount * created.length,
    },
    { status: 201 },
  );
});
