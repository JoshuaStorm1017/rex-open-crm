import { randomUUID } from 'node:crypto';

import type { PendingChoice } from '../act/pending-choice';
import type { ToolCall } from '../act/types';

const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_PROPOSALS = 200;

export type ChoiceCandidate = {
  id: string;
  label: string;
  etag: string;
};

export type StoredProposal = {
  id: string;
  memberId: string;
  workspaceId: string;
  tools: ToolCall[];
  pendingChoice?: PendingChoice;
  expiresAt: number;
};

export type ClaimResult =
  | { ok: true; proposal: StoredProposal }
  | { ok: false; reason: 'missing' | 'expired' | 'workspace' | 'choice' };

export class ProposalStore {
  private readonly proposals = new Map<string, StoredProposal>();

  save(
    memberId: string,
    workspaceId: string,
    tools: ToolCall[],
    pendingChoice?: PendingChoice,
    now = Date.now(),
  ): StoredProposal | undefined {
    this.prune(now);

    if (this.proposals.size >= MAX_PROPOSALS) {
      return undefined;
    }

    const proposal = this.createProposal(memberId, workspaceId, tools, pendingChoice, now);
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  claim(
    id: string,
    workspaceId: string,
    memberId: string,
    choiceId?: string,
    now = Date.now(),
  ): ClaimResult {
    const proposal = this.proposals.get(id);

    if (!proposal || proposal.memberId !== memberId) {
      return { ok: false, reason: 'missing' };
    }

    if (proposal.expiresAt <= now) {
      this.proposals.delete(id);
      return { ok: false, reason: 'expired' };
    }

    if (proposal.workspaceId !== workspaceId) {
      return { ok: false, reason: 'workspace' };
    }

    const claimed = this.claimStored(proposal, choiceId);

    if (claimed.ok || claimed.reason !== 'choice') {
      this.proposals.delete(id);
    }

    return claimed;
  }

  protected createProposal(
    memberId: string,
    workspaceId: string,
    tools: ToolCall[],
    pendingChoice: PendingChoice | undefined,
    now: number,
  ): StoredProposal {
    return {
      id: `proposal_${randomUUID()}`,
      memberId,
      workspaceId,
      tools,
      ...(pendingChoice ? { pendingChoice } : {}),
      expiresAt: now + PROPOSAL_TTL_MS,
    };
  }

  protected claimStored(proposal: StoredProposal, choiceId: string | undefined): ClaimResult {
    if (!proposal.pendingChoice) {
      return { ok: true, proposal };
    }

    const candidate = proposal.pendingChoice.candidates.find((item) => item.id === choiceId);

    if (!candidate) {
      return { ok: false, reason: 'choice' };
    }

    return {
      ok: true,
      proposal: {
        ...proposal,
        tools: [toolFromChoice(proposal.pendingChoice, candidate)],
        pendingChoice: undefined,
      },
    };
  }

  private prune(now: number): void {
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) {
        this.proposals.delete(id);
      }
    }
  }
}

function toolFromChoice(choice: PendingChoice, candidate: ChoiceCandidate): ToolCall {
  if (choice.kind === 'note') {
    return {
      name: 'create_note',
      args: {
        ...(choice.title ? { title: choice.title } : {}),
        body: choice.body,
        targetObject: choice.objectName,
        targetId: candidate.id,
      },
    };
  }

  return {
    name: 'update_record',
    args: {
      object: choice.objectName,
      id: candidate.id,
      field: choice.field,
      value: choice.value,
      ifMatch: candidate.etag,
    },
  };
}
