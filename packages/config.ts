export type PaymentProviderName = 'sandbox' | 'payos' | 'vnpay';
export interface Config {
  databaseUrl: string; redisUrl: string; jwtSecret: string; otpSecret: string;
  webhookSecret: string; production: boolean; devOtp: boolean; devKey: string;
  /** Development only: a caller holding the development key may have its code pushed to its own phone over FCM. */
  devOtpPush: boolean;
  fcmEnabled: boolean; port: number; realtimePort: number; corsOrigins: string[]; redisKeyPrefix: string; bindHost: string;
  /** Reverse proxies in front of the API whose X-Forwarded-For is believed; 0 means clients connect directly. */
  trustedProxyHops: number;
  paymentProvider: PaymentProviderName; paymentReturnUrl: string; paymentCancelUrl: string;
  payos?: { clientId: string; apiKey: string; checksumKey: string; baseUrl: string };
  vnpay?: { tmnCode: string; hashSecret: string; payUrl: string; apiUrl: string };
  otpDelivery: 'development' | 'provider';
  smtp?: { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
  twilio?: { accountSid: string; authToken: string; from: string };
  refund: { fullHours: number; partialHours: number; partialPercent: number; orderHours: number };
  accountPurge: boolean;
  /** Hours a venue owner has to confirm or reject a paid booking before it self-cancels with a full refund. */
  ownerConfirmWindowHours: number;
}
/** OAuth client IDs whose Google sign-ins are accepted (GOOGLE_CLIENT_ID, comma separated). Apps are told the first. */
export function googleClientIds(env: NodeJS.ProcessEnv = process.env) {
  return (env.GOOGLE_CLIENT_ID || '').split(',').map(id => id.trim()).filter(Boolean);
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string, min = 1) => {
    const value = env[key];
    if (!value || value.length < min) throw new Error(`Missing/invalid configuration: ${key}`);
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Missing/invalid configuration: ${key}`);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  if (googleClientIds(env).some(id => !/^[\w-]+\.apps\.googleusercontent\.com$/.test(id))) throw new Error('GOOGLE_CLIENT_ID must hold Google OAuth client IDs');
  // It replaces Google's keys, so whoever sets it decides who can sign in: integration tests only, against a local stand-in.
  if (env.GOOGLE_JWKS_URL && (env.NODE_ENV !== 'test' || !URL.canParse(env.GOOGLE_JWKS_URL)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(env.GOOGLE_JWKS_URL).hostname))) {
    throw new Error('GOOGLE_JWKS_URL is only for integration tests with a key server on this machine');
  }
  const jwtSecret = required('JWT_SECRET', 32);
  const otpSecret = required('OTP_HASH_SECRET', 32);
  const paymentProvider = env.PAYMENT_PROVIDER as PaymentProviderName;
  if (!['sandbox', 'payos', 'vnpay'].includes(paymentProvider)) throw new Error('PAYMENT_PROVIDER must be sandbox, payos or vnpay');
  const otpDelivery = env.OTP_DELIVERY as Config['otpDelivery'];
  if (!['development', 'provider'].includes(otpDelivery)) throw new Error('OTP_DELIVERY must be development or provider');
  const webhookSecret = paymentProvider === 'sandbox' ? required('SANDBOX_WEBHOOK_SECRET', 32) : env.SANDBOX_WEBHOOK_SECRET || '';
  if (production && [jwtSecret, otpSecret, webhookSecret].some(v => v.startsWith('local-'))) {
    throw new Error('Local secrets cannot be used in production');
  }
  if (production && (env.DEV_OTP_ENABLED === 'true' || env.OTP_DEV_PUSH === 'true' || otpDelivery === 'development' || paymentProvider === 'sandbox')) {
    throw new Error('Development OTP, its push and sandbox payment are blocked in production');
  }
  // Real providers fail closed: every credential must be present before the process starts.
  let payos: Config['payos'], vnpay: Config['vnpay'], paymentReturnUrl = '', paymentCancelUrl = '';
  if (paymentProvider !== 'sandbox') {
    paymentReturnUrl = required('PAYMENT_RETURN_URL'); paymentCancelUrl = env.PAYMENT_CANCEL_URL || paymentReturnUrl;
    for (const url of [paymentReturnUrl, paymentCancelUrl]) if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(url)) throw new Error('Invalid payment return URL');
  }
  if (paymentProvider === 'payos') payos = { clientId: required('PAYOS_CLIENT_ID'), apiKey: required('PAYOS_API_KEY'),
    checksumKey: required('PAYOS_CHECKSUM_KEY', 16), baseUrl: env.PAYOS_BASE_URL || 'https://api-merchant.payos.vn' };
  if (paymentProvider === 'vnpay') vnpay = { tmnCode: required('VNPAY_TMN_CODE'), hashSecret: required('VNPAY_HASH_SECRET', 16),
    payUrl: env.VNPAY_PAY_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    apiUrl: env.VNPAY_API_URL || 'https://sandbox.vnpayment.vn/merchant_webapi/api/transaction' };
  let smtp: Config['smtp'], twilio: Config['twilio'];
  if (otpDelivery === 'provider') {
    if (env.SMTP_HOST) { const port = integer('SMTP_PORT', 587, 1, 65535);
      smtp = { host: env.SMTP_HOST, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
        user: required('SMTP_USER'), pass: required('SMTP_PASS'), from: required('SMTP_FROM') }; }
    if (env.TWILIO_ACCOUNT_SID) twilio = { accountSid: env.TWILIO_ACCOUNT_SID, authToken: required('TWILIO_AUTH_TOKEN'), from: required('TWILIO_FROM') };
    if (!smtp && !twilio) throw new Error('OTP_DELIVERY=provider needs SMTP_* (email) and/or TWILIO_* (SMS) credentials');
  }
  const devOtp = env.DEV_OTP_ENABLED === 'true';
  const devKey = env.DEV_ADMIN_KEY || '';
  if (devOtp && devKey.length < 32) throw new Error('DEV_ADMIN_KEY must be >=32 characters when development OTP is enabled');
  // A push reaches the phone that asked for the code, not whoever owns the number or address: it proves nothing,
  // so it is a development aid like GET /dev/otp, never a way to deliver codes.
  const devOtpPush = env.OTP_DEV_PUSH === 'true';
  if (devOtpPush && !devOtp) throw new Error('OTP_DEV_PUSH requires DEV_OTP_ENABLED=true');
  if (devOtpPush && !env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('OTP_DEV_PUSH needs GOOGLE_APPLICATION_CREDENTIALS: a service-account file allowed to send FCM messages');
  }
  const port = Number(env.PORT || 3000);
  const realtimePort = Number(env.REALTIME_PORT || 3001);
  for (const value of [port, realtimePort]) if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid port');
  const refund = { fullHours: integer('REFUND_FULL_HOURS', 24, 0, 720), partialHours: integer('REFUND_PARTIAL_HOURS', 2, 0, 720),
    partialPercent: integer('REFUND_PARTIAL_PERCENT', 50, 1, 100), orderHours: integer('REFUND_ORDER_HOURS', 24, 0, 720) };
  if (refund.partialHours > refund.fullHours) throw new Error('REFUND_PARTIAL_HOURS cannot exceed REFUND_FULL_HOURS');
  const ownerConfirmWindowHours = integer('OWNER_CONFIRM_WINDOW_HOURS', 2, 1, 168);
  return { databaseUrl: required('DATABASE_URL'), redisUrl: required('REDIS_URL'), jwtSecret, otpSecret, webhookSecret,
    production, devOtp, devOtpPush, devKey, fcmEnabled: env.FCM_ENABLED === 'true', port, realtimePort,
    corsOrigins: (env.CORS_ORIGINS || '').split(',').filter(Boolean), redisKeyPrefix: env.REDIS_KEY_PREFIX || 'anta:', bindHost: env.BIND_HOST || '127.0.0.1',
    trustedProxyHops: integer('TRUSTED_PROXY_HOPS', 0, 0, 10),
    paymentProvider, paymentReturnUrl, paymentCancelUrl, payos, vnpay, otpDelivery, smtp, twilio, refund,
    accountPurge: env.ACCOUNT_PURGE_ENABLED !== 'false', ownerConfirmWindowHours };
}
