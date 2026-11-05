import { randomUUID } from 'node:crypto';

export type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  workspaceId?: string;
  action: 'plan' | 'act';
  summary: string;
  tools: string[];
  recordIds: string[];
  ok: boolean;
  confirmed?: boolean;
  reason?: string;
  replayed?: boolean;
};

const MAX_ENTRIES = 200;

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const stored: AuditEntry = {
      ...entry,
      id: `audit_${randomUUID()}`,
      at: new Date().toISOString(),
      summary: entry.summary.replace(/\s+/g, ' ').trim().slice(0, 500),
    };
    this.entries.push(stored);

    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }

    return stored;
  }

  list(): AuditEntry[] {
    return [...this.entries];
  }
}
