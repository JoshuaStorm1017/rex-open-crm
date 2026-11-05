import { AsyncLocalStorage } from 'node:async_hooks';

import type { TwentyCredential } from './types';

const credentialStore = new AsyncLocalStorage<TwentyCredential>();

export function withMemberCredential<TResult>(
  credential: TwentyCredential,
  run: () => Promise<TResult>,
): Promise<TResult> {
  return credentialStore.run(credential, run);
}

export function currentTwentyCredential(): TwentyCredential {
  const credential = credentialStore.getStore();

  if (!credential) {
    throw new Error('No signed-in Twenty credential for this request.');
  }

  return credential;
}

export function twentyAuthHeaders(credential: TwentyCredential): Record<string, string> {
  if (credential.kind === 'bearer') {
    return { authorization: `Bearer ${credential.token}` };
  }

  return {
    cookie: `${credential.cookieName}=${credential.sessionToken}`,
    origin: credential.origin,
  };
}
