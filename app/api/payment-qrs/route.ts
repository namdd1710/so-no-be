import { getCollections } from '@/lib/db';
import { json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { MAX_QR_COUNT, parseQrImage } from '@/lib/payment-qr';
import { listPaymentQrs, toPaymentQrJson } from '@/lib/service';
import { parseBooleanish, parseString } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/payment-qrs — danh sách ảnh QR nhận tiền (admin). */
export const GET = route(async (request) => {
  await requireAdmin(request);
  return json({ paymentQrs: await listPaymentQrs(false) });
});

/**
 * POST /api/payment-qrs — thêm một ảnh QR.
 *
 * Ảnh gửi lên dạng data URL base64 (FE đọc file bằng FileReader) và được lưu
 * nguyên trong Mongo, nên không cần dịch vụ lưu file nào khác.
 */
export const POST = route(async (request) => {
  await requireAdmin(request);
  requireMutation(request);

  const body = await readJson(request);
  const { paymentQrs } = await getCollections();

  if ((await paymentQrs.countDocuments({})) >= MAX_QR_COUNT) {
    return json({ error: { code: 'TOO_MANY_QR', message: `Chỉ lưu tối đa ${MAX_QR_COUNT} ảnh QR` } }, { status: 400 });
  }

  const now = new Date();
  const doc = {
    bankName: parseString(body.bankName, { field: 'Tên ngân hàng/ví', max: 60, required: true }),
    accountName: parseString(body.accountName, { field: 'Tên người thụ hưởng', max: 80 }),
    accountNumber: parseString(body.accountNumber, { field: 'Số tài khoản/SĐT', max: 40 }),
    note: parseString(body.note, { field: 'Ghi chú', max: 200 }),
    image: parseQrImage(body.image),
    active: parseBooleanish(body.active) ?? true,
    createdAt: now,
    updatedAt: now,
  };

  const result = await paymentQrs.insertOne(doc as never);
  return json(
    {
      paymentQr: toPaymentQrJson({ ...doc, _id: result.insertedId } as never),
    },
    { status: 201 },
  );
});
