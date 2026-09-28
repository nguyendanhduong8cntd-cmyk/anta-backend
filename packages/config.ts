export interface Config {
  databaseUrl: string; redisUrl: string; jwtSecret: string; otpSecret: string;
  webhookSecret: string; production: boolean; devOtp: boolean; devKey: string;
  fcmEnabled: boolean; port: number; realtimePort: number; corsOrigins: string[]; redisKeyPrefix: string; bindHost: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string, min = 1) => {
    const value = env[key];
    if (!value || value.length < min) throw new Error(`Missing/invalid configuration: ${key}`);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  const jwtSecret = required('JWT_SECRET', 32);
  const otpSecret = required('OTP_HASH_SECRET', 32);
  const webhookSecret = required('SANDBOX_WEBHOOK_SECRET', 32);
  if (production && [jwtSecret, otpSecret, webhookSecret].some(v => v.startsWith('local-'))) {
    throw new Error('Local secrets cannot be used in production');
  }
  if (production && (env.DEV_OTP_ENABLED === 'true' || env.OTP_DELIVERY === 'development' || env.PAYMENT_PROVIDER === 'sandbox')) {
    throw new Error('Development OTP and sandbox payment are blocked in production');
  }
  // No guessed SMS/payment integration: fail closed until a real adapter is implemented.
  if (env.PAYMENT_PROVIDER !== 'sandbox') throw new Error('Only the sandbox payment adapter is implemented');
  if (env.OTP_DELIVERY !== 'development') throw new Error('Configure an SMS/email adapter before enabling non-development OTP');
  const devOtp = env.DEV_OTP_ENABLED === 'true';
  const devKey = env.DEV_ADMIN_KEY || '';
  if (devOtp && devKey.length < 32) throw new Error('DEV_ADMIN_KEY must be >=32 characters when development OTP is enabled');
  const port = Number(env.PORT || 3000);
  const realtimePort = Number(env.REALTIME_PORT || 3001);
  for (const value of [port, realtimePort]) if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid port');
  return { databaseUrl: required('DATABASE_URL'), redisUrl: required('REDIS_URL'), jwtSecret, otpSecret, webhookSecret,
    production, devOtp, devKey, fcmEnabled: env.FCM_ENABLED === 'true', port, realtimePort,
    corsOrigins: (env.CORS_ORIGINS || '').split(',').filter(Boolean), redisKeyPrefix: env.REDIS_KEY_PREFIX || 'alobo:', bindHost: env.BIND_HOST || '127.0.0.1' };
}
