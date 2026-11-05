import { timingSafeEqual } from 'node:crypto';

export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer (.+)$/i.exec(header ?? '')?.[1] ?? '';
  const actual = Buffer.from(presented);
  const expected = Buffer.from(token);

  if (actual.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }

  return timingSafeEqual(actual, expected);
}
