/**
 * lib/service.ts — truy vấn Mongo + dựng dữ liệu trả về cho client.
 *
 * Mọi tổng số đều tính lại từ `entries` bằng `lib/ledger.ts`; settlement.amount
 * chỉ dùng để hiển thị lịch sử (nguyên tắc vàng, BRIEF §5.4).
 */

import { ObjectId } from 'mongodb';
import { getCollections } from './db';
import {
  groupByDate,
  monthTotal,
  settleAmount,
  settleCount,
  sumRange,
  todayInTimeZone,
  unsettled,
  watermarkOf,
  latestActiveSettlement,
  isValidMonth,
} from './ledger';
import { ApiError } from './http';
import type {
  DebtorDoc,
  DebtorSummary,
  EntryDoc,
  EntryJson,
  LedgerResponse,
  PublicLedgerResponse,
  SettlementDoc,
  SettlementJson,
} from './types';

export function toObjectId(id: string): ObjectId {
  if (!/^[a-f\d]{24}$/i.test(id)) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu');
  return new ObjectId(id);
}

function baseUrl(): string {
  return (process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
}

export function shareUrlFor(accessCode: string): string {
  return `${baseUrl()}/s/${accessCode}`;
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
    shareUrl: shareUrlFor(debtor.accessCode),
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

  return docs.map((doc) =>
    summarise(doc, entriesByDebtor.get(doc._id.toString()) ?? [], settlementsByDebtor.get(doc._id.toString()) ?? [], today),
  );
}

/* ------------------------------- Ledger ------------------------------ */

export async function loadLedger(debtorId: string, month?: string | null): Promise<LedgerResponse> {
  const debtor = await findDebtorById(debtorId);
  const { entries, settlements } = await getCollections();
  const today = todayInTimeZone();

  const [entryDocs, settlementDocs] = await Promise.all([
    entries.find({ debtorId: debtor._id, deletedAt: null }).sort({ date: -1, createdAt: 1 }).toArray(),
    settlements.find({ debtorId: debtor._id }).sort({ periodEnd: -1 }).toArray(),
  ]);

  const watermark = watermarkOf(settlementDocs);
  const monthFilter = month && isValidMonth(month) ? month : null;
  const visibleDocs = monthFilter ? entryDocs.filter((doc) => doc.date.startsWith(monthFilter)) : entryDocs;

  const visibleEntries = visibleDocs.map((doc) => toEntryJson(doc, watermark));
  const groups = groupByDate(visibleEntries).map((group) => ({
    date: group.date,
    total: group.total,
    count: group.count,
    entries: group.entries,
  }));

  const categories = [...new Set(entryDocs.map((doc) => doc.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));

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
      monthTotal: monthFilter ? monthTotal(entryDocs, monthFilter) : sumRange(entryDocs, null, today),
      unsettledCount: settleCount(entryDocs, watermark, today),
      settlePreview: settleAmount(entryDocs, watermark, today),
      settlePreviewCount: settleCount(entryDocs, watermark, today),
    },
    entries: visibleEntries,
    groups,
    settlements: settlementDocs.map(toSettlementJson),
    month: monthFilter,
    categories,
  };
}

/* --------------------------- Public ledger --------------------------- */

export async function loadPublicLedger(code: string, month?: string | null): Promise<PublicLedgerResponse> {
  const debtor = await findDebtorByCode(code);
  // 404 không phân biệt "không tồn tại" và "không có quyền" (BRIEF §9).
  if (!debtor) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  const { entries, settlements } = await getCollections();
  const today = todayInTimeZone();

  const [entryDocs, settlementDocs] = await Promise.all([
    entries.find({ debtorId: debtor._id, deletedAt: null }).sort({ date: -1, createdAt: 1 }).toArray(),
    settlements.find({ debtorId: debtor._id }).sort({ periodEnd: -1 }).toArray(),
  ]);

  const watermark = watermarkOf(settlementDocs);
  const monthFilter = month && isValidMonth(month) ? month : null;
  const visibleDocs = monthFilter ? entryDocs.filter((doc) => doc.date.startsWith(monthFilter)) : entryDocs;

  // Chỉ trường công khai: KHÔNG phone, KHÔNG note nội bộ, KHÔNG accessCode.
  const entriesJson = visibleDocs.map((doc) => ({
    id: doc._id.toString(),
    date: doc.date,
    category: doc.category,
    amount: doc.amount,
    note: doc.note ?? '',
  }));

  const groups = groupByDate(entriesJson).map((group) => ({
    date: group.date,
    total: group.total,
    count: group.count,
    entries: group.entries,
  }));

  const active = settlementDocs.filter((s) => s.status === 'active');
  const latest = latestActiveSettlement(settlementDocs);

  return {
    name: debtor.name,
    today,
    watermark,
    latestSettlement: latest ? { periodEnd: latest.periodEnd, amount: latest.amount } : null,
    totals: {
      unsettled: unsettled(entryDocs, watermark, today),
      unsettledCount: settleCount(entryDocs, watermark, today),
      settled: active.reduce((sum, s) => sum + s.amount, 0),
      monthTotal: monthFilter ? monthTotal(entryDocs, monthFilter) : sumRange(entryDocs, null, today),
    },
    entries: entriesJson,
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
    month: monthFilter,
  };
}

/** Danh sách danh mục đã dùng (autocomplete) — không phụ thuộc con nợ. */
export async function usedCategories(debtorId?: string): Promise<string[]> {
  const { entries } = await getCollections();
  const filter: Record<string, unknown> = { deletedAt: null };
  if (debtorId) filter.debtorId = toObjectId(debtorId);
  const values = await entries.distinct('category', filter);
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).sort((a, b) => a.localeCompare(b, 'vi'));
}
