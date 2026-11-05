import { isRecord } from '../is-record';
import type { ToolCall } from './types';

export const SKILL_PARAMETER_NAMES = ['city', 'amount', 'stage'] as const;

export type SkillParameterName = (typeof SKILL_PARAMETER_NAMES)[number];

export type SkillParameterPrompt = {
  name: SkillParameterName;
  label: string;
};

const PARAMETER_LABELS: Record<SkillParameterName, string> = {
  city: 'City',
  amount: 'Amount',
  stage: 'Stage',
};

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

    if (
      tool.name === 'update_record' &&
      typeof args.field === 'string' &&
      isSkillParameterName(args.field) &&
      wanted.has(args.field)
    ) {
      args.value = parameterMarker(args.field);
    }

    for (const name of wanted) {
      if (Object.prototype.hasOwnProperty.call(args, name)) {
        args[name] = parameterMarker(name);
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
  return names.map((name) => ({ name, label: PARAMETER_LABELS[name] }));
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
        if (!missing.some((item) => item.name === name)) {
          missing.push({ name, label: PARAMETER_LABELS[name] });
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
