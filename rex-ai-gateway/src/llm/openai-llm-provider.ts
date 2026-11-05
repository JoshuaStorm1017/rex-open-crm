import { isRecord } from '../is-record';
import { toolCatalog } from '../act/tool-schema';
import { refusal, type ToolCall } from '../act/types';
import { assertProviderHostIsPublic, assertPublicProviderBaseUrl } from '../http/public-url';
import type { LlmPlan, LlmProvider } from './llm-provider';
import type { LlmConfig } from './read-llm-config';

const REFUSAL_REASONS = new Set(['unsafe_intent', 'ambiguous_intent', 'unmapped_intent']);

export function createOpenAiLlmProvider(
  config: Extract<LlmConfig, { provider: 'openai' }>,
  fetchImpl: typeof fetch = fetch,
): LlmProvider {
  const parsed = assertPublicProviderBaseUrl(config.baseUrl);
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async plan(input) {
      if (fetchImpl === fetch) {
        await assertProviderHostIsPublic(parsed.hostname);
      }

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: input.intent },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        throw new Error(`LLM request failed with ${response.status}.`);
      }

      const text = await response.text();

      return parseModelPlan(text);
    },
  };
}

function systemPrompt(): string {
  return [
    'You plan CRM actions. Reply with one JSON object and no markdown.',
    'Either {"summary":"short","tools":[{"name":"tool","args":{}}]} or {"refused":true,"reason":"unsafe_intent|ambiguous_intent|unmapped_intent","message":"why"}.',
    'Use only the tools in this catalog. Do not invent record ids. If the user did not give an id, search instead of updating.',
    'amount is major currency units. $50k means 50000. Refuse deletes, exports, and anything about passwords or credentials.',
    'A named record without an id uses update_record query or create_note targetQuery. Do not invent ids. The gateway offers choices when several records match.',
    JSON.stringify(toolCatalog()),
  ].join('\n');
}

export function parseModelPlan(bodyText: string): LlmPlan {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return refusal('unmapped_intent', 'The model response was not JSON.');
  }

  const content = readContent(parsed);

  if (!content) {
    return refusal('unmapped_intent', 'The model response did not include a plan.');
  }

  let plan: unknown;

  try {
    plan = JSON.parse(stripFence(content));
  } catch {
    return refusal('unmapped_intent', 'The model response was not a tool plan.');
  }

  if (!isRecord(plan)) {
    return refusal('unmapped_intent', 'The model response was not a tool plan.');
  }

  if (plan.refused === true) {
    const reason = typeof plan.reason === 'string' ? plan.reason : 'unmapped_intent';
    const message =
      typeof plan.message === 'string' && plan.message.trim().length > 0
        ? plan.message.trim().slice(0, 500)
        : 'The model refused this request.';

    return refusal(REFUSAL_REASONS.has(reason) ? (reason as 'unsafe_intent') : 'unmapped_intent', message);
  }

  if (!Array.isArray(plan.tools)) {
    return refusal('unmapped_intent', 'The model response did not include tools.');
  }

  const tools: ToolCall[] = [];

  for (const tool of plan.tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !isRecord(tool.args)) {
      return refusal('unmapped_intent', 'The model returned a tool that is not an object.');
    }

    tools.push({ name: tool.name, args: tool.args });
  }

  const summary = typeof plan.summary === 'string' ? plan.summary.trim().slice(0, 200) : '';

  return { ok: true, summary, tools };
}

function readContent(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return undefined;
  }

  const choice = body.choices[0];

  if (!isRecord(choice) || !isRecord(choice.message)) {
    return undefined;
  }

  return typeof choice.message.content === 'string' ? choice.message.content : undefined;
}

function stripFence(content: string): string {
  return content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}
