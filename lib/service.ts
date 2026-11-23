/**
 * lib/service.ts — truy vấn Mongo + dựng dữ liệu trả về cho client.
 *
 * Mọi tổng số đều tính lại từ `entries` bằng `lib/ledger.ts`; settlement.amount
 * chỉ dùng để hiển thị lịch sử (nguyên tắc vàng, BRIEF §5.4).
 */

import { ObjectId } from 'mongodb';
import { getCollections } from './db';
import {
  filterEntriesByLedgerQuery,
  groupByDate,
  settleAmount,
  settleCount,
  todayInTimeZone,
  unsettled,
  watermarkOf,
  latestActiveSettlement,
  isValidMonth,
  paginateDayGroups,
} from './ledger';
import { ApiError } from './http';
import { MAX_QR_COUNT } from './payment-qr';
import type {
  CategoryDoc,
  CategoryJson,
  ConfirmationDoc,
  ConfirmationJson,
  DebtorDoc,
  PaymentQrDoc,
  PaymentQrJson,
  DebtorSummary,
  EntryDoc,
  EntryJson,
  LedgerResponse,
  PublicLedgerResponse,
  SettlementDoc,
  SettlementJson,
} from './types';

export type LedgerQueryInput = {
  status?: 'unsettled' | 'settled' | 'all';
  month?: string | null;
  from?: string | null;
  to?: string | null;
  page?: number;
  pageSize?: number;
};

function hasRange(from: string | null, to: string | null) {
  return Boolean(from || to);
}

export function toObjectId(id: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(id)) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
  return new ObjectId(id);
}

function iso(date: Date | null | undefined): string | null {
  return date ? new Date(date).toISOString() : null;
}

export function toSettlementJson(doc: SettlementDoc): SettlementJson {
  return {
    id: doc._id.toString(),
    periodStart: doc.periodStart,
    periodEnd: doc.periodEnd,
    amount: doc.amount,
    entryCount: doc.entryCount,
    status: doc.status,
    voidReason: doc.voidReason ?? null,
    createdAt: iso(doc.createdAt) ?? new Date().toISOString(),
    voidedAt: iso(doc.voidedAt),
  };
}

function toEntryJson(doc: EntryDoc, watermark: string | null): EntryJson {
  return {
    id: doc._id.toString(),
    date: doc.date,
    category: doc.category,
    amount: doc.amount,
    // Khoản cũ (trước khi có số lượng) rơi về đơn giá = tổng, số lượng = 1.
    unitAmount: doc.unitAmount ?? doc.amount,
    quantity: doc.quantity ?? 1,
    entryType: doc.entryType ?? 'single',
    startDate: doc.startDate ?? null,
    endDate: doc.startDate ? doc.date : null,
    note: doc.note ?? '',
    editable: watermark === null || doc.date > watermark,
    createdAt: iso(doc.createdAt) ?? '',
    updatedAt: iso(doc.updatedAt) ?? '',
  };
}

/* ------------------------------ Debtors ------------------------------ */

export async function findDebtorById(id: string): Promise<DebtorDoc> {
  const { debtors } = await getCollections();
  const doc = await debtors.findOne({ _id: toObjectId(id) });
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy con nợ');
  return doc;
}

export async function findDebtorByCode(code: string): Promise<DebtorDoc | null> {
  const { debtors } = await getCollections();
  return debtors.findOne({ accessCode: code, active: true });
}

function summarise(
  debtor: DebtorDoc,
  entries: { date: string; amount: number }[],
  settlements: SettlementDoc[],
  today: string,
): DebtorSummary {
  const watermark = watermarkOf(settlements);
  const active = settlements.filter((s) => s.status === 'active');
  const latest = latestActiveSettlement(settlements);
  return {
    id: debtor._id.toString(),
    name: debtor.name,
    phone: debtor.phone ?? null,
    note: debtor.note ?? null,
    accessCode: debtor.accessCode,
    active: debtor.active,
    createdAt: iso(debtor.createdAt) ?? '',
    archivedAt: iso(debtor.archivedAt),
    dueDate: debtor.dueDate ?? null,
    unsettled: unsettled(entries, watermark, today),
    settled: active.reduce((sum, s) => sum + s.amount, 0),
    lastSettledAt: latest?.periodEnd ?? null,
    entryCount: entries.length,
  };
}

export type ListDebtorsOptions = {
  includeArchived?: boolean;
  search?: string;
  today?: string;
};

