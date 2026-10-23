import nodemailer from 'nodemailer';
import type { TokenMessage } from 'firebase-admin/messaging';
import { Config } from '../../packages/config';
import { ApiError } from '../../packages/contracts/errors';
import { messaging } from '../../packages/firebase';

export type OtpChannel = 'email' | 'sms';
export interface OtpMessage { identifier: string; code: string; purpose: 'register' | 'reset-password' }
export interface OtpTransports {
  email?: (to: string, subject: string, text: string) => Promise<void>;
  sms?: (to: string, text: string) => Promise<void>;
  /** Development only: hands the code to the phone that asked for it (see IdentityService.sendOtp). */
  push?: (token: string, message: OtpMessage) => Promise<void>;
}
export const channelOf = (identifier: string): OtpChannel => identifier.includes('@') ? 'email' : 'sms';
/** The configured channel that reaches whoever owns the identifier, or null when none does. */
export function realChannel(transports: OtpTransports, identifier: string): OtpChannel | null {
  const channel = channelOf(identifier);
  return transports[channel] ? channel : null;
}
export function otpText(message: OtpMessage) {
  const action = message.purpose === 'register' ? 'dang ky tai khoan' : 'dat lai mat khau';
  // ASCII only: Vietnamese diacritics force UCS-2 SMS and triple the segment cost.
  return `Ma xac thuc ${action} cua ban la ${message.code}. Ma het han sau 5 phut. Khong chia se ma nay voi bat ky ai.`;
}
/** Email costs nothing per character, so it keeps the diacritics an SMS has to drop. */
export function otpEmail(message: OtpMessage) {
  const action = message.purpose === 'register' ? 'đăng ký tài khoản' : 'đặt lại mật khẩu';
  return {
    subject: `Mã xác thực Anta: ${message.code}`,
    text: `Mã xác thực ${action} Anta của bạn là ${message.code}.\n\n`
      + 'Mã hết hạn sau 5 phút. Đừng chia sẻ mã này với bất kỳ ai, kể cả người tự xưng là nhân viên Anta.\n\n'
      + 'Nếu bạn không yêu cầu mã này, hãy bỏ qua email.',
  };
}
/** Data the app turns into its own notification; urgent, and dropped by FCM once the code has expired. */
export function devPushMessage(token: string, message: OtpMessage): TokenMessage {
  return { token, data: { type: 'otp', code: message.code, purpose: message.purpose }, android: { priority: 'high', ttl: 300000 } };
}
export function smtpTransport(smtp: NonNullable<Config['smtp']>): OtpTransports['email'] {
  const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 10000, socketTimeout: 10000 });
  return async (to, subject, text) => { await transport.sendMail({ from: smtp.from, to, subject, text }); };
}
/** Twilio Programmable Messaging REST API; `from` is a sender number or a `MG...` messaging service SID. */
export function twilioTransport(twilio: NonNullable<Config['twilio']>, http: typeof fetch = fetch): OtpTransports['sms'] {
  return async (to, text) => {
    const form = new URLSearchParams({ To: to, Body: text });
    form.set(twilio.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', twilio.from);
    const response = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Basic ${Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64')}` } });
    if (!response.ok) throw new Error(`Twilio HTTP ${response.status}`);
  };
}
export function firebasePushTransport(): NonNullable<OtpTransports['push']> {
  return async (token, message) => { await messaging().send(devPushMessage(token, message)); };
}
export function transportsFor(config: Config): OtpTransports {
  const provider = config.otpDelivery === 'provider';
  return { email: provider && config.smtp ? smtpTransport(config.smtp) : undefined,
    sms: provider && config.twilio ? twilioTransport(config.twilio) : undefined,
    push: config.devOtpPush ? firebasePushTransport() : undefined };
}
/** Sends the code over the channel implied by the identifier. Never logs the code or the recipient. */
export async function deliverOtp(transports: OtpTransports, message: OtpMessage): Promise<OtpChannel> {
  const channel = channelOf(message.identifier);
  let send: (() => Promise<void>) | undefined;
  if (channel === 'email' && transports.email) {
    const { subject, text } = otpEmail(message);
    send = () => transports.email!(message.identifier, subject, text);
  } else if (channel === 'sms' && transports.sms) {
    send = () => transports.sms!(message.identifier, otpText(message));
  }
  if (!send) throw new ApiError('OTP_CHANNEL_UNAVAILABLE', `Verification by ${channel} is not available`, 503);
  try { await send(); }
  catch { throw new ApiError('OTP_DELIVERY_FAILED', 'Could not send the verification code. Try again later.', 503); }
  return channel;
}
