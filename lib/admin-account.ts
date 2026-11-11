/**
 * lib/admin-account.ts — mật khẩu admin: env (khởi tạo) hoặc hash trong Mongo.
 *
 * Thứ tự ưu tiên:
 *   1. `settings.passwordHash` trong Mongo  → dùng khi đã đổi mật khẩu
 *   2. `ADMIN_PASSWORD` trong env           → mật khẩu khởi tạo
 *
 * Nhờ vậy quên mật khẩu vẫn đổi được ngay trên production (không redeploy),
 * mà vẫn có mật khẩu gốc để dựng môi trường mới.
 */

import { getDb } from './db';
import { hashPassword, safeCompare, validateNewPassword, verifyPasswordHash } from './auth';

export const ADMIN_SETTINGS_ID = 'admin';

export type AdminSettingsDoc = {
  _id: string;
  passwordHash: string;
  updatedAt: Date;
  updatedReason: string | null;
};

async function settingsCollection() {
  const db = await getDb();
  return db.collection<AdminSettingsDoc>('settings');
}

export async function getStoredPasswordHash(): Promise<string | null> {
  const settings = await settingsCollection();
  const doc = await settings.findOne({ _id: ADMIN_SETTINGS_ID }, { projection: { passwordHash: 1 } });
  return doc?.passwordHash ?? null;
}

export async function getPasswordState(): Promise<{ source: 'database' | 'env'; updatedAt: Date | null }> {
  const settings = await settingsCollection();
  const doc = await settings.findOne(
    { _id: ADMIN_SETTINGS_ID },
    { projection: { passwordHash: 1, updatedAt: 1 } },
  );
  if (doc?.passwordHash) return { source: 'database', updatedAt: doc.updatedAt ?? null };
  return { source: 'env', updatedAt: null };
}

/** Kiểm tra mật khẩu đăng nhập: ưu tiên hash trong DB, sau đó tới env. */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  const stored = await getStoredPasswordHash();
  if (stored) return verifyPasswordHash(password, stored);

  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword) {
    console.error('[admin-account] Chưa có ADMIN_PASSWORD và chưa có mật khẩu trong DB — không thể đăng nhập.');
    return false;
  }
  return safeCompare(password, envPassword);
}

export type SetPasswordResult = { ok: true } | { ok: false; message: string };

/** Đổi mật khẩu (đã xác thực recovery key ở route). */
export async function setAdminPassword(rawPassword: unknown, reason = 'reset'): Promise<SetPasswordResult> {
  const validated = validateNewPassword(rawPassword);
  if (!validated.ok) return { ok: false, message: validated.message };

  const settings = await settingsCollection();
  const now = new Date();
  await settings.updateOne(
    { _id: ADMIN_SETTINGS_ID },
    {
      $set: {
        passwordHash: hashPassword(validated.password),
        updatedAt: now,
        updatedReason: reason,
      },
    },
    { upsert: true },
  );

  return { ok: true };
}
