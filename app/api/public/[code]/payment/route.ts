import QRCode from 'qrcode';
import { isValidAccessCodeShape, normalizeAccessCode } from '@/lib/access-code';
import { clientIp, fail, json, route, takeRateLimit } from '@/lib/http';
import { buildTransferQr, paymentConfig } from '@/lib/momo-qr';
import { loadPublicLedger } from '@/lib/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ code: string }> };

const LIMIT = 20;
const WINDOW_MS = 60 * 1000;

/**
 * GET /api/public/:code/payment?amount=…
 *
 * Trả thông tin nhận tiền + mã QR MoMo (ảnh PNG dạng data URL) cho con nợ.
 * Số tiền mặc định là tổng còn nợ; `?amount=` cho phép trả một phần.
 */
export const GET = route<Context>(async (request, context) => {
  const limit = takeRateLimit(`public-pay:${clientIp(request)}`, LIMIT, WINDOW_MS);
  if (limit.limited) {
    return fail(429, 'TOO_MANY_REQUESTS', 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.', {
      retryAfter: limit.retryAfter,
    });
  }

  const { code } = await context.params;
  const normalized = normalizeAccessCode(code);
  if (!isValidAccessCodeShape(normalized)) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');

  let ledger;
  try {
    ledger = await loadPublicLedger(normalized, {});
  } catch (error) {
    if ((error as { status?: number }).status === 404) return fail(404, 'NOT_FOUND', 'Không tìm thấy sổ nợ');
    throw error;
  }

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('amount'));
  const amount = Number.isFinite(requested) && requested > 0 ? Math.round(requested) : ledger.totals.unsettled;

  if (!(amount > 0)) {
    return fail(400, 'NOTHING_TO_PAY', 'Không còn khoản nào cần thanh toán');
  }

  const config = paymentConfig();
  const transfer = buildTransferQr(config, amount, `SO NO ${normalized}`);
  const qrDataUrl = await QRCode.toDataURL(transfer.payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#0b1c2c', light: '#ffffff' },
  });

  return json({
    provider: 'momo',
    debtorName: ledger.name,
    phone: config.phone,
    name: config.name || null,
    // 'emvco' = QR có sẵn số tiền (cần MOMO_WALLET_ACCOUNT); 'link' = link MoMo.
    mode: transfer.mode,
    payload: transfer.payload,
    memo: transfer.memo,
    amount: transfer.amount ?? amount,
    qrDataUrl,
  });
});
