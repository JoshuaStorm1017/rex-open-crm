export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const CORS_BASE_HEADERS = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'content-type, authorization, idempotency-key, x-twenty-authorization',
  'access-control-expose-headers': 'idempotency-replayed',
  vary: 'origin',
};

export function readAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  if (env.REX_AI_CORS_ORIGINS === undefined) {
    return [...DEFAULT_ALLOWED_ORIGINS];
  }

  const origins = new Set<string>();

  for (const entry of env.REX_AI_CORS_ORIGINS.split(',')) {
    const origin = originValue(entry.trim());

    if (origin) {
      origins.add(origin);
    }
  }

  return [...origins];
}

export function allowedRequestOrigin(
  originHeader: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | undefined {
  const origin = originValue(originHeader);

  if (!origin || !allowedOrigins.has(origin)) {
    return undefined;
  }

  return origin;
}

export function corsHeadersFor(
  originHeader: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): Record<string, string> {
  const origin = allowedRequestOrigin(originHeader, allowedOrigins);

  if (!origin) {
    return { ...CORS_BASE_HEADERS };
  }

  return {
    ...CORS_BASE_HEADERS,
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
  };
}

function originValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }

    if (url.origin !== value) {
      return undefined;
    }

    return url.origin;
  } catch {
    return undefined;
  }
}
