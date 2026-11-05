export class CrmNotFoundError extends Error {
  readonly code = 'not_found' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CrmNotFoundError';
  }
}

export class CrmPartialWriteError extends Error {
  readonly code = 'partial_failure' as const;
  readonly remainingRecordIds: string[];

  constructor(message: string, remainingRecordIds: string[]) {
    super(message);
    this.name = 'CrmPartialWriteError';
    this.remainingRecordIds = remainingRecordIds;
  }
}

export class CrmPreconditionError extends Error {
  readonly code = 'precondition_failed' as const;
  readonly currentEtag: string;

  constructor(message: string, currentEtag: string) {
    super(message);
    this.name = 'CrmPreconditionError';
    this.currentEtag = currentEtag;
  }
}
