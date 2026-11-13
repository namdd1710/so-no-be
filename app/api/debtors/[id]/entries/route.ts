import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { MAX_RANGE_DAYS, checkEntryWritable, daysInRange, todayInTimeZone, watermarkOf } from '@/lib/ledger';
import { findDebtorById, loadLedger, toObjectId } from '@/lib/service';
import { parseAmount, parseEntryDate, parseLedgerQuery, parseQuantity, parseString } from '@/lib/validate';
import type { EntryDoc, EntryType } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Một lần thêm tối đa bao nhiêu khoản (đủ cho một buổi nhập tay). */
const MAX_ITEMS = 50;

type ParsedItem = {
  category: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  note: string;
};

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
 * Ngày dùng chung cho cả lần thêm:
 * - một ngày: `{ date }`
 * - khoảng ngày: `{ fromDate, toDate }` → MỘT bản ghi, `startDate = fromDate`,
 *   `date = toDate` (ngày kết thúc là mốc nhóm ngày và tính tổng).
 *
 * Khoản có thể gửi một hoặc nhiều:
 * - nhiều: `{ items: [{ category, unitAmount, quantity, note }, ...] }`
 * - một (client cũ): `{ category, unitAmount, quantity, note }`
 *
 * Tiền: client gửi `unitAmount` (đơn giá ×1) + `quantity`; server tự tính
 * `amount = unitAmount × quantity`. Client rất cũ chỉ gửi `amount` thì coi như
 * đơn giá = amount, số lượng = 1.
 */
export const POST = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const debtor = await findDebtorById(id);

  const body = await readJson(request);
  const today = todayInTimeZone();

  // ----- ngày: một ngày hay một khoảng (vẫn một bản ghi mỗi khoản) -----
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
  const entryType: EntryType = isRange ? 'range' : 'single';

  // ----- danh sách khoản: một hoặc nhiều -----
  const rawItems = Array.isArray(body.items) && body.items.length > 0 ? body.items : [body];
  if (rawItems.length > MAX_ITEMS) {
    throw new ApiError(400, 'TOO_MANY_ITEMS', `Mỗi lần chỉ thêm được tối đa ${MAX_ITEMS} khoản`);
  }

  const items: ParsedItem[] = rawItems.map((raw, index) => {
    const label = rawItems.length > 1 ? `Khoản ${index + 1}: ` : '';
    const item = (raw ?? {}) as Record<string, unknown>;
    const category = parseString(item.category, { field: `${label}Danh mục`, max: 60, required: true });
    const quantity = parseQuantity(item.quantity);
    const unitAmount = parseAmount('unitAmount' in item ? item.unitAmount : item.amount);
    const amount = parseAmount(unitAmount * quantity);
    if (amount === 0) throw new ApiError(400, 'INVALID_AMOUNT', `${label} số tiền không được bằng 0`);
    const note = parseString(item.note, { field: `${label}Ghi chú`, max: 500 });
    return { category, quantity, unitAmount, amount, note };
  });

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

  const now = new Date();
  const docs: Omit<EntryDoc, '_id'>[] = items.map((item) => ({
    debtorId: toObjectId(id),
    date,
    startDate,
    category: item.category,
    amount: item.amount,
    unitAmount: item.unitAmount,
    quantity: item.quantity,
    entryType,
    note: item.note,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));

  const result = await entries.insertMany(docs as EntryDoc[]);
  const created = docs.map((doc, index) => ({
    id: result.insertedIds[index]!.toString(),
    date: doc.date,
    startDate: doc.startDate ?? null,
    endDate: startDate ? doc.date : null,
    category: doc.category,
    amount: doc.amount,
    unitAmount: doc.unitAmount ?? doc.amount,
    quantity: doc.quantity ?? 1,
    entryType,
    note: doc.note,
    editable: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }));

  return json(
    {
      // `entry` giữ nguyên cho client cũ; `entries` cho trường hợp thêm nhiều khoản.
      entry: created[0],
      entries: created,
      createdCount: created.length,
      createdTotal: created.reduce((sum, entry) => sum + entry.amount, 0),
    },
    { status: 201 },
  );
});
