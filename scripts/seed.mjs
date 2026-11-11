#!/usr/bin/env node
/**
 * scripts/seed.mjs — tạo dữ liệu mẫu để xem UI (không bắt buộc).
 *
 *   npm run seed                 (bỏ qua nếu đã có con nợ)
 *   node --env-file=.env.local scripts/seed.mjs --force
 */
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function accessCode() {
  const bytes = randomBytes(8);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  const sixty = bits & ((1n << 60n) - 1n);
  let code = '';
  for (let shift = 55n; shift >= 0n; shift -= 5n) code += ALPHABET[Number((sixty >> shift) & 31n)];
  return code;
}

function todayVn() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('Thiếu MONGODB_URI. Chạy: npm run seed (đọc .env.local)');
  process.exit(1);
}

const force = process.argv.includes('--force');
const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'so_no');

const existing = await db.collection('debtors').countDocuments();
if (existing > 0 && !force) {
  console.log(`Đã có ${existing} con nợ — bỏ qua. Dùng --force để thêm dữ liệu mẫu.`);
  await client.close();
  process.exit(0);
}

const today = todayVn();

const seeds = [
  {
    name: 'Nguyễn Văn A',
    phone: '0901234567',
    note: 'Khách quen, hay mua chịu buổi sáng',
    entries: [
      { date: shiftDays(today, -21), category: 'Mua cơm', amount: 30000 },
      { date: shiftDays(today, -18), category: 'Mua thuốc', amount: 120000 },
      { date: shiftDays(today, -12), category: 'Mua cơm', amount: 35000 },
      { date: shiftDays(today, -3), category: 'Trả trước', amount: -50000 },
      { date: shiftDays(today, -1), category: 'Mua cơm', amount: 35000 },
      { date: today, category: 'Mua thuốc', amount: 65000 },
    ],
  },
  {
    name: 'Trần Thị B',
    phone: '0987654321',
    note: 'Tạp hoá đầu ngõ',
    entries: [
      { date: shiftDays(today, -9), category: 'Gạo', amount: 250000 },
      { date: shiftDays(today, -2), category: 'Dầu ăn', amount: 90000 },
    ],
  },
];

for (const seed of seeds) {
  const now = new Date();
  const code = accessCode();
  const { insertedId } = await db.collection('debtors').insertOne({
    name: seed.name,
    phone: seed.phone,
    note: seed.note,
    accessCode: code,
    active: true,
    createdAt: now,
    archivedAt: null,
  });

  await db.collection('entries').insertMany(
    seed.entries.map((entry) => ({
      debtorId: insertedId,
      date: entry.date,
      category: entry.category,
      amount: entry.amount,
      note: '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })),
  );

  console.log(`${seed.name}: ${seed.entries.length} khoản — link /s/${code}`);
}

await client.close();
console.log('\nSeed xong. Link công khai ở trên (mở http://localhost:3000/s/<code>).');
