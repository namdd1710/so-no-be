# so-no-be — Sổ Nợ (backend)

API cho app ghi sổ nợ theo ngày. **Next.js 15 Route Handlers + MongoDB**. Không NestJS, không ORM.

Frontend tương ứng: [`so-no-fe`](../so-no-fe) — Next.js + Material UI.

---

## 1. Chạy local

```bash
npm install

# 1) Tạo .env.local từ .env.example
cp .env.example .env.local

# 2) Điền vào .env.local:
#    ADMIN_PASSWORD=<mật khẩu đăng nhập, chữ thường>
#    ADMIN_RECOVERY_KEY=<chuỗi bí mật tự đặt, dùng để đổi mật khẩu khi quên>
#    SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

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
| `MONGODB_DNS_SERVERS` | | chỉ định DNS cho driver (`1.1.1.1,8.8.8.8`) khi máy local báo `querySrv ECONNREFUSED`. Bỏ trống trên production. |
| `ADMIN_PASSWORD` | ✅ | **Mật khẩu chữ thường** (không phải hash). Là mật khẩu khởi tạo. |
| `ADMIN_RECOVERY_KEY` | ✅ | Chuỗi bí mật **bạn tự đặt**; nhập đúng key này + mật khẩu mới thì mới đổi được mật khẩu. Để trống = tắt tính năng. |
| `SESSION_SECRET` | ✅ | ≥16 ký tự, nên là 64 hex |
| `APP_BASE_URL` | ✅ | URL công khai của **FE**, dùng để dựng link `/s/{code}` |
| `ALLOWED_ORIGINS` | ✅ | Origin được phép gọi API, phân tách bằng dấu phẩy (chống CSRF). Hỗ trợ `*` = mọi nguồn, `https://*.vercel.app` = mọi domain con |

## 4. API

```
POST   /api/auth/login              { password }              → Set-Cookie HttpOnly
POST   /api/auth/logout
POST   /api/auth/password           { recoveryKey, newPassword } → đổi mật khẩu khi quên
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

### Đổi mật khẩu khi quên

Mật khẩu có 2 nguồn, theo thứ tự ưu tiên:

1. `settings.passwordHash` trong Mongo — có sau khi đã đổi mật khẩu;
2. `ADMIN_PASSWORD` trong env — mật khẩu khởi tạo.

`POST /api/auth/password` **(không cần đăng nhập)** nhận `{ recoveryKey, newPassword }`:

- `recoveryKey` phải trùng value của env `ADMIN_RECOVERY_KEY` (so sánh timing-safe);
- `newPassword` ≥ 8 ký tự, băm scrypt rồi ghi vào `settings` → **đổi được ngay trên production, không cần redeploy**;
- sai key 5 lần / 15 phút / IP thì chặn tạm; vẫn kiểm tra `Origin`;
- chưa đặt `ADMIN_RECOVERY_KEY` thì endpoint trả `503 RECOVERY_DISABLED` — tính năng tắt hoàn toàn.

UI: nút **Quên mật khẩu?** ngay dưới form đăng nhập.

> Sau khi đổi, `ADMIN_PASSWORD` trong env **không còn tác dụng** (chỉ là mật khẩu khởi tạo cho môi trường mới).
> Các session đang đăng nhập vẫn dùng được tới khi hết hạn 30 ngày; muốn đá hết ngay thì đổi `SESSION_SECRET` rồi redeploy.
> Muốn quay về mật khẩu trong env: xoá document `_id: "admin"` trong collection `settings`.
- `/api/public/*`: 20 req/phút/IP, `no-store`, 404 giống nhau cho mọi trường hợp sai.
- Trang công khai chỉ trả tên, khoản phát sinh, tổng và lịch sử đã trả — **không** SĐT, không ghi chú nội bộ.

## 7. Deploy Vercel

Repo đã có `vercel.json`: pin region **`sin1`** và `installCommand: npm install --ignore-scripts`
(mongodb-memory-server là devDependency cho test local, có postinstall tải mongod — không cần và
không nên chạy trên Vercel).

**Chuẩn bị (Atlas)**

1. Cluster M0, database `so_no`, user riêng chỉ có quyền trên `so_no`.
2. Network Access: `0.0.0.0/0` vì Vercel không có IP tĩnh.

**Deploy**

3. Import repo → Vercel tự nhận framework Next.js, giữ nguyên Root Directory (`.`) và Build Command mặc định.
4. Thêm biến môi trường (Production): `MONGODB_URI`, `MONGODB_DB=so_no`, `ADMIN_PASSWORD`,
   `ADMIN_RECOVERY_KEY`, `SESSION_SECRET` (64 hex). `APP_BASE_URL` / `ALLOWED_ORIGINS` điền ở bước 6.
5. Deploy, rồi mở `https://<be-domain>/api/health` — phải trả `{"ok":true,"db":true}`.
   Nếu `ok:false`: xem lại Atlas Network Access và `MONGODB_URI`.
6. Có domain FE rồi thì cập nhật `APP_BASE_URL=https://<fe-domain>` và
   `ALLOWED_ORIGINS=https://<fe-domain>` → **Redeploy** (link `/s/{code}` dựng từ `APP_BASE_URL`).

**Lưu ý**

- Vercel **Deployment Protection** phải tắt với môi trường Production, nếu không con nợ mở link sẽ bị chặn đăng nhập.
- Preview deployment có domain riêng: muốn test login trên preview thì thêm domain đó vào `ALLOWED_ORIGINS`,
  còn không thì chỉ dùng domain Production (đơn giản nhất).
- Mở cho nhiều nguồn: `ALLOWED_ORIGINS=https://*.vercel.app` (mọi domain con) hoặc `ALLOWED_ORIGINS=*`
  (mọi nguồn, kể cả request không gửi `Origin` như curl/Postman — coi như tắt chống CSRF, chỉ dùng khi cần).
- `MONGODB_DNS_SERVERS` để trống trên Vercel — chỉ cần cho máy local bị lỗi resolver SRV.
- Node: `engines.node >= 20` (Vercel chọn 22.x).

## 8. Cấu trúc

```
app/api/**/route.ts   # endpoint (Node runtime)
lib/ledger.ts         # toàn bộ logic tính tổng + chốt (hàm thuần)
lib/service.ts        # query Mongo + dựng payload
lib/auth.ts           # băm/so sánh mật khẩu, recovery key
lib/admin-account.ts  # mật khẩu admin: env (khởi tạo) hoặc hash trong Mongo
lib/session.ts        # HMAC session (Edge-safe, dùng chung với middleware)
lib/db.ts             # MongoClient singleton + index + transaction
lib/http.ts           # JSON/no-store, session, Origin, rate limit
middleware.ts         # chặn request ghi
tests/                # test hàm thuần + test API đầu-cuối
```
