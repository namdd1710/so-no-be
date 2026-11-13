/**
 * lib/momo-qr.ts — dựng nội dung QR chuyển tiền MoMo.
 *
 * Hai chế độ:
 *
 * 1. `emvco` — khi có số tài khoản ví MoMo (`MOMO_WALLET_ACCOUNT`, dạng
 *    `99MM...` lấy ở màn hình "Nhận tiền" trong app). MoMo nhận tiền qua
 *    VietQR: payload là chuỗi EMVCo Merchant-Presented Mode mang BIN 970454
 *    (BVBank — đầu mối ví MoMo) và số ví, kèm số tiền + nội dung. Mọi app ngân
 *    hàng và MoMo quét được, tiền vào thẳng ví.
 *
 * 2. `link` — chỉ có số điện thoại: QR chứa link chuyển tiền chính thức
 *    `https://nhantien.momo.vn/{phone}`. Quét bằng camera/MoMo sẽ mở màn hình
 *    chuyển tiền tới đúng người nhận, người trả tự nhập số tiền.
 *
 * Không gọi dịch vụ ngoài: chuỗi QR sinh tại đây, ảnh PNG do thư viện `qrcode`
 * render phía server.
 */

const MOMO_BIN = '970454';
const DEFAULT_PHONE = '0352611710';

export type PaymentConfig = {
  phone: string;
  name: string;
  /** Số tài khoản ví trong app MoMo (`99MM…`) — có thì dựng được QR có số tiền. */
  walletAccount: string | null;
};

export function paymentConfig(): PaymentConfig {
  return {
    phone: (process.env.MOMO_PHONE ?? DEFAULT_PHONE).replace(/\s+/g, ''),
    name: (process.env.MOMO_NAME ?? '').trim(),
    walletAccount: (process.env.MOMO_WALLET_ACCOUNT ?? '').trim() || null,
  };
}

/** Một trường TLV của EMVCo: tag (2) + độ dài (2) + giá trị. */
export function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC16-CCITT (poly 0x1021, init 0xFFFF) — chuẩn EMVCo dùng cho tag 63. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Bỏ dấu tiếng Việt để nội dung chuyển khoản không bị lỗi font ở app ngân hàng. */
export function asciiMemo(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export type TransferQr = {
  /** 'emvco' = QR có số tiền, quét bằng app ngân hàng/MoMo; 'link' = link MoMo. */
  mode: 'emvco' | 'link';
  payload: string;
  amount: number | null;
  memo: string;
};

/**
 * Dựng payload QR chuyển tiền về ví MoMo.
 *
 * @param amount số tiền (0/undefined = QR tĩnh, người trả tự nhập)
 * @param memo nội dung chuyển khoản (sẽ được bỏ dấu, cắt còn 25 ký tự)
 */
export function buildTransferQr(config: PaymentConfig, amount?: number | null, memo = ''): TransferQr {
  const cleanMemo = asciiMemo(memo).slice(0, 25);
  const value = Number.isFinite(amount) && (amount ?? 0) > 0 ? Math.round(amount as number) : null;

  if (!config.walletAccount) {
    return {
      mode: 'link',
      payload: `https://nhantien.momo.vn/${config.phone}`,
      amount: value,
      memo: cleanMemo,
    };
  }

  // 38 = merchant account information: GUID NAPAS, BIN + số tài khoản ví, dịch vụ chuyển tiền.
  const merchant =
    tlv('00', 'A000000727') + tlv('01', tlv('00', MOMO_BIN) + tlv('01', config.walletAccount)) + tlv('02', 'QRIBFTTA');

  let payload =
    tlv('00', '01') + // payload format indicator
    tlv('01', value ? '12' : '11') + // 12 = động (có số tiền), 11 = tĩnh
    tlv('38', merchant) +
    tlv('53', '704') + // VND
    (value ? tlv('54', String(value)) : '') +
    tlv('58', 'VN') +
    (cleanMemo ? tlv('62', tlv('08', cleanMemo)) : '');

  payload += '6304'; // tag 63 + độ dài, CRC tính trên toàn bộ chuỗi tới đây
  return { mode: 'emvco', payload: payload + crc16(payload), amount: value, memo: cleanMemo };
}
