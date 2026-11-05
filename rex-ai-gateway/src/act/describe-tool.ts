import type { CreatedRecord } from '../twenty/twenty-crm-client';
import type { ProposalLine } from './types';
import type { ValidatedTool } from './validate-tool';

export function describeTool(
  tool: ValidatedTool,
  current?: CreatedRecord,
): ProposalLine {
  switch (tool.name) {
    case 'create_person':
      return {
        tool: tool.name,
        summary: `Create person ${tool.input.firstName} ${tool.input.lastName}.`,
      };
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
      const linked =
        tool.input.companyId?.startsWith('$') || tool.input.pointOfContactId?.startsWith('$')
          ? ' Linked to the records created in this step.'
          : '';

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
    case 'archive_record':
      return {
        tool: tool.name,
        summary: `Archive ${tool.input.objectName} ${current?.label ?? tool.input.id ?? tool.input.query ?? 'record'}. If-Match ${tool.input.ifMatch}.`,
      };
    case 'update_record': {
      const previous = current?.properties[tool.input.field];
      const from =
        previous === undefined ? '' : ` from ${formatValue(previous)}`;
      const label = current?.label ?? tool.input.id ?? tool.input.query ?? 'record';

      return {
        tool: tool.name,
        summary: `Set ${tool.input.objectName} ${label} ${tool.input.field}${from} to ${formatValue(tool.input.value)}. If-Match ${tool.input.ifMatch}.`,
      };
    }
  }
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
