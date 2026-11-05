export const OPPORTUNITY_STAGES = [
  'NEW',
  'SCREENING',
  'MEETING',
  'PROPOSAL',
  'CUSTOMER',
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

const STAGE_SET = new Set<string>(OPPORTUNITY_STAGES);

export function canonicalOpportunityStage(value: string): OpportunityStage | undefined {
  const canonical = value.trim().toUpperCase();

  return STAGE_SET.has(canonical) ? (canonical as OpportunityStage) : undefined;
}
