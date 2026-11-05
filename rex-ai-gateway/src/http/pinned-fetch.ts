import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import { isBlockedIp } from './public-url';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const PIN_TTL_MS = 30_000;

type AddressRecord = { address: string; family: number };

type PinLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly AddressRecord[]>;

type Pin = {
  address: string;
  family: 4 | 6;
  expiresAt: number;
};

const pins = new Map<string, Pin>();

// A check-then-fetch lets DNS rebinding answer the check with a public address
// and the fetch with a private one. The socket connects to the address that passed.
export async function fetchWithPinnedDns(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  label = 'URL',
  lookupImpl: PinLookup = lookup,
): Promise<Response> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (fetchImpl !== fetch || isDirectAddress(hostname)) {
    return fetchImpl(url, init);
  }

  const pin = await resolvePin(hostname, label, lookupImpl);

  return requestPinned(url, init, pin);
}

export function clearPinnedDnsCache(): void {
  pins.clear();
}

function isDirectAddress(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname) || isIP(hostname) !== 0;
}

async function resolvePin(hostname: string, label: string, lookupImpl: PinLookup): Promise<Pin> {
  const cached = pins.get(hostname);

  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  let records: readonly AddressRecord[];

  try {
    records = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`${label} could not be resolved.`);
  }

  const usable = records.filter((record) => record.address.length > 0);

  if (usable.length === 0 || usable.some((record) => isBlockedIp(record.address))) {
    throw new Error(`${label} resolves to a non-public address.`);
  }

  const first = usable[0];

  if (!first) {
    throw new Error(`${label} resolves to a non-public address.`);
  }

  const pin: Pin = {
    address: first.address,
    family: first.family === 6 ? 6 : 4,
    expiresAt: Date.now() + PIN_TTL_MS,
  };
  pins.set(hostname, pin);

  return pin;
}

function requestPinned(urlString: string, init: RequestInit, pin: Pin): Promise<Response> {
  const url = new URL(urlString);
  const lib = url.protocol === 'https:' ? https : http;
  const headers = headersFrom(init.headers);
  headers.host = url.host;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: pin.address,
        servername: url.hostname,
        family: pin.family,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        setHost: false,
      },
      (incoming) => {
        if (
          init.redirect === 'error' &&
          incoming.statusCode !== undefined &&
          incoming.statusCode >= 300 &&
          incoming.statusCode < 400
        ) {
          incoming.resume();
          reject(new TypeError('Redirects are not followed.'));
          return;
        }

        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on('end', () => {
          const responseHeaders = new Headers();

          for (const [key, value] of Object.entries(incoming.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              responseHeaders.set(key, value.join(', '));
            }
          }

          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers: responseHeaders,
            }),
          );
        });
      },
    );

    req.on('error', reject);

    if (init.signal) {
      const abort = () => req.destroy();

      if (init.signal.aborted) {
        abort();
        reject(init.signal.reason ?? new Error('The request was aborted.'));
        return;
      }

      init.signal.addEventListener('abort', abort, { once: true });
    }

    if (typeof init.body === 'string') {
      req.end(init.body);
      return;
    }

    if (init.body instanceof Uint8Array) {
      req.end(init.body);
      return;
    }

    req.end();
  });
}

function headersFrom(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}
