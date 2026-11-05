import { canonicalOpportunityStage } from '../twenty/opportunity-stages';
import { isRecord } from '../is-record';
import type { ToolCall } from './types';

export const SKILL_PARAMETER_NAMES = [
  'city',
  'amount',
  'stage',
  'company',
  'owner',
  'closeDate',
] as const;

export type SkillParameterName = (typeof SKILL_PARAMETER_NAMES)[number];

export type SkillParameterControl =
  | 'text'
  | 'amount'
  | 'stage'
  | 'company'
  | 'date'
  | 'owner';

export type SkillParameterPrompt = {
  name: SkillParameterName;
  label: string;
  control: SkillParameterControl;
  options?: string[];
};

const PARAMETER_LABELS: Record<SkillParameterName, string> = {
  city: 'City',
  amount: 'Amount',
  stage: 'Stage',
  company: 'Company',
  owner: 'Owner',
  closeDate: 'Close date',
};

const PARAMETER_CONTROLS: Record<SkillParameterName, SkillParameterControl> = {
  city: 'text',
  amount: 'amount',
  stage: 'stage',
  company: 'company',
  owner: 'owner',
  closeDate: 'date',
};

const STAGE_OPTIONS = ['NEW', 'SCREENING', 'MEETING', 'PROPOSAL', 'CUSTOMER'];

const ARG_PARAMETERS: Record<string, SkillParameterName> = {
  city: 'city',
  amount: 'amount',
  stage: 'stage',
  owner: 'owner',
  accountOwner: 'owner',
  closeDate: 'closeDate',
  companyId: 'company',
};

const OWNER_PATTERN =
  /^(me|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function isSkillParameterName(
  value: string,
): value is SkillParameterName {
  return (SKILL_PARAMETER_NAMES as readonly string[]).includes(value);
}

export function parameterMarker(name: SkillParameterName): {
  $param: SkillParameterName;
} {
  return { $param: name };
}

export function readParameterName(
  value: unknown,
): SkillParameterName | undefined {
  if (!isRecord(value) || typeof value.$param !== 'string') {
    return undefined;
  }

  return isSkillParameterName(value.$param) ? value.$param : undefined;
}

export function blankSkillTools(
  tools: ToolCall[],
  blanks: SkillParameterName[],
): ToolCall[] {
  const wanted = new Set(blanks);

  return tools.map((tool) => {
    const args = { ...tool.args };

    if (tool.name === 'update_record' && typeof args.field === 'string') {
      const name = ARG_PARAMETERS[args.field];

      if (name && wanted.has(name)) {
        args.value = parameterMarker(name);
      }
    }

    for (const [key, name] of Object.entries(ARG_PARAMETERS)) {
      if (wanted.has(name) && Object.prototype.hasOwnProperty.call(args, key)) {
        args[key] = parameterMarker(name);
      }
    }

    return { name: tool.name, args };
  });
}

export function parametersIn(tools: ToolCall[]): SkillParameterName[] {
  const names: SkillParameterName[] = [];

  for (const tool of tools) {
    for (const value of Object.values(tool.args)) {
      const name = readParameterName(value);

      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
  }

  return names;
}

export function parameterPrompts(
  names: SkillParameterName[],
): SkillParameterPrompt[] {
  return names.map((name) => ({
    name,
    label: PARAMETER_LABELS[name],
    control: PARAMETER_CONTROLS[name],
    ...(name === 'stage' ? { options: [...STAGE_OPTIONS] } : {}),
  }));
}

export function parseSkillParameterValue(
  name: SkillParameterName,
  raw: unknown,
): { ok: true; value: string | number } | { ok: false; message: string } {
  if (name === 'amount') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      return {
        ok: false,
        message: 'parameterValues.amount must be a non-negative number.',
      };
    }

    return { ok: true, value: raw };
  }

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      ok: false,
      message: `parameterValues.${name} must be text.`,
    };
  }

  const value = raw.trim();

  if (name === 'stage') {
    const stage = canonicalOpportunityStage(value);

    if (!stage) {
      return {
        ok: false,
        message:
          'parameterValues.stage must be NEW, SCREENING, MEETING, PROPOSAL, or CUSTOMER.',
      };
    }

    return { ok: true, value: stage };
  }

  if (name === 'company') {
    if (!COMPANY_ID_PATTERN.test(value) || value.startsWith('$')) {
      return {
        ok: false,
        message: 'parameterValues.company must be a company id.',
      };
    }

    return { ok: true, value };
  }

  if (name === 'owner') {
    if (!OWNER_PATTERN.test(value)) {
      return {
        ok: false,
        message: 'parameterValues.owner must be "me" or a workspace member id.',
      };
    }

    return { ok: true, value };
  }

  if (name === 'closeDate') {
    if (!isCalendarDate(value)) {
      return {
        ok: false,
        message:
          'parameterValues.closeDate must be a calendar date, YYYY-MM-DD.',
      };
    }

    return { ok: true, value };
  }

  if (value.length > 80) {
    return {
      ok: false,
      message: `parameterValues.${name} must be 1–80 characters.`,
    };
  }

  return { ok: true, value };
}

export function fillSkillParameters(
  tools: ToolCall[],
  values: Partial<Record<SkillParameterName, string | number>>,
):
  | { ok: true; tools: ToolCall[] }
  | { ok: false; missing: SkillParameterPrompt[] } {
  const missing: SkillParameterPrompt[] = [];
  const filled = tools.map((tool) => {
    const args = { ...tool.args };

    for (const [key, value] of Object.entries(args)) {
      const name = readParameterName(value);

      if (!name) {
        continue;
      }

      const provided = values[name];

      if (
        provided === undefined ||
        (typeof provided === 'string' && provided.trim().length === 0)
      ) {
        const prompt = parameterPrompts([name])[0];

        if (prompt && !missing.some((item) => item.name === name)) {
          missing.push(prompt);
        }

        continue;
      }

      args[key] = provided;
    }

    return { name: tool.name, args };
  });

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, tools: filled };
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
