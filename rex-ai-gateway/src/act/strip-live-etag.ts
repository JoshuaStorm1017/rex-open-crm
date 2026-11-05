import type { ToolCall } from './types';

const PLACEHOLDER_ETAGS = new Set(['chained', 'created']);

export function withoutLiveEtag(tools: ToolCall[]): ToolCall[] {
  return tools.map((tool) => {
    const ifMatch = tool.args.ifMatch;

    if (
      typeof ifMatch !== 'string' ||
      PLACEHOLDER_ETAGS.has(ifMatch) ||
      ifMatch.startsWith('$')
    ) {
      return { name: tool.name, args: { ...tool.args } };
    }

    const args = { ...tool.args };
    delete args.ifMatch;

    return { name: tool.name, args };
  });
}
