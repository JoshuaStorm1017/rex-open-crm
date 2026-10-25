import { isRecord } from '../is-record';

// Gateway workspace ids are caller tokens (`ws_demo`), not Twenty row ids.
// A full-string `ws_*` value anywhere in the args is another workspace.
export const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9_-]+$/;

export function findForeignWorkspaceId(
  value: unknown,
  requestWorkspaceId: string,
): string | undefined {
  if (typeof value === 'string') {
    return value !== requestWorkspaceId && WORKSPACE_ID_PATTERN.test(value)
      ? value
      : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForeignWorkspaceId(item, requestWorkspaceId);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      (key === 'workspaceId' || key === 'workspace_id') &&
      typeof child === 'string' &&
      child !== requestWorkspaceId
    ) {
      return child;
    }

    const found = findForeignWorkspaceId(child, requestWorkspaceId);

    if (found) {
      return found;
    }
  }

  return undefined;
}
