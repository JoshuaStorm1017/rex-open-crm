import { randomUUID } from 'node:crypto';

import type { ActEffect } from '../act/types';

export const UNDO_STACK_LIMIT = 8;

export type UndoTicket = {
  id: string;
  memberId: string;
  workspaceId: string;
  summary: string;
  effects: ActEffect[];
  createdAt: number;
  actAuditId?: string;
};

export type TakeUndoResult =
  | { ok: true; ticket: UndoTicket }
  | { ok: false; reason: 'missing' | 'workspace' | 'busy' | 'order' };

export function summarizeUndo(effects: ActEffect[]): string {
  const created = effects.filter((effect) => effect.kind === 'created').length;
  const updated = effects.filter((effect) => effect.kind === 'updated').length;
  const archived = effects.filter(
    (effect) => effect.kind === 'archived',
  ).length;
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
  private readonly stacks = new Map<string, UndoTicket[]>();
  private readonly running = new Map<string, string>();
  private readonly generation = new Map<string, number>();
  private readonly begunGeneration = new Map<string, number>();
  private stamp = 0;

  save(
    memberId: string,
    workspaceId: string,
    effects: ActEffect[],
  ): UndoTicket | undefined {
    const ticket = this.buildTicket(memberId, workspaceId, effects);

    if (!ticket) {
      return undefined;
    }

    this.noteSaved(memberId);
    const stack = this.stacks.get(memberId) ?? [];
    stack.unshift(ticket);
    this.stacks.set(memberId, stack.slice(0, UNDO_STACK_LIMIT));

    return ticket;
  }

  list(memberId: string, workspaceId: string): UndoTicket[] {
    return (this.stacks.get(memberId) ?? []).filter(
      (ticket) => ticket.workspaceId === workspaceId,
    );
  }

  linkAct(id: string, memberId: string, auditId: string): void {
    const ticket = (this.stacks.get(memberId) ?? []).find(
      (item) => item.id === id,
    );

    if (ticket) {
      ticket.actAuditId = auditId;
    }
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
      this.running.set(memberId, id);
      this.begunGeneration.set(memberId, this.generation.get(memberId) ?? 0);
    }

    return result;
  }

  superseded(memberId: string): boolean {
    const begun = this.begunGeneration.get(memberId);

    if (begun === undefined) {
      return false;
    }

    return begun !== (this.generation.get(memberId) ?? 0);
  }

  // In-memory undos have one process. The sqlite store overrides this so a
  // stolen lock is visible to the process that lost it.
  holdsLock(memberId: string): boolean {
    return this.running.has(memberId);
  }

  finish(memberId: string): void {
    const id = this.running.get(memberId);
    this.running.delete(memberId);
    this.begunGeneration.delete(memberId);

    if (!id) {
      return;
    }

    const stack = this.stacks.get(memberId) ?? [];
    this.stacks.set(
      memberId,
      stack.filter((ticket) => ticket.id !== id),
    );
  }

  release(memberId: string): void {
    this.running.delete(memberId);
    this.begunGeneration.delete(memberId);
  }

  retain(
    id: string,
    memberId: string,
    workspaceId: string,
    effects: ActEffect[],
  ): boolean {
    const current = this.read(id, memberId, workspaceId);

    if (!current.ok || effects.length === 0) {
      return false;
    }

    current.ticket.summary = summarizeUndo(effects);
    current.ticket.effects = effects;

    return true;
  }

  take(id: string, memberId: string, workspaceId: string): TakeUndoResult {
    const result = this.read(id, memberId, workspaceId);

    if (result.ok) {
      this.running.delete(memberId);
      this.begunGeneration.delete(memberId);
      const stack = this.stacks.get(memberId) ?? [];
      this.stacks.set(
        memberId,
        stack.filter((ticket) => ticket.id !== id),
      );
    }

    return result;
  }

  protected buildTicket(
    memberId: string,
    workspaceId: string,
    effects: ActEffect[],
  ): UndoTicket | undefined {
    if (effects.length === 0) {
      return undefined;
    }

    const now = Date.now();
    this.stamp = now > this.stamp ? now : this.stamp + 1;

    return {
      id: `undo_${randomUUID()}`,
      memberId,
      workspaceId,
      summary: summarizeUndo(effects),
      effects,
      createdAt: this.stamp,
    };
  }

  protected runningUndoId(memberId: string): string | undefined {
    return this.running.get(memberId);
  }

  protected noteSaved(memberId: string): void {
    this.generation.set(memberId, (this.generation.get(memberId) ?? 0) + 1);
  }

  protected generationAtBegin(memberId: string): number | undefined {
    return this.begunGeneration.get(memberId);
  }

  protected setGenerationAtBegin(memberId: string, generation: number): void {
    this.begunGeneration.set(memberId, generation);
  }

  private read(
    id: string,
    memberId: string,
    workspaceId: string,
  ): TakeUndoResult {
    const stack = this.stacks.get(memberId) ?? [];
    const ticket = stack.find((item) => item.id === id);

    if (!ticket) {
      return { ok: false, reason: 'missing' };
    }

    if (ticket.workspaceId !== workspaceId) {
      return { ok: false, reason: 'workspace' };
    }

    const newest = stack.find((item) => item.workspaceId === workspaceId);

    if (newest && newest.id !== id) {
      return { ok: false, reason: 'order' };
    }

    return { ok: true, ticket };
  }
}
