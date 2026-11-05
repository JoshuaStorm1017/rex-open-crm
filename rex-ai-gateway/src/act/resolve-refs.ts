import { refusal, type ActRefusal } from './types';
import type { ValidatedTool } from './validate-tool';

const REF_PATTERN = /^\$(\d+)$/;

export function preflightRefs(tools: ValidatedTool[]): ActRefusal | undefined {
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];

    if (
      !tool ||
      (tool.name !== 'create_opportunity' &&
        tool.name !== 'create_person' &&
        tool.name !== 'create_note' &&
        tool.name !== 'update_record')
    ) {
      continue;
    }

    const refs = relationRefs(tool);

    for (const ref of refs) {
      const match = REF_PATTERN.exec(ref);

      if (!match?.[1]) {
        continue;
      }

      const targetIndex = Number(match[1]);
      const target = tools[targetIndex];

      if (targetIndex >= index || !target || !isSingleRecordTool(target)) {
        return refusal(
          'invalid_request',
          `Refusing ${tool.name}: ${ref} must point at an earlier create or update in this request.`,
          { toolName: tool.name },
        );
      }
    }
  }

  return undefined;
}

export function resolveRelationId(
  value: string | undefined,
  priorIds: Array<string | undefined>,
  toolName: ValidatedTool['name'],
): string | undefined | ActRefusal {
  if (!value) {
    return undefined;
  }

  const match = REF_PATTERN.exec(value);

  if (!match?.[1]) {
    return value;
  }

  const id = priorIds[Number(match[1])];

  if (!id) {
    return refusal(
      'invalid_request',
      `Refusing ${toolName}: ${value} did not resolve to a record id.`,
      { toolName },
    );
  }

  return id;
}

function relationRefs(tool: ValidatedTool): string[] {
  if (tool.name === 'create_person') {
    return tool.input.companyId ? [tool.input.companyId] : [];
  }

  if (tool.name === 'create_opportunity') {
    return [tool.input.companyId, tool.input.pointOfContactId].filter(
      (value): value is string => typeof value === 'string',
    );
  }

  if (tool.name === 'create_note') {
    return tool.input.targetId ? [tool.input.targetId] : [];
  }

  if (tool.name === 'update_record' && tool.input.id?.startsWith('$')) {
    return [tool.input.id];
  }

  return [];
}

function isSingleRecordTool(tool: ValidatedTool): boolean {
  return tool.name !== 'search_records';
}
