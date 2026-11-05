import type { PartialToolCall } from '../llm/llm-provider';
import type { CreatedRecord } from '../twenty/twenty-crm-client';
import { isAllowedToolName } from './allowlist';
import { assertToolPermitted, type AudienceLoad } from './permissions';
import type { ProposalLine } from './types';
import { validateTool, type ValidatedTool } from './validate-tool';

export function describeTool(
  tool: ValidatedTool,
  current?: CreatedRecord,
  options?: { disambiguate?: boolean },
): ProposalLine {
  switch (tool.name) {
    case 'create_person': {
      // A concrete companyId is not in the name line. Confirm has to say it.
      const linked =
        tool.input.companyId && !tool.input.companyId.startsWith('$')
          ? ' Linked to the company already on file.'
          : '';

      return {
        tool: tool.name,
        summary: `Create person ${tool.input.firstName} ${tool.input.lastName}.${linked}`,
      };
    }
    case 'create_company':
      return {
        tool: tool.name,
        summary: `Create company “${tool.input.name}”.`,
      };
    case 'create_opportunity': {
      const amount =
        tool.input.amount === undefined
          ? ''
          : ` for ${formatMajor(tool.input.amount, tool.input.currencyCode ?? 'USD')}`;
      const linkedToCreated =
        tool.input.companyId?.startsWith('$') ||
        tool.input.pointOfContactId?.startsWith('$')
          ? ' Linked to the records created in this step.'
          : '';
      const linkedToCompany =
        tool.input.companyId && !tool.input.companyId.startsWith('$')
          ? ' Linked to the company already on file.'
          : '';
      const linked = `${linkedToCreated}${linkedToCompany}`;

      return {
        tool: tool.name,
        summary: `Create opportunity “${tool.input.name}”${amount}.${linked}`,
      };
    }
    case 'create_note':
      return {
        tool: tool.name,
        summary: `Add a note to ${tool.input.targetObject} ${tool.input.targetId ?? tool.input.targetQuery ?? ''}: “${tool.input.body}”.`,
      };
    case 'search_records':
      return {
        tool: tool.name,
        summary: `Search ${plural(tool.input.objectName)} for “${tool.input.query}”.`,
      };
    case 'search_notes':
      return {
        tool: tool.name,
        summary: tool.input.recordId
          ? 'Read notes on the open record.'
          : `Search note titles and bodies for “${tool.input.query}”.`,
      };
    case 'search_tasks':
      return {
        tool: tool.name,
        summary: tool.input.recordId
          ? 'Read tasks on the open record.'
          : `Search task titles and bodies for “${tool.input.query}”.`,
      };
    case 'search_activities':
      return {
        tool: tool.name,
        summary: tool.input.recordId
          ? 'Read activities on the open record.'
          : `Search activities linked to “${tool.input.query}”.`,
      };
    case 'archive_record':
      return {
        tool: tool.name,
        summary: `Archive ${tool.input.objectName} ${current?.label ?? tool.input.id ?? tool.input.query ?? 'record'}. If-Match ${etagLabel(tool.input.ifMatch)}.`,
      };
    case 'update_matching_records':
      return {
        tool: tool.name,
        summary: `Set ${tool.input.field} to ${formatValue(tool.input.value)} on every ${tool.input.objectName} matching “${tool.input.query ?? ''}”.`,
      };
    case 'update_record': {
      const previous = current?.properties[tool.input.field];
      const from =
        previous === undefined ? '' : ` from ${formatValue(previous)}`;
      const label =
        current?.label ?? tool.input.id ?? tool.input.query ?? 'record';
      const identity =
        options?.disambiguate && current ? ` (${current.id})` : '';

      return {
        tool: tool.name,
        summary: `Set ${tool.input.objectName} ${label}${identity} ${tool.input.field}${from} to ${formatValue(tool.input.value)}. If-Match ${etagLabel(tool.input.ifMatch)}.`,
      };
    }
  }
}

// A completed partial would otherwise name a field this role cannot write.
export function partialsForRole(
  tools: PartialToolCall[],
  workspaceId: string,
  audience: AudienceLoad,
  allowed: ReadonlySet<string>,
): PartialToolCall[] {
  return tools.flatMap((tool) => {
    if (!allowed.has(tool.name)) {
      return [];
    }

    if (!tool.complete) {
      return [tool];
    }

    const validated = validateTool(
      { name: tool.name, args: tool.args },
      workspaceId,
    );

    if ('refused' in validated || assertToolPermitted(validated, audience)) {
      return [{ name: tool.name, args: {}, complete: false }];
    }

    return [tool];
  });
}

export function describePartialTools(
  tools: PartialToolCall[],
  workspaceId: string,
): ProposalLine[] {
  return tools.flatMap((tool) => {
    const name = isAllowedToolName(tool.name) ? tool.name : undefined;

    if (!name) {
      return [
        {
          tool: 'search_records' as const,
          summary: 'Planning the next action…',
        },
      ];
    }

    if (!tool.complete) {
      return [{ tool: name, summary: `Planning ${name}…` }];
    }

    const validated = validateTool({ name, args: tool.args }, workspaceId);

    if ('refused' in validated) {
      return [{ tool: name, summary: `Planning ${name}…` }];
    }

    return [describeTool(validated)];
  });
}

export function summarizeLines(lines: ProposalLine[]): string {
  if (lines.length === 0) {
    return 'No actions.';
  }

  if (lines.length === 1) {
    return lines[0]?.summary ?? 'One action.';
  }

  return lines.map((line) => line.summary.replace(/\.$/, '')).join(' ');
}

function etagLabel(ifMatch: string | undefined): string {
  if (ifMatch === 'chained') {
    return 'the etag from the previous write in this preview';
  }

  return ifMatch ?? 'the current record';
}

function plural(objectName: 'person' | 'company' | 'opportunity'): string {
  if (objectName === 'person') {
    return 'people';
  }

  if (objectName === 'company') {
    return 'companies';
  }

  return 'opportunities';
}

function formatValue(value: string | number): string {
  return typeof value === 'number' ? formatMajor(value, 'USD') : `“${value}”`;
}

function formatMajor(amount: number, currency: string): string {
  const formatted = amount.toLocaleString('en-US');

  return currency === 'USD' ? `$${formatted}` : `${formatted} ${currency}`;
}
