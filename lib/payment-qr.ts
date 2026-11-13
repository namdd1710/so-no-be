/**
 * lib/payment-qr.ts — ảnh QR nhận tiền lưu thẳng trong Mongo dưới dạng base64.
 *
 * Ảnh do chủ nợ tải lên từ máy; FE đọc file bằng FileReader rồi gửi nguyên data
 * URL. Giới hạn ~1,1 MB ảnh (1,6 triệu ký tự base64) để không phình document
 * (Mongo giới hạn 16 MB) và không làm nặng trang công khai.
 */

import { ApiError } from './http';

const IMAGE_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/** Ký tự base64 tối đa cho một ảnh (~1,1 MB nhị phân). */
export const MAX_QR_IMAGE_CHARS = 1_600_000;

/** Số ảnh QR tối đa hiển thị cho con nợ. */
export const MAX_QR_COUNT = 20;

export function parseQrImage(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'MISSING_IMAGE', 'Chưa chọn ảnh QR');
  }
  if (!IMAGE_PATTERN.test(value)) {
    throw new ApiError(400, 'INVALID_IMAGE', 'File phải là ảnh PNG/JPG/WebP/GIF');
  }
  if (value.length > MAX_QR_IMAGE_CHARS) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Ảnh quá lớn, chọn ảnh dưới 1 MB');
  }
  return value;
}
