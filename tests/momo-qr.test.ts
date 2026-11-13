/**
 * Test cho lib/momo-qr.ts — chạy: npm test
 * Không cần network: chỉ dựng chuỗi QR và kiểm tra cấu trúc TLV + CRC.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asciiMemo, buildTransferQr, crc16, type PaymentConfig } from '../lib/momo-qr.ts';

/** Tách payload EMVCo thành các trường {tag: value} ở mức gốc. */
function parseRoot(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  let index = 0;
  while (index < payload.length) {
    const tag = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    assert.ok(Number.isInteger(length), `độ dài không hợp lệ ở tag ${tag}`);
    out[tag] = payload.slice(index + 4, index + 4 + length);
    index += 4 + length;
  }
  return out;
}

const base: PaymentConfig = { phone: '0352611710', name: '', walletAccount: null };
const wallet: PaymentConfig = { ...base, walletAccount: '99MM24011M34875080' };

describe('crc16', () => {
  it('khớp vector chuẩn CRC-16/CCITT-FALSE', () => {
    assert.equal(crc16('123456789'), '29B1');
  });
});

describe('buildTransferQr', () => {
  it('chỉ có số điện thoại → QR link MoMo', () => {
    const qr = buildTransferQr(base, 630000, 'so no abc');
    assert.equal(qr.mode, 'link');
    assert.equal(qr.payload, 'https://nhantien.momo.vn/0352611710');
  });

  it('có số ví → payload EMVCo đủ trường và CRC đúng', () => {
    const qr = buildTransferQr(wallet, 630000, 'Sổ nợ ABC123');
    assert.equal(qr.mode, 'emvco');

    const body = qr.payload.slice(0, -4);
    const checksum = qr.payload.slice(-4);
    assert.equal(checksum, crc16(body), 'CRC phải tính trên toàn bộ chuỗi trước tag 63');

    const fields = parseRoot(qr.payload);
    assert.equal(fields['00'], '01');
    assert.equal(fields['01'], '12', 'có số tiền thì phải là QR động');
    assert.equal(fields['53'], '704');
    assert.equal(fields['54'], '630000');
    assert.equal(fields['58'], 'VN');
    assert.equal(fields['63'], checksum);

    const merchant = fields['38'];
    assert.ok(merchant.includes('A000000727'), 'GUID NAPAS');
    assert.ok(merchant.includes('970454'), 'BIN MoMo');
    assert.ok(merchant.includes('99MM24011M34875080'), 'số ví');
    assert.ok(merchant.includes('QRIBFTTA'), 'dịch vụ chuyển tiền');

    // 62.08 = nội dung chuyển khoản, đã bỏ dấu
    assert.ok(fields['62'].startsWith('08'), 'tag 62 chứa sub-tag 08');
    assert.ok(fields['62'].includes('SO NO ABC123'));
  });

  it('không truyền số tiền → QR tĩnh (tag 01 = 11, không có tag 54)', () => {
    const qr = buildTransferQr(wallet, 0, '');
    const fields = parseRoot(qr.payload);
    assert.equal(fields['01'], '11');
    assert.equal(fields['54'], undefined);
  });
});

describe('asciiMemo', () => {
  it('bỏ dấu tiếng Việt và ký tự lạ', () => {
    assert.equal(asciiMemo('Sổ nợ: Chuyển 630.000đ'), 'SO NO CHUYEN 630 000D');
  });
});
