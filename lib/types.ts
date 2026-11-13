/**
 * lib/types.ts — kiểu dữ liệu Mongo (BRIEF §6).
 *
 * Ngày là CHUỖI `YYYY-MM-DD`. Tiền là số nguyên VND.
 */

import type { ObjectId } from 'mongodb';

export type DebtorDoc = {
  _id: ObjectId;
  name: string;
  phone: string | null;
  note: string | null;
  /** 12 ký tự Crockford Base32, sinh 1 lần, BẤT BIẾN. */
  accessCode: string;
  active: boolean;
  createdAt: Date;
  archivedAt: Date | null;
};

export type EntryDoc = {
  _id: ObjectId;
  debtorId: ObjectId;
  date: string; // YYYY-MM-DD
  category: string;
  /** Tổng = unitAmount × quantity (đây là số mọi phép tính sổ dùng). */
  amount: number; // số nguyên VND, cho phép âm
  /** Đơn giá nhập vào (×1). Khoản cũ chưa có field này → coi như = amount. */
  unitAmount?: number;
  /** Số lượng. Khoản cũ chưa có → coi như 1. */
  quantity?: number;
  note: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type SettlementDoc = {
  _id: ObjectId;
  debtorId: ObjectId;
  periodStart: string | null;
  periodEnd: string;
  amount: number;
  entryCount: number;
  status: 'active' | 'void';
  voidReason: string | null;
  createdAt: Date;
  voidedAt: Date | null;
};

/* ---------- Hình dạng dữ liệu trả cho client (JSON) ---------- */

export type DebtorSummary = {
  id: string;
  name: string;
  phone: string | null;
  note: string | null;
  accessCode: string;
  active: boolean;
  createdAt: string;
  archivedAt: string | null;
  unsettled: number;
  settled: number;
  lastSettledAt: string | null;
  entryCount: number;
};

export type EntryJson = {
  id: string;
  date: string;
  category: string;
  /** Tổng của khoản = unitAmount × quantity. */
  amount: number;
  /** Đơn giá nhập vào (không nhân số lượng). */
  unitAmount: number;
  /** Số lượng (≥ 1). */
  quantity: number;
  note: string;
  editable: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SettlementJson = {
  id: string;
  periodStart: string | null;
  periodEnd: string;
  amount: number;
  entryCount: number;
  status: 'active' | 'void';
  voidReason: string | null;
  createdAt: string;
  voidedAt: string | null;
};

export type LedgerTotals = {
  /** Tổng chưa thanh toán (date > W, date <= today). */
  unsettled: number;
  /** Tổng đã chốt (Σ settlement active.amount — chỉ để hiển thị lịch sử). */
  settled: number;
  /** Tổng theo bộ lọc tháng đang xem. */
  monthTotal: number;
  /** Số khoản chưa thanh toán. */
  unsettledCount: number;
  /** Tổng trong kỳ chưa chốt, sẵn sàng để chốt ngay hôm nay. */
  settlePreview: number;
  settlePreviewCount: number;
};

export type PaginationMeta = {
  page: number;
  pageSize: number;
  totalGroups: number;
  totalPages: number;
};

export type LedgerResponse = {
  debtor: DebtorSummary;
  today: string;
  watermark: string | null;
  latestSettlement: SettlementJson | null;
  totals: LedgerTotals;
  entries: EntryJson[];
  groups: { date: string; total: number; count: number; entries: EntryJson[] }[];
  settlements: SettlementJson[];
  month: string | null;
  status: 'unsettled' | 'settled' | 'all';
  from: string | null;
  to: string | null;
  pagination: PaginationMeta;
  categories: string[];
};

export type PublicLedgerResponse = {
  name: string;
  today: string;
  watermark: string | null;
  latestSettlement: { periodEnd: string; amount: number } | null;
  totals: { unsettled: number; unsettledCount: number; settled: number; monthTotal: number };
  entries: { id: string; date: string; category: string; amount: number; unitAmount: number; quantity: number; note: string }[];
  groups: {
    date: string;
    total: number;
    count: number;
    entries: { id: string; date: string; category: string; amount: number; unitAmount: number; quantity: number; note: string }[];
  }[];
  settlements: { id: string; periodStart: string | null; periodEnd: string; amount: number; entryCount: number; createdAt: string }[];
  month: string | null;
  status: 'unsettled' | 'settled' | 'all';
  from: string | null;
  to: string | null;
  pagination: PaginationMeta;
};
