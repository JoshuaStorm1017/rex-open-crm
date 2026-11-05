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
  | { conflict?: false; response: IdempotentResponse; replayed: boolean };

export class IdempotencyStore {
  private readonly completed = new Map<string, Completed>();
  private readonly order: string[] = [];
  private readonly inflight = new Map<string, { hash: string; promise: Promise<IdempotentResponse> }>();

  constructor(private readonly capacity = 500) {}

  async run(
    key: string,
    rawBody: string,
    execute: () => Promise<IdempotentResponse>,
  ): Promise<RunResult> {
    const hash = createHash('sha256').update(rawBody).digest('hex');
    const existing = this.completed.get(key);

    if (existing) {
      if (existing.hash !== hash) {
        return { conflict: true };
      }

      return { response: existing.response, replayed: true };
    }

    const current = this.inflight.get(key);

    if (current) {
      if (current.hash !== hash) {
        return { conflict: true };
      }

      return { response: await current.promise, replayed: true };
    }

    const promise = execute();
    this.inflight.set(key, { hash, promise });

    try {
      const response = await promise;
      this.remember(key, hash, response);
      return { response, replayed: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  private remember(key: string, hash: string, response: IdempotentResponse): void {
    if (!this.completed.has(key)) {
      this.order.push(key);
    }

    this.completed.set(key, { hash, response });

    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();

      if (oldest) {
        this.completed.delete(oldest);
      }
    }
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
