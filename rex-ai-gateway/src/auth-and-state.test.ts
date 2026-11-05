import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { createTwentyAuthenticator } from './auth/authenticate';
import { readSessionCookie } from './auth/read-session-cookie';
import { openGatewayState } from './state/sqlite-state';

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();

    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('signed-in member auth', () => {
  it('verifies the session cookie with Twenty and ignores a client actor header', async () => {
    const authenticator = createTwentyAuthenticator('http://twenty.test', async (url, init) => {
      expect(String(url)).toBe('http://twenty.test/metadata');
      const headers = new Headers(init?.headers);
      expect(headers.get('cookie')).toBe('twenty-session=sess_member_token');
      expect(headers.get('origin')).toBe('http://localhost:3001');
      expect(headers.get('authorization')).toBeNull();

      return new Response(
        JSON.stringify({
          data: {
            currentUser: {
              id: 'user_1',
              email: 'ada@analytical.example',
              workspaceMember: { id: '2f4a1c0e-6b7d-4e8f-9a10-111213141516' },
            },
            currentWorkspace: { id: 'workspace_1' },
          },
        }),
      );
    });

    const principal = await authenticator.authenticate(
      {
        headers: {
          cookie: 'twenty-session=sess_member_token',
          origin: 'http://localhost:3001',
          'x-rex-actor': 'spoofed@evil.example',
        },
      } as never,
      { allowedOrigins: new Set(['http://localhost:3001']) },
    );

    expect(principal).toMatchObject({
      actor: 'ada@analytical.example',
      memberId: '2f4a1c0e-6b7d-4e8f-9a10-111213141516',
      twentyWorkspaceId: 'workspace_1',
    });
  });

  it('keeps the service bearer separate from the member token', async () => {
    const authenticator = createTwentyAuthenticator('http://twenty.test', async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer member-access-token-value');
      expect(new Headers(init?.headers).get('cookie')).toBeNull();

      return new Response(
        JSON.stringify({
          data: {
            currentUser: {
              id: 'user_2',
              email: 'grace@analytical.example',
              workspaceMember: { id: '3f4a1c0e-6b7d-4e8f-9a10-111213141516' },
            },
            currentWorkspace: { id: 'workspace_1' },
          },
        }),
      );
    });

    const missingMember = await authenticator.authenticate(
      { headers: { authorization: 'Bearer gateway-token' } } as never,
      { bearerToken: 'gateway-token', allowedOrigins: new Set() },
    );
    const principal = await authenticator.authenticate(
      {
        headers: {
          authorization: 'Bearer gateway-token',
          'x-twenty-authorization': 'Bearer member-access-token-value',
          'x-rex-actor': 'spoofed@evil.example',
        },
      } as never,
      { bearerToken: 'gateway-token', allowedOrigins: new Set() },
    );

    expect(missingMember).toBeUndefined();
    expect(principal?.actor).toBe('grace@analytical.example');
    expect(principal?.credential).toEqual({
      kind: 'bearer',
      token: 'member-access-token-value',
    });
  });

  it('rejects a session token presented as the service bearer', async () => {
    const authenticator = createTwentyAuthenticator('http://twenty.test', async () => {
      throw new Error('Twenty should not be called');
    });
    const principal = await authenticator.authenticate(
      {
        headers: {
          authorization: 'Bearer gateway-token',
          'x-twenty-authorization': 'Bearer SESS_member_token_value',
        },
      } as never,
      { bearerToken: 'gateway-token', allowedOrigins: new Set() },
    );

    expect(principal).toBeUndefined();
  });

  it('rejects a whoami payload that is not a member identity', async () => {
    const authenticator = createTwentyAuthenticator('http://twenty.test', async () => {
      return new Response(
        JSON.stringify({
          data: {
            currentUser: {
              id: 'user_1',
              email: 'ada@analytical.example\ncc:evil@example',
              workspaceMember: { id: 'not-a-uuid' },
            },
            currentWorkspace: { id: 'workspace_1' },
          },
        }),
      );
    });
    const principal = await authenticator.authenticate(
      {
        headers: {
          cookie: 'twenty-session=sess_member_token',
          origin: 'http://localhost:3001',
        },
      } as never,
      { allowedOrigins: new Set(['http://localhost:3001']) },
    );

    expect(principal).toBeUndefined();
  });
});

