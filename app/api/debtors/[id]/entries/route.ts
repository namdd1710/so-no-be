import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { MAX_RANGE_DAYS, checkEntryWritable, daysInRange, todayInTimeZone, watermarkOf } from '@/lib/ledger';
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
 * Hai dạng, MỘT bản ghi cho mỗi lần gọi:
 * - một ngày: `{ date, ... }` — không có khoảng.
 * - khoảng ngày: `{ fromDate, toDate, ... }` — lưu `startDate = fromDate`,
 *   `date = toDate` (ngày kết thúc là mốc để nhóm ngày và tính tổng).
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

  // ----- ngày: một ngày hay một khoảng (vẫn chỉ một bản ghi) -----
  const hasFrom = body.fromDate !== undefined && body.fromDate !== null && body.fromDate !== '';
  const hasTo = body.toDate !== undefined && body.toDate !== null && body.toDate !== '';
  const isRange = hasFrom || hasTo;

  const fromRaw = isRange ? (hasFrom ? body.fromDate : body.toDate) : body.date;
  const toRaw = isRange ? (hasTo ? body.toDate : body.fromDate) : body.date;

  const parsedFrom = parseEntryDate(fromRaw, today);
  const date = parseEntryDate(toRaw, today); // ngày kết thúc (hoặc ngày duy nhất)

  if (isRange && parsedFrom > date) {
    throw new ApiError(400, 'INVALID_RANGE', 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc');
  }
  if (isRange && daysInRange(parsedFrom, date) > MAX_RANGE_DAYS) {
    throw new ApiError(400, 'RANGE_TOO_LONG', `Một khoảng chỉ được dài tối đa ${MAX_RANGE_DAYS} ngày`);
  }

  const startDate = isRange ? parsedFrom : null;

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

  // Cả hai đầu của khoảng đều phải nằm ngoài kỳ đã chốt.
  for (const guardDate of isRange ? [parsedFrom, date] : [date]) {
    const guard = checkEntryWritable(guardDate, watermark);
    if (!guard.ok) throw new ApiError(409, guard.code, guard.message);
  }

  // Phân biệt khoản thêm lẻ và khoản theo khoảng ngày.
  const entryType: EntryType = isRange ? 'range' : 'single';

  const now = new Date();
  const doc: Omit<EntryDoc, '_id'> = {
    debtorId: toObjectId(id),
    date,
    startDate,
    category,
    amount,
    unitAmount,
    quantity,
    entryType,
    note,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const result = await entries.insertOne(doc as EntryDoc);

  return json(
    {
      entry: {
        id: result.insertedId.toString(),
        date,
        startDate,
        endDate: isRange ? date : null,
        category,
        amount,
        unitAmount,
        quantity,
        entryType,
        note,
        editable: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      createdCount: 1,
    },
    { status: 201 },
  );
});
