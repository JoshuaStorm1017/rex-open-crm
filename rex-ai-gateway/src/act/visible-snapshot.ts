import type { AudienceLoad } from './permissions';
import { matchDetail } from './create-new-choice';
import type { CreatedRecord, TwentyCrmClient, TwentyObjectName } from '../twenty/twenty-crm-client';

export type VisibleRecord = {
  ref: string;
  objectName: TwentyObjectName;
  id: string;
  label: string;
  detail: string;
};

const RECENT_LIMIT = 5;
const PREFIX: Record<TwentyObjectName, string> = {
  person: 'p',
  company: 'c',
  opportunity: 'o',
};

export async function loadVisibleSnapshot(
  client: TwentyCrmClient,
  workspaceId: string,
  audience: AudienceLoad,
): Promise<VisibleRecord[]> {
  if (audience.kind === 'unavailable') {
    return [];
  }

  const names = (['person', 'company', 'opportunity'] as const).filter((name) =>
    audience.kind === 'unrestricted' ? true : audience.audience.canRead.has(name),
  );
  const visible: VisibleRecord[] = [];

  for (const objectName of names) {
    let records: CreatedRecord[] = [];

    try {
      records = await client.listRecent({ workspaceId, objectName, limit: RECENT_LIMIT });
    } catch {
      // One object failing to list should not hide the others from the planner.
      continue;
    }

    records.slice(0, RECENT_LIMIT).forEach((record, index) => {
      visible.push({
        ref: `${PREFIX[objectName]}${index + 1}`,
        objectName,
        id: record.id,
        label: record.label,
        detail: matchDetail(record),
      });
    });
  }

  return visible;
}

export function publicVisibleRecords(
  records: VisibleRecord[],
): Array<Omit<VisibleRecord, 'id'>> {
  return records.map(({ ref, objectName, label, detail }) => ({
    ref,
    objectName,
    label,
    detail,
  }));
}
