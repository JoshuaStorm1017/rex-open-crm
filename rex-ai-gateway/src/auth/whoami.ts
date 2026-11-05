import { isRecord } from '../is-record';
import { twentyAuthHeaders } from './call-context';
import type { MemberPrincipal, TwentyCredential } from './types';

const WHOAMI_QUERY = `query RexAiWhoami {
  currentUser { id email workspaceMember { id } }
  currentWorkspace { id }
}`;

export async function verifyMemberCredential(
  apiUrl: string,
  credential: TwentyCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<Omit<MemberPrincipal, 'credential'> | undefined> {
  let response: Response;

  try {
    response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/metadata`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...twentyAuthHeaders(credential),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: WHOAMI_QUERY }),
    });
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

  if (!email || !userId || !memberId || !twentyWorkspaceId) {
    return undefined;
  }

  return {
    memberId,
    userId,
    email: email.slice(0, 80),
    twentyWorkspaceId,
    actor: email.slice(0, 80),
  };
}
