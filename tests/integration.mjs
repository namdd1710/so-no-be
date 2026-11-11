/**
 * tests/integration.mjs — kiểm thử API đầu-cuối với MongoDB in-memory.
 *
 *   node tests/integration.mjs
 *
 * Tự bật MongoMemoryReplSet (để có transaction như Atlas) + `next dev`,
 * rồi chạy kịch bản BRIEF §12 qua HTTP thật.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'matkhau-test-123';

function hashPassword(password) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, 64, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

let failures = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`, extra === undefined ? '' : JSON.stringify(extra));
  }
}

let cookie = '';

async function api(method, path, body, options = {}) {
  const headers = { Origin: options.origin ?? ORIGIN };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie !== undefined ? options.cookie : cookie) headers.Cookie = options.cookie ?? cookie;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json, setCookie, headers: response.headers };
}

function todayVN() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Next nạp `.env.local` của project; tạm cất đi để test dùng đúng env bên dưới.
const envLocal = path.join(process.cwd(), '.env.local');
const envBackup = path.join(process.cwd(), '.env.local.integration-backup');
let envMoved = false;
if (fs.existsSync(envLocal)) {
  fs.renameSync(envLocal, envBackup);
  envMoved = true;
}
function restoreEnv() {
  if (envMoved && fs.existsSync(envBackup)) fs.renameSync(envBackup, envLocal);
  envMoved = false;
}
process.on('SIGINT', () => {
  restoreEnv();
  process.exit(130);
});

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const uri = mongo.getUri();
console.log('Mongo in-memory:', uri);

const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-p', String(PORT)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MONGODB_URI: uri,
    MONGODB_DB: 'so_no_test',
    ADMIN_PASSWORD_HASH: hashPassword(PASSWORD),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    APP_BASE_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: ORIGIN,
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

async function waitForReady() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.status === 200) return true;
    } catch {
      /* chưa lên */
    }
    await sleep(1000);
  }
  return false;
}

