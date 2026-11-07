import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { redactValue } from './redact';
import type {
  ApprovalRecord,
  ArtifactRecord,
  AttemptRecord,
  EffectRecord,
  EffectRequest,
  EffectRole,
  EffectStatus,
  OutboxRecord,
  PipelineState,
  RunConfig,
  RunRecord,
  StateVersionRecord,
  StoredEvent,
  TaskContext,
  TaskContract,
} from './types';

type RunRow = {
  id: string;
  state: PipelineState;
  version: number;
  config_json: string;
  contract_json: string | null;
  context_id: string | null;
  head_sha: string | null;
  writer_external_id: string | null;
  repair_attempts: number;
  agent_runs: number;
  active_ms: number;
  last_tick_at: number;
  paused_from: PipelineState | null;
  block_reason: string | null;
  fail_reason: string | null;
  paused_reason: string | null;
  created_at: number;
  updated_at: number;
};

export class PipelineStore {
  private readonly database: DatabaseSync;

  constructor(private readonly filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true });
    }

    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        version INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        contract_json TEXT,
        context_id TEXT,
        head_sha TEXT,
        writer_external_id TEXT,
        repair_attempts INTEGER NOT NULL,
        agent_runs INTEGER NOT NULL,
        active_ms INTEGER NOT NULL,
        last_tick_at INTEGER NOT NULL,
        paused_from TEXT,
        block_reason TEXT,
        fail_reason TEXT,
        paused_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_versions (
        run_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (run_id, version)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effects (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        client_token TEXT NOT NULL,
        external_id TEXT,
        attempt INTEGER NOT NULL,
        delivery_attempted INTEGER NOT NULL,
        terminal INTEGER NOT NULL,
        counted INTEGER NOT NULL,
        request_json TEXT NOT NULL,
        outcome_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        effect_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        commit_sha TEXT,
        context_id TEXT,
        context_version INTEGER,
        payload_json TEXT NOT NULL,
        stale INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        approver_id TEXT NOT NULL,
        effect TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        n INTEGER NOT NULL,
        effect_id TEXT NOT NULL,
        commit_sha TEXT,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (run_id, kind, n)
      );
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        invalidated_at INTEGER,
        invalidation_reason TEXT,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS inbox (
        event_id TEXT PRIMARY KEY,
        effect_id TEXT,
        client_token TEXT,
        payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
    `);
    this.restrict();
  }

  transaction<T>(body: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const result = body();
      this.database.exec('COMMIT');
      this.restrict();
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  insertRun(run: RunRecord): void {
    this.database
      .prepare(
        `INSERT INTO runs (
          id, state, version, config_json, contract_json, context_id, head_sha,
          writer_external_id, repair_attempts, agent_runs, active_ms, last_tick_at,
          paused_from, block_reason, fail_reason, paused_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.state,
        run.version,
        persist(run.config),
        run.contract ? persist(run.contract) : null,
        run.contextId,
        run.headSha,
        run.writerExternalId,
        run.repairAttempts,
        run.agentRuns,
        run.activeMs,
        run.lastTickAt,
        run.pausedFrom,
        run.blockReason,
        run.failReason,
        run.pausedReason,
        run.createdAt,
        run.updatedAt,
      );
  }

  saveRun(run: RunRecord): void {
    this.database
      .prepare(
        `UPDATE runs SET
          state = ?, version = ?, config_json = ?, contract_json = ?, context_id = ?,
          head_sha = ?, writer_external_id = ?, repair_attempts = ?, agent_runs = ?,
          active_ms = ?, last_tick_at = ?, paused_from = ?, block_reason = ?,
          fail_reason = ?, paused_reason = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        run.state,
        run.version,
        persist(run.config),
        run.contract ? persist(run.contract) : null,
        run.contextId,
        run.headSha,
        run.writerExternalId,
        run.repairAttempts,
        run.agentRuns,
        run.activeMs,
        run.lastTickAt,
        run.pausedFrom,
        run.blockReason,
        run.failReason,
        run.pausedReason,
        run.updatedAt,
        run.id,
      );
  }

  loadRun(id: string): RunRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(id) as RunRow | undefined;

    return row ? mapRun(row) : undefined;
  }

  appendVersion(record: StateVersionRecord): void {
    this.database
      .prepare(
        `INSERT INTO state_versions (run_id, version, state, reason, at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.version,
        record.state,
        record.reason,
        record.at,
      );
  }

  listVersions(runId: string): StateVersionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT run_id, version, state, reason, at
         FROM state_versions WHERE run_id = ? ORDER BY version`,
      )
      .all(runId) as Array<{
      run_id: string;
      version: number;
      state: PipelineState;
      reason: string;
      at: number;
    }>;

    return rows.map((row) => ({
      runId: row.run_id,
      version: row.version,
      state: row.state,
      reason: row.reason,
      at: row.at,
    }));
  }

  findEvent(id: string): StoredEvent | undefined {
    const row = this.database
      .prepare('SELECT * FROM events WHERE id = ?')
      .get(id) as EventRow | undefined;

    return row ? mapEvent(row) : undefined;
  }

  insertEvent(event: StoredEvent): void {
    this.database
      .prepare(
        `INSERT INTO events (id, run_id, type, payload_json, status, result_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.runId,
        event.type,
        persist(event.payload),
        event.status,
        persist(event.result),
        event.receivedAt,
      );
  }

  insertEffect(effect: EffectRecord): void {
    this.database
      .prepare(
        `INSERT INTO effects (
          id, run_id, kind, role, status, client_token, external_id, attempt,
          delivery_attempted, terminal, counted, request_json, outcome_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        effect.id,
        effect.runId,
        effect.kind,
        effect.role,
        effect.status,
        effect.clientToken,
        effect.externalId,
        effect.attempt,
        effect.deliveryAttempted ? 1 : 0,
        effect.terminal ? 1 : 0,
        effect.counted ? 1 : 0,
        persist(effect.request),
        effect.outcome === undefined ? null : persist(effect.outcome),
        effect.createdAt,
      );
  }

  saveEffect(effect: EffectRecord): void {
    this.database
      .prepare(
        `UPDATE effects SET
          status = ?, external_id = ?, delivery_attempted = ?, terminal = ?,
          counted = ?, request_json = ?, outcome_json = ?
        WHERE id = ?`,
      )
      .run(
        effect.status,
        effect.externalId,
        effect.deliveryAttempted ? 1 : 0,
        effect.terminal ? 1 : 0,
        effect.counted ? 1 : 0,
        persist(effect.request),
        effect.outcome === undefined ? null : persist(effect.outcome),
        effect.id,
      );
  }

  findEffect(id: string): EffectRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM effects WHERE id = ?')
      .get(id) as EffectRow | undefined;

    return row ? mapEffect(row) : undefined;
  }

  findEffectByToken(clientToken: string): EffectRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM effects WHERE client_token = ?')
      .get(clientToken) as EffectRow | undefined;

    return row ? mapEffect(row) : undefined;
  }

  listEffects(runId: string): EffectRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM effects WHERE run_id = ? ORDER BY rowid')
      .all(runId) as EffectRow[];

    return rows.map((row) => mapEffect(row));
  }

  latestEffect(
    runId: string,
    kind?: EffectRecord['kind'],
  ): EffectRecord | undefined {
    const row = (
      kind
        ? this.database
            .prepare(
              `SELECT * FROM effects WHERE run_id = ? AND kind = ?
               ORDER BY rowid DESC LIMIT 1`,
            )
            .get(runId, kind)
        : this.database
            .prepare(
              `SELECT * FROM effects WHERE run_id = ?
               ORDER BY rowid DESC LIMIT 1`,
            )
            .get(runId)
    ) as EffectRow | undefined;

    return row ? mapEffect(row) : undefined;
  }

  openEffect(runId: string): EffectRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM effects WHERE run_id = ? AND terminal = 0
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runId) as EffectRow | undefined;

    return row ? mapEffect(row) : undefined;
  }

  insertOutbox(record: OutboxRecord): void {
    this.database
      .prepare(
        `INSERT INTO outbox (id, effect_id, status, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.effectId,
        record.status,
        record.result === undefined ? null : persist(record.result),
        record.createdAt,
      );
  }

  saveOutbox(record: OutboxRecord): void {
    this.database
      .prepare('UPDATE outbox SET status = ?, result_json = ? WHERE id = ?')
      .run(
        record.status,
        record.result === undefined ? null : persist(record.result),
        record.id,
      );
  }

  listOutbox(effectId: string): OutboxRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM outbox WHERE effect_id = ? ORDER BY rowid')
      .all(effectId) as OutboxRow[];

    return rows.map((row) => mapOutbox(row));
  }

  listRunOutbox(runId: string): OutboxRecord[] {
    const rows = this.database
      .prepare(
        `SELECT outbox.* FROM outbox
         JOIN effects ON effects.id = outbox.effect_id
         WHERE effects.run_id = ?
         ORDER BY outbox.rowid`,
      )
      .all(runId) as OutboxRow[];

    return rows.map((row) => mapOutbox(row));
  }

  insertArtifact(record: ArtifactRecord): void {
    this.database
      .prepare(
        `INSERT INTO artifacts (
          id, run_id, kind, commit_sha, context_id, context_version,
          payload_json, stale, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.kind,
        record.commitSha,
        record.contextId,
        record.contextVersion,
        persist(record.payload),
        record.stale ? 1 : 0,
        record.createdAt,
      );
  }

  markArtifactsStale(runId: string): void {
    this.database
      .prepare('UPDATE artifacts SET stale = 1 WHERE run_id = ?')
      .run(runId);
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY rowid')
      .all(runId) as ArtifactRow[];

    return rows.map((row) => mapArtifact(row));
  }

  insertApproval(record: ApprovalRecord): void {
    this.database
      .prepare(
        `INSERT INTO approvals (
          id, run_id, commit_sha, approver_id, effect, approved_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.commitSha,
        record.approverId,
        record.effect,
        record.approvedAt,
        record.expiresAt,
      );
  }

  listApprovals(runId: string): ApprovalRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY rowid')
      .all(runId) as ApprovalRow[];

    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      commitSha: row.commit_sha,
      approverId: row.approver_id,
      effect: 'guarded_merge',
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
    }));
  }

  insertAttempt(record: AttemptRecord): void {
    this.database
      .prepare(
        `INSERT INTO attempts (run_id, kind, n, effect_id, commit_sha, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.kind,
        record.n,
        record.effectId,
        record.commitSha,
        persist(record.detail),
      );
  }

  listAttempts(runId: string): AttemptRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid')
      .all(runId) as AttemptRow[];

    return rows.map((row) => ({
      runId: row.run_id,
      kind: row.kind,
      n: row.n,
      effectId: row.effect_id,
      commitSha: row.commit_sha,
      detail: parseJson(row.detail_json),
    }));
  }

  findReusableContext(contentHash: string): TaskContext | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM contexts
         WHERE content_hash = ? AND invalidated_at IS NULL
         ORDER BY version DESC LIMIT 1`,
      )
      .get(contentHash) as ContextRow | undefined;

    return row ? mapContext(row) : undefined;
  }

  latestContextByHash(contentHash: string): TaskContext | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM contexts WHERE content_hash = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(contentHash) as ContextRow | undefined;

    return row ? mapContext(row) : undefined;
  }

  loadContext(id: string, version: number): TaskContext | undefined {
    const row = this.database
      .prepare('SELECT * FROM contexts WHERE id = ? AND version = ?')
      .get(id, version) as ContextRow | undefined;

    return row ? mapContext(row) : undefined;
  }

  insertContext(context: TaskContext): void {
    this.database
      .prepare(
        `INSERT INTO contexts (
          id, version, content_hash, payload_json, invalidated_at, invalidation_reason
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        context.id,
        context.version,
        context.contentHash,
        persist(context),
        context.invalidatedAt,
        context.invalidationReason,
      );
  }

  invalidateContext(
    id: string,
    version: number,
    at: number,
    reason: string,
  ): void {
    const current = this.loadContext(id, version);

    if (!current) {
      return;
    }

    const invalidated: TaskContext = {
      ...current,
      invalidatedAt: at,
      invalidationReason: reason,
    };
    this.database
      .prepare(
        `UPDATE contexts
         SET invalidated_at = ?, invalidation_reason = ?, payload_json = ?
         WHERE id = ? AND version = ?`,
      )
      .run(at, reason, persist(invalidated), id, version);
  }

  insertInbox(record: {
    eventId: string;
    effectId?: string;
    clientToken?: string;
    payload: unknown;
    receivedAt: number;
  }): void {
    this.database
      .prepare(
        `INSERT INTO inbox (event_id, effect_id, client_token, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.eventId,
        record.effectId ?? null,
        record.clientToken ?? null,
        persist(record.payload),
        record.receivedAt,
      );
  }

  takeInbox(
    effectId: string,
    clientToken: string,
  ): Array<{ eventId: string; payload: unknown }> {
    const rows = this.database
      .prepare(
        `SELECT event_id, payload_json FROM inbox
         WHERE effect_id = ? OR client_token = ?
         ORDER BY received_at, event_id`,
      )
      .all(effectId, clientToken) as Array<{
      event_id: string;
      payload_json: string;
    }>;
    this.database
      .prepare('DELETE FROM inbox WHERE effect_id = ? OR client_token = ?')
      .run(effectId, clientToken);

    return rows.map((row) => ({
      eventId: row.event_id,
      payload: parseJson(row.payload_json),
    }));
  }

  checkpoint(): void {
    this.database.exec('PRAGMA wal_checkpoint(FULL);');
    this.restrict();
  }

  close(): void {
    this.checkpoint();
    this.database.close();
    this.restrict();
  }

  private restrict(): void {
    if (this.filename === ':memory:') {
      return;
    }

    for (const candidate of [
      this.filename,
      `${this.filename}-wal`,
      `${this.filename}-shm`,
    ]) {
      if (existsSync(candidate)) {
        chmodSync(candidate, 0o600);
      }
    }
  }
}

