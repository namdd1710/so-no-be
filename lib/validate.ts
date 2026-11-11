/**
 * lib/validate.ts — kiểm tra & chuẩn hoá dữ liệu đầu vào của API.
 */

import { ApiError } from './http';
import { isValidIsoDate, isValidMonth, todayInTimeZone, type LedgerStatus } from './ledger';

export type StringOptions = {
  field: string;
  max?: number;
  required?: boolean;
};

export function parseString(value: unknown, options: StringOptions): string {
  const max = options.max ?? 500;
  if (value === null || value === undefined) {
    if (options.required) throw new ApiError(400, 'MISSING_FIELD', `${options.field} không được để trống`);
    return '';
  }
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_FIELD', `${options.field} không hợp lệ`);
  const trimmed = value.trim();
  if (options.required && !trimmed) throw new ApiError(400, 'MISSING_FIELD', `${options.field} không được để trống`);
  if (trimmed.length > max) throw new ApiError(400, 'FIELD_TOO_LONG', `${options.field} tối đa ${max} ký tự`);
  return trimmed;
}

const MAX_AMOUNT = 1_000_000_000_000; // 1 nghìn tỷ

/**
 * Nhận `35000`, `"35000"`, `"35.000"`, `"35,000"` → 35000 (số nguyên VND).
 * Cho phép âm (giảm nợ / trả trước).
 */
export function parseAmount(value: unknown): number {
  let amount: number;

  if (typeof value === 'number') {
    amount = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw new ApiError(400, 'INVALID_AMOUNT', 'Số tiền không được để trống');
    const negative = trimmed.startsWith('-');
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (!digitsOnly) throw new ApiError(400, 'INVALID_AMOUNT', 'Số tiền không hợp lệ');
    amount = Number(digitsOnly) * (negative ? -1 : 1);
  } else {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Số tiền không hợp lệ');
  }

  if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.trunc(amount))) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Số tiền phải là số nguyên');
  }
  const rounded = Math.trunc(amount);
  if (Math.abs(rounded) > MAX_AMOUNT) {
    throw new ApiError(400, 'AMOUNT_TOO_LARGE', 'Số tiền vượt mức cho phép');
  }
  return rounded;
}

/** Ngày `YYYY-MM-DD`, không ở tương lai (BRIEF §5.4). */
export function parseEntryDate(value: unknown, today: string = todayInTimeZone()): string {
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    throw new ApiError(400, 'INVALID_DATE', 'Ngày không hợp lệ (định dạng YYYY-MM-DD)');
  }
  if (value > today) throw new ApiError(400, 'FUTURE_DATE', 'Không được nhập ngày ở tương lai');
  return value;
}

/** Tham số `month=YYYY-MM` (không bắt buộc). */
export function parseMonthParam(value: string | null): string | null {
  if (!value) return null;
  if (!isValidMonth(value)) throw new ApiError(400, 'INVALID_MONTH', 'month không hợp lệ (YYYY-MM)');
  return value;
}

export function parseLedgerStatus(value: string | null): LedgerStatus {
  if (!value || value === 'all') return 'all';
  if (value === 'unsettled' || value === 'settled') return value;
  throw new ApiError(400, 'INVALID_STATUS', 'status phải là unsettled, settled hoặc all');
}

export function parseOptionalIsoDateParam(value: string | null, field: string): string | null {
  if (!value) return null;
  if (!isValidIsoDate(value)) throw new ApiError(400, 'INVALID_DATE', `${field} không hợp lệ (YYYY-MM-DD)`);
  return value;
}

export function parsePageParam(value: string | null): number {
  if (!value) return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'INVALID_PAGE', 'page phải là số nguyên ≥ 1');
  return n;
}

export function parsePageSizeParam(value: string | null): number {
  if (!value) return 10;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new ApiError(400, 'INVALID_PAGE_SIZE', 'pageSize phải từ 1 đến 50');
  }
  return n;
}

export function parseLedgerQuery(searchParams: URLSearchParams) {
  const status = parseLedgerStatus(searchParams.get('status'));
  const month = parseMonthParam(searchParams.get('month'));
  const from = parseOptionalIsoDateParam(searchParams.get('from'), 'from');
  const to = parseOptionalIsoDateParam(searchParams.get('to'), 'to');
  if (from && to && from > to) throw new ApiError(400, 'INVALID_RANGE', 'from phải ≤ to');
  const page = parsePageParam(searchParams.get('page'));
  const pageSize = parsePageSizeParam(searchParams.get('pageSize'));
  return { status, month, from, to, page, pageSize };
}

export function parseBooleanish(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}
