import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

/** Firebase Cloud Messaging, signed in with the service-account file that GOOGLE_APPLICATION_CREDENTIALS names. */
export function messaging() {
  if (!getApps().length) initializeApp({ credential: applicationDefault() });
  return getMessaging();
}
