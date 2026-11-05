import type { CreatedRecord } from '../twenty/twenty-crm-client';
import { FIELD_METADATA_NAMES } from '../twenty/field-permission-names';
import type { ProposalChange } from './types';
import type { ValidatedTool } from './validate-tool';

type ReadySlot = { type: 'ready'; tool: ValidatedTool; record?: CreatedRecord };
type PreviewSlot = ReadySlot | { type: 'choice' };

export function changesFromSlots(slots: PreviewSlot[]): ProposalChange[] {
  const changes: ProposalChange[] = [];

  for (const slot of slots) {
    if (slot.type !== 'ready' || !slot.record) {
      continue;
    }

    if (slot.tool.name === 'update_record' && slot.tool.input.id) {
      const recordId = slot.tool.input.id;
      const field = slot.tool.input.field;
      const prior = [...changes]
        .reverse()
        .find(
          (change) => change.recordId === recordId && change.field === field,
        );
      const raw = prior ? prior.proposed : slot.record.properties[field];
      const current =
        typeof raw === 'string' || typeof raw === 'number' ? raw : null;

      changes.push(
        displayChange({
          objectName: slot.tool.input.objectName,
          recordId: slot.tool.input.id,
          label: slot.record.label,
          field,
          current,
          proposed: slot.tool.input.value,
          ifMatch: slot.tool.input.ifMatch ?? slot.record.etag,
        }),
      );
      continue;
    }

    if (
      slot.tool.name === 'archive_record' &&
      slot.tool.input.id &&
      slot.tool.input.ifMatch
    ) {
      changes.push(
        displayChange({
          objectName: slot.tool.input.objectName,
          recordId: slot.tool.input.id,
          label: slot.record.label,
          current: slot.record.label,
          proposed: null,
          ifMatch: slot.tool.input.ifMatch,
        }),
      );
    }
  }

  return changes;
}

export function displayChange(input: {
  objectName: 'person' | 'company' | 'opportunity';
  recordId: string;
  label: string;
  field?: string;
  current: string | number | null;
  proposed: string | number | null;
  ifMatch: string;
}): ProposalChange {
  const metadataNames = input.field
    ? FIELD_METADATA_NAMES[input.objectName][input.field]
    : undefined;
  const summary = input.field
    ? `Current ${input.field} ${displayValue(input.current)}. Proposed ${displayValue(input.proposed)}.`
    : `Current ${input.label}. Proposed archived.`;

  return {
    objectName: input.objectName,
    recordId: input.recordId,
    label: input.label,
    ...(input.field ? { field: input.field } : {}),
    ...(metadataNames?.[0] ? { metadataField: metadataNames[0] } : {}),
    current: input.current,
    proposed: input.proposed,
    ifMatch: input.ifMatch,
    summary,
  };
}

function displayValue(value: string | number | null): string {
  if (value === null) {
    return 'empty';
  }

  if (typeof value === 'number') {
    return value.toLocaleString('en-US');
  }

  return `“${value}”`;
}
