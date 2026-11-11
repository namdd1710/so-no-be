/**
 * lib/access-code.ts — sinh mã truy cập CỐ ĐỊNH (BRIEF §4.1, §9).
 *
 * 12 ký tự Crockford Base32 lấy từ 60 bit của `crypto.randomBytes(8)` (~60 bit
 * entropy). Sinh đúng MỘT LẦN khi tạo con nợ, lưu vào `debtors.accessCode`,
 * không bao giờ update — không có endpoint/UI cấp lại.
 *
 * Bỏ các ký tự dễ nhầm (I, L, O, U) để link dễ đọc/gõ lại.
 */

import { randomBytes } from 'node:crypto';

export const ACCESS_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 ký tự
export const ACCESS_CODE_LENGTH = 12;

export function generateAccessCode(): string {
  const bytes = randomBytes(8);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  const sixtyBits = bits & ((1n << 60n) - 1n);

  let code = '';
  for (let shift = 55n; shift >= 0n; shift -= 5n) {
    code += ACCESS_CODE_ALPHABET[Number((sixtyBits >> shift) & 31n)];
  }
  return code;
}

/** Mã có đúng hình dạng không (dùng để trả 404 sớm, khỏi query DB). */
export function isValidAccessCodeShape(code: string): boolean {
  if (code.length !== ACCESS_CODE_LENGTH) return false;
  for (const char of code.toUpperCase()) {
    if (!ACCESS_CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/** Chuẩn hoá mã người dùng dán vào (chữ thường, khoảng trắng, gạch nối). */
export function normalizeAccessCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}
