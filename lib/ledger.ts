/**
 * lib/ledger.ts — trái tim của app (BRIEF §5, §15).
 *
 * Toàn bộ hàm ở đây là hàm THUẦN (pure): không I/O, không phụ thuộc Mongo.
 * Mọi tổng số đều tính lại từ `entries`; `settlement.amount` chỉ là snapshot
 * lịch sử (nguyên tắc vàng: không bao giờ lệch sổ).
 *
 * Ngày luôn là CHUỖI `YYYY-MM-DD` để tránh lệch múi giờ.
 * So sánh ngày dùng so sánh chuỗi (an toàn với định dạng ISO).
 */

export const TIME_ZONE = 'Asia/Ho_Chi_Minh';

export type LedgerEntry = {
  date: string; // YYYY-MM-DD
  amount: number; // số nguyên VND, cho phép âm
};

export type SettlementLike = {
  periodStart: string | null;
  periodEnd: string;
  amount: number;
  entryCount: number;
  status: 'active' | 'void';
};

/** Chỉ cần hai trường này để xác định mốc chốt W. */
export type WatermarkSource = {
  periodEnd: string;
  status: 'active' | 'void';
};

/* ------------------------------------------------------------------ */
/* Ngày                                                                */
/* ------------------------------------------------------------------ */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` hợp lệ và là ngày có thật trên lịch (chặn 31/09). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** `YYYY-MM` hợp lệ. */
export function isValidMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Hôm nay theo Asia/Ho_Chi_Minh, dạng `YYYY-MM-DD`. */
export function todayInTimeZone(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `YYYY-MM-DD` -> `2026-11-10` (không đổi, giữ đúng ngữ nghĩa chuỗi). */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Cộng/trừ số ngày trên lịch UTC, trả về `YYYY-MM-DD`. */
export function addDaysIso(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Số ngày tối đa cho một lần thêm theo khoảng (chặn bấm nhầm 10 năm). */
export const MAX_RANGE_DAYS = 366;

/** Số ngày trong khoảng [from, to], tính cả hai đầu. */
export function daysInRange(from: string, to: string): number {
  let count = 0;
  for (let date = from; date <= to; date = addDaysIso(date, 1)) count += 1;
  return count;
}

/**
 * Danh sách ngày `YYYY-MM-DD` trong [from, to], tăng dần.
 * Dùng để thêm cùng một khoản cho từng ngày của một khoảng.
 */
export function dateRangeList(from: string, to: string, maxDays: number = MAX_RANGE_DAYS): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to && dates.length < maxDays; date = addDaysIso(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/* ------------------------------------------------------------------ */
/* Tổng theo khoảng ngày                                               */
/* ------------------------------------------------------------------ */

/** Σ amount của các entry thoả `from < date <= to`. `from = null` = từ đầu. */
export function sumRange(entries: LedgerEntry[], from: string | null, to: string): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.date > to) continue;
    if (from !== null && entry.date <= from) continue;
    total += entry.amount;
  }
  return total;
}

/** Số entry thoả `from < date <= to`. */
export function countRange(entries: LedgerEntry[], from: string | null, to: string): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.date > to) continue;
    if (from !== null && entry.date <= from) continue;
    count += 1;
  }
  return count;
}

/** Các entry thoả `from < date <= to`, sắp xếp mới nhất trước. */
export function entriesInRange<T extends LedgerEntry>(entries: T[], from: string | null, to: string): T[] {
  return entries
    .filter((entry) => entry.date <= to && (from === null || entry.date > from))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ------------------------------------------------------------------ */
/* Mốc chốt (watermark) W                                              */
/* ------------------------------------------------------------------ */

/** Settlement đang active, sắp theo periodEnd tăng dần. */
export function activeSettlements<T extends WatermarkSource>(settlements: T[]): T[] {
  return settlements
    .filter((s) => s.status === 'active')
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

/** Settlement active mới nhất (kỳ gần nhất đã chốt). */
export function latestActiveSettlement<T extends WatermarkSource>(settlements: T[]): T | null {
  const active = activeSettlements(settlements);
  return active.length > 0 ? active[active.length - 1] : null;
}

/** `W = periodEnd` của settlement active mới nhất, hoặc `null` nếu chưa chốt lần nào. */
export function watermarkOf(settlements: WatermarkSource[]): string | null {
  return latestActiveSettlement(settlements)?.periodEnd ?? null;
}

/* ------------------------------------------------------------------ */
/* Hai hàm cốt lõi (BRIEF §15)                                          */
/* ------------------------------------------------------------------ */

/** Tổng CHƯA thanh toán: các entry `date > W` và `date <= today`. */
export function unsettled(entries: LedgerEntry[], watermark: string | null, today: string): number {
  return sumRange(entries, watermark, today);
}

/** Tổng sẽ chốt nếu chốt vào ngày `d`: các entry `W < date <= d`. */
export function settleAmount(entries: LedgerEntry[], watermark: string | null, d: string): number {
  return sumRange(entries, watermark, d);
}

/** Số khoản sẽ chốt nếu chốt vào ngày `d`. */
export function settleCount(entries: LedgerEntry[], watermark: string | null, d: string): number {
  return countRange(entries, watermark, d);
}

/** Ngày đã nằm trong kỳ đã chốt chưa (bị khoá sửa/xoá)? */
export function isLockedBySettlement(date: string, watermark: string | null): boolean {
  return watermark !== null && date <= watermark;
}

/* ------------------------------------------------------------------ */
/* Nhóm theo ngày / tháng / danh mục                                   */
/* ------------------------------------------------------------------ */

export type DayGroup<T extends LedgerEntry = LedgerEntry> = {
  date: string;
  total: number;
  count: number;
  entries: T[];
};

/** Nhóm entry theo ngày, mới nhất trên cùng. */
export function groupByDate<T extends LedgerEntry>(entries: T[]): DayGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const entry of entries) {
    const bucket = map.get(entry.date);
    if (bucket) bucket.push(entry);
    else map.set(entry.date, [entry]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
      date,
      total: list.reduce((sum, e) => sum + e.amount, 0),
      count: list.length,
      entries: list,
    }));
}

export type LedgerStatus = 'unsettled' | 'settled' | 'all';

export type LedgerListFilter = {
  status: LedgerStatus;
  month: string | null;
  from: string | null;
  to: string | null;
  today: string;
  watermark: string | null;
};

/** Lọc entry theo status + tháng/khoảng ngày (range thắng month). */
export function filterEntriesByLedgerQuery<T extends LedgerEntry>(entries: T[], filter: LedgerListFilter): T[] {
  let list = entries;

  if (filter.status === 'unsettled') {
    list = list.filter((e) => e.date <= filter.today && (filter.watermark === null || e.date > filter.watermark));
  } else if (filter.status === 'settled') {
    if (filter.watermark === null) return [];
    list = list.filter((e) => e.date <= filter.watermark!);
  }

  const hasRange = Boolean(filter.from || filter.to);
  if (hasRange) {
    list = list.filter((e) => {
      if (filter.from && e.date < filter.from) return false;
      if (filter.to && e.date > filter.to) return false;
      return true;
    });
  } else if (filter.month) {
    list = list.filter((e) => e.date.startsWith(filter.month!));
  }

  return list;
}

/** Phân trang theo folder ngày; page ngoài biên bị kẹp về trang hợp lệ. */
export function paginateDayGroups<T extends LedgerEntry>(
  groups: DayGroup<T>[],
  page: number,
  pageSize: number,
): { groups: DayGroup<T>[]; pagination: { page: number; pageSize: number; totalGroups: number; totalPages: number } } {
  const totalGroups = groups.length;
  const totalPages = totalGroups === 0 ? 0 : Math.ceil(totalGroups / pageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    groups: groups.slice(start, start + pageSize),
    pagination: { page: safePage, pageSize, totalGroups, totalPages },
  };
}

/** Tổng các entry thuộc một tháng `YYYY-MM`. */
export function monthTotal(entries: LedgerEntry[], month: string): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.date.startsWith(month)) total += entry.amount;
  }
  return total;
}

export type CategoryTotal = { category: string; total: number; count: number };

/** Tổng theo danh mục, lớn nhất trước. */
export function totalsByCategory(entries: LedgerEntry[] & { category?: string }[]): CategoryTotal[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const entry of entries as { category?: string; amount: number }[]) {
    const key = entry.category?.trim() || 'Khác';
    const bucket = map.get(key) ?? { total: 0, count: 0 };
    bucket.total += entry.amount;
    bucket.count += 1;
    map.set(key, bucket);
  }
  return [...map.entries()]
    .map(([category, value]) => ({ category, ...value }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

/* ------------------------------------------------------------------ */
/* Kiểm tra nghiệp vụ                                                  */
/* ------------------------------------------------------------------ */

export type SettleCheck =
  | { ok: true; periodStart: string | null; periodEnd: string; amount: number; entryCount: number; dayCount: number }
  | { ok: false; code: string; message: string };

/**
 * Kiểm tra một lần chốt vào ngày `periodEnd` (BRIEF §5.2, §5.4).
 * Không ghi gì cả — chỉ trả về kết quả tính toán.
 */
export function checkSettlement(
  entries: LedgerEntry[],
  settlements: WatermarkSource[],
  periodEnd: string,
  today: string,
): SettleCheck {
  if (!isValidIsoDate(periodEnd)) {
    return { ok: false, code: 'INVALID_DATE', message: 'Ngày chốt không hợp lệ' };
  }
  if (periodEnd > today) {
    return { ok: false, code: 'FUTURE_DATE', message: 'Ngày chốt không được ở tương lai' };
  }
  const watermark = watermarkOf(settlements);
  if (watermark !== null && periodEnd < watermark) {
    return {
      ok: false,
      code: 'BEFORE_WATERMARK',
      message: `Ngày chốt phải sau mốc chốt gần nhất (${watermark})`,
    };
  }
  const periodEntries = entriesInRange(entries, watermark, periodEnd);
  const entryCount = periodEntries.length;
  if (entryCount === 0) {
    return { ok: false, code: 'EMPTY_PERIOD', message: 'Không có khoản nào trong kỳ' };
  }
  return {
    ok: true,
    periodStart: watermark,
    periodEnd,
    amount: periodEntries.reduce((sum, entry) => sum + entry.amount, 0),
    entryCount,
    dayCount: new Set(periodEntries.map((entry) => entry.date)).size,
  };
}

/**
 * Kiểm tra chốt một khoản ăn / sửa vào ngày `date` khi đã có mốc `W`.
 * Khoản nằm trong kỳ đã chốt (date <= W) thì phải huỷ chốt trước.
 */
export function checkEntryWritable(date: string, watermark: string | null): SettleCheck | { ok: true } {
  if (watermark !== null && date <= watermark) {
    return {
      ok: false,
      code: 'LOCKED_PERIOD',
      message: `Khoản này thuộc kỳ đã chốt (đến ${watermark}). Huỷ chốt kỳ ${watermark} để sửa.`,
    };
  }
  return { ok: true };
}
