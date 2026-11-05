export type OpenRecordContext = {
  objectName: 'person' | 'company' | 'opportunity';
  recordId: string;
};

const OPEN_RECORD_PATH =
  /\/object\/(?<objectName>person|company|opportunity)\/(?<recordId>[A-Za-z0-9_-]{1,80})(?:\/|$)/;

export const readOpenRecordFromPath = (
  pathname: string,
): OpenRecordContext | undefined => {
  const match = OPEN_RECORD_PATH.exec(pathname);
  const objectName = match?.groups?.objectName;
  const recordId = match?.groups?.recordId;

  if (
    (objectName !== 'person' &&
      objectName !== 'company' &&
      objectName !== 'opportunity') ||
    recordId === undefined
  ) {
    return undefined;
  }

  return { objectName, recordId };
};
