import { domainHostKey } from '../twenty/map-to-twenty-payload';
import type { ToolCall } from './types';

const TOOL_REF = /^\$(\d+)$/;

// Drops the new company and points the new person at the company already on file.
// Returns undefined when the preview does not have that person, so the caller
// leaves the stored proposal untouched.
export function linkPeopleToExistingCompany(
  tools: ToolCall[],
  companyId: string,
  domainHost: string,
): ToolCall[] | undefined {
  const removed = new Set<number>();

  tools.forEach((tool, index) => {
    if (tool.name !== 'create_company') {
      return;
    }

    const domain = stringArg(tool, 'domain') ?? stringArg(tool, 'website');

    if (domain && domainHostKey(domain) === domainHost) {
      removed.add(index);
    }
  });

  if (removed.size === 0 || !hasPersonToLink(tools, removed)) {
    return undefined;
  }

  const indexMap = new Map<number, number>();
  let next = 0;

  tools.forEach((_tool, index) => {
    if (!removed.has(index)) {
      indexMap.set(index, next);
      next += 1;
    }
  });

  const rewritten: ToolCall[] = [];

  for (const [index, tool] of tools.entries()) {
    if (removed.has(index)) {
      continue;
    }

    const args = { ...tool.args };

    for (const [key, value] of Object.entries(args)) {
      if (typeof value !== 'string') {
        continue;
      }

      const match = TOOL_REF.exec(value);

      if (!match) {
        continue;
      }

      const oldIndex = Number(match[1]);

      if (removed.has(oldIndex)) {
        if (key !== 'companyId') {
          return undefined;
        }

        args[key] = companyId;
        continue;
      }

      const mapped = indexMap.get(oldIndex);

      if (mapped === undefined) {
        return undefined;
      }

      args[key] = `$${mapped}`;
    }

    if (
      tool.name === 'create_person' &&
      (args.companyId === undefined || args.companyId === '')
    ) {
      args.companyId = companyId;
    }

    rewritten.push({ name: tool.name, args });
  }

  return rewritten.length > 0 ? rewritten : undefined;
}

function hasPersonToLink(tools: ToolCall[], removed: Set<number>): boolean {
  return tools.some((tool) => {
    if (tool.name !== 'create_person') {
      return false;
    }

    const companyId = stringArg(tool, 'companyId');

    if (!companyId) {
      return true;
    }

    const match = TOOL_REF.exec(companyId);

    return match ? removed.has(Number(match[1])) : false;
  });
}

function stringArg(tool: ToolCall, key: string): string | undefined {
  const value = tool.args[key];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
