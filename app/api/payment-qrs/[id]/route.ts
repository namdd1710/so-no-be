import { getCollections } from '@/lib/db';
import { ApiError, json, readJson, requireAdmin, requireMutation, route } from '@/lib/http';
import { parseQrImage } from '@/lib/payment-qr';
import { toObjectId, toPaymentQrJson } from '@/lib/service';
import { parseBooleanish, parseString } from '@/lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/payment-qrs/:id — sửa thông tin hoặc bật/tắt một ảnh QR. */
export const PATCH = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const body = await readJson(request);
  const update: Record<string, unknown> = { updatedAt: new Date() };

  if ('bankName' in body) {
    update.bankName = parseString(body.bankName, { field: 'Tên ngân hàng/ví', max: 60, required: true });
  }
  if ('accountName' in body) {
    update.accountName = parseString(body.accountName, { field: 'Tên người thụ hưởng', max: 80 });
  }
  if ('accountNumber' in body) {
    update.accountNumber = parseString(body.accountNumber, { field: 'Số tài khoản/SĐT', max: 40 });
  }
  if ('note' in body) update.note = parseString(body.note, { field: 'Ghi chú', max: 200 });
  if ('image' in body) update.image = parseQrImage(body.image);
  const active = parseBooleanish(body.active);
  if (active !== null) update.active = active;

  const { paymentQrs } = await getCollections();
  const result = await paymentQrs.findOneAndUpdate(
    { _id: toObjectId(id) },
    { $set: update },
    { returnDocument: 'after' },
  );
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy ảnh QR này');

  return json({ paymentQr: toPaymentQrJson(result) });
});

/** DELETE /api/payment-qrs/:id — xoá hẳn ảnh QR. */
export const DELETE = route<Context>(async (request, context) => {
  await requireAdmin(request);
  requireMutation(request);

  const { id } = await context.params;
  const { paymentQrs } = await getCollections();
  const result = await paymentQrs.deleteOne({ _id: toObjectId(id) });
  if (result.deletedCount === 0) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy ảnh QR này');

  return json({ ok: true, deletedId: id });
});
