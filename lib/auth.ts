/**
 * lib/auth.ts — Node runtime: băm & kiểm tra mật khẩu admin (BRIEF §9).
 *
 * Dùng `scrypt` có sẵn trong Node, không cần thư viện ngoài.
 * Định dạng `ADMIN_PASSWORD_HASH`:
 *   scrypt:<N>:<r>:<p>:<salt-hex>:<hash-hex>
 *
 * Dùng dấu `:` (không dùng `$`) vì `.env` của Next/Vercel có thể expand `$`
 * và làm hỏng giá trị hash.
 * Sinh bằng: `npm run hash-password -- "mat-khau-cua-ban"`
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;

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

/** Kiểm tra mật khẩu admin với `ADMIN_PASSWORD_HASH` trong env. */
export function verifyAdminPassword(password: string): boolean {
  const stored = process.env.ADMIN_PASSWORD_HASH;
  if (!stored) {
    console.error('[auth] ADMIN_PASSWORD_HASH chưa được cấu hình — từ chối đăng nhập.');
    return false;
  }
  return verifyPasswordHash(password, stored);
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, verifySessionToken } from './session';
