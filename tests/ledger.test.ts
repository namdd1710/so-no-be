/**
 * Test cho "trái tim" của app (BRIEF §15) — chạy: npm test
 * Không cần Mongo, không cần network: chỉ hàm thuần.
 */

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import {
  addDaysIso,
  checkSettlement,
  countRange,
  dateRangeList,
  daysInRange,
  filterEntriesByLedgerQuery,
  groupByDate,
  isLockedBySettlement,
  isValidIsoDate,
  isValidMonth,
  monthTotal,
  paginateDayGroups,
  settleAmount,
  todayInTimeZone,
  unsettled,
  watermarkOf,
  totalsByCategory,
} from '../lib/ledger.ts';

type E = { date: string; amount: number };
type S = { periodStart: string | null; periodEnd: string; amount: number; entryCount: number; status: 'active' | 'void' };

const TODAY = '2026-11-10';
const ENTRIES: E[] = [
  { date: '2026-09-15', amount: 50000 },
  { date: '2026-09-30', amount: 75000 },
  { date: '2026-10-01', amount: 35000 },
  { date: '2026-10-09', amount: 30000 },
  { date: '2026-11-10', amount: 120000 },
  { date: '2026-11-11', amount: 999 }, // tương lai — phải bị loại khỏi unsettled
];

const SETTLED_0930: S = {
  periodStart: null,
  periodEnd: '2026-09-30',
  amount: 125000,
  entryCount: 2,
  status: 'active',
};

describe('ngày tháng', () => {
  it('chấp nhận ngày có thật', () => {
    assert.equal(isValidIsoDate('2026-09-30'), true);
    assert.equal(isValidIsoDate('2024-02-29'), true);
  });

  it('chặn 31/09 và các ngày không tồn tại (BRIEF §5.3)', () => {
    assert.equal(isValidIsoDate('2026-09-31'), false);
    assert.equal(isValidIsoDate('2026-02-30'), false);
    assert.equal(isValidIsoDate('2025-02-29'), false);
    assert.equal(isValidIsoDate('2026-13-01'), false);
    assert.equal(isValidIsoDate('10/11/2026'), false);
  });

  it('tính "hôm nay" theo Asia/Ho_Chi_Minh', () => {
    // 2026-11-10T18:00:00Z = 01:00 ngày 11/11 giờ VN
    assert.equal(todayInTimeZone(new Date('2026-11-10T18:00:00Z')), '2026-11-11');
    // 2026-11-10T16:59:00Z = 23:59 ngày 10/11 giờ VN
    assert.equal(todayInTimeZone(new Date('2026-11-10T16:59:00Z')), '2026-11-10');
  });

  it('kiểm tra tham số tháng', () => {
    assert.equal(isValidMonth('2026-11'), true);
    assert.equal(isValidMonth('2026-13'), false);
    assert.equal(isValidMonth('2026-1'), false);
  });
});

describe('tổng theo khoảng', () => {
  it('sumRange với from = null tính từ đầu', () => {
    assert.equal(settleAmount(ENTRIES, null, '2026-09-30'), 125000);
  });

  it('countRange đếm đúng số khoản trong kỳ', () => {
    assert.equal(countRange(ENTRIES, null, '2026-09-30'), 2);
    assert.equal(countRange(ENTRIES, '2026-09-30', TODAY), 3);
  });
});

describe('chốt 30/09 với W = null', () => {
  it('amount = tổng mọi khoản <= 30/09', () => {
    assert.equal(settleAmount(ENTRIES, null, '2026-09-30'), 125000);
  });

  it('sau chốt, unsettled chỉ còn khoản > 30/09 và <= hôm nay', () => {
    assert.equal(unsettled(ENTRIES, '2026-09-30', TODAY), 35000 + 30000 + 120000);
  });

  it('khoản tương lai không bao giờ vào unsettled', () => {
    const withFuture = [...ENTRIES, { date: '2026-12-01', amount: 5000000 }];
    assert.equal(unsettled(withFuture, '2026-09-30', TODAY), 185000);
  });

  it('chốt ngày 30/09 không xoá khoản nào', () => {
    assert.equal(ENTRIES.length, 6);
  });
});

