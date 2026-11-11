#!/usr/bin/env node
/**
 * scripts/dev-db.mjs — MongoDB tạm cho lúc phát triển (KHÔNG dùng cho production).
 *
 *   node scripts/dev-db.mjs
 *
 * Bật một replica-set 1 node trong RAM (có transaction như Atlas), in URI ra
 * stdout rồi giữ chạy. Dùng cho `.env.local`:
 *   MONGODB_URI=mongodb://127.0.0.1:<port>/?replicaSet=...
 *
 * Production dùng MongoDB Atlas (xem README).
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ dbName: 'so_no', dbPath: undefined }],
});

console.log('MONGODB_URI=' + replSet.getUri());
console.log('Mongo dev đang chạy. Ctrl+C để dừng.');

async function shutdown() {
  await replSet.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
