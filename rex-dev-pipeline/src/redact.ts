const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_PATTERN =
  /\b(sk|rk|pk|ghp|github_pat|xox[baprs]|cursor)_[A-Za-z0-9_-]+/g;
const SK_PREFIX_PATTERN = /\b(sk|rk|pk)-[A-Za-z0-9_-]+/g;
const ASSIGNED_SECRET_PATTERN =
  /(api[_-]?key|authorization|secret|token|password|credential)\s*[:=]\s*\S+/gi;
const SENSITIVE_KEY_PATTERN =
  /(^|_)(api[-_]?key|authorization|secret|password|credential|access[-_]?token|refresh[-_]?token)$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redact(value: string): string {
  return value
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(ASSIGNED_SECRET_PATTERN, '$1=[redacted]')
    .replace(TOKEN_PATTERN, '[redacted]')
    .replace(SK_PREFIX_PATTERN, '[redacted]');
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[redacted]'
      : redactValue(child);
  }

  return output;
}

export type PipelineLog = {
  lines: string[];
  write: (line: string) => void;
};

export function createLog(): PipelineLog {
  const lines: string[] = [];

  return {
    lines,
    write(line: string) {
      lines.push(redact(line));
    },
  };
}
