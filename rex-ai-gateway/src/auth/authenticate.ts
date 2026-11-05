import type { IncomingMessage } from 'node:http';

import { bearerMatches } from '../http/bearer-auth';
import { allowedRequestOrigin } from '../http/cors';
import { readSessionCookie } from './read-session-cookie';
import type { MemberPrincipal, TwentyCredential } from './types';
import { verifyMemberCredential } from './whoami';

export type AuthenticateContext = {
  bearerToken?: string;
  allowedOrigins: ReadonlySet<string>;
};

export type Authenticator = {
  authenticate: (
    request: IncomingMessage,
    context: AuthenticateContext,
  ) => Promise<MemberPrincipal | undefined>;
};

const MOCK_MEMBER_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MOCK_MEMBER_BEARER = /^Bearer member:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;

export function createMockAuthenticator(): Authenticator {
  return {
    async authenticate(request, context) {
      const serviceCredential = readServiceCredential(request, context.bearerToken);

      if (context.bearerToken) {
        if (!bearerMatches(headerValue(request.headers.authorization), context.bearerToken)) {
          return mockFromSession(request, context);
        }

        return serviceCredential ? mockPrincipal(serviceCredential.email, serviceCredential.credential) : undefined;
      }

      const sessionPrincipal = mockFromSession(request, context);

      if (sessionPrincipal) {
        return sessionPrincipal;
      }

      const email = headerValue(request.headers['x-rex-member'])?.trim() ?? '';

      if (!MOCK_MEMBER_EMAIL.test(email) || email.length > 80) {
        return undefined;
      }

      return mockPrincipal(email, { kind: 'bearer', token: `mock:${email}` });
    },
  };
}

export function createTwentyAuthenticator(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Authenticator {
  return {
    async authenticate(request, context) {
      const credential = selectTwentyCredential(request, context);

      if (!credential) {
        return undefined;
      }

      const verified = await verifyMemberCredential(apiUrl, credential, fetchImpl);

      if (!verified) {
        return undefined;
      }

      return { ...verified, credential };
    },
  };
}

function selectTwentyCredential(
  request: IncomingMessage,
  context: AuthenticateContext,
): TwentyCredential | undefined {
  const gatewayAuthorization = headerValue(request.headers.authorization);

  if (context.bearerToken && bearerMatches(gatewayAuthorization, context.bearerToken)) {
    return readTwentyBearer(headerValue(request.headers['x-twenty-authorization']));
  }

  if (context.bearerToken && gatewayAuthorization) {
    return undefined;
  }

  return sessionCredential(request, context);
}

function readServiceCredential(
  request: IncomingMessage,
  bearerToken: string | undefined,
): { email: string; credential: TwentyCredential } | undefined {
  if (!bearerToken || !bearerMatches(headerValue(request.headers.authorization), bearerToken)) {
    return undefined;
  }

  const match = MOCK_MEMBER_BEARER.exec(headerValue(request.headers['x-twenty-authorization']) ?? '');
  const email = match?.[1];

  if (!email) {
    return undefined;
  }

  return {
    email,
    credential: { kind: 'bearer', token: `mock:${email}` },
  };
}

function mockFromSession(
  request: IncomingMessage,
  context: AuthenticateContext,
): MemberPrincipal | undefined {
  const credential = sessionCredential(request, context);

  if (!credential) {
    return undefined;
  }

  return mockPrincipal('member@example', credential);
}

function sessionCredential(
  request: IncomingMessage,
  context: AuthenticateContext,
): TwentyCredential | undefined {
  const origin = allowedRequestOrigin(headerValue(request.headers.origin), context.allowedOrigins);
  const session = readSessionCookie(headerValue(request.headers.cookie));

  if (!origin || !session) {
    return undefined;
  }

  return {
    kind: 'session',
    cookieName: session.cookieName,
    sessionToken: session.sessionToken,
    origin,
  };
}

function readTwentyBearer(header: string | undefined): TwentyCredential | undefined {
  const match = /^Bearer (\S+)$/.exec(header?.trim() ?? '');
  const token = match?.[1];

  if (!token || token.startsWith('sess_') || token.length < 20 || token.length > 4000) {
    return undefined;
  }

  return { kind: 'bearer', token };
}

function mockPrincipal(email: string, credential: TwentyCredential): MemberPrincipal {
  return {
    memberId: `member_${email}`,
    userId: `user_${email}`,
    email,
    twentyWorkspaceId: 'workspace_demo',
    actor: email,
    credential,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
