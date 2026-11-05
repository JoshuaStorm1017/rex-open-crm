import { AppPath } from 'twenty-shared/types';
import { getAppPath } from 'twenty-shared/utils';

const SAFE_OBJECT_NAME = /^(person|company|opportunity)$/;
const SAFE_RECORD_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const recordShowPath = (
  objectNameSingular: string,
  recordId: string,
): string | undefined => {
  if (
    !SAFE_OBJECT_NAME.test(objectNameSingular) ||
    !SAFE_RECORD_ID.test(recordId)
  ) {
    return undefined;
  }

  return getAppPath(AppPath.RecordShowPage, {
    objectNameSingular,
    objectRecordId: recordId,
  });
};
