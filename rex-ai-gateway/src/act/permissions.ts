import type {
  MemberCapabilities,
  TwentyCrmClient,
  TwentyObjectName,
} from '../twenty/twenty-crm-client';
import type { ActEffect } from './types';
import { refusal, type ActRefusal, type AllowedToolName } from './types';
import { toolCatalog, type ToolAudience } from './tool-schema';
import type { ValidatedTool } from './validate-tool';

export type AudienceLoad =
  | { kind: 'unrestricted' }
  | { kind: 'restricted'; audience: ToolAudience }
  | { kind: 'unavailable' };

const OBJECT_NAMES = new Set(['person', 'company', 'opportunity', 'note']);

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
      return requireUpdate(audience, 'person', tool.name);
    case 'create_company':
      return requireUpdate(audience, 'company', tool.name);
    case 'create_opportunity':
      return requireUpdate(audience, 'opportunity', tool.name);
    case 'create_note':
      if (!audience.canUpdate.has('note')) {
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
    case 'update_record':
      if (
        !audience.canRead.has(tool.input.objectName) ||
        !audience.canUpdate.has(tool.input.objectName)
      ) {
        return refusal('forbidden', `You cannot update ${tool.input.objectName} records.`, {
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
    if (effect.kind === 'created') {
      const permissionObject = effect.objectName === 'noteTarget' ? 'note' : effect.objectName;

      if (!load.audience.canSoftDelete.has(permissionObject)) {
        return refusal(
          'forbidden',
          `You cannot delete ${effect.objectName} records, so this create cannot be undone.`,
        );
      }
    }

    if (
      effect.kind === 'updated' &&
      (!load.audience.canRead.has(effect.objectName) ||
        !load.audience.canUpdate.has(effect.objectName))
    ) {
      return refusal(
        'forbidden',
        `You cannot update ${effect.objectName} records, so this change cannot be undone.`,
      );
    }
  }

  return undefined;
}

function requireUpdate(
  audience: ToolAudience,
  objectName: 'person' | 'company' | 'opportunity',
  toolName: AllowedToolName,
): ActRefusal | undefined {
  if (audience.canUpdate.has(objectName)) {
    return undefined;
  }

  return refusal('forbidden', `You cannot create ${objectName} records.`, { toolName });
}

function audienceFrom(capabilities: MemberCapabilities): ToolAudience {
  const canRead = new Set<TwentyObjectName>();
  const canUpdate = new Set<TwentyObjectName | 'note'>();
  const canSoftDelete = new Set<TwentyObjectName | 'note'>();

  for (const object of capabilities.objects) {
    if (!OBJECT_NAMES.has(object.objectName)) {
      continue;
    }

    if (object.objectName !== 'note' && object.canRead) {
      canRead.add(object.objectName);
    }

    if (object.canUpdate) {
      canUpdate.add(object.objectName);
    }

    if (object.canSoftDelete) {
      canSoftDelete.add(object.objectName);
    }
  }

  return { canRead, canUpdate, canSoftDelete };
}
