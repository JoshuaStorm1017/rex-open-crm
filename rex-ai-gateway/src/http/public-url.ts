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

export function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);

  if (mapped?.[1]) {
    return isBlockedIpv4(mapped[1]);
  }

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
  if (address === '::' || address === '::1') {
    return true;
  }

  return (
    address.startsWith('fc') ||
    address.startsWith('fd') ||
    address.startsWith('fe80:') ||
    address.startsWith('fec0:') ||
    address.startsWith('ff') ||
    address.startsWith('2001:db8:')
  );
}
