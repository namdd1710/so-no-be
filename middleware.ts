/**
 * middleware.ts — chặn mọi request GHI khi chưa có session hợp lệ (BRIEF §9).
 *
 * Đây là lớp bảo vệ thứ nhất (defense in depth); mỗi route handler vẫn tự
 * kiểm tra session + Origin lần nữa.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readSessionCookie, verifySessionToken } from '@/lib/session';

const PUBLIC_WRITE_ROUTES = new Set(['/api/auth/login', '/api/auth/logout']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (SAFE_METHODS.has(request.method)) return NextResponse.next();
  if (PUBLIC_WRITE_ROUTES.has(pathname.replace(/\/+$/, ''))) return NextResponse.next();

  const token = readSessionCookie(request.headers.get('cookie'));
  const session = await verifySessionToken(token);

  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Bạn cần đăng nhập' } },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
