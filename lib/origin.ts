/**
 * lib/origin.ts — so khớp Origin cho mọi request ghi (chống CSRF).
 *
 * Tách khỏi `lib/http.ts` để không kéo theo session/crypto: module này thuần,
 * chỉ đọc `process.env` và header của `Request`, nên test được trực tiếp.
 *
 * `ALLOWED_ORIGINS` hiểu:
 * - `*` → mọi nguồn (tắt kiểm tra, kể cả request không gửi `Origin`)
 * - `https://*.vercel.app` → mọi domain con, tiện cho preview deployment
 * - origin chính xác, ngăn cách bằng dấu phẩy
 * `APP_BASE_URL` luôn được coi là hợp lệ.
 */

function toPattern(value: string): RegExp {
  const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`, 'i');
}

type OriginRules = { any: boolean; exact: Set<string>; patterns: RegExp[] };

let cachedKey = '';
let cachedRules: OriginRules | null = null;

function originRules(): OriginRules {
  const sources = [process.env.ALLOWED_ORIGINS ?? '', process.env.APP_BASE_URL ?? ''];
  const key = sources.join('|');
  if (cachedRules && cachedKey === key) return cachedRules;

  const rules: OriginRules = { any: false, exact: new Set<string>(), patterns: [] };
  for (const raw of sources.join(',').split(',')) {
    const value = raw.trim().replace(/\/+$/, '');
    if (!value) continue;
    if (value === '*') {
      rules.any = true;
    } else if (value.includes('*')) {
      rules.patterns.push(toPattern(value));
    } else {
      rules.exact.add(value);
    }
  }

  cachedKey = key;
  cachedRules = rules;
  return rules;
}

/**
 * Request ghi có đến từ nguồn được phép không.
 *
 * - `ALLOWED_ORIGINS=*` → cho qua mọi nguồn, kể cả request không gửi `Origin`
 *   (curl/Postman/server-to-server). Chỉ nên dùng khi thật sự mở API.
 * - Còn lại: thiếu `Origin` → từ chối.
 */
export function isAllowedOrigin(request: Request): boolean {
  const rules = originRules();
  if (rules.any) return true;

  const origin = request.headers.get('origin');
  if (!origin) return false;
  const normalized = origin.replace(/\/+$/, '');
  if (rules.exact.has(normalized)) return true;
  if (rules.patterns.some((pattern) => pattern.test(normalized))) return true;

  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return false;
  return normalized === `https://${host}` || normalized === `http://${host}`;
}
