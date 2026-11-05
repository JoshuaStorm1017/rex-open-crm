import type { ProposalCreate } from './types';
import type { ValidatedTool } from './validate-tool';

type PreviewSlot = { type: 'ready'; tool: ValidatedTool } | { type: 'choice' };

export function createsFromSlots(slots: PreviewSlot[]): ProposalCreate[] {
  const creates: ProposalCreate[] = [];

  for (const slot of slots) {
    if (slot.type !== 'ready') {
      continue;
    }

    if (slot.tool.name === 'create_person') {
      const detail = [slot.tool.input.email, slot.tool.input.jobTitle].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );

      creates.push({
        objectName: 'person',
        label: `${slot.tool.input.firstName} ${slot.tool.input.lastName}`,
        summary: detail.join(' · '),
      });
    }

    if (slot.tool.name === 'create_company') {
      const detail = [slot.tool.input.domain, slot.tool.input.city].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );

      creates.push({
        objectName: 'company',
        label: slot.tool.input.name,
        summary: detail.join(' · '),
      });
    }
  }

  return creates;
}
