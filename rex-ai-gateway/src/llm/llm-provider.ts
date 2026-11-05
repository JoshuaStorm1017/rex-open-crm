import type { ActRefusal, ToolCall } from '../act/types';
import type { TwentyCrmClient } from '../twenty/twenty-crm-client';

export type LlmProposal = {
  ok: true;
  summary: string;
  tools: ToolCall[];
};

export type LlmPlan = LlmProposal | ActRefusal;

export type LlmPlanInput = {
  intent: string;
  workspaceId: string;
  client: TwentyCrmClient;
};

export type LlmProvider = {
  plan: (input: LlmPlanInput) => Promise<LlmPlan>;
};
