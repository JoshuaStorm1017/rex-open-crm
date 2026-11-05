import type { ToolSchema } from '../act/tool-schema';
import type { ActRefusal, ToolCall } from '../act/types';
import type { TwentyCrmClient, TwentyObjectName } from '../twenty/twenty-crm-client';

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
  catalog?: { tools: ToolSchema[] };
  openRecord?: {
    objectName: TwentyObjectName;
    label: string;
  };
  visibleRecords?: Array<{
    ref: string;
    objectName: TwentyObjectName;
    label: string;
    detail: string;
  }>;
};

export type LlmProvider = {
  plan: (input: LlmPlanInput) => Promise<LlmPlan>;
};
