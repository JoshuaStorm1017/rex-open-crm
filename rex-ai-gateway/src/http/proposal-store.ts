import { randomUUID } from 'node:crypto';

import type { ToolCall } from '../act/types';

const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_PROPOSALS = 200;

export type StoredProposal = {
  id: string;
  workspaceId: string;
  tools: ToolCall[];
  expiresAt: number;
};

export type ClaimResult =
  | { ok: true; proposal: StoredProposal }
  | { ok: false; reason: 'missing' | 'expired' | 'workspace' };

export class ProposalStore {
  private readonly proposals = new Map<string, StoredProposal>();

  save(workspaceId: string, tools: ToolCall[], now = Date.now()): StoredProposal | undefined {
    this.prune(now);

    if (this.proposals.size >= MAX_PROPOSALS) {
      return undefined;
    }

    const proposal: StoredProposal = {
      id: `proposal_${randomUUID()}`,
      workspaceId,
      tools,
      expiresAt: now + PROPOSAL_TTL_MS,
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  claim(id: string, workspaceId: string, now = Date.now()): ClaimResult {
    const proposal = this.proposals.get(id);

    if (!proposal) {
      return { ok: false, reason: 'missing' };
    }

    if (proposal.expiresAt <= now) {
      this.proposals.delete(id);
      return { ok: false, reason: 'expired' };
    }

    if (proposal.workspaceId !== workspaceId) {
      return { ok: false, reason: 'workspace' };
    }

    this.proposals.delete(id);
    return { ok: true, proposal };
  }

  private prune(now: number): void {
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) {
        this.proposals.delete(id);
      }
    }
  }
}
