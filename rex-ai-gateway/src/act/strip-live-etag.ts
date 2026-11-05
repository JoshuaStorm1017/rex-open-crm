import type { ToolCall } from './types';

// "created" is the etag of a row this same preview creates. "chained" is
// recomputed when the preview is built; keeping it makes enrichUpdate treat
// the sentinel as a stale etag and refuse the reload.
const KEPT_ETAGS = new Set(['created']);

export function withoutLiveEtag(tools: ToolCall[]): ToolCall[] {
  return tools.map((tool) => {
    const ifMatch = tool.args.ifMatch;

    if (
      typeof ifMatch !== 'string' ||
      KEPT_ETAGS.has(ifMatch) ||
      ifMatch.startsWith('$')
    ) {
      return { name: tool.name, args: { ...tool.args } };
    }

    const args = { ...tool.args };
    delete args.ifMatch;

    return { name: tool.name, args };
  });
}
