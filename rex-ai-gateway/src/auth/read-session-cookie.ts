import type { SessionCookieName } from './types';

const SESSION_COOKIE_NAMES: SessionCookieName[] = [
  '__Host-twenty-session',
  'twenty-session',
];

// base64url after sess_, matching Twenty's randomBytes(32) tokens, and the shorter test tokens.
const SESSION_TOKEN_PATTERN = /^sess_[A-Za-z0-9_-]{8,128}$/;

export type SessionCookie = {
  cookieName: SessionCookieName;
  sessionToken: string;
};

export function readSessionCookie(
  cookieHeader: string | undefined,
  origin?: string,
): SessionCookie | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const parts = cookieHeader.split(';').map((part) => part.trim()).filter((part) => part.length > 0);
  // On https, Twenty ignores the plain cookie so a sibling host cannot fixate a session.
  const cookieNames =
    origin?.startsWith('https://') === true
      ? SESSION_COOKIE_NAMES.filter((cookieName) => cookieName === '__Host-twenty-session')
      : SESSION_COOKIE_NAMES;

  for (const cookieName of cookieNames) {
    const matches = parts.filter((part) => part.startsWith(`${cookieName}=`));

    if (matches.length === 0) {
      continue;
    }

    // A second value is a tossed cookie. Browsers send the longer path first.
    if (matches.length !== 1) {
      return undefined;
    }

    const sessionToken = matches[0]?.slice(cookieName.length + 1) ?? '';

    // Twenty compares the raw cookie. Decoding would accept a different session than the jar holds.
    if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
      return undefined;
    }

    return { cookieName, sessionToken };
  }

  return undefined;
}
