import type { ProposalCreate, ProposalCreateCell } from './types';
import type { ValidatedTool } from './validate-tool';

type PreviewSlot = { type: 'ready'; tool: ValidatedTool } | { type: 'choice' };

export function createsFromSlots(slots: PreviewSlot[]): ProposalCreate[] {
  const creates: ProposalCreate[] = [];

  for (const slot of slots) {
    if (slot.type !== 'ready') {
      continue;
    }

    if (slot.tool.name === 'create_person') {
      const name = `${slot.tool.input.firstName} ${slot.tool.input.lastName}`;
      const detail = [slot.tool.input.email, slot.tool.input.jobTitle].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );

      creates.push({
        objectName: 'person',
        label: name,
        summary: detail.join(' · '),
        cells: cellsFor([
          ['name', name],
          ['email', slot.tool.input.email],
        ]),
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
        cells: cellsFor([
          ['name', slot.tool.input.name],
          ['domain', slot.tool.input.domain],
        ]),
      });
    }

    if (slot.tool.name === 'create_opportunity') {
      const amount =
        slot.tool.input.amount === undefined
          ? undefined
          : String(slot.tool.input.amount);
      const detail = [amount, slot.tool.input.stage].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      );

      creates.push({
        objectName: 'opportunity',
        label: slot.tool.input.name,
        summary: detail.join(' · '),
        cells: cellsFor([
          ['name', slot.tool.input.name],
          ['amount', amount],
          ['stage', slot.tool.input.stage],
        ]),
      });
    }
  }

  return creates;
}

function cellsFor(
  pairs: Array<[ProposalCreateCell['field'], string | undefined]>,
): ProposalCreateCell[] {
  return pairs.flatMap(([field, value]) =>
    value && value.length > 0 ? [{ field, value }] : [],
  );
}
