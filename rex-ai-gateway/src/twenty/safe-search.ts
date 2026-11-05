const SAFE_SEARCH_QUERY = /^[\p{L}\p{N}][\p{L}\p{N} .@'+-]{0,79}$/u;

export class UnsafeSearchQueryError extends Error {
  constructor() {
    super('Refusing to interpolate an unsafe search query into a Twenty filter.');
    this.name = 'UnsafeSearchQueryError';
  }
}

export function isSafeSearchQuery(query: string): boolean {
  return SAFE_SEARCH_QUERY.test(query);
}

export function assertSafeSearchQuery(query: string): void {
  if (!isSafeSearchQuery(query)) {
    throw new UnsafeSearchQueryError();
  }
}

export function quoteFilterValue(value: string): string {
  assertSafeSearchQuery(value.replace(/^%|%$/g, ''));

  return JSON.stringify(value);
}
