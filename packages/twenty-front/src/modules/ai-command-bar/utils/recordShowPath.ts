import { AppPath } from 'twenty-shared/types';
import { getAppPath } from 'twenty-shared/utils';

export const recordShowPath = (objectNameSingular: string, recordId: string) =>
  getAppPath(AppPath.RecordShowPage, {
    objectNameSingular,
    objectRecordId: recordId,
  });
