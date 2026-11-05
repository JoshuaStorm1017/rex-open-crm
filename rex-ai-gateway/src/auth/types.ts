export type SessionCookieName = 'twenty-session' | '__Host-twenty-session';

export type TwentyCredential =
  | {
      kind: 'session';
      cookieName: SessionCookieName;
      sessionToken: string;
      origin: string;
    }
  | { kind: 'bearer'; token: string };

export type MemberPrincipal = {
  memberId: string;
  userId: string;
  email: string;
  twentyWorkspaceId: string;
  actor: string;
  credential: TwentyCredential;
};
