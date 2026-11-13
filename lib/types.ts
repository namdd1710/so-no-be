/**
 * lib/types.ts — kiểu dữ liệu Mongo (BRIEF §6).
 *
 * Ngày là CHUỖI `YYYY-MM-DD`. Tiền là số nguyên VND.
 */

import type { ObjectId } from 'mongodb';

/** Cách một khoản được tạo ra — để phân biệt khoản lẻ và khoản theo khoảng ngày. */
export type EntryType = 'single' | 'range';

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
  /**
   * Nguồn tạo khoản: `single` = thêm lẻ một ngày,
   * `range` = sinh ra từ một lần thêm theo khoảng ngày.
   * Khoản cũ chưa có field này → coi như `single`.
   */
  entryType?: EntryType;
  /**
   * Với khoản theo khoảng ngày: ngày bắt đầu của khoảng.
   * `date` là ngày kết thúc (mốc dùng để nhóm ngày và tính tổng).
   * Khoản một ngày thì không có field này.
   */
  startDate?: string | null;
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
  /** `single` = thêm lẻ, `range` = một khoản trải trên một khoảng ngày. */
  entryType: EntryType;
  /** `null` với khoản một ngày; có giá trị với khoản theo khoảng. */
  startDate: string | null;
  /** `null` với khoản một ngày; với khoảng thì bằng `date` (ngày kết thúc). */
  endDate: string | null;
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

/** Ảnh QR nhận tiền (MoMo/ngân hàng) chủ nợ tải lên, lưu base64 trong Mongo. */
export type PaymentQrDoc = {
  _id: ObjectId;
  bankName: string;
  accountName: string;
  accountNumber: string;
  note: string;
  /** Data URL: `data:image/png;base64,…` */
  image: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PaymentQrJson = {
  id: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  note: string;
  image: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Con nợ tự báo "đã chuyển khoản" để chủ nợ kiểm tra và xác nhận đã nhận. */
export type ConfirmationDoc = {
  _id: ObjectId;
  debtorId: ObjectId;
  amount: number;
  note: string;
  status: 'pending' | 'confirmed' | 'rejected';
  /** Phản hồi của chủ nợ khi xác nhận (con nợ đọc được). */
  reply: string;
  declaredAt: Date;
  resolvedAt: Date | null;
};

export type ConfirmationJson = {
  id: string;
  amount: number;
  note: string;
  status: 'pending' | 'confirmed' | 'rejected';
  reply: string;
  declaredAt: string;
  resolvedAt: string | null;
};

/** Danh mục kèm đơn giá gần nhất — dùng để tự điền giá khi thêm khoản. */
export type CategoryDoc = {
  _id: ObjectId;
  debtorId: ObjectId;
  name: string;
  /** Đơn giá ×1 gần nhất của danh mục này. */
  unitPrice: number;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CategoryJson = {
  name: string;
  unitPrice: number;
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
  /** Cùng danh sách `categories` nhưng kèm đơn giá gần nhất. */
  categoryDefaults: CategoryJson[];
  /** Các lần con nợ báo đã chuyển khoản (mới nhất trước). */
  confirmations: ConfirmationJson[];
};

export type PublicLedgerResponse = {
  name: string;
  today: string;
  watermark: string | null;
  latestSettlement: { periodEnd: string; amount: number } | null;
  totals: { unsettled: number; unsettledCount: number; settled: number; monthTotal: number };
  /** Lời báo đã chuyển khoản của chính con nợ này (kèm phản hồi của chủ nợ). */
  confirmations: {
    id: string;
    amount: number;
    note: string;
    status: 'pending' | 'confirmed' | 'rejected';
    reply: string;
    declaredAt: string;
    resolvedAt: string | null;
  }[];
  entries: {
    id: string;
    date: string;
    category: string;
    amount: number;
    unitAmount: number;
    quantity: number;
    entryType: EntryType;
    startDate: string | null;
    endDate: string | null;
    note: string;
  }[];
  groups: {
    date: string;
    total: number;
    count: number;
    entries: {
      id: string;
      date: string;
      category: string;
      amount: number;
      unitAmount: number;
      quantity: number;
      entryType: EntryType;
      startDate: string | null;
      endDate: string | null;
      note: string;
    }[];
  }[];
  settlements: { id: string; periodStart: string | null; periodEnd: string; amount: number; entryCount: number; createdAt: string }[];
  month: string | null;
  status: 'unsettled' | 'settled' | 'all';
  from: string | null;
  to: string | null;
  pagination: PaginationMeta;
};
