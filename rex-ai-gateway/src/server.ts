import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { executeAct, type ExecuteActOptions } from './act/execute-act';
import type { ActResult } from './act/types';
import type { TwentyCrmClient } from './twenty/twenty-crm-client';

const ACT_PATH = '/v1/ai/act';
const MAX_BODY_BYTES = 64 * 1024;

export type GatewayOptions = ExecuteActOptions & {
  client: TwentyCrmClient;
  port?: number;
  host?: string;
};

export type RunningGateway = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

export function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const server = createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      const message = error instanceof Error ? error.message : 'Unexpected error';
      sendJson(response, 500, { ok: false, message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Gateway failed to bind a TCP port'));
        return;
      }

      resolve({
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (url.pathname !== ACT_PATH) {
    sendJson(response, 404, { ok: false, message: 'Not found' });
    return;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, message: 'Method not allowed' });
    return;
  }

  const rawBody = await readBody(request);

  if (rawBody === undefined) {
    sendJson(response, 400, {
      ok: false,
      refused: true,
      reason: 'invalid_request',
      message: `Body exceeds ${MAX_BODY_BYTES} bytes.`,
    });
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    sendJson(response, 400, {
      ok: false,
      refused: true,
      reason: 'invalid_request',
      message: 'Body must be JSON.',
    });
    return;
  }

  const result = await executeAct(parsed, options.client, {
    boundWorkspaceId: options.boundWorkspaceId,
  });

  sendJson(response, statusFor(result), result);
}

function statusFor(result: ActResult): number {
  if (result.ok) {
    return 200;
  }

  if (result.reason === 'upstream_error') {
    return 502;
  }

  return 400;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      return undefined;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}