export async function listDebtors(options: ListDebtorsOptions = {}): Promise<DebtorSummary[]> {
  const { debtors, entries, settlements } = await getCollections();
  const today = options.today ?? todayInTimeZone();

  const filter: Record<string, unknown> = {};
  if (!options.includeArchived) filter.active = true;
  if (options.search) {
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.name = { $regex: escaped, $options: 'i' };
  }

  const docs = await debtors.find(filter).sort({ active: 1, createdAt: -1 }).toArray();
  if (docs.length === 0) return [];

  const ids = docs.map((doc) => doc._id);
  const [entryRows, settlementRows] = await Promise.all([
    entries
      .find({ debtorId: { $in: ids }, deletedAt: null, date: { $lte: today } })
      .project<{ debtorId: ObjectId; date: string; amount: number }>({ debtorId: 1, date: 1, amount: 1 })
      .toArray(),
    settlements.find({ debtorId: { $in: ids } }).sort({ periodEnd: 1 }).toArray(),
  ]);

  const entriesByDebtor = new Map<string, { date: string; amount: number }[]>();
  for (const row of entryRows) {
    const key = row.debtorId.toString();
    const bucket = entriesByDebtor.get(key);
    if (bucket) bucket.push({ date: row.date, amount: row.amount });
    else entriesByDebtor.set(key, [{ date: row.date, amount: row.amount }]);
  }

  const settlementsByDebtor = new Map<string, SettlementDoc[]>();
  for (const row of settlementRows) {
    const key = row.debtorId.toString();
    const bucket = settlementsByDebtor.get(key);
    if (bucket) bucket.push(row);
    else settlementsByDebtor.set(key, [row]);
  }

  const summaries = docs.map((doc) =>
    summarise(doc, entriesByDebtor.get(doc._id.toString()) ?? [], settlementsByDebtor.get(doc._id.toString()) ?? [], today),
  );

  // Sổ nợ: ai nợ nhiều nhất lên đầu. Cùng số tiền thì xếp theo tên cho ổn định
  // (và để kết quả không nhảy qua lại giữa các lần tải).
  return summaries.sort((a, b) => b.unsettled - a.unsettled || a.name.localeCompare(b.name, 'vi'));
}

/* ------------------------------- Ledger ------------------------------ */

export function toCategoryJson(doc: CategoryDoc): CategoryJson {
  return { id: doc._id.toString(), name: doc.name, unitPrice: doc.unitPrice };
}

/** Danh mục dùng chung, sắp xếp theo tên tiếng Việt. */
export async function listCategories(): Promise<CategoryJson[]> {
  const { categories } = await getCollections();
  const docs = await categories.find({}).sort({ name: 1 }).toArray();
  return docs.map(toCategoryJson).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Báo lỗi 409 nếu tên danh mục đã tồn tại (bỏ qua chính nó khi sửa). */
async function assertCategoryNameFree(name: string, excludeId?: ObjectId): Promise<void> {
  const { categories } = await getCollections();
  const filter: Record<string, unknown> = { name };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await categories.findOne(filter)) {
    throw new ApiError(409, 'DUPLICATE_CATEGORY', `Danh mục "${name}" đã có rồi`);
  }
}

/** Thêm danh mục dùng chung (tên + đơn giá cố định). */
export async function createCategory(name: string, unitPrice: number): Promise<CategoryJson> {
  await assertCategoryNameFree(name);
  const now = new Date();
  const { categories } = await getCollections();
  const doc = { name, unitPrice: Math.abs(unitPrice), createdAt: now, updatedAt: now };
  try {
    const result = await categories.insertOne(doc as CategoryDoc);
    return toCategoryJson({ ...doc, _id: result.insertedId } as CategoryDoc);
  } catch (error) {
    // Hai request cùng lúc: index unique chặn ở DB, đổi thành lỗi 409 dễ hiểu.
    if (error instanceof Error && /E11000/.test(error.message)) {
      throw new ApiError(409, 'DUPLICATE_CATEGORY', `Danh mục "${name}" đã có rồi`);
    }
    throw error;
  }
}

/** Sửa tên/đơn giá của một danh mục. */
export async function updateCategory(
  id: string,
  patch: { name?: string; unitPrice?: number },
): Promise<CategoryJson> {
  const objectId = toObjectId(id);
  if (patch.name !== undefined) await assertCategoryNameFree(patch.name, objectId);

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.unitPrice !== undefined) update.unitPrice = Math.abs(patch.unitPrice);

  const { categories } = await getCollections();
  const doc = await categories.findOneAndUpdate({ _id: objectId }, { $set: update }, { returnDocument: 'after' });
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy danh mục này');
  return toCategoryJson(doc);
}

/** Xoá danh mục. Khoản cũ vẫn giữ tên danh mục dạng chuỗi nên không mất dữ liệu. */
export async function deleteCategory(id: string): Promise<void> {
  const { categories } = await getCollections();
  const result = await categories.deleteOne({ _id: toObjectId(id) });
  if (result.deletedCount === 0) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy danh mục này');
}

