/**
 * tests/origin.test.ts — kiểm tra `isAllowedOrigin` (CSRF) trên lib/origin.ts.
 *
 * Chạy: npm test (node --test, không cần build).
 * Lưu ý: trong Node, `new Request()` không tự có header `Host`, nên phần
 * "trùng host" được test qua `x-forwarded-host` — đúng cái Vercel gửi.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { isAllowedOrigin } from '../lib/origin.ts';

const URL_UNDER_TEST = 'https://so-no-be.vercel.app/api/auth/login';

function request(origin?: string, forwardedHost?: string): Request {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (forwardedHost) headers.set('x-forwarded-host', forwardedHost);
  return new Request(URL_UNDER_TEST, { method: 'POST', headers });
}

function setEnv(allowedOrigins: string | undefined) {
  if (allowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = allowedOrigins;
}

afterEach(() => setEnv(undefined));

describe('isAllowedOrigin — danh sách chính xác', () => {
  it('cho qua origin khớp, kể cả khi có dấu / ở cuối', () => {
    setEnv('https://so-no-fe.vercel.app,http://localhost:3000');
    assert.equal(isAllowedOrigin(request('https://so-no-fe.vercel.app')), true);
    assert.equal(isAllowedOrigin(request('https://so-no-fe.vercel.app/')), true);
    assert.equal(isAllowedOrigin(request('http://localhost:3000')), true);
  });

  it('từ chối origin lạ và request không có Origin', () => {
    setEnv('https://so-no-fe.vercel.app');
    assert.equal(isAllowedOrigin(request('https://evil.example')), false);
    assert.equal(isAllowedOrigin(request()), false);
  });

  it('cho qua origin trùng host của chính request', () => {
    setEnv('');
    assert.equal(isAllowedOrigin(request('https://so-no-be.vercel.app', 'so-no-be.vercel.app')), true);
    assert.equal(isAllowedOrigin(request('http://so-no-be.vercel.app', 'so-no-be.vercel.app')), true);
    assert.equal(isAllowedOrigin(request('https://evil.example', 'so-no-be.vercel.app')), false);
  });
});

describe('isAllowedOrigin — wildcard', () => {
  it('`*` cho qua mọi nguồn, kể cả không có Origin', () => {
    setEnv('*');
    assert.equal(isAllowedOrigin(request('https://evil.example')), true);
    assert.equal(isAllowedOrigin(request('http://localhost:5173')), true);
    assert.equal(isAllowedOrigin(request()), true);
  });

  it('`https://*.vercel.app` khớp mọi domain con, không khớp domain khác', () => {
    setEnv('https://*.vercel.app');
    assert.equal(isAllowedOrigin(request('https://so-no-fe.vercel.app')), true);
    assert.equal(isAllowedOrigin(request('https://so-no-fe-git-main-namdd1710.vercel.app')), true);
    assert.equal(isAllowedOrigin(request('https://vercel.app')), false);
    assert.equal(isAllowedOrigin(request('https://vercel.app.evil.example')), false);
    assert.equal(isAllowedOrigin(request('http://so-no-fe.vercel.app')), false);
  });

  it('trộn wildcard với origin chính xác', () => {
    setEnv('https://*.vercel.app,http://localhost:3000');
    assert.equal(isAllowedOrigin(request('http://localhost:3000')), true);
    assert.equal(isAllowedOrigin(request('https://abc.vercel.app')), true);
    assert.equal(isAllowedOrigin(request('https://evil.example')), false);
  });

  it('không có biến môi trường thì chỉ còn luật trùng host', () => {
    setEnv(undefined);
    assert.equal(isAllowedOrigin(request('https://evil.example')), false);
    assert.equal(isAllowedOrigin(request('https://so-no-be.vercel.app', 'so-no-be.vercel.app')), true);
  });
});