describe('huỷ chốt', () => {
  it('W quay về null thì unsettled trở lại như trước', () => {
    const voided: S = { ...SETTLED_0930, status: 'void' };
    assert.equal(watermarkOf([voided]), null);
    assert.equal(unsettled(ENTRIES, watermarkOf([voided]), TODAY), 50000 + 75000 + 35000 + 30000 + 120000);
  });

  it('W lùi về settlement active trước đó', () => {
    const list: S[] = [SETTLED_0930, { ...SETTLED_0930, periodStart: '2026-09-30', periodEnd: '2026-10-31', amount: 65000, entryCount: 2 }];
    assert.equal(watermarkOf(list), '2026-10-31');
    assert.equal(watermarkOf([list[0], { ...list[1], status: 'void' }]), '2026-09-30');
  });

  it('bỏ qua settlement void khi tính W', () => {
    const list: S[] = [
      SETTLED_0930,
      { periodStart: '2026-09-30', periodEnd: '2026-10-31', amount: 65000, entryCount: 2, status: 'void' },
    ];
    assert.equal(watermarkOf(list), '2026-09-30');
  });
});

describe('chặn sửa khoản đã chốt', () => {
  it('khoản <= W bị khoá', () => {
    assert.equal(isLockedBySettlement('2026-09-30', '2026-09-30'), true);
    assert.equal(isLockedBySettlement('2026-10-01', '2026-09-30'), false);
  });

  it('chưa chốt lần nào thì không khoá gì', () => {
    assert.equal(isLockedBySettlement('2020-01-01', null), false);
  });
});

describe('checkSettlement (BRIEF §5.4)', () => {
  it('chốt hợp lệ', () => {
    const result = checkSettlement(ENTRIES, [], '2026-09-30', TODAY);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.amount, 125000);
      assert.equal(result.entryCount, 2);
      assert.equal(result.periodStart, null);
    }
  });

  it('chặn kỳ rỗng', () => {
    const result = checkSettlement(ENTRIES, [SETTLED_0930], '2026-09-30', TODAY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'EMPTY_PERIOD');
  });

  it('chặn chọn ngày chốt < W', () => {
    const result = checkSettlement(ENTRIES, [SETTLED_0930], '2026-09-01', TODAY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'BEFORE_WATERMARK');
  });

  it('chặn ngày chốt ở tương lai', () => {
    const result = checkSettlement(ENTRIES, [], '2026-11-11', TODAY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'FUTURE_DATE');
  });

  it('double-click: lần 2 thấy kỳ rỗng nên bị từ chối', () => {
    const first = checkSettlement(ENTRIES, [], '2026-10-10', TODAY);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const after: S = {
      periodStart: first.periodStart,
      periodEnd: first.periodEnd,
      amount: first.amount,
      entryCount: first.entryCount,
      status: 'active',
    };
    const second = checkSettlement(ENTRIES, [after], '2026-10-10', TODAY);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, 'EMPTY_PERIOD');
  });

  it('chặn ngày không tồn tại (31/09)', () => {
    const result = checkSettlement(ENTRIES, [], '2026-09-31', TODAY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_DATE');
  });
});

describe('nhóm & tổng phụ', () => {
  it('nhóm theo ngày, mới nhất trước', () => {
    const groups = groupByDate([
      { date: '2026-11-10', amount: 35000 },
      { date: '2026-11-10', amount: 120000 },
      { date: '2026-11-09', amount: 30000 },
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].date, '2026-11-10');
    assert.equal(groups[0].total, 155000);
    assert.equal(groups[0].count, 2);
    assert.equal(groups[1].total, 30000);
  });

  it('tổng theo tháng', () => {
    assert.equal(monthTotal(ENTRIES, '2026-11'), 120000 + 999);
    assert.equal(monthTotal(ENTRIES, '2026-10'), 65000);
    assert.equal(monthTotal(ENTRIES, '2026-08'), 0);
  });

  it('tổng theo danh mục, gộp khoản âm', () => {
    const totals = totalsByCategory([
      { date: '2026-11-01', category: 'Mua cơm', amount: 35000 },
      { date: '2026-11-02', category: 'Mua cơm', amount: 15000 },
      { date: '2026-11-03', category: 'Trả trước', amount: -50000 },
    ]);
    const rice = totals.find((t) => t.category === 'Mua cơm');
    assert.equal(rice?.total, 50000);
    assert.equal(rice?.count, 2);
    const credit = totals.find((t) => t.category === 'Trả trước');
    assert.equal(credit?.total, -50000);
  });

  it('khoản âm vẫn cộng vào tổng', () => {
    assert.equal(
      unsettled(
        [
          { date: '2026-11-01', amount: 100000 },
          { date: '2026-11-02', amount: -40000 },
        ],
        null,
        TODAY,
      ),
      60000,
    );
  });
});