/**
 * Bổ sung danh mục còn thiếu khi gặp một tên mới (nhập tự do trong lúc thêm
 * khoản). Danh mục đã có thì giữ nguyên đơn giá do chủ nợ đặt — không tự đè.
 */
export async function rememberCategoryPrices(items: { category: string; unitAmount: number }[]): Promise<void> {
  const valid = items.filter((item) => item.category && item.unitAmount !== 0);
  if (valid.length === 0) return;

  const { categories } = await getCollections();
  const now = new Date();
  try {
    await Promise.all(
      valid.map((item) =>
        categories.updateOne(
          { name: item.category },
          {
            $setOnInsert: { unitPrice: Math.abs(item.unitAmount), createdAt: now },
            $set: { updatedAt: now },
          },
          { upsert: true },
        ),
      ),
    );
  } catch (error) {
    // Chỉ là bổ sung danh mục cho lần sau — lỗi ở đây không được làm hỏng việc
    // lưu khoản mà người dùng vừa thực hiện.
    console.warn('[service] Không lưu được danh mục:', error instanceof Error ? error.message : error);
  }
}

export function toPaymentQrJson(doc: PaymentQrDoc): PaymentQrJson {
  return {
    id: doc._id.toString(),
    bankName: doc.bankName ?? '',
    accountName: doc.accountName ?? '',
    accountNumber: doc.accountNumber ?? '',
    note: doc.note ?? '',
    image: doc.image,
    active: doc.active !== false,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Danh sách ảnh QR nhận tiền; `activeOnly` dùng cho trang công khai. */
export async function listPaymentQrs(activeOnly = false): Promise<PaymentQrJson[]> {
  const { paymentQrs } = await getCollections();
  const filter = activeOnly ? { active: true } : {};
  const docs = await paymentQrs.find(filter).sort({ createdAt: -1 }).limit(MAX_QR_COUNT).toArray();
  return docs.map(toPaymentQrJson);
}

export function toConfirmationJson(doc: ConfirmationDoc): ConfirmationJson {
  return {
    id: doc._id.toString(),
    amount: doc.amount,
    note: doc.note ?? '',
    status: doc.status,
    reply: doc.reply ?? '',
    declaredAt: doc.declaredAt.toISOString(),
    resolvedAt: doc.resolvedAt ? doc.resolvedAt.toISOString() : null,
  };
}

export async function loadLedger(debtorId: string, query: LedgerQueryInput = {}): Promise<LedgerResponse> {
  const debtor = await findDebtorById(debtorId);
  const { entries, settlements, categories: categoryCollection, confirmations } = await getCollections();
  const today = todayInTimeZone();

  const [entryDocs, settlementDocs, storedCategories, confirmationDocs] = await Promise.all([
    entries.find({ debtorId: debtor._id, deletedAt: null }).sort({ date: -1, createdAt: 1 }).toArray(),
    settlements.find({ debtorId: debtor._id }).sort({ periodEnd: -1 }).toArray(),
    categoryCollection.find({}).sort({ name: 1 }).toArray(),
    confirmations.find({ debtorId: debtor._id }).sort({ declaredAt: -1 }).limit(30).toArray(),
  ]);

  const watermark = watermarkOf(settlementDocs);
  const status = query.status ?? 'all';
  const month = query.month && isValidMonth(query.month) ? query.month : null;
  const from = query.from ?? null;
  const to = query.to ?? null;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 10;

  const filteredDocs = filterEntriesByLedgerQuery(entryDocs, {
    status,
    month,
    from,
    to,
    today,
    watermark,
  });

  const visibleEntries = filteredDocs.map((doc) => toEntryJson(doc, watermark));
  const allGroups = groupByDate(visibleEntries).map((group) => ({
    date: group.date,
    total: group.total,
    count: group.count,
    entries: group.entries,
  }));
  const { groups, pagination } = paginateDayGroups(allGroups, page, pageSize);

  const filterTotal = filteredDocs.reduce((sum, doc) => sum + doc.amount, 0);

  // Danh mục lấy từ bộ dùng chung (collection `categories`), không phụ thuộc
  // con nợ — thêm khoản chỉ việc chọn danh mục rồi nhập số lượng.
  const categoryDefaults = storedCategories
    .map(toCategoryJson)
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const categories = categoryDefaults.map((item) => item.name);

  const summary = summarise(debtor, entryDocs, settlementDocs, today);
  const active = settlementDocs.filter((s) => s.status === 'active');

  return {
    debtor: summary,
    today,
    watermark,
    latestSettlement: latestActiveSettlement(settlementDocs) ? toSettlementJson(latestActiveSettlement(settlementDocs)!) : null,
    totals: {
      unsettled: unsettled(entryDocs, watermark, today),
      settled: active.reduce((sum, s) => sum + s.amount, 0),
      monthTotal: filterTotal,
      unsettledCount: settleCount(entryDocs, watermark, today),
      settlePreview: settleAmount(entryDocs, watermark, today),
      settlePreviewCount: settleCount(entryDocs, watermark, today),
    },
    entries: groups.flatMap((g) => g.entries),
    groups,
    settlements: settlementDocs.map(toSettlementJson),
    status,
    month: hasRange(from, to) ? null : month,
    from,
    to,
    pagination,
    categories,
    categoryDefaults,
    confirmations: confirmationDocs.map(toConfirmationJson),
  };
}

/* --------------------------- Public ledger --------------------------- */

export async function loadPublicLedger(code: string, query: LedgerQueryInput = {}): Promise<PublicLedgerResponse> {
  const debtor = await findDebtorByCode(code);
  // 404 không phân biệt "không tồn tại" và "không có quyền" (BRIEF §9).
  if (!debtor) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  const { entries, settlements, confirmations } = await getCollections();
  const today = todayInTimeZone();

  const [entryDocs, settlementDocs, confirmationDocs] = await Promise.all([
    entries.find({ debtorId: debtor._id, deletedAt: null }).sort({ date: -1, createdAt: 1 }).toArray(),
    settlements.find({ debtorId: debtor._id }).sort({ periodEnd: -1 }).toArray(),
    confirmations.find({ debtorId: debtor._id }).sort({ declaredAt: -1 }).limit(20).toArray(),
  ]);

  const watermark = watermarkOf(settlementDocs);
  const status = query.status ?? 'all';
  const month = query.month && isValidMonth(query.month) ? query.month : null;
  const from = query.from ?? null;
  const to = query.to ?? null;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 10;

  const filteredDocs = filterEntriesByLedgerQuery(entryDocs, {
    status,
    month,
    from,
    to,
    today,
    watermark,
  });

  // Chỉ trường công khai: KHÔNG phone, KHÔNG note nội bộ, KHÔNG accessCode.
  const entriesJson = filteredDocs.map((doc) => ({
    id: doc._id.toString(),
    date: doc.date,
    category: doc.category,
    amount: doc.amount,
    unitAmount: doc.unitAmount ?? doc.amount,
    quantity: doc.quantity ?? 1,
    entryType: doc.entryType ?? 'single',
    startDate: doc.startDate ?? null,
    endDate: doc.startDate ? doc.date : null,
    note: doc.note ?? '',
  }));

  const allGroups = groupByDate(entriesJson).map((group) => ({
    date: group.date,
    total: group.total,
    count: group.count,
    entries: group.entries,
  }));
  const { groups, pagination } = paginateDayGroups(allGroups, page, pageSize);

  const filterTotal = filteredDocs.reduce((sum, doc) => sum + doc.amount, 0);

  const active = settlementDocs.filter((s) => s.status === 'active');
  const latest = latestActiveSettlement(settlementDocs);

  // Ngày bắt đầu của phần còn nợ: lấy mốc sớm nhất trong các khoản chưa chốt
  // (khoảng ngày thì tính từ startDate). Chưa chốt lần nào thì tính từ khoản
  // đầu tiên, để nội dung chuyển khoản luôn đủ "từ ngày … đến ngày …".
  const unpaidDocs = watermark ? entryDocs.filter((doc) => doc.date > watermark) : entryDocs;
  const debtFrom = unpaidDocs.reduce<string | null>((min, doc) => {
    const start = doc.startDate ?? doc.date;
    return min === null || start < min ? start : min;
  }, null);

  return {
    name: debtor.name,
    today,
    watermark,
    debtFrom,
    latestSettlement: latest ? { periodEnd: latest.periodEnd, amount: latest.amount } : null,
    totals: {
      unsettled: unsettled(entryDocs, watermark, today),
      unsettledCount: settleCount(entryDocs, watermark, today),
      settled: active.reduce((sum, s) => sum + s.amount, 0),
      monthTotal: filterTotal,
    },
    entries: groups.flatMap((g) => g.entries),
    groups,
    settlements: active
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
      .map((doc) => ({
        id: doc._id.toString(),
        periodStart: doc.periodStart,
        periodEnd: doc.periodEnd,
        amount: doc.amount,
        entryCount: doc.entryCount,
        createdAt: iso(doc.createdAt) ?? '',
      })),
    status,
    month: hasRange(from, to) ? null : month,
    from,
    to,
    pagination,
    confirmations: confirmationDocs.map(toConfirmationJson),
  };
}

/** Tên các danh mục dùng chung (autocomplete) — không phụ thuộc con nợ. */
export async function usedCategories(): Promise<string[]> {
  return (await listCategories()).map((item) => item.name);
}
