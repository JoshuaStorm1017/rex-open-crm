import { randomUUID } from 'node:crypto';

export type AuditAction = 'plan' | 'act' | 'tools' | 'audit';

export type AuditEntry = {
  id: string;
  at: string;
  memberId: string;
  actor: string;
  workspaceId?: string;
  action: AuditAction;
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

  list(memberId: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.memberId === memberId);
  }
}
