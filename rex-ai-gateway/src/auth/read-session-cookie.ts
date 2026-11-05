import type { SessionCookieName } from './types';

const SESSION_COOKIE_NAMES: SessionCookieName[] = [
  '__Host-twenty-session',
  'twenty-session',
];

export type SessionCookie = {
  cookieName: SessionCookieName;
  sessionToken: string;
};

export function readSessionCookie(cookieHeader: string | undefined): SessionCookie | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const parts = cookieHeader.split(';').map((part) => part.trim());

  for (const cookieName of SESSION_COOKIE_NAMES) {
    const match = parts.find((part) => part.startsWith(`${cookieName}=`));

    if (!match) {
      continue;
    }

    const raw = match.slice(cookieName.length + 1);

    let sessionToken: string;

    try {
      sessionToken = decodeURIComponent(raw);
    } catch {
      return undefined;
    }

    if (!sessionToken.startsWith('sess_') || sessionToken.length < 10 || sessionToken.length > 200) {
      return undefined;
    }

    return { cookieName, sessionToken };
  }

  return undefined;
}
