import nodemailer from 'nodemailer';
import { Config } from '../../packages/config';
import { ApiError } from '../../packages/contracts/errors';

export type OtpChannel = 'email' | 'sms';
export interface OtpMessage { identifier: string; code: string; purpose: 'register' | 'reset-password' }
export interface OtpTransports {
  email?: (to: string, subject: string, text: string) => Promise<void>;
  sms?: (to: string, text: string) => Promise<void>;
}
export const channelOf = (identifier: string): OtpChannel => identifier.includes('@') ? 'email' : 'sms';
export function otpText(message: OtpMessage) {
  const action = message.purpose === 'register' ? 'dang ky tai khoan' : 'dat lai mat khau';
  // ASCII only: Vietnamese diacritics force UCS-2 SMS and triple the segment cost.
  return `Ma xac thuc ${action} cua ban la ${message.code}. Ma het han sau 5 phut. Khong chia se ma nay voi bat ky ai.`;
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
export function transportsFor(config: Config): OtpTransports {
  return { email: config.smtp ? smtpTransport(config.smtp) : undefined, sms: config.twilio ? twilioTransport(config.twilio) : undefined };
}
/** Sends the code over the channel implied by the identifier. Never logs the code or the recipient. */
export async function deliverOtp(transports: OtpTransports, message: OtpMessage): Promise<OtpChannel> {
  const channel = channelOf(message.identifier), text = otpText(message);
  const send = channel === 'email' ? transports.email && ((): Promise<void> => transports.email!(message.identifier, 'Ma xac thuc cua ban', text))
    : transports.sms && ((): Promise<void> => transports.sms!(message.identifier, text));
  if (!send) throw new ApiError('OTP_CHANNEL_UNAVAILABLE', `Verification by ${channel} is not available`, 503);
  try { await send(); }
  catch { throw new ApiError('OTP_DELIVERY_FAILED', 'Could not send the verification code. Try again later.', 503); }
  return channel;
}