describe('kịch bản trọn vòng đời (BRIEF §12)', () => {
  it('chốt 30/09 → thêm 01/10 → huỷ chốt ra đúng số cũ', () => {
    const entries: E[] = [
      { date: '2026-09-10', amount: 100000 },
      { date: '2026-09-30', amount: 50000 },
    ];

    // 1. Trước khi chốt
    assert.equal(unsettled(entries, null, TODAY), 150000);

    // 2. Chốt ngày 30/09
    const settled = checkSettlement(entries, [], '2026-09-30', TODAY);
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(settled.amount, 150000);
    assert.equal(settled.entryCount, 2);

    const settlements: S[] = [{ ...settled, status: 'active' }];
    const w = watermarkOf(settlements);

    // 3. Khoản cũ rời khỏi "chưa thanh toán"
    assert.equal(unsettled(entries, w, TODAY), 0);

    // 4. Thêm khoản 01/10
    entries.push({ date: '2026-10-01', amount: 35000 });
    assert.equal(unsettled(entries, w, TODAY), 35000);

    // 5. Huỷ chốt → tổng trở lại như trước khi chốt
    settlements[0] = { ...settlements[0], status: 'void' };
    assert.equal(unsettled(entries, watermarkOf(settlements), TODAY), 185000);
  });
});

const SAMPLE = [
  { date: '2026-10-31', amount: 10000 },
  { date: '2026-11-01', amount: 20000 },
  { date: '2026-11-10', amount: 30000 },
  { date: '2026-11-11', amount: 40000 },
];

test('addDaysIso advances calendar day', () => {
  assert.equal(addDaysIso('2026-11-10', 1), '2026-11-11');
  assert.equal(addDaysIso('2026-10-31', 1), '2026-11-01');
});

test('filterEntriesByLedgerQuery status unsettled / settled / all', () => {
  const base = { month: null, from: null, to: null, today: '2026-11-11', watermark: '2026-10-31' };
  assert.deepEqual(
    filterEntriesByLedgerQuery(SAMPLE, { ...base, status: 'unsettled' }).map((e) => e.date),
    ['2026-11-01', '2026-11-10', '2026-11-11'],
  );
  assert.deepEqual(
    filterEntriesByLedgerQuery(SAMPLE, { ...base, status: 'settled' }).map((e) => e.date),
    ['2026-10-31'],
  );
  assert.equal(filterEntriesByLedgerQuery(SAMPLE, { ...base, status: 'all' }).length, 4);
});

test('range wins over month; inclusive bounds', () => {
  const base = { status: 'all' as const, today: '2026-11-11', watermark: null };
  const monthOnly = filterEntriesByLedgerQuery(SAMPLE, { ...base, month: '2026-11', from: null, to: null });
  assert.equal(monthOnly.length, 3);
  const ranged = filterEntriesByLedgerQuery(SAMPLE, {
    ...base,
    month: '2026-11',
    from: '2026-11-10',
    to: '2026-11-11',
  });
  assert.deepEqual(ranged.map((e) => e.date), ['2026-11-10', '2026-11-11']);
});

test('dateRangeList trải đều mỗi ngày trong khoảng', () => {
  assert.deepEqual(dateRangeList('2026-10-01', '2026-10-04'), [
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
  ]);
  assert.deepEqual(dateRangeList('2026-11-10', '2026-11-10'), ['2026-11-10']);
  // vắt qua cuối tháng vẫn đúng thứ tự
  assert.deepEqual(dateRangeList('2026-10-31', '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(daysInRange('2026-10-01', '2026-11-11'), 42);
});

test('dateRangeList tôn trọng giới hạn số ngày', () => {
  assert.equal(dateRangeList('2020-01-01', '2030-01-01', 10).length, 10);
});

test('paginateDayGroups clamps page and counts folders', () => {
  const groups = groupByDate(SAMPLE);
  const page1 = paginateDayGroups(groups, 1, 2);
  assert.equal(page1.groups.length, 2);
  assert.equal(page1.pagination.totalGroups, 4);
  assert.equal(page1.pagination.totalPages, 2);
  const clamped = paginateDayGroups(groups, 99, 2);
  assert.equal(clamped.pagination.page, 2);
  assert.equal(clamped.groups.length, 2);
});
