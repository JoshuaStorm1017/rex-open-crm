export class CrmNotFoundError extends Error {
  readonly code = 'not_found' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CrmNotFoundError';
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
