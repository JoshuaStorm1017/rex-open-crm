import { randomUUID } from 'node:crypto';

import {
  type CreatedRecord,
  type TwentyCrmClient,
  companyProperties,
  opportunityProperties,
  personProperties,
} from './twenty-crm-client';

export type MockTwentyCrmClient = TwentyCrmClient & {
  created: CreatedRecord[];
};

export function createMockTwentyCrmClient(): MockTwentyCrmClient {
  const created: CreatedRecord[] = [];

  return {
    created,
    async createPerson(input) {
      const record: CreatedRecord = {
        id: `person_${randomUUID()}`,
        objectName: 'person',
        workspaceId: input.workspaceId,
        properties: personProperties(input),
      };
      created.push(record);
      return record;
    },
    async createCompany(input) {
      const record: CreatedRecord = {
        id: `company_${randomUUID()}`,
        objectName: 'company',
        workspaceId: input.workspaceId,
        properties: companyProperties(input),
      };
      created.push(record);
      return record;
    },
    async createOpportunity(input) {
      const record: CreatedRecord = {
        id: `opportunity_${randomUUID()}`,
        objectName: 'opportunity',
        workspaceId: input.workspaceId,
        properties: opportunityProperties(input),
      };
      created.push(record);
      return record;
    },
  };
}
