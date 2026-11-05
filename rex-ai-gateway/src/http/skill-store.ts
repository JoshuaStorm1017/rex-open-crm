import { randomUUID } from 'node:crypto';

import { isRecord } from '../is-record';
import { parametersIn } from '../act/skill-parameters';
import type { ToolCall } from '../act/types';

export const SKILL_LIMIT = 20;
export const CONFIRMED_PLAN_LIMIT = 40;
export const CONFIRMED_PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredSkill = {
  id: string;
  memberId: string;
  workspaceId: string;
  name: string;
  tools: ToolCall[];
  createdAt: number;
};

export type ConfirmedPlan = {
  id: string;
  memberId: string;
  workspaceId: string;
  tools: ToolCall[];
  createdAt: number;
};

export type SkillSummary = {
  id: string;
  name: string;
  tools: string[];
  parameters?: string[];
};

export type SaveSkillResult =
  | { ok: true; skill: StoredSkill }
  | { ok: false; reason: 'duplicate' | 'full' | 'empty' };

export class SkillStore {
  private readonly confirmed: ConfirmedPlan[] = [];
  private readonly skills: StoredSkill[] = [];

  saveConfirmed(
    memberId: string,
    workspaceId: string,
    tools: ToolCall[],
    now = Date.now(),
  ): ConfirmedPlan | undefined {
    const stored = cloneTools(tools);

    if (stored.length === 0) {
      return undefined;
    }

    this.dropExpired(now);
    const plan: ConfirmedPlan = {
      id: `confirmed_${randomUUID()}`,
      memberId,
      workspaceId,
      tools: stored,
      createdAt: now,
    };
    this.confirmed.push(plan);

    if (this.confirmed.length > CONFIRMED_PLAN_LIMIT) {
      this.confirmed.splice(0, this.confirmed.length - CONFIRMED_PLAN_LIMIT);
    }

    return plan;
  }

  readConfirmed(
    id: string,
    memberId: string,
    now = Date.now(),
  ): ConfirmedPlan | undefined {
    this.dropExpired(now);

    return this.confirmed.find(
      (plan) => plan.id === id && plan.memberId === memberId,
    );
  }

  saveSkill(
    memberId: string,
    workspaceId: string,
    name: string,
    tools: ToolCall[],
  ): SaveSkillResult {
    const stored = cloneTools(tools);

    if (stored.length === 0) {
      return { ok: false, reason: 'empty' };
    }

    const owned = this.skills.filter(
      (skill) =>
        skill.memberId === memberId && skill.workspaceId === workspaceId,
    );

    if (
      owned.some((skill) => skill.name.toLowerCase() === name.toLowerCase())
    ) {
      return { ok: false, reason: 'duplicate' };
    }

    if (owned.length >= SKILL_LIMIT) {
      return { ok: false, reason: 'full' };
    }

    const skill: StoredSkill = {
      id: `skill_${randomUUID()}`,
      memberId,
      workspaceId,
      name,
      tools: stored,
      createdAt: Date.now(),
    };
    this.skills.push(skill);

    return { ok: true, skill };
  }

  list(memberId: string, workspaceId: string): SkillSummary[] {
    return this.skills
      .filter(
        (skill) =>
          skill.memberId === memberId && skill.workspaceId === workspaceId,
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(summarize);
  }

  read(id: string, memberId: string): StoredSkill | undefined {
    return this.skills.find(
      (skill) => skill.id === id && skill.memberId === memberId,
    );
  }

  private dropExpired(now: number): void {
    const cutoff = now - CONFIRMED_PLAN_TTL_MS;

    for (let index = this.confirmed.length - 1; index >= 0; index -= 1) {
      const plan = this.confirmed[index];

      if (plan && plan.createdAt <= cutoff) {
        this.confirmed.splice(index, 1);
      }
    }
  }
}

export function summarize(skill: StoredSkill): SkillSummary {
  const parameters = parametersIn(skill.tools);

  return {
    id: skill.id,
    name: skill.name,
    tools: skill.tools.map((tool) => tool.name),
    ...(parameters.length > 0 ? { parameters } : {}),
  };
}

export function cloneTools(tools: ToolCall[]): ToolCall[] {
  return tools.flatMap((tool) => {
    if (
      !isRecord(tool) ||
      typeof tool.name !== 'string' ||
      !isRecord(tool.args)
    ) {
      return [];
    }

    return [{ name: tool.name, args: { ...tool.args } }];
  });
}
