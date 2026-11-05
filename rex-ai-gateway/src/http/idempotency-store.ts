import { createHash } from 'node:crypto';

export type IdempotentResponse = {
  status: number;
  body: unknown;
};

type Completed = {
  hash: string;
  response: IdempotentResponse;
};

type RunResult =
  | { conflict: true }
  | { full: true }
  | { response: IdempotentResponse; replayed: boolean };

export class IdempotencyStore {
  private readonly completed = new Map<string, Completed>();
  private readonly inflight = new Map<string, { hash: string; promise: Promise<IdempotentResponse> }>();

  constructor(private readonly capacity = 500) {}

  async run(
    memberId: string,
    key: string,
    rawBody: string,
    execute: () => Promise<IdempotentResponse>,
  ): Promise<RunResult> {
    const hash = createHash('sha256').update(rawBody).digest('hex');
    const storageKey = `${memberId}\n${key}`;
    const existing = this.readCompleted(memberId, key);

    if (existing) {
      if (existing.hash !== hash) {
        return { conflict: true };
      }

      return { response: existing.response, replayed: true };
    }

    const current = this.inflight.get(storageKey);

    if (current) {
      if (current.hash !== hash) {
        return { conflict: true };
      }

      return { response: await current.promise, replayed: true };
    }

    if (this.countCompleted() >= this.capacity) {
      return { full: true };
    }

    const promise = execute();
    this.inflight.set(storageKey, { hash, promise });

    try {
      const response = await promise;
      this.writeCompleted(memberId, key, hash, response);
      return { response, replayed: false };
    } finally {
      this.inflight.delete(storageKey);
    }
  }

  protected readCompleted(
    memberId: string,
    key: string,
  ): { hash: string; response: IdempotentResponse } | undefined {
    return this.completed.get(`${memberId}\n${key}`);
  }

  protected countCompleted(): number {
    return this.completed.size;
  }

  protected writeCompleted(
    memberId: string,
    key: string,
    hash: string,
    response: IdempotentResponse,
  ): void {
    this.completed.set(`${memberId}\n${key}`, { hash, response });
  }
}

export function readIdempotencyKey(header: string | undefined): string | undefined | 'invalid' {
  if (header === undefined || header.trim().length === 0) {
    return undefined;
  }

  const key = header.trim();

  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) {
    return 'invalid';
  }

  return key;
}
