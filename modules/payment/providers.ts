import { createHmac, randomUUID } from 'node:crypto';
import { Config } from '../../packages/config';
import { secureEqual } from '../../packages/auth/crypto';
import { ApiError } from '../../packages/contracts/errors';

export interface CheckoutRequest { orderCode: string; amount: number; description: string; expiresAt: Date; clientIp: string }
export interface Checkout { checkoutUrl: string | null; qrCode: string | null }
export interface ProviderPayment { eventId: string; orderCode: string; amount: number; currency: 'VND'; paid: boolean; providerRef?: string; paidAt?: string }
export interface RefundRequest { refundId: string; orderCode: string; amount: number; full: boolean; providerRef?: string | null; paidAt?: string | null; reason: string }
export interface RefundOutcome { status: 'SUCCEEDED' | 'FAILED' | 'MANUAL_REVIEW'; providerRef?: string }
type Fetch = typeof fetch;

const hmac = (algorithm: 'sha256' | 'sha512', key: string, text: string) => createHmac(algorithm, key).update(text, 'utf8').digest('hex');
async function call(http: Fetch, url: string, init: RequestInit) {
  try {
    const response = await http(url, { ...init, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as any;
  } catch { throw new ApiError('PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider is unavailable', 502); }
}

// ---- PayOS (https://payos.vn/docs/api/) ----
// Signature text is `key=value` pairs sorted by key and joined with `&`, HMAC-SHA256 with the checksum key.
export function payosSignatureText(data: Record<string, unknown>) {
  return Object.keys(data).sort().map(key => {
    const value = data[key];
    return `${key}=${value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)}`;
  }).join('&');
}
export const payosSign = (data: Record<string, unknown>, checksumKey: string) => hmac('sha256', checksumKey, payosSignatureText(data));
export async function payosCheckout(config: Config, request: CheckoutRequest, http: Fetch = fetch): Promise<Checkout> {
  const payos = config.payos!;
  const body = { orderCode: Number(request.orderCode), amount: request.amount, description: request.description.slice(0, 25),
    cancelUrl: config.paymentCancelUrl, returnUrl: config.paymentReturnUrl };
  const result = await call(http, `${payos.baseUrl}/v2/payment-requests`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client-id': payos.clientId, 'x-api-key': payos.apiKey },
    body: JSON.stringify({ ...body, expiredAt: Math.floor(request.expiresAt.getTime() / 1000), signature: payosSign(body, payos.checksumKey) }) });
  if (result?.code !== '00' || !result.data?.checkoutUrl) throw new ApiError('PAYMENT_PROVIDER_REJECTED', 'Payment provider rejected the request', 502);
  return { checkoutUrl: result.data.checkoutUrl, qrCode: result.data.qrCode || null };
}
export function payosWebhook(body: any, checksumKey: string): ProviderPayment {
  const data = body?.data, signature = body?.signature;
  if (!data || typeof data !== 'object' || typeof signature !== 'string' || !secureEqual(payosSign(data, checksumKey), signature.toLowerCase()))
    throw new ApiError('INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature', 401);
  const amount = Number(data.amount);
  if (!Number.isSafeInteger(amount) || !/^\d{1,18}$/.test(String(data.orderCode))) throw new ApiError('VALIDATION_FAILED', 'Invalid webhook payload', 400);
  const reference = String(data.reference || data.paymentLinkId || '');
  return { eventId: `payos:${data.orderCode}:${reference}`, orderCode: String(data.orderCode), amount, currency: 'VND',
    paid: body.success === true && body.code === '00' && data.code === '00', providerRef: reference || undefined,
    paidAt: data.transactionDateTime ? String(data.transactionDateTime) : undefined };
}

// ---- VNPay (https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html) ----
const vnpEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
export function vnpayQuery(params: Record<string, string>) {
  return Object.keys(params).filter(key => params[key] !== '' && params[key] !== undefined).sort()
    .map(key => `${vnpEncode(key)}=${vnpEncode(params[key])}`).join('&');
}
export const vnpaySign = (params: Record<string, string>, secret: string) => hmac('sha512', secret, vnpayQuery(params));
/** VNPay timestamps are `yyyyMMddHHmmss` in GMT+7. */
export function vnpayDate(date: Date) {
  return new Date(date.getTime() + 7 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
const vnpIp = (ip: string) => /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip.replace(/^::ffff:/, '') : '127.0.0.1';
export function vnpayCheckout(config: Config, request: CheckoutRequest, now = new Date()): Checkout {
  const vnpay = config.vnpay!;
  const params: Record<string, string> = { vnp_Version: '2.1.0', vnp_Command: 'pay', vnp_TmnCode: vnpay.tmnCode,
    vnp_Amount: String(request.amount * 100), vnp_CurrCode: 'VND', vnp_TxnRef: request.orderCode,
    vnp_OrderInfo: request.description, vnp_OrderType: 'other', vnp_Locale: 'vn', vnp_ReturnUrl: config.paymentReturnUrl,
    vnp_IpAddr: vnpIp(request.clientIp), vnp_CreateDate: vnpayDate(now), vnp_ExpireDate: vnpayDate(request.expiresAt) };
  return { checkoutUrl: `${vnpay.payUrl}?${vnpayQuery(params)}&vnp_SecureHash=${vnpaySign(params, vnpay.hashSecret)}`, qrCode: null };
}
/** Returns null when the secure hash does not verify. */
export function vnpayIpn(query: Record<string, unknown>, secret: string): ProviderPayment | null {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('vnp_') || key === 'vnp_SecureHash' || key === 'vnp_SecureHashType' || typeof value !== 'string') continue;
    params[key] = value;
  }
  const hash = query.vnp_SecureHash;
  if (typeof hash !== 'string' || !secureEqual(vnpaySign(params, secret), hash.toLowerCase())) return null;
  const amount = Number(params.vnp_Amount) / 100;
  return { eventId: `vnpay:${params.vnp_TxnRef}:${params.vnp_TransactionNo || '0'}`, orderCode: params.vnp_TxnRef || '', amount,
    currency: 'VND', paid: params.vnp_ResponseCode === '00' && params.vnp_TransactionStatus === '00',
    providerRef: params.vnp_TransactionNo, paidAt: params.vnp_PayDate };
}
export async function vnpayRefund(config: Config, request: RefundRequest, http: Fetch = fetch, now = new Date()): Promise<RefundOutcome> {
  const vnpay = config.vnpay!;
  if (!request.providerRef || !request.paidAt) return { status: 'MANUAL_REVIEW' };
  const body: Record<string, string> = { vnp_RequestId: request.refundId.replace(/-/g, ''), vnp_Version: '2.1.0', vnp_Command: 'refund',
    vnp_TmnCode: vnpay.tmnCode, vnp_TransactionType: request.full ? '02' : '03', vnp_TxnRef: request.orderCode,
    vnp_Amount: String(request.amount * 100), vnp_TransactionNo: request.providerRef, vnp_TransactionDate: request.paidAt,
    vnp_CreateBy: 'alobo-backend', vnp_CreateDate: vnpayDate(now), vnp_IpAddr: '127.0.0.1', vnp_OrderInfo: request.reason.slice(0, 200) };
  const text = ['vnp_RequestId', 'vnp_Version', 'vnp_Command', 'vnp_TmnCode', 'vnp_TransactionType', 'vnp_TxnRef', 'vnp_Amount',
    'vnp_TransactionNo', 'vnp_TransactionDate', 'vnp_CreateBy', 'vnp_CreateDate', 'vnp_IpAddr', 'vnp_OrderInfo'].map(key => body[key]).join('|');
  const result = await call(http, vnpay.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, vnp_SecureHash: hmac('sha512', vnpay.hashSecret, text) }) });
  return result?.vnp_ResponseCode === '00' ? { status: 'SUCCEEDED', providerRef: String(result.vnp_TransactionNo || '') } : { status: 'FAILED' };
}

export async function createCheckout(config: Config, request: CheckoutRequest): Promise<Checkout> {
  if (config.paymentProvider === 'payos') return payosCheckout(config, request);
  if (config.paymentProvider === 'vnpay') return vnpayCheckout(config, request);
  // Sandbox issues no fake merchant URL or QR; the locally signed webhook is the only confirmation.
  return { checkoutUrl: null, qrCode: null };
}
/** PayOS exposes no refund API: the merchant transfers the money back and an admin records it. */
export async function executeRefund(config: Config, provider: string, request: RefundRequest): Promise<RefundOutcome> {
  if (provider === 'sandbox') return { status: 'SUCCEEDED', providerRef: `sandbox-refund-${randomUUID()}` };
  if (provider === 'vnpay' && config.vnpay) return vnpayRefund(config, request);
  return { status: 'MANUAL_REVIEW' };
}
