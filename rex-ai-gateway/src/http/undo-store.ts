import { randomUUID } from 'node:crypto';

import type { ActEffect } from '../act/types';

export type UndoTicket = {
  id: string;
  memberId: string;
  workspaceId: string;
  summary: string;
  effects: ActEffect[];
};

export type TakeUndoResult =
  | { ok: true; ticket: UndoTicket }
  | { ok: false; reason: 'missing' | 'workspace' | 'busy' };

export function summarizeUndo(effects: ActEffect[]): string {
  const created = effects.filter((effect) => effect.kind === 'created').length;
  const updated = effects.filter((effect) => effect.kind === 'updated').length;
  const archived = effects.filter((effect) => effect.kind === 'archived').length;
  const parts: string[] = [];

  if (created > 0) {
    parts.push(`${created} created record${created === 1 ? '' : 's'}`);
  }

  if (updated > 0) {
    parts.push(`${updated} field change${updated === 1 ? '' : 's'}`);
  }

  if (archived > 0) {
    parts.push(`${archived} archived record${archived === 1 ? '' : 's'}`);
  }

  return `Undo ${parts.join(' and ')}.`;
}

export class UndoStore {
  private readonly tickets = new Map<string, UndoTicket>();
  private readonly running = new Set<string>();

  save(
    memberId: string,
    workspaceId: string,
    effects: ActEffect[],
  ): UndoTicket | undefined {
    if (effects.length === 0) {
      return undefined;
    }

    const ticket: UndoTicket = {
      id: `undo_${randomUUID()}`,
      memberId,
      workspaceId,
      summary: summarizeUndo(effects),
      effects,
    };

    this.tickets.set(memberId, ticket);

    return ticket;
  }

  peek(id: string, memberId: string, workspaceId: string): TakeUndoResult {
    return this.read(id, memberId, workspaceId);
  }

  begin(id: string, memberId: string, workspaceId: string): TakeUndoResult {
    if (this.running.has(memberId)) {
      return { ok: false, reason: 'busy' };
    }

    const result = this.peek(id, memberId, workspaceId);

    if (result.ok) {
      this.running.add(memberId);
    }

    return result;
  }

  finish(memberId: string): void {
    this.running.delete(memberId);
    this.tickets.delete(memberId);
  }

  release(memberId: string): void {
    this.running.delete(memberId);
  }

  retain(id: string, memberId: string, workspaceId: string, effects: ActEffect[]): boolean {
    const current = this.read(id, memberId, workspaceId);

    if (!current.ok || effects.length === 0) {
      return false;
    }

    this.tickets.set(memberId, {
      ...current.ticket,
      summary: summarizeUndo(effects),
      effects,
    });

    return true;
  }

  take(id: string, memberId: string, workspaceId: string): TakeUndoResult {
    const result = this.read(id, memberId, workspaceId);

    if (result.ok) {
      this.running.delete(memberId);
      this.tickets.delete(memberId);
    }

    return result;
  }

  private read(id: string, memberId: string, workspaceId: string): TakeUndoResult {
    const ticket = this.tickets.get(memberId);

    if (!ticket || ticket.id !== id) {
      return { ok: false, reason: 'missing' };
    }

    if (ticket.workspaceId !== workspaceId) {
      return { ok: false, reason: 'workspace' };
    }

    return { ok: true, ticket };
  }
}