try {
  const ready = await waitForReady();
  if (!ready) {
    console.error('Server không khởi động được. Log:\n', logs.join(''));
    process.exit(1);
  }
  console.log('\n=== Auth ===');
  const noOrigin = await api('POST', '/api/auth/login', { password: PASSWORD }, { origin: 'http://evil.example' });
  check('login từ origin lạ bị chặn 403', noOrigin.status === 403, noOrigin.json);

  const wrong = await api('POST', '/api/auth/login', { password: 'sai-mat-khau' });
  check('mật khẩu sai → 401', wrong.status === 401, wrong.json);

  const login = await api('POST', '/api/auth/login', { password: PASSWORD });
  check('đăng nhập đúng → 200 + Set-Cookie', login.status === 200 && login.setCookie.length > 0, login.json);
  const setCookieHeader = login.setCookie[0] ?? '';
  check('cookie HttpOnly + SameSite=Lax', /HttpOnly/i.test(setCookieHeader) && /SameSite=Lax/i.test(setCookieHeader), setCookieHeader);
  cookie = setCookieHeader.split(';')[0];

  const anon = await api('GET', '/api/debtors', undefined, { cookie: '' });
  check('chưa đăng nhập → 401', anon.status === 401, anon.json);

  console.log('\n=== Con nợ ===');
  const created = await api('POST', '/api/debtors', { name: 'Nguyễn Văn A', phone: '0901234567', note: 'nội bộ' });
  check('tạo con nợ → 201', created.status === 201, created.json);
  const debtor = created.json.debtor;
  check('accessCode dài 12 ký tự Base32', /^[0-9A-HJKMNP-TV-Z]{12}$/.test(debtor.accessCode), debtor.accessCode);
  check('shareUrl đúng dạng /s/{code}', debtor.shareUrl === `http://localhost:3000/s/${debtor.accessCode}`, debtor.shareUrl);

  const noOriginCreate = await api('POST', '/api/debtors', { name: 'X' }, { origin: 'http://evil.example' });
  check('tạo từ origin lạ → 403', noOriginCreate.status === 403, noOriginCreate.json);

  const noName = await api('POST', '/api/debtors', { name: '   ' });
  check('thiếu tên → 400', noName.status === 400, noName.json);

  const immut = await api('PATCH', `/api/debtors/${debtor.id}`, { accessCode: 'HACKHACKHACK' });
  check('đổi accessCode → 400 ACCESS_CODE_IMMUTABLE', immut.status === 400 && immut.json?.error?.code === 'ACCESS_CODE_IMMUTABLE', immut.json);

  console.log('\n=== Khoản phát sinh ===');
  const today = todayVN();
  const yesterday = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const e1 = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: yesterday, category: 'Mua cơm', amount: '35.000' });
  check('thêm khoản (số có dấu chấm) → 201', e1.status === 201, e1.json);
  check('parse "35.000" = 35000', e1.json?.entry?.amount === 35000, e1.json?.entry);

  const e2 = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: yesterday, category: 'Mua thuốc', amount: 120000 });
  check('thêm khoản ngày hôm qua → 201', e2.status === 201, e2.json);

  const future = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: '2099-01-01', category: 'Tương lai', amount: 1000 });
  check('ngày tương lai → 400', future.status === 400, future.json);

  const badDate = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: '2026-09-31', category: 'Sai', amount: 1000 });
  check('ngày 31/09 → 400', badDate.status === 400, badDate.json);

  const zero = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: today, category: 'Zero', amount: 0 });
  check('số tiền 0 → 400', zero.status === 400, zero.json);

  const negative = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: today, category: 'Trả trước', amount: -20000 });
  check('khoản âm được phép → 201', negative.status === 201, negative.json);

  const ledger = await api('GET', `/api/debtors/${debtor.id}`);
  check('tổng chưa trả = 35000 + 120000 - 20000', ledger.json?.totals?.unsettled === 135000, ledger.json?.totals);
  check('nhóm theo ngày, mới nhất trước', ledger.json?.groups?.[0]?.date === today, ledger.json?.groups?.map((g) => g.date));

  console.log('\n=== Trang công khai ===');
  const pub = await api('GET', `/api/public/${debtor.accessCode}`, undefined, { cookie: '' });
  check('mở link công khai không cần cookie → 200', pub.status === 200, pub.json);
  check('công khai hiển thị đúng tổng', pub.json?.totals?.unsettled === 135000, pub.json?.totals);
  check('KHÔNG lộ số điện thoại', !JSON.stringify(pub.json).includes('0901234567'), pub.json);
  check('KHÔNG lộ ghi chú nội bộ', !JSON.stringify(pub.json).includes('nội bộ'), pub.json);
  check('header no-store', (pub.headers.get('cache-control') ?? '').includes('no-store'), pub.headers.get('cache-control'));

  const badCode = await api('GET', '/api/public/AAAAAAAAAAAA', undefined, { cookie: '' });
  check('mã sai → 404', badCode.status === 404, badCode.json);
  const badShape = await api('GET', '/api/public/abc', undefined, { cookie: '' });
  check('mã sai định dạng → 404 giống nhau', badShape.status === 404, badShape.json);

  console.log('\n=== Chốt thanh toán ===');
  const preview = await api('GET', `/api/debtors/${debtor.id}`);
  check('settlePreview = tổng kỳ', preview.json?.totals?.settlePreview === 135000, preview.json?.totals);

  // Chốt kỳ (null → hôm qua], đúng mô hình của BRIEF: W ≤ D ≤ T
  const settle = await api('POST', `/api/debtors/${debtor.id}/settle`, { periodEnd: yesterday, expectedWatermark: '' });
  check('chốt kỳ đến hôm qua → 201', settle.status === 201, settle.json);
  check('settlement.amount = 155000', settle.json?.settlement?.amount === 155000, settle.json?.settlement);
  check('entryCount = 2', settle.json?.settlement?.entryCount === 2, settle.json?.settlement);
  check('periodStart = null (kỳ đầu)', settle.json?.settlement?.periodStart === null, settle.json?.settlement);

  const afterSettle = await api('GET', `/api/debtors/${debtor.id}`);
  check('sau chốt, chưa trả chỉ còn khoản sau mốc = -20000', afterSettle.json?.totals?.unsettled === -20000, afterSettle.json?.totals);
  check('W = ngày chốt', afterSettle.json?.watermark === yesterday, afterSettle.json?.watermark);
  check('khoản trong kỳ đã chốt bị khoá sửa', afterSettle.json?.entries?.filter((e) => e.date <= yesterday).every((e) => e.editable === false), afterSettle.json?.entries?.map((e) => [e.date, e.editable]));

  const doubleClick = await api('POST', `/api/debtors/${debtor.id}/settle`, { periodEnd: yesterday });
  check('chốt lần 2 (kỳ rỗng) → 409', doubleClick.status === 409, doubleClick.json);

  const editLocked = await api('PATCH', `/api/entries/${e2.json.entry.id}`, { amount: 1 });
  check('sửa khoản đã chốt → 409 LOCKED_PERIOD', editLocked.status === 409 && editLocked.json?.error?.code === 'LOCKED_PERIOD', editLocked.json);

  const deleteLocked = await api('DELETE', `/api/entries/${e2.json.entry.id}`);
  check('xoá khoản đã chốt → 409', deleteLocked.status === 409, deleteLocked.json);

  const backdated = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: yesterday, category: 'Cũ', amount: 5000 });
  check('thêm khoản vào kỳ đã chốt → 409', backdated.status === 409, backdated.json);

  const staleSettle = await api('POST', `/api/debtors/${debtor.id}/settle`, { periodEnd: today, expectedWatermark: '' });
  check('chốt với watermark cũ → 409 STALE_WATERMARK', staleSettle.status === 409 && staleSettle.json?.error?.code === 'STALE_WATERMARK', staleSettle.json);

  console.log('\n=== Sau chốt: khoản mới ===');
  const e3 = await api('POST', `/api/debtors/${debtor.id}/entries`, { date: today, category: 'Mua cơm', amount: 30000 });
  check('thêm khoản sau mốc chốt → 201', e3.status === 201, e3.json);
  const afterNew = await api('GET', `/api/debtors/${debtor.id}`);
  check('chưa trả chỉ còn khoản sau mốc = 10000', afterNew.json?.totals?.unsettled === 10000, afterNew.json?.totals);

  const pubAfter = await api('GET', `/api/public/${debtor.accessCode}`, undefined, { cookie: '' });
  check('link công khai khớp admin đến từng đồng', pubAfter.json?.totals?.unsettled === 10000, pubAfter.json?.totals);
  check('công khai có lịch sử đã trả', pubAfter.json?.settlements?.length === 1 && pubAfter.json.settlements[0].amount === 155000, pubAfter.json?.settlements);
  check('công khai có watermark = ngày chốt', pubAfter.json?.watermark === yesterday, pubAfter.json?.watermark);

  console.log('\n=== Mã truy cập không đổi ===');
  const renamed = await api('PATCH', `/api/debtors/${debtor.id}`, { name: 'Nguyễn Văn A (đổi tên)' });
  check('sửa tên → mã không đổi', renamed.json?.debtor?.accessCode === debtor.accessCode, renamed.json?.debtor);

  const voided = await api('POST', `/api/settlements/${settle.json.settlement.id}`, { reason: 'Ghi nhầm' });
  check('huỷ chốt → 200', voided.status === 200, voided.json);
  check('W quay về null', voided.json?.watermark === null, voided.json);

  const afterVoid = await api('GET', `/api/debtors/${debtor.id}`);
  check('huỷ chốt → chưa trả trở lại 165000', afterVoid.json?.totals?.unsettled === 165000, afterVoid.json?.totals);
  check('settlement lưu status void (không xoá)', afterVoid.json?.settlements?.[0]?.status === 'void', afterVoid.json?.settlements?.[0]);
  check('voidReason được lưu', afterVoid.json?.settlements?.[0]?.voidReason === 'Ghi nhầm', afterVoid.json?.settlements?.[0]);

  const voidTwice = await api('POST', `/api/settlements/${settle.json.settlement.id}`, { reason: 'lần 2' });
  check('huỷ chốt 2 lần → 409', voidTwice.status === 409, voidTwice.json);

  const editAfterVoid = await api('PATCH', `/api/entries/${e2.json.entry.id}`, { amount: 120000 });
  check('huỷ chốt xong thì sửa lại được', editAfterVoid.status === 200, editAfterVoid.json);

  console.log('\n=== Lọc tháng & xoá mềm ===');
  const month = today.slice(0, 7);
  const filtered = await api('GET', `/api/debtors/${debtor.id}?month=${month}`);
  check('lọc tháng trả về groups của tháng', filtered.json?.groups?.every((g) => g.date.startsWith(month)), null);
  const emptyMonth = await api('GET', `/api/debtors/${debtor.id}?month=2020-01`);
  check('tháng rỗng → 200, không lỗi', emptyMonth.status === 200 && emptyMonth.json.entries.length === 0, emptyMonth.json);

  const del = await api('DELETE', `/api/entries/${e1.json.entry.id}`);
  check('xoá mềm → 200', del.status === 200, del.json);
  const afterDelete = await api('GET', `/api/debtors/${debtor.id}`);
  check('khoản đã xoá biến khỏi tổng', afterDelete.json?.totals?.unsettled === 130000, afterDelete.json?.totals);

  console.log('\n=== Đăng xuất ===');
  const logout = await api('POST', '/api/auth/logout', {});
  check('đăng xuất xoá cookie', /Max-Age=0/.test(logout.setCookie[0] ?? ''), logout.setCookie);

  console.log('\n=== Lưu trữ ===');
  const archived = await api('PATCH', `/api/debtors/${debtor.id}`, { archived: true });
  check('lưu trữ → 200', archived.status === 200, archived.json);
  const pubArchived = await api('GET', `/api/public/${debtor.accessCode}`, undefined, { cookie: '' });
  check('link của con nợ đã lưu trữ → 404', pubArchived.status === 404, pubArchived.json);
} catch (error) {
  failures += 1;
  console.error('LỖI TEST:', error);
  console.error(logs.join(''));
} finally {
  server.kill();
  await mongo.stop();
  restoreEnv();
}

console.log(`\n${failures === 0 ? '✅ Tất cả kiểm thử API đều đạt' : `❌ ${failures} kiểm thử thất bại`}`);
process.exit(failures === 0 ? 0 : 1);
