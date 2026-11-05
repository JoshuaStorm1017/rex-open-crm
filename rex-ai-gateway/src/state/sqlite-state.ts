import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PendingChoice } from '../act/pending-choice';
import type { ToolCall } from '../act/types';
import { AuditLog, type AuditEntry } from '../audit/audit-log';
import { IdempotencyStore, type IdempotentResponse } from '../http/idempotency-store';
import { ProposalStore, type ClaimResult, type StoredProposal } from '../http/proposal-store';

export type GatewayState = {
  proposals: ProposalStore;
  idempotency: IdempotencyStore;
  audit: AuditLog;
  close: () => void;
};

const MAX_AUDIT_ROWS = 500;

export function openGatewayState(filename: string): GatewayState {
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true });
  }

  const database = new DatabaseSync(filename);
  restrictStateFiles(filename);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      pending_choice_json TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency (
      member_id TEXT NOT NULL,
      key TEXT NOT NULL,
      hash TEXT NOT NULL,
      status INTEGER NOT NULL,
      body_json TEXT NOT NULL,
      PRIMARY KEY (member_id, key)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      member_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      workspace_id TEXT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      record_ids_json TEXT NOT NULL,
      ok INTEGER NOT NULL,
      confirmed INTEGER,
      reason TEXT,
      replayed INTEGER NOT NULL
    );
  `);

  return {
    proposals: new SqliteProposalStore(database, () => restrictStateFiles(filename)),
    idempotency: new SqliteIdempotencyStore(database, () => restrictStateFiles(filename)),
    audit: new SqliteAuditLog(database, () => restrictStateFiles(filename)),
    close: () => {
      database.close();
      restrictStateFiles(filename);
    },
  };
}

class SqliteProposalStore extends ProposalStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly restrict: () => void,
  ) {
    super();
  }

  override save(
    memberId: string,
    workspaceId: string,
    tools: ToolCall[],
    pendingChoice?: PendingChoice,
    now = Date.now(),
  ): StoredProposal | undefined {
    this.database
      .prepare('DELETE FROM proposals WHERE expires_at <= ?')
      .run(now);
    const count = this.database.prepare('SELECT COUNT(*) AS count FROM proposals').get() as
      | { count: number }
      | undefined;

    if ((count?.count ?? 0) >= 200) {
      return undefined;
    }

    const proposal = this.createProposal(memberId, workspaceId, tools, pendingChoice, now);
    this.database
      .prepare(
        `INSERT INTO proposals (id, member_id, workspace_id, tools_json, pending_choice_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.memberId,
        proposal.workspaceId,
        JSON.stringify(proposal.tools),
        proposal.pendingChoice ? JSON.stringify(proposal.pendingChoice) : null,
        proposal.expiresAt,
      );
    this.restrict();

    return proposal;
  }

  override claim(
    id: string,
    workspaceId: string,
    memberId: string,
    choiceId?: string,
    now = Date.now(),
  ): ClaimResult {
    const row = this.database
      .prepare(
        `SELECT member_id, workspace_id, tools_json, pending_choice_json, expires_at
         FROM proposals WHERE id = ?`,
      )
      .get(id) as
      | {
          member_id: string;
          workspace_id: string;
          tools_json: string;
          pending_choice_json: string | null;
          expires_at: number;
        }
      | undefined;

    if (!row || row.member_id !== memberId) {
      return { ok: false, reason: 'missing' };
    }

    if (row.expires_at <= now) {
      this.database.prepare('DELETE FROM proposals WHERE id = ?').run(id);
      return { ok: false, reason: 'expired' };
    }

    if (row.workspace_id !== workspaceId) {
      return { ok: false, reason: 'workspace' };
    }

    let proposal: StoredProposal;

    try {
      proposal = this.proposalFromRow(id, row);
    } catch {
      this.database.prepare('DELETE FROM proposals WHERE id = ?').run(id);
      return { ok: false, reason: 'missing' };
    }

    const claimed = this.claimStored(proposal, choiceId);

    if (!claimed.ok && claimed.reason === 'choice') {
      return claimed;
    }

    this.database.prepare('DELETE FROM proposals WHERE id = ?').run(id);
    return claimed;
  }

  private proposalFromRow(
    id: string,
    row: {
      member_id: string;
      workspace_id: string;
      tools_json: string;
      pending_choice_json: string | null;
      expires_at: number;
    },
  ): StoredProposal {
    const tools = JSON.parse(row.tools_json) as unknown;

    if (!Array.isArray(tools)) {
      throw new Error('Stored preview tools are not an array.');
    }

    const pendingChoice = row.pending_choice_json
      ? (JSON.parse(row.pending_choice_json) as PendingChoice)
      : undefined;

    return {
      id,
      memberId: row.member_id,
      workspaceId: row.workspace_id,
      tools: tools as ToolCall[],
      ...(pendingChoice ? { pendingChoice } : {}),
      expiresAt: row.expires_at,
    };
  }
}