function persist(value: unknown): string {
  return JSON.stringify(redactValue(value));
}

function parseJson(value: string | null): unknown {
  if (value === null) {
    return null;
  }

  return JSON.parse(value) as unknown;
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    state: row.state,
    version: row.version,
    config: parseJson(row.config_json) as RunConfig,
    contract: row.contract_json
      ? (parseJson(row.contract_json) as TaskContract)
      : null,
    contextId: row.context_id,
    headSha: row.head_sha,
    writerExternalId: row.writer_external_id,
    repairAttempts: row.repair_attempts,
    agentRuns: row.agent_runs,
    activeMs: row.active_ms,
    lastTickAt: row.last_tick_at,
    pausedFrom: row.paused_from,
    blockReason: row.block_reason,
    failReason: row.fail_reason,
    pausedReason: row.paused_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type EventRow = {
  id: string;
  run_id: string;
  type: string;
  payload_json: string;
  status: string;
  result_json: string;
  received_at: number;
};

function mapEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    payload: parseJson(row.payload_json),
    status: row.status,
    result: parseJson(row.result_json),
    receivedAt: row.received_at,
  };
}

type EffectRow = {
  id: string;
  run_id: string;
  kind: EffectRecord['kind'];
  role: EffectRole;
  status: EffectStatus;
  client_token: string;
  external_id: string | null;
  attempt: number;
  delivery_attempted: number;
  terminal: number;
  counted: number;
  request_json: string;
  outcome_json: string | null;
  created_at: number;
};