describe('session cookie', () => {
  it('forwards one raw token and rejects tossed or encoded cookies', () => {
    expect(
      readSessionCookie('twenty-session=sess_member_token', 'http://localhost:3001'),
    ).toEqual({
      cookieName: 'twenty-session',
      sessionToken: 'sess_member_token',
    });
    expect(
      readSessionCookie(
        'twenty-session=sess_attacker_token; twenty-session=sess_member_token',
        'http://localhost:3001',
      ),
    ).toBeUndefined();
    expect(
      readSessionCookie('twenty-session=sess_member%0d%0aX-Injected:%20yes', 'http://localhost:3001'),
    ).toBeUndefined();
    expect(
      readSessionCookie('twenty-session=sess_member_token', 'https://crm.example'),
    ).toBeUndefined();
    expect(
      readSessionCookie('__Host-twenty-session=sess_member_token', 'https://crm.example'),
    ).toEqual({
      cookieName: '__Host-twenty-session',
      sessionToken: 'sess_member_token',
    });
  });
});

describe('gateway state', () => {
  it('keeps previews, idempotency, and audit after the process reopens the file', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rex-ai-state-'));
    directories.push(directory);
    const filename = path.join(directory, 'gateway-state.sqlite');
    const first = openGatewayState(filename);
    const proposal = first.proposals.save('member_ada', 'ws_demo', [
      { name: 'create_company', args: { name: 'Analytical Engines' } },
    ]);
    first.audit.record({
      memberId: 'member_ada',
      actor: 'ada@analytical.example',
      action: 'tools',
      summary: 'tools denied',
      tools: [],
      recordIds: [],
      ok: false,
      reason: 'unauthorized',
    });
    let writes = 0;
    await first.idempotency.run('member_ada', 'demo-key-1', '{"ok":true}', async () => {
      writes += 1;
      return { status: 200, body: { ok: true } };
    });
    first.close();

    const second = openGatewayState(filename);
    const otherMember = second.proposals.claim(proposal?.id ?? '', 'ws_demo', 'member_other');
    const claimed = second.proposals.claim(proposal?.id ?? '', 'ws_demo', 'member_ada');
    const replay = await second.idempotency.run('member_ada', 'demo-key-1', '{"ok":true}', async () => {
      writes += 1;
      return { status: 500, body: { ok: false } };
    });

    expect(claimed.ok).toBe(true);
    expect(otherMember).toEqual({ ok: false, reason: 'missing' });
    expect(second.audit.list('member_ada')).toEqual([
      expect.objectContaining({ action: 'tools', actor: 'ada@analytical.example' }),
    ]);
    expect(replay).toMatchObject({ replayed: true, response: { status: 200 } });
    expect(writes).toBe(1);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    second.close();
  });

  it('drops a preview whose stored tools are not JSON', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rex-ai-state-'));
    directories.push(directory);
    const filename = path.join(directory, 'gateway-state.sqlite');
    const first = openGatewayState(filename);
    const proposal = first.proposals.save('member_ada', 'ws_demo', [
      { name: 'create_company', args: { name: 'Analytical Engines' } },
    ]);
    first.close();

    const proposalId = proposal?.id;

    if (!proposalId) {
      throw new Error('Expected a stored preview id.');
    }

    const raw = new DatabaseSync(filename);
    raw.prepare('UPDATE proposals SET tools_json = ? WHERE id = ?').run('{', proposalId);
    raw.close();

    const second = openGatewayState(filename);

    expect(second.proposals.claim(proposalId, 'ws_demo', 'member_ada')).toEqual({
      ok: false,
      reason: 'missing',
    });
    second.close();
  });
});
