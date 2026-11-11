/**
 * lib/session.ts — ký / xác thực cookie session bằng HMAC-SHA256.
 *
 * Chỉ dùng Web Crypto API nên chạy được cả ở Edge runtime (middleware.ts)
 * và Node runtime (route handlers). KHÔNG import `node:crypto` ở đây.
 *
 * Cookie value = base64url(JSON payload) + "." + base64url(HMAC)
 * Payload: { sub: 'admin', iat, exp }  (BRIEF §9)
 */

export const SESSION_COOKIE = 'sn_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 ngày

export type SessionPayload = {
  sub: 'admin';
  iat: number;
  exp: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sessionSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 16 ? secret : null;
}

async function importHmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function signSession(now: number = Date.now()): Promise<{ token: string; expiresAt: number } | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const iat = Math.floor(now / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload: SessionPayload = { sub: 'admin', iat, exp };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return { token: `${body}.${toBase64Url(new Uint8Array(signature))}`, expiresAt: exp };
}

export async function verifySessionToken(token: string | null | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const secret = sessionSecret();
  if (!secret) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  let provided: Uint8Array;
  try {
    provided = fromBase64Url(signature);
  } catch {
    return null;
  }

  const key = await importHmacKey(secret, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, provided as unknown as BufferSource, encoder.encode(body));
  if (!valid) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(body))) as SessionPayload;
  } catch {
    return null;
  }

  if (payload?.sub !== 'admin') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

/** Đọc cookie session từ header `Cookie` của request. */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** Chuỗi `Set-Cookie` cho session (HttpOnly, Secure, SameSite=Lax, Path=/). */
export function sessionCookie(token: string, maxAgeSeconds: number = SESSION_TTL_SECONDS): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
}

/** Chuỗi `Set-Cookie` để xoá session. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
