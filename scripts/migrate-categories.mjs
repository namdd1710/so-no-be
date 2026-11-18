#!/usr/bin/env node
/**
 * scripts/migrate-categories.mjs — gộp danh mục riêng từng con nợ thành danh
 * mục dùng chung (tên + đơn giá).
 *
 * Trước đây mỗi con nợ có bộ danh mục riêng (khoá `debtorId + name`), nên cùng
 * một món như "Cơm máng lợn" phải tạo lại cho từng người. Bản mới giữ MỘT danh
 * sách chung: mỗi tên một bản ghi kèm đơn giá dùng để tự điền khi thêm khoản.
 *
 *   node --env-file=.env.local scripts/migrate-categories.mjs           # xem trước
 *   node --env-file=.env.local scripts/migrate-categories.mjs --apply   # ghi thật
 *
 * Đơn giá lấy theo lần dùng GẦN NHẤT của tên đó trong `entries`; tên chỉ có
 * trong `categories` (chưa dùng lần nào) thì giữ nguyên đơn giá đang lưu.
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
const categories = db.collection('categories');
const entries = db.collection('entries');

const existing = await categories.find({}).toArray();
const used = await entries
  .find({ deletedAt: null })
  .sort({ date: 1, createdAt: 1 })
  .project({ category: 1, unitAmount: 1, amount: 1 })
  .toArray();

/** name → { unitPrice, fromEntries } (entries đi sau sẽ đè lên = lần dùng mới nhất). */
const byName = new Map();
for (const doc of existing) {
  const name = (doc.name ?? '').trim();
  if (!name) continue;
  const price = Math.abs(Number(doc.unitPrice) || 0);
  const current = byName.get(name);
  // Trùng tên giữa nhiều con nợ: lấy giá lớn hơn 0 đầu tiên gặp được.
  if (!current || (current.unitPrice === 0 && price > 0)) {
    byName.set(name, { unitPrice: price, fromEntries: current?.fromEntries ?? false });
  }
}
for (const doc of used) {
  const name = (doc.category ?? '').trim();
  if (!name) continue;
  const price = Math.abs(Number(doc.unitAmount ?? doc.amount) || 0);
  const current = byName.get(name);
  byName.set(name, { unitPrice: price || current?.unitPrice || 0, fromEntries: true });
}

const plan = [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0], 'vi'));
console.log(`Danh mục hiện có: ${existing.length} bản ghi → gộp thành ${plan.length} tên dùng chung:`);
for (const [name, info] of plan) {
  console.log(`  ${name}: ${info.unitPrice}₫${info.fromEntries ? '' : ' (chưa dùng lần nào)'}`);
}

if (!APPLY) {
  console.log('\nĐây là bản xem trước. Thêm --apply để ghi thật.');
  await client.close();
  process.exit(0);
}

// Index cũ khoá theo (debtorId, name) phải bỏ trước khi ghi danh sách chung.
await categories.dropIndex('debtorId_1_name_1').catch(() => undefined);

const now = new Date();
await categories.deleteMany({});
if (plan.length > 0) {
  await categories.insertMany(
    plan.map(([name, info]) => ({ name, unitPrice: info.unitPrice, createdAt: now, updatedAt: now })),
  );
}
await categories.createIndex({ name: 1 }, { unique: true });

console.log(`\nXong: ${plan.length} danh mục dùng chung, đã bỏ danh mục riêng theo con nợ.`);
await client.close();
