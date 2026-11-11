/**
 * lib/auth.ts — mật khẩu admin.
 *
 * Mật khẩu KHỞI TẠO nằm ở env `ADMIN_PASSWORD` (dạng chữ thường, không phải hash).
 * Khi admin đổi mật khẩu (quên mật khẩu → dùng `ADMIN_RECOVERY_KEY`), mật khẩu mới
 * được băm bằng scrypt và lưu trong Mongo (`settings.passwordHash`) — nhờ vậy đổi
 * được ngay trên production mà không cần redeploy.
 *
 * Định dạng hash lưu trong DB: `scrypt:<N>:<r>:<p>:<salt-hex>:<hash-hex>`
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function hashPassword(password: string, params: { N?: number; r?: number; p?: number } = {}): string {
  const N = params.N ?? DEFAULT_N;
  const r = params.r ?? DEFAULT_R;
  const p = params.p ?? DEFAULT_P;
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Tách hash, chấp nhận cả định dạng cũ dùng `$`. */
function splitHash(stored: string): string[] {
  const trimmed = stored.trim();
  return trimmed.includes('$') ? trimmed.split('$') : trimmed.split(':');
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = splitHash(stored);
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** So sánh chuỗi không lộ thông tin qua thời gian phản hồi. */
export function safeCompare(input: string, expected: string): boolean {
  const left = Buffer.from(input.normalize('NFKC'), 'utf8');
  const right = Buffer.from(expected.normalize('NFKC'), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Kiểm tra mật khẩu khởi tạo trong env `ADMIN_PASSWORD`. */
export function verifyEnvPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    console.error('[auth] ADMIN_PASSWORD chưa được cấu hình — từ chối đăng nhập.');
    return false;
  }
  return safeCompare(password, expected);
}

/**
 * Key khôi phục lấy từ env `ADMIN_RECOVERY_KEY` (bạn tự đặt tên biến trong .env).
 * Chưa cấu hình thì tính năng đổi mật khẩu bị tắt hoàn toàn.
 */
export function verifyRecoveryKey(key: string): boolean {
  const expected = process.env.ADMIN_RECOVERY_KEY;
  if (!expected) return false;
  return safeCompare(key, expected);
}

export function isRecoveryEnabled(): boolean {
  return Boolean(process.env.ADMIN_RECOVERY_KEY);
}

export function validateNewPassword(value: unknown): { ok: true; password: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: 'Mật khẩu mới không hợp lệ' };
  const password = value.trim();
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Mật khẩu mới phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `Mật khẩu mới tối đa ${MAX_PASSWORD_LENGTH} ký tự` };
  }
  return { ok: true, password };
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, verifySessionToken } from './session';
