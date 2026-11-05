import { fetchWithPinnedDns } from '../http/pinned-fetch';
import { isRecord } from '../is-record';
import { twentyAuthHeaders } from './call-context';
import type { MemberPrincipal, TwentyCredential } from './types';

const WHOAMI_QUERY = `query RexAiWhoami {
  currentUser { id email workspaceMember { id } }
  currentWorkspace { id }
}`;

const MEMBER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ACTOR_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function verifyMemberCredential(
  apiUrl: string,
  credential: TwentyCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<MemberPrincipal, 'credential'> | undefined> {
  let response: Response;

  try {
    response = await fetchWithPinnedDns(
      `${apiUrl.replace(/\/+$/, '')}/metadata`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...twentyAuthHeaders(credential),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: WHOAMI_QUERY }),
        signal: AbortSignal.timeout(10_000),
      },
      fetchImpl,
      'TWENTY_API_URL',
    );
  } catch {
    return undefined;
  }

  if (!response.ok) {
    return undefined;
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return undefined;
  }

  if (!isRecord(body) || !isRecord(body.data)) {
    return undefined;
  }

  const currentUser = body.data.currentUser;
  const currentWorkspace = body.data.currentWorkspace;

  if (!isRecord(currentUser) || !isRecord(currentWorkspace)) {
    return undefined;
  }

  const workspaceMember = currentUser.workspaceMember;
  const email = typeof currentUser.email === 'string' ? currentUser.email.trim() : '';
  const userId = typeof currentUser.id === 'string' ? currentUser.id : '';
  const memberId =
    isRecord(workspaceMember) && typeof workspaceMember.id === 'string'
      ? workspaceMember.id
      : '';
  const twentyWorkspaceId =
    typeof currentWorkspace.id === 'string' ? currentWorkspace.id : '';

  if (
    !ACTOR_EMAIL_PATTERN.test(email) ||
    email.length > 254 ||
    !SAFE_ID_PATTERN.test(userId) ||
    !MEMBER_ID_PATTERN.test(memberId) ||
    !SAFE_ID_PATTERN.test(twentyWorkspaceId)
  ) {
    return undefined;
  }

  return {
    memberId,
    userId,
    email,
    twentyWorkspaceId,
    actor: email,
  };
}