function mapEffect(row: EffectRow): EffectRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    role: row.role,
    status: row.status,
    clientToken: row.client_token,
    externalId: row.external_id,
    attempt: row.attempt,
    deliveryAttempted: row.delivery_attempted === 1,
    terminal: row.terminal === 1,
    counted: row.counted === 1,
    request: parseJson(row.request_json) as EffectRequest,
    outcome: row.outcome_json === null ? null : parseJson(row.outcome_json),
    createdAt: row.created_at,
  };
}

type OutboxRow = {
  id: string;
  effect_id: string;
  status: OutboxRecord['status'];
  result_json: string | null;
  created_at: number;
};

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    effectId: row.effect_id,
    status: row.status,
    result: row.result_json === null ? null : parseJson(row.result_json),
    createdAt: row.created_at,
  };
}

type ArtifactRow = {
  id: string;
  run_id: string;
  kind: string;
  commit_sha: string | null;
  context_id: string | null;
  context_version: number | null;
  payload_json: string;
  stale: number;
  created_at: number;
};

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    commitSha: row.commit_sha,
    contextId: row.context_id,
    contextVersion: row.context_version,
    payload: parseJson(row.payload_json),
    stale: row.stale === 1,
    createdAt: row.created_at,
  };
}

type ApprovalRow = {
  id: string;
  run_id: string;
  commit_sha: string;
  approver_id: string;
  effect: 'guarded_merge';
  approved_at: number;
  expires_at: number;
};

type AttemptRow = {
  run_id: string;
  kind: string;
  n: number;
  effect_id: string;
  commit_sha: string | null;
  detail_json: string;
};

type ContextRow = {
  id: string;
  version: number;
  content_hash: string;
  payload_json: string;
  invalidated_at: number | null;
  invalidation_reason: string | null;
};

function mapContext(row: ContextRow): TaskContext {
  const payload = parseJson(row.payload_json) as TaskContext;

  return {
    ...payload,
    id: row.id,
    version: row.version,
    contentHash: row.content_hash,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
  };
}