class SqliteIdempotencyStore extends IdempotencyStore {
  constructor(
    database: DatabaseSync,
    private readonly restrict: () => void,
    capacity = 500,
  ) {
    super(capacity);
    this.database = database;
  }

  private readonly database: DatabaseSync;

  protected override readCompleted(
    memberId: string,
    key: string,
  ): { hash: string; response: IdempotentResponse } | undefined {
    const row = this.database
      .prepare(
        'SELECT hash, status, body_json FROM idempotency WHERE member_id = ? AND key = ?',
      )
      .get(memberId, key) as { hash: string; status: number; body_json: string } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      hash: row.hash,
      response: { status: row.status, body: JSON.parse(row.body_json) as unknown },
    };
  }

  protected override countCompleted(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM idempotency').get() as
      | { count: number }
      | undefined;

    return row?.count ?? 0;
  }

  protected override writeCompleted(
    memberId: string,
    key: string,
    hash: string,
    response: IdempotentResponse,
  ): void {
    this.database
      .prepare(
        `INSERT INTO idempotency (member_id, key, hash, status, body_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memberId, key, hash, response.status, JSON.stringify(response.body));
    this.restrict();
  }
}

class SqliteAuditLog extends AuditLog {
  constructor(
    private readonly database: DatabaseSync,
    private readonly restrict: () => void,
  ) {
    super();
  }

  override record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const stored = super.record(entry);
    this.database
      .prepare(
        `INSERT INTO audit_log (
           id, at, member_id, actor, workspace_id, action, summary, tools_json,
           record_ids_json, ok, confirmed, reason, replayed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.id,
        stored.at,
        stored.memberId,
        stored.actor,
        stored.workspaceId ?? null,
        stored.action,
        stored.summary,
        JSON.stringify(stored.tools),
        JSON.stringify(stored.recordIds),
        stored.ok ? 1 : 0,
        stored.confirmed === undefined ? null : stored.confirmed ? 1 : 0,
        stored.reason ?? null,
        stored.replayed ? 1 : 0,
      );
    this.database
      .prepare(
        `DELETE FROM audit_log WHERE id NOT IN (
           SELECT id FROM audit_log ORDER BY at DESC LIMIT ?
         )`,
      )
      .run(MAX_AUDIT_ROWS);
    this.restrict();

    return stored;
  }

  override list(memberId: string): AuditEntry[] {
    const rows = this.database
      .prepare(
        `SELECT id, at, member_id, actor, workspace_id, action, summary, tools_json,
                record_ids_json, ok, confirmed, reason, replayed
         FROM audit_log WHERE member_id = ? ORDER BY at ASC`,
      )
      .all(memberId) as Array<Record<string, unknown>>;

    return rows.map(readAuditRow);
  }
}

function restrictStateFiles(filename: string): void {
  if (filename === ':memory:') {
    return;
  }

  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (existsSync(candidate)) {
      chmodSync(candidate, 0o600);
    }
  }
}

function readJsonStringArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));

    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function readAuditRow(row: Record<string, unknown>): AuditEntry {
  return {
    id: String(row.id),
    at: String(row.at),
    memberId: String(row.member_id),
    actor: String(row.actor),
    ...(typeof row.workspace_id === 'string' ? { workspaceId: row.workspace_id } : {}),
    action: row.action as AuditEntry['action'],
    summary: String(row.summary),
    tools: readJsonStringArray(row.tools_json),
    recordIds: readJsonStringArray(row.record_ids_json),
    ok: row.ok === 1,
    ...(row.confirmed === null || row.confirmed === undefined
      ? {}
      : { confirmed: row.confirmed === 1 }),
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
    ...(row.replayed === 1 ? { replayed: true } : {}),
  };
}
