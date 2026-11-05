import { randomUUID } from 'node:crypto';

import { CREATE_NEW_CHOICE_ID } from '../act/create-new-choice';
import {
  isPendingBatch,
  type PendingBatch,
  type PendingChoice,
  type PendingSelection,
} from '../act/pending-choice';
import type { ToolCall } from '../act/types';

const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const MAX_PROPOSALS = 200;

export type ChoiceCandidate = {
  id: string;
  label: string;
  detail?: string;
  etag: string;
};

export type StoredProposal = {
  id: string;
  memberId: string;
  workspaceId: string;
  tools: ToolCall[];
  pendingChoice?: PendingSelection;
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
    pendingChoice?: PendingSelection,
    now = Date.now(),
  ): StoredProposal | undefined {
    this.prune(now);

    if (this.proposals.size >= MAX_PROPOSALS) {
      return undefined;
    }

    const proposal = this.createProposal(
      memberId,
      workspaceId,
      tools,
      pendingChoice,
      now,
    );
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  claim(
    id: string,
    workspaceId: string,
    memberId: string,
    choiceId?: string,
    choices?: Record<string, string>,
    now = Date.now(),
  ): ClaimResult {
    const peeked = this.peek(id, workspaceId, memberId, choiceId, choices, now);

    if (
      !peeked.ok &&
      (peeked.reason === 'missing' || peeked.reason === 'workspace')
    ) {
      return peeked;
    }

    if (peeked.ok || peeked.reason !== 'choice') {
      this.proposals.delete(id);
    }

    return peeked;
  }

  peek(
    id: string,
    workspaceId: string,
    memberId: string,
    choiceId?: string,
    choices?: Record<string, string>,
    now = Date.now(),
  ): ClaimResult {
    const proposal = this.proposals.get(id);

    if (!proposal || proposal.memberId !== memberId) {
      return { ok: false, reason: 'missing' };
    }

    if (proposal.expiresAt <= now) {
      return { ok: false, reason: 'expired' };
    }

    if (proposal.workspaceId !== workspaceId) {
      return { ok: false, reason: 'workspace' };
    }

    return this.claimStored(proposal, choiceId, choices);
  }

  protected createProposal(
    memberId: string,
    workspaceId: string,
    tools: ToolCall[],
    pendingChoice: PendingSelection | undefined,
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

  protected claimStored(
    proposal: StoredProposal,
    choiceId: string | undefined,
    choices?: Record<string, string>,
  ): ClaimResult {
    if (!proposal.pendingChoice) {
      return { ok: true, proposal };
    }

    if (isPendingBatch(proposal.pendingChoice)) {
      const tools = toolsFromBatch(proposal.pendingChoice, choiceId, choices);

      if (!tools) {
        return { ok: false, reason: 'choice' };
      }

      return {
        ok: true,
        proposal: { ...proposal, tools, pendingChoice: undefined },
      };
    }

    const candidate = proposal.pendingChoice.candidates.find(
      (item) => item.id === choiceId,
    );

    if (!candidate) {
      return { ok: false, reason: 'choice' };
    }

    if (candidate.id === CREATE_NEW_CHOICE_ID) {
      if (
        !proposal.pendingChoice.createTools ||
        proposal.pendingChoice.createTools.length === 0
      ) {
        return { ok: false, reason: 'choice' };
      }

      return {
        ok: true,
        proposal: {
          ...proposal,
          tools: proposal.pendingChoice.createTools,
          pendingChoice: undefined,
        },
      };
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

function toolsFromBatch(
  batch: PendingBatch,
  choiceId: string | undefined,
  choices: Record<string, string> | undefined,
): ToolCall[] | undefined {
  const selected: Record<string, string> = { ...(choices ?? {}) };

  if (batch.groups.length === 1 && choiceId) {
    const only = batch.groups[0];

    if (only && selected[only.id] === undefined) {
      selected[only.id] = choiceId;
    }
  }

  const tools: ToolCall[] = [];
  const created = new Set<string>();

  for (const step of batch.steps) {
    if (step.type === 'tool') {
      tools.push(step.tool);
      continue;
    }

    const group = batch.groups.find((item) => item.id === step.groupId);

    if (!group) {
      return undefined;
    }

    const candidate = group.candidates.find(
      (item) => item.id === selected[group.id],
    );

    if (!candidate) {
      return undefined;
    }

    if (candidate.id === CREATE_NEW_CHOICE_ID) {
      if (created.has(group.id)) {
        continue;
      }

      if (!group.createTools || group.createTools.length === 0) {
        return undefined;
      }

      tools.push(
        ...group.createTools.map((tool) => shiftRefs(tool, tools.length)),
      );
      created.add(group.id);
      continue;
    }

    if (group.kind === 'archive') {
      tools.push({
        name: 'archive_record',
        args: {
          object: group.objectName,
          id: candidate.id,
          ifMatch: candidate.etag,
        },
      });
      continue;
    }

    if (group.kind === 'note') {
      tools.push({
        name: 'create_note',
        args: {
          ...(group.title ? { title: group.title } : {}),
          body: group.body,
          targetObject: group.objectName,
          targetId: candidate.id,
        },
      });
      continue;
    }

    const update = group.updates[step.updateIndex];

    if (!update) {
      return undefined;
    }

    tools.push({
      name: 'update_record',
      args: {
        object: group.objectName,
        id: candidate.id,
        field: update.field,
        value: update.value,
        ifMatch: step.updateIndex > 0 ? 'chained' : candidate.etag,
      },
    });
  }

  return tools;
}

function shiftRefs(tool: ToolCall, offset: number): ToolCall {
  if (offset === 0) {
    return tool;
  }

  const args = { ...tool.args };

  for (const key of ['id', 'targetId', 'companyId', 'pointOfContactId']) {
    const value = args[key];
    const match =
      typeof value === 'string' ? /^\$(\d+)$/.exec(value) : undefined;

    if (match?.[1]) {
      args[key] = `$${Number(match[1]) + offset}`;
    }
  }

  return { name: tool.name, args };
}

function toolFromChoice(
  choice: PendingChoice,
  candidate: ChoiceCandidate,
): ToolCall {
  if (choice.kind === 'archive') {
    return {
      name: 'archive_record',
      args: {
        object: choice.objectName,
        id: candidate.id,
        ifMatch: candidate.etag,
      },
    };
  }

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
