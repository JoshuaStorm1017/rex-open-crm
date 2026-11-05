import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_HOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.internal',
]);

// The provider base URL is fetched with the API key attached. A private, link-local,
// or metadata target would send that key onto the host network.
export function assertPublicProviderBaseUrl(baseUrl: string): URL {
  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('REX_AI_BASE_URL must be an http(s) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('REX_AI_BASE_URL must be an http(s) URL.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('REX_AI_BASE_URL must not include credentials.');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('REX_AI_BASE_URL must not include a query or hash.');
  }

  if (
    parsed.pathname.includes('//') ||
    parsed.pathname.includes('..') ||
    parsed.pathname.includes('\\') ||
    parsed.pathname.includes('@') ||
    !/^\/[A-Za-z0-9._~/-]*$/.test(parsed.pathname)
  ) {
    throw new Error('REX_AI_BASE_URL path is not allowed.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (
    BLOCKED_HOST_NAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('REX_AI_BASE_URL must not target a local or metadata host.');
  }

  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
    throw new Error('REX_AI_BASE_URL must not target a raw numeric address.');
  }

  if (isIpv4Literal(hostname)) {
    if (hostname.split('.').some((part) => part.length > 1 && part.startsWith('0'))) {
      throw new Error('REX_AI_BASE_URL must not target a non-public address.');
    }

    if (isBlockedIp(hostname)) {
      throw new Error('REX_AI_BASE_URL must not target a non-public address.');
    }
  } else if (isIP(hostname) && isBlockedIp(hostname)) {
    throw new Error('REX_AI_BASE_URL must not target a non-public address.');
  }

  return parsed;
}

export async function assertProviderHostIsPublic(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (isIP(bare) || isIpv4Literal(bare)) {
    if (isBlockedIp(bare)) {
      throw new Error('REX_AI_BASE_URL must not target a non-public address.');
    }

    return;
  }

  let records: Array<{ address: string }>;

  try {
    records = await lookup(bare, { all: true, verbatim: true });
  } catch {
    throw new Error('REX_AI_BASE_URL could not be resolved.');
  }

  if (records.length === 0 || records.some((record) => isBlockedIp(record.address))) {
    throw new Error('REX_AI_BASE_URL resolves to a non-public address.');
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Returns how a hostname may be dialed. "name" still has to be pinned to the
// addresses that passed this check; a literal never goes through DNS.
export function assertConnectableHost(
  hostname: string,
  label: string,
  allowLoopback: boolean,
): 'loopback' | 'literal' | 'name' {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (allowLoopback && LOOPBACK_HOSTS.has(bare)) {
    return 'loopback';
  }

  if (
    BLOCKED_HOST_NAMES.has(bare) ||
    bare.endsWith('.localhost') ||
    bare.endsWith('.local') ||
    bare.endsWith('.internal')
  ) {
    throw new Error(`${label} must not target a local or metadata host.`);
  }

  if (/^\d+$/.test(bare) || /^0x[0-9a-f]+$/i.test(bare)) {
    throw new Error(`${label} must not target a raw numeric address.`);
  }

  if (isIpv4Literal(bare) || isIP(bare) !== 0) {
    if (
      isIpv4Literal(bare) &&
      bare.split('.').some((part) => part.length > 1 && part.startsWith('0'))
    ) {
      throw new Error(`${label} must not target a non-public address.`);
    }

    if (isBlockedIp(bare)) {
      throw new Error(`${label} must not target a non-public address.`);
    }

    return 'literal';
  }

  return 'name';
}

export function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';

  if (normalized.includes(':')) {
    return isBlockedIpv6(normalized);
  }

  return isBlockedIpv4(normalized);
}

function isIpv4Literal(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }

  const [first, second, third] = parts as [number, number, number, number];

  if (first === 0 || first === 10 || first === 127) {
    return true;
  }

  if (first === 169 && second === 254) {
    return true;
  }

  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }

  if (first === 192 && second === 168) {
    return true;
  }

  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }

  if (first === 192 && second === 0 && (third === 0 || third === 2)) {
    return true;
  }

  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }

  if (first === 198 && second === 51 && third === 100) {
    return true;
  }

  if (first === 203 && second === 0 && third === 113) {
    return true;
  }

  return first >= 224;
}

function isBlockedIpv6(address: string): boolean {
  const hextets = ipv6Hextets(address);

  if (!hextets) {
    return true;
  }

  const embedded = embeddedIpv4(hextets);

  if (embedded) {
    return isBlockedIpv4(embedded);
  }

  const first = hextets[0] ?? 0;
  const second = hextets[1] ?? 0;

  if (hextets.every((part) => part === 0) || (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1)) {
    return true;
  }

  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) {
    return true;
  }

  if ((first & 0xff00) === 0xff00) {
    return true;
  }

  // 2001:db8::/32 documentation, 64:ff9b::/96 and 64:ff9b:1::/48 NAT64.
  if (first === 0x2001 && second === 0x0db8) {
    return true;
  }

  return first === 0x64 && second === 0xff9b;
}

function embeddedIpv4(hextets: number[]): string | undefined {
  const v4Compatible =
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    (hextets[5] === 0 || hextets[5] === 0xffff);
  const nat64 =
    hextets[0] === 0x64 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0;
  const sixToFour = hextets[0] === 0x2002;
  const pair =
    v4Compatible || nat64 ? [hextets[6], hextets[7]] : sixToFour ? [hextets[1], hextets[2]] : undefined;

  if (!pair) {
    return undefined;
  }

  return ipv4FromPair(pair[0] ?? 0, pair[1] ?? 0);
}

function ipv4FromPair(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function ipv6Hextets(address: string): number[] | undefined {
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);

  if (tail.includes('.')) {
    const parts = tail.split('.').map((part) => Number(part));

    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return undefined;
    }

    const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
    const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
    const head = expandHextets(address.slice(0, lastColon), 6);

    if (!head) {
      return undefined;
    }

    return [...head, high, low];
  }

  return expandHextets(address, 8);
}

function expandHextets(value: string, width: number): number[] | undefined {
  const halves = value.split('::');

  if (halves.length > 2) {
    return undefined;
  }

  const parseSide = (side: string): number[] | undefined => {
    if (side.length === 0) {
      return [];
    }

    const parts = side.split(':');
    const numbers: number[] = [];

    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return undefined;
      }

      numbers.push(Number.parseInt(part, 16));
    }

    return numbers;
  };

  const left = parseSide(halves[0] ?? '');
  const right = halves.length === 2 ? parseSide(halves[1] ?? '') : [];

  if (!left || !right) {
    return undefined;
  }

  if (halves.length === 1) {
    return left.length === width ? left : undefined;
  }

  const missing = width - left.length - right.length;

  if (missing < 1) {
    return undefined;
  }

  return [...left, ...Array<number>(missing).fill(0), ...right];
}
