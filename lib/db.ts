/**
 * lib/db.ts — MongoClient singleton, tái dùng connection (BRIEF §10).
 *
 * Cache trên `globalThis` để hot-reload lúc dev và cold start trên Vercel
 * không mở pool mới cho mỗi request. Atlas chạy cùng region `sin1`.
 */

import { setServers } from 'node:dns';
import { MongoClient, type Db } from 'mongodb';
import type { CategoryDoc, DebtorDoc, EntryDoc, SettlementDoc } from './types';

const DEFAULT_DB = 'so_no';

type MongoCache = {
  client: MongoClient | null;
  promise: Promise<MongoClient> | null;
  indexes: Promise<void> | null;
};

const globalForMongo = globalThis as typeof globalThis & { __soNoMongo?: MongoCache };
const cache: MongoCache = (globalForMongo.__soNoMongo ??= { client: null, promise: null, indexes: null });

function mongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI chưa được cấu hình');
  return uri;
}

let dnsConfigured = false;

/**
 * Tuỳ chọn: `MONGODB_DNS_SERVERS=1.1.1.1,8.8.8.8`.
 *
 * URI `mongodb+srv://` cần tra bản ghi SRV bằng resolver của Node (c-ares).
 * Trên một số máy Windows, c-ares không đọc được resolver hệ thống và báo
 * `querySrv ECONNREFUSED` — khi đó chỉ định DNS công khai ở đây là xong.
 * Production (Vercel) thường không cần biến này.
 */
function configureDns(): void {
  if (dnsConfigured) return;
  const raw = process.env.MONGODB_DNS_SERVERS;
  if (!raw) return;
  const servers = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (servers.length === 0) return;
  try {
    setServers(servers);
    dnsConfigured = true;
    console.log('[db] Dùng DNS riêng cho Mongo:', servers.join(', '));
  } catch (error) {
    console.warn('[db] Không đặt được MONGODB_DNS_SERVERS:', error instanceof Error ? error.message : error);
  }
}

export function getClient(): Promise<MongoClient> {
  configureDns();
  if (!cache.promise) {
    const client = new MongoClient(mongoUri(), {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      retryWrites: true,
    });
    cache.promise = client
      .connect()
      .then((connected) => {
        cache.client = connected;
        return connected;
      })
      .catch((error) => {
        cache.promise = null;
        throw error;
      });
  }
  return cache.promise;
}

async function ensureIndexes(db: Db): Promise<void> {
  if (!cache.indexes) {
    cache.indexes = (async () => {
      // Index bắt buộc (BRIEF §6)
      await db.collection<DebtorDoc>('debtors').createIndex({ accessCode: 1 }, { unique: true });
      await db.collection<EntryDoc>('entries').createIndex({ debtorId: 1, date: -1 });
      await db.collection<EntryDoc>('entries').createIndex({ debtorId: 1, deletedAt: 1, date: -1 });
      await db.collection<SettlementDoc>('settlements').createIndex({ debtorId: 1, periodEnd: -1 });
      // Danh mục + đơn giá gần nhất, mỗi tên một bản ghi cho mỗi con nợ.
      await db
        .collection<CategoryDoc>('categories')
        .createIndex({ debtorId: 1, name: 1 }, { unique: true });
    })().catch((error) => {
      cache.indexes = null;
      throw error;
    });
  }
  return cache.indexes;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  const db = client.db(process.env.MONGODB_DB || DEFAULT_DB);
  await ensureIndexes(db);
  return db;
}

export async function getCollections() {
  const db = await getDb();
  return {
    db,
    debtors: db.collection<DebtorDoc>('debtors'),
    entries: db.collection<EntryDoc>('entries'),
    settlements: db.collection<SettlementDoc>('settlements'),
    categories: db.collection<CategoryDoc>('categories'),
  };
}

/**
 * Chạy trong transaction khi Mongo hỗ trợ (Atlas replica set).
 * Với standalone (dev local) thì fallback gọi thẳng `fn()` — chốt vẫn kiểm
 * tra lại watermark ngay trước khi insert nên vẫn đúng.
 */
export async function withTransaction<T>(fn: (session: import('mongodb').ClientSession | null) => Promise<T>): Promise<T> {
  const client = await getClient();
  const session = client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unsupported =
      /Transaction numbers are only allowed on a replica set member or mongos/i.test(message) ||
      /does not support transactions/i.test(message) ||
      /Cannot run command .* in a transaction/i.test(message);
    if (unsupported) {
      console.warn('[db] Mongo không hỗ trợ transaction, dùng đường không-transaction:', message);
      return fn(null);
    }
    throw error;
  } finally {
    await session.endSession().catch(() => undefined);
  }
}

export async function pingDatabase(): Promise<boolean> {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return true;
  } catch (error) {
    console.error('[db] ping thất bại:', error instanceof Error ? error.message : error);
    return false;
  }
}
