import type { CaptureImage } from '../act/parse-request';
import type { ToolSchema } from '../act/tool-schema';
import type { ActRefusal, ToolCall } from '../act/types';
import type {
  TwentyCrmClient,
  TwentyObjectName,
} from '../twenty/twenty-crm-client';

export type LlmProposal = {
  ok: true;
  summary: string;
  tools: ToolCall[];
};

export type LlmPlan = LlmProposal | ActRefusal;

export type PartialToolCall = {
  name: string;
  args: Record<string, unknown>;
  complete: boolean;
};

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
  planStream?: (
    input: LlmPlanInput,
    emit: (tools: PartialToolCall[]) => void,
  ) => Promise<LlmPlan>;
  readCard?: (image: CaptureImage) => Promise<string>;
};
