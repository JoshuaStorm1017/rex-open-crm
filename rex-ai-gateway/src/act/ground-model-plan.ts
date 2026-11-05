import { refusal, type ActRefusal, type ToolCall } from './types';
import type { VisibleRecord } from './visible-snapshot';

const RELATION_FIELDS = ['id', 'targetId', 'companyId', 'pointOfContactId'] as const;

// The model may repeat an id the member typed. Anything else is a guess, and a guess is not a recordRef.
export function groundModelPlan(
  tools: ToolCall[],
  intent: string,
  snapshot: VisibleRecord[],
): ToolCall[] | ActRefusal {
  const byRef = new Map(snapshot.map((record) => [record.ref, record]));
  const grounded: ToolCall[] = [];

  for (const tool of tools) {
    const args = { ...tool.args };
    const recordRef = typeof args.recordRef === 'string' ? args.recordRef : undefined;

    if (recordRef && recordRef !== 'open') {
      const visible = byRef.get(recordRef);

      if (!visible) {
        return refusal(
          'invalid_request',
          `Unknown recordRef "${recordRef}". Use a handle from the visible list, "open", or a name query.`,
          { toolName: tool.name },
        );
      }

      if (tool.name === 'create_note') {
        args.targetObject = visible.objectName;
        args.targetId = visible.id;
        delete args.targetQuery;
        delete args.id;
        delete args.recordRef;
      } else if (tool.name === 'update_record' || tool.name === 'archive_record') {
        args.object = visible.objectName;
        args.id = visible.id;
        delete args.query;
        delete args.recordRef;
      } else {
        return refusal('invalid_request', `${tool.name} does not accept recordRef.`, {
          toolName: tool.name,
        });
      }
    }

    for (const key of RELATION_FIELDS) {
      const value = args[key];

      if (typeof value !== 'string' || /^\$[0-9]+$/.test(value)) {
        continue;
      }

      const visible = byRef.get(value);

      if (visible) {
        args[key] = visible.id;
        continue;
      }

      if (recordRef === 'open' && (key === 'id' || key === 'targetId')) {
        continue;
      }

      if (recordRef && recordRef !== 'open' && (key === 'id' || key === 'targetId')) {
        continue;
      }

      if (intentIncludesId(intent, value)) {
        continue;
      }

      return refusal(
        'invalid_request',
        'The model cannot choose a record id. Use recordRef or a name query.',
        { toolName: tool.name },
      );
    }

    grounded.push({ name: tool.name, args });
  }

  return grounded;
}

const UUID_TOKEN =
  /^(?:[A-Za-z]+_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intentIncludesId(intent: string, id: string): boolean {
  // Only a UUID the member typed is an id. A long word in the sentence is not.
  if (!UUID_TOKEN.test(id)) {
    return false;
  }

  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:[^A-Za-z0-9_-]|$)`, 'i').test(intent);
}
