#!/usr/bin/env node
/**
 * scripts/collapse-range-entries.mjs — dọn dữ liệu do bản cũ sinh ra.
 *
 * Bản cũ tạo MỖI NGÀY một bản ghi khi thêm theo khoảng ngày. Bản mới chỉ tạo
 * một bản ghi có `startDate` (ngày bắt đầu) và `date` (ngày kết thúc). Script
 * này gom các bản ghi cũ liền ngày, cùng con nợ/danh mục/đơn giá/số lượng/ghi
 * chú thành một bản ghi duy nhất.
 *
 *   node --env-file=.env.local scripts/collapse-range-entries.mjs           # xem trước (không ghi)
 *   node --env-file=.env.local scripts/collapse-range-entries.mjs --apply   # ghi thật
 *
 * Không xoá cứng: các bản ghi thừa bị đánh dấu `deletedAt` để vẫn giữ dấu vết.
 */
import { MongoClient } from 'mongodb';

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI;
if (!URI) {
  console.error('Thiếu MONGODB_URI. Chạy với --env-file=.env.local');
  process.exit(1);
}

const client = new MongoClient(URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'so_no');
const entries = db.collection('entries');

function addDays(isoDate, delta) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + delta));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

// Chỉ đụng vào bản ghi do bản cũ sinh ra: entryType 'range' nhưng chưa có startDate.
const docs = await entries
  .find({ deletedAt: null, entryType: 'range', startDate: null })
  .sort({ debtorId: 1, date: 1 })
  .toArray();

const groups = new Map();
for (const doc of docs) {
  const key = [
    doc.debtorId.toString(),
    doc.category,
    doc.amount,
    doc.unitAmount ?? doc.amount,
    doc.quantity ?? 1,
    doc.note ?? '',
  ].join('|');
  const list = groups.get(key);
  if (list) list.push(doc);
  else groups.set(key, [doc]);
}

const plan = [];
for (const list of groups.values()) {
  let run = [list[0]];
  const flush = () => {
    if (run.length > 1) plan.push(run);
  };
  for (const doc of list.slice(1)) {
    const prev = run[run.length - 1];
    if (doc.date === addDays(prev.date, 1)) run.push(doc);
    else {
      flush();
      run = [doc];
    }
  }
  flush();
}

if (plan.length === 0) {
  console.log('Không có bản ghi nào cần gom.');
  await client.close();
  process.exit(0);
}

const scopes = plan.map((run) => {
  const last = run[run.length - 1];
  return {
    category: last.category,
    from: run[0].date,
    to: last.date,
    days: run.length,
    amount: last.amount,
    keepId: last._id,
    removeIds: run.slice(0, -1).map((doc) => doc._id),
  };
});

const totalRemove = scopes.reduce((sum, scope) => sum + scope.removeIds.length, 0);
console.log(`Gom ${scopes.length} khoảng, giữ ${scopes.length} bản ghi, ẩn ${totalRemove} bản ghi thừa:`);
for (const scope of scopes) {
  console.log(`  ${scope.category}: ${scope.from} → ${scope.to} (${scope.days} ngày, ${scope.amount}₫/ngày)`);
}

if (!APPLY) {
  console.log('\nĐây là bản xem trước. Thêm --apply để ghi thật.');
  await client.close();
  process.exit(0);
}

const now = new Date();
for (const scope of scopes) {
  await entries.updateOne({ _id: scope.keepId }, { $set: { startDate: scope.from, updatedAt: now } });
  await entries.updateMany(
    { _id: { $in: scope.removeIds } },
    { $set: { deletedAt: now, updatedAt: now } },
  );
}

console.log(`\nXong: đã gom ${scopes.length} khoảng, ẩn ${totalRemove} bản ghi thừa.`);
await client.close();
