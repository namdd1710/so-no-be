/**
 * lib/http.ts — helper phản hồi JSON, session, kiểm tra Origin, rate limit IP.
 *
 * Nguyên tắc: mọi response API đều `Cache-Control: no-store` (BRIEF §9).
 */

import { readSessionCookie, verifySessionToken, type SessionPayload } from './session';

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export class ApiError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: { code, message, ...(extra ?? {}) } }, { status });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'INVALID_BODY', 'Dữ liệu gửi lên không hợp lệ');
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_BODY', 'Dữ liệu gửi lên không phải JSON hợp lệ');
  }
}

/* ------------------------------ Session ------------------------------ */

export function getSessionToken(request: Request): string | null {
  return readSessionCookie(request.headers.get('cookie'));
}

export async function getSession(request: Request): Promise<SessionPayload | null> {
  return verifySessionToken(getSessionToken(request));
}

/* ------------------------------- Origin ------------------------------ */

function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  for (const raw of (process.env.ALLOWED_ORIGINS ?? '').split(',')) {
    const value = raw.trim().replace(/\/+$/, '');
    if (value) set.add(value);
  }
  const appBase = (process.env.APP_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (appBase) set.add(appBase);
  return set;
}

/**
 * Kiểm tra CSRF: request ghi phải có `Origin` khớp host hoặc danh sách cho phép.
 * Không có Origin → từ chối.
 */
export function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const normalized = origin.replace(/\/+$/, '');
  if (allowedOrigins().has(normalized)) return true;

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return false;
  return normalized === `https://${host}` || normalized === `http://${host}`;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/* ---------------------------- Rate limiting -------------------------- */

type Bucket = { count: number; firstAt: number };

const globalForRate = globalThis as typeof globalThis & { __soNoRate?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (globalForRate.__soNoRate ??= new Map());

function sweep(now: number) {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.firstAt > 60 * 60 * 1000) buckets.delete(key);
  }
}

/** Đã bị chặn chưa (không tăng đếm). */
export function isRateLimited(key: string, limit: number, windowMs: number): { limited: boolean; retryAfter: number } {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket) return { limited: false, retryAfter: 0 };
  if (now - bucket.firstAt > windowMs) {
    buckets.delete(key);
    return { limited: false, retryAfter: 0 };
  }
  if (bucket.count >= limit) {
    return { limited: true, retryAfter: Math.ceil((bucket.firstAt + windowMs - now) / 1000) };
  }
  return { limited: false, retryAfter: 0 };
}

/** Ghi nhận một lần vượt (dùng cho đăng nhập sai). */
export function recordFailure(key: string, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.firstAt > windowMs) {
    buckets.set(key, { count: 1, firstAt: now });
    return;
  }
  bucket.count += 1;
}

export function failureCount(key: string, windowMs: number): number {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.firstAt > windowMs) return 0;
  return bucket.count;
}

export function clearFailures(key: string): void {
  buckets.delete(key);
}

/** Rate limit chung: đếm mọi request (dùng cho `/api/public/*`). */
export function takeRateLimit(key: string, limit: number, windowMs: number): { limited: boolean; retryAfter: number } {
  const state = isRateLimited(key, limit, windowMs);
  if (state.limited) return state;
  recordFailure(key, windowMs);
  return { limited: false, retryAfter: 0 };
}

/* --------------------------- Auth helpers ---------------------------- */

/** Bắt buộc có session admin hợp lệ, ngược lại ném 401. */
export async function requireAdmin(request: Request): Promise<SessionPayload> {
  const session = await getSession(request);
  if (!session) throw new ApiError(401, 'UNAUTHORIZED', 'Bạn cần đăng nhập');
  return session;
}

/** Bắt buộc Origin khớp (CSRF) cho mọi request ghi, ngược lại ném 403. */
export function requireMutation(request: Request): void {
  if (!isAllowedOrigin(request)) {
    throw new ApiError(403, 'BAD_ORIGIN', 'Yêu cầu không đến từ ứng dụng hợp lệ');
  }
}

/* ---------------------------- Error wrapper -------------------------- */

type Handler<Ctx> = (request: Request, context: Ctx) => Promise<Response>;

export function route<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ApiError) {
        return fail(error.status, error.code, error.message, error.extra);
      }
      console.error('[api] lỗi không mong đợi:', error);
      const message = error instanceof Error ? error.message : 'Lỗi không xác định';
      const isConfig = /MONGODB_URI|SESSION_SECRET|chưa được cấu hình/.test(message);
      return fail(isConfig ? 500 : 500, isConfig ? 'CONFIG_ERROR' : 'INTERNAL_ERROR', isConfig ? message : 'Lỗi máy chủ');
    }
  };
}
