#!/usr/bin/env node
/**
 * Sinh giá trị ADMIN_PASSWORD_HASH.
 *
 *   npm run hash-password -- "mat-khau-cua-ban"
 *   node scripts/hash-password.mjs            (sẽ hỏi mật khẩu)
 */
import { randomBytes, scryptSync } from 'node:crypto';
import readline from 'node:readline/promises';

const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

function hash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 });
  // Dùng ':' thay vì '$' để .env của Next/Vercel không expand mất ký tự.
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

let password = process.argv[2];

if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Mật khẩu admin: ');
  rl.close();
}

if (!password || password.length < 8) {
  console.error('Mật khẩu phải có ít nhất 8 ký tự.');
  process.exit(1);
}

console.log('\nADMIN_PASSWORD_HASH=' + hash(password));
console.log('\n(Thêm dòng trên vào .env.local hoặc Vercel > Environment Variables)');
