# so-no-be — Sổ Nợ (backend)

API cho app ghi sổ nợ theo ngày. **Next.js 15 Route Handlers + MongoDB**. Không NestJS, không ORM.

Frontend tương ứng: [`so-no-fe`](../so-no-fe) — Next.js + Material UI.

---

## 1. Chạy local

```bash
npm install

# 1) Sinh hash mật khẩu admin (copy dòng ADMIN_PASSWORD_HASH in ra)
npm run hash-password -- "mat-khau-cua-ban"

# 2) Sinh session secret
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"

# 3) Tạo .env.local từ .env.example rồi điền 3 giá trị trên
cp .env.example .env.local

npm run dev        # http://127.0.0.1:3001
```

Không có sẵn MongoDB? Chạy Mongo tạm trong RAM (có transaction như Atlas):

```bash
npm run dev:db     # in ra MONGODB_URI, giữ process chạy
```

Dữ liệu mẫu để xem UI:

```bash
npm run seed       # cần .env.local
```

## 2. Kiểm thử

```bash
npm test           # 26 test cho lib/ledger.ts (hàm thuần, không cần DB)
npm run test:api   # 50+ check HTTP thật: bật Mongo in-memory + next dev
```

`test:api` tự cất `.env.local` đi trong lúc chạy để dùng env của test, xong trả lại.

## 3. Biến môi trường

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `MONGODB_URI` | ✅ | Atlas, database riêng `so_no` |
| `MONGODB_DB` | | mặc định `so_no` |
| `ADMIN_PASSWORD_HASH` | ✅ | `scrypt:<N>:<r>:<p>:<salt>:<hash>` — sinh bằng `npm run hash-password` |
| `SESSION_SECRET` | ✅ | ≥16 ký tự, nên là 64 hex |
| `APP_BASE_URL` | ✅ | URL công khai của **FE**, dùng để dựng link `/s/{code}` |
| `ALLOWED_ORIGINS` | ✅ | Origin của FE, phân tách bằng dấu phẩy (CSRF) |

> Hash dùng dấu `:` chứ không dùng `$`, vì `.env` của Next/Vercel có thể expand `$` và làm hỏng giá trị.

## 4. API

```
POST   /api/auth/login              { password }              → Set-Cookie HttpOnly
POST   /api/auth/logout
GET    /api/auth/session                                       → { authenticated }
GET    /api/health                                             → ping Mongo

GET    /api/debtors?includeArchived=&q=
POST   /api/debtors                 { name, phone?, note? }    → trả accessCode (cố định)
GET    /api/debtors/:id?month=YYYY-MM
PATCH  /api/debtors/:id             { name?, phone?, note?, archived? }

GET    /api/debtors/:id/entries?month=YYYY-MM
POST   /api/debtors/:id/entries     { date, category, amount, note? }
PATCH  /api/entries/:id
DELETE /api/entries/:id                                        → soft delete

GET    /api/debtors/:id/settle?periodEnd=YYYY-MM-DD            → xem trước kỳ chốt
POST   /api/debtors/:id/settle      { periodEnd, expectedWatermark? }
POST   /api/settlements/:id         { reason? }                → huỷ chốt

GET    /api/public/:code?month=YYYY-MM                         → trang công khai (chỉ đọc)
```

**Không có** endpoint đổi/cấp lại `accessCode` — đây là quyết định thiết kế (BRIEF §4.1, §8).

## 5. Quy tắc tính toán

Toàn bộ nằm trong `lib/ledger.ts` (hàm thuần, có test):

- `W` = `periodEnd` của settlement **active** mới nhất; chưa chốt thì `null`.
- `unsettled = Σ amount` với `deletedAt = null`, `date > W`, `date <= hôm nay (Asia/Ho_Chi_Minh)`.
- Chốt ngày `D`: kỳ `(W, D]`, `W ≤ D ≤ T`, kỳ rỗng thì từ chối.
- Huỷ chốt: `status = 'void'` + `voidReason`, **không xoá** bản ghi; `W` tự lùi.
- Mọi tổng đều tính lại từ `entries`; `settlement.amount` chỉ là snapshot lịch sử.

Ghi chú triển khai (chặt hơn BRIEF một chút, để sổ không bao giờ lệch):

- Khoản có `date <= W` bị khoá **sửa, xoá và cả thêm mới** — nếu thêm được vào kỳ đã chốt thì tiền
  sẽ rơi ra khỏi mọi tổng. Thông điệp lỗi chỉ rõ cần huỷ chốt kỳ nào.
- Chỉ huỷ được **lần chốt gần nhất** đang active.
- Ngày là chuỗi `YYYY-MM-DD`; `31/09` bị chặn ở cả API lẫn form.

## 6. Bảo mật

- `accessCode`: 12 ký tự Crockford Base32 từ 60 bit `crypto.randomBytes(8)`, unique index, sinh 1 lần.
- Session: cookie `sn_session` = payload + HMAC-SHA256 (`SESSION_SECRET`), `HttpOnly; SameSite=Lax; Secure` (production), 30 ngày.
- `middleware.ts` chặn mọi request ghi khi chưa có session; mỗi handler kiểm tra lại session + `Origin`.
- Đăng nhập sai 5 lần / 15 phút / IP thì chặn tạm.
- `/api/public/*`: 20 req/phút/IP, `no-store`, 404 giống nhau cho mọi trường hợp sai.
- Trang công khai chỉ trả tên, khoản phát sinh, tổng và lịch sử đã trả — **không** SĐT, không ghi chú nội bộ.

## 7. Deploy Vercel

1. Tạo project từ repo này, region **sin1**.
2. Thêm 6 biến môi trường ở mục 3 (`APP_BASE_URL`, `ALLOWED_ORIGINS` trỏ về domain FE).
3. Atlas M0 + Network Access `0.0.0.0/0` (Vercel không có IP tĩnh), DB user chỉ có quyền trên `so_no`.

## 8. Cấu trúc

```
app/api/**/route.ts   # endpoint (Node runtime)
lib/ledger.ts         # toàn bộ logic tính tổng + chốt (hàm thuần)
lib/service.ts        # query Mongo + dựng payload
lib/auth.ts           # scrypt password hash
lib/session.ts        # HMAC session (Edge-safe, dùng chung với middleware)
lib/db.ts             # MongoClient singleton + index + transaction
lib/http.ts           # JSON/no-store, session, Origin, rate limit
middleware.ts         # chặn request ghi
tests/                # test hàm thuần + test API đầu-cuối
```
