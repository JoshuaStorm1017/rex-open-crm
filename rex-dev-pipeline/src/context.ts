import { createHash } from 'node:crypto';

import { isRecord } from './redact';
import type { ContextSource } from './types';

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashSources(sources: ContextSource[]): string {
  return contentHash(
    sources.map((source) => ({
      kind: source.kind,
      ref: source.ref,
      sha: source.sha ?? null,
      capturedAt: source.capturedAt,
    })),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}
