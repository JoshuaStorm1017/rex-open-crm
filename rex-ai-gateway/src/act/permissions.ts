import type {
  MemberCapabilities,
  TimelineObjectName,
  TwentyCrmClient,
  TwentyObjectName,
} from '../twenty/twenty-crm-client';
import type { ActEffect } from './types';
import { refusal, type ActRefusal, type AllowedToolName } from './types';
import { toolCatalog, type ToolAudience } from './tool-schema';
import type { ValidatedTool } from './validate-tool';
import { isUpdatableObjectName } from './writable-fields';

export type AudienceLoad =
  | { kind: 'unrestricted' }
  | { kind: 'restricted'; audience: ToolAudience }
  | { kind: 'unavailable' };

const OBJECT_NAMES = new Set([
  'person',
  'company',
  'opportunity',
  'note',
  'task',
  'timelineActivity',
]);

export async function loadAudience(client: TwentyCrmClient): Promise<AudienceLoad> {
  if (!client.loadCapabilities) {
    return { kind: 'unrestricted' };
  }

  try {
    const capabilities = await client.loadCapabilities();

    if (capabilities.unavailable) {
      return { kind: 'unavailable' };
    }

    return { kind: 'restricted', audience: audienceFrom(capabilities) };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function catalogForAudience(
  load: AudienceLoad,
): ReturnType<typeof toolCatalog> | ActRefusal {
  if (load.kind === 'unavailable') {
    return refusal(
      'forbidden',
      'Permissions could not be read from Twenty, so no actions are available.',
    );
  }

  if (load.kind === 'unrestricted') {
    return toolCatalog();
  }

  return toolCatalog(load.audience);
}

export function assertToolPermitted(
  tool: ValidatedTool,
  load: AudienceLoad,
): ActRefusal | undefined {
  if (load.kind === 'unrestricted') {
    return undefined;
  }

  if (load.kind === 'unavailable') {
    return refusal(
      'forbidden',
      'Permissions could not be read from Twenty, so this action was not run.',
      { toolName: tool.name },
    );
  }

  const { audience } = load;

  switch (tool.name) {
    case 'create_person':
      return assertCreate(audience, 'person', tool.name, fieldsOnPerson(tool.input));
    case 'create_company':
      return assertCreate(audience, 'company', tool.name, fieldsOnCompany(tool.input));
    case 'create_opportunity':
      return assertCreate(audience, 'opportunity', tool.name, fieldsOnOpportunity(tool.input));
    case 'create_note':
      if (!audience.canCreate.has('note')) {
        return refusal('forbidden', 'You cannot add notes.', { toolName: tool.name });
      }

      if (!audience.canRead.has(tool.input.targetObject)) {
        return refusal(
          'forbidden',
          `You cannot read ${tool.input.targetObject} records, so a note cannot be linked.`,
          { toolName: tool.name },
        );
      }

      return undefined;
    case 'search_records':
      return audience.canRead.has(tool.input.objectName)
        ? undefined
        : refusal('forbidden', `You cannot search ${tool.input.objectName} records.`, {
            toolName: tool.name,
          });
    case 'search_notes':
      return requireTimelineRead(audience, 'note', tool.name, 'notes');
    case 'search_tasks':
      return requireTimelineRead(audience, 'task', tool.name, 'tasks');
    case 'search_activities':
      return requireTimelineRead(audience, 'timelineActivity', tool.name, 'activities');
    case 'update_record':
    case 'update_matching_records':
      if (
        !audience.canRead.has(tool.input.objectName) ||
        !audience.canUpdate.has(tool.input.objectName)
      ) {
        return refusal('forbidden', `You cannot update ${tool.input.objectName} records.`, {
          toolName: tool.name,
        });
      }

      return assertFieldWritable(audience, tool.input.objectName, tool.input.field, tool.name, 'changed');
    case 'archive_record':
      if (
        !audience.canRead.has(tool.input.objectName) ||
        !audience.canSoftDelete.has(tool.input.objectName)
      ) {
        return refusal('forbidden', `You cannot archive ${tool.input.objectName} records.`, {
          toolName: tool.name,
        });
      }

      return undefined;
  }
}

export function assertCanUndo(effects: ActEffect[], load: AudienceLoad): ActRefusal | undefined {
  if (load.kind === 'unrestricted') {
    return undefined;
  }

  if (load.kind === 'unavailable') {
    return refusal('forbidden', 'Permissions could not be read from Twenty, so this undo was not run.');
  }

  for (const effect of effects) {
    if (effect.kind === 'archived') {
      if (
        !load.audience.canRead.has(effect.objectName) ||
        !load.audience.canSoftDelete.has(effect.objectName)
      ) {
        return refusal(
          'forbidden',
          `You cannot archive ${effect.objectName} records, so this archive cannot be undone.`,
        );
      }
    }

    if (effect.kind === 'created') {
      const permissionObject = effect.objectName === 'noteTarget' ? 'note' : effect.objectName;

      if (!load.audience.canSoftDelete.has(permissionObject)) {
        return refusal(
          'forbidden',
          `You cannot delete ${effect.objectName} records, so this create cannot be undone.`,
        );
      }
    }

    if (effect.kind === 'updated') {
      if (
        !load.audience.canRead.has(effect.objectName) ||
        !load.audience.canUpdate.has(effect.objectName)
      ) {
        return refusal(
          'forbidden',
          `You cannot update ${effect.objectName} records, so this change cannot be undone.`,
        );
      }

      const fieldRefusal = assertFieldWritable(
        load.audience,
        effect.objectName,
        effect.field,
        'update_record',
        'restored',
      );

      if (fieldRefusal) {
        return fieldRefusal;
      }
    }
  }

  return undefined;
}

function assertCreate(
  audience: ToolAudience,
  objectName: 'person' | 'company' | 'opportunity',
  toolName: AllowedToolName,
  fields: string[],
): ActRefusal | undefined {
  const createRefusal = requireCreate(audience, objectName, toolName);

  if (createRefusal) {
    return createRefusal;
  }

  for (const field of fields) {
    const fieldRefusal = assertFieldWritable(audience, objectName, field, toolName, 'set');

    if (fieldRefusal) {
      return fieldRefusal;
    }
  }

  return undefined;
}

function fieldsOnPerson(input: {
  firstName: string;
  lastName: string;
  email?: string;
  jobTitle?: string;
  phone?: string;
  linkedin?: string;
}): string[] {
  return presentFields(
    [
      ['firstName', input.firstName],
      ['lastName', input.lastName],
      ['email', input.email],
      ['jobTitle', input.jobTitle],
      ['phone', input.phone],
      ['linkedin', input.linkedin],
    ],
  );
}

function fieldsOnCompany(input: {
  name: string;
  domain?: string;
  linkedin?: string;
  address?: string;
  city?: string;
}): string[] {
  return presentFields([
    ['name', input.name],
    ['domain', input.domain],
    ['linkedin', input.linkedin],
    ['address', input.address],
    ['city', input.city],
  ]);
}

function fieldsOnOpportunity(input: {
  name: string;
  stage: string;
  amount?: number;
  closeDate?: string;
}): string[] {
  return presentFields([
    ['name', input.name],
    ['stage', input.stage],
    ['amount', input.amount],
    ['closeDate', input.closeDate],
  ]);
}

function presentFields(fields: Array<[string, string | number | undefined]>): string[] {
  return fields.flatMap(([name, value]) => (value === undefined ? [] : [name]));
}

function requireTimelineRead(
  audience: ToolAudience,
  objectName: TimelineObjectName,
  toolName: AllowedToolName,
  label: string,
): ActRefusal | undefined {
  if (audience.canReadTimeline.has(objectName)) {
    return undefined;
  }

  return refusal('forbidden', `You cannot search ${label}.`, { toolName });
}

function assertFieldWritable(
  audience: ToolAudience,
  objectName: TwentyObjectName,
  field: string,
  toolName: AllowedToolName,
  verb: 'changed' | 'restored' | 'set',
): ActRefusal | undefined {
  if (audience.fieldPermissionsUnreadable?.has(objectName) || audience.unreadableFields?.get(objectName)?.has(field)) {
    return refusal(
      'forbidden',
      `Field permissions for ${objectName}.${field} could not be read from Twenty, so it was not ${verb}.`,
      { toolName },
    );
  }

  const writable = audience.writableFields?.get(objectName);

  if (!writable) {
    return undefined;
  }

  if (writable.has(field)) {
    return undefined;
  }

  const action = verb === 'set' ? 'set' : verb === 'restored' ? 'restore' : 'update';

  return refusal('forbidden', `You cannot ${action} ${field} on ${objectName} records.`, { toolName });
}

function isRecordPermissionObject(
  objectName: string,
): objectName is TwentyObjectName | 'note' {
  return (
    objectName === 'person' ||
    objectName === 'company' ||
    objectName === 'opportunity' ||
    objectName === 'note'
  );
}

function requireCreate(
  audience: ToolAudience,
  objectName: 'person' | 'company' | 'opportunity',
  toolName: AllowedToolName,
): ActRefusal | undefined {
  if (audience.canCreate.has(objectName)) {
    return undefined;
  }

  return refusal('forbidden', `You cannot create ${objectName} records.`, { toolName });
}

function audienceFrom(capabilities: MemberCapabilities): ToolAudience {
  const canRead = new Set<TwentyObjectName>();
  const canCreate = new Set<TwentyObjectName | 'note'>();
  const canUpdate = new Set<TwentyObjectName | 'note'>();
  const canSoftDelete = new Set<TwentyObjectName | 'note'>();
  const writableFields = new Map<TwentyObjectName, Set<string>>();
  const unreadableFields = new Map<TwentyObjectName, Set<string>>();
  const fieldPermissionsUnreadable = new Set<TwentyObjectName>();
  const canReadTimeline = new Set<TimelineObjectName>();

  for (const object of capabilities.objects) {
    if (!OBJECT_NAMES.has(object.objectName)) {
      continue;
    }

    if (object.objectName !== 'note' && object.objectName !== 'task' && object.objectName !== 'timelineActivity' && object.canRead) {
      canRead.add(object.objectName);
    }

    if (
      (object.objectName === 'note' || object.objectName === 'task' || object.objectName === 'timelineActivity') &&
      object.canRead
    ) {
      canReadTimeline.add(object.objectName);
    }

    if (isRecordPermissionObject(object.objectName)) {
      if (object.canCreate ?? object.canUpdate) {
        canCreate.add(object.objectName);
      }

      if (object.canUpdate) {
        canUpdate.add(object.objectName);
      }

      if (object.canSoftDelete) {
        canSoftDelete.add(object.objectName);
      }
    }

    if (!isUpdatableObjectName(object.objectName) || object.fieldPermissions === undefined) {
      continue;
    }

    if (object.fieldPermissions === 'unavailable') {
      fieldPermissionsUnreadable.add(object.objectName);
      continue;
    }

    const writable = new Set<string>();
    const unreadable = new Set<string>();

    for (const field of object.fieldPermissions) {
      if (field.unreadable) {
        unreadable.add(field.name);
        continue;
      }

      if (field.canUpdate) {
        writable.add(field.name);
      }
    }

    writableFields.set(object.objectName, writable);
    if (unreadable.size > 0) {
      unreadableFields.set(object.objectName, unreadable);
    }
  }

  return {
    canRead,
    canCreate,
    canUpdate,
    canSoftDelete,
    canReadTimeline,
    ...(writableFields.size > 0 ? { writableFields } : {}),
    ...(unreadableFields.size > 0 ? { unreadableFields } : {}),
    ...(fieldPermissionsUnreadable.size > 0 ? { fieldPermissionsUnreadable } : {}),
  };
}
