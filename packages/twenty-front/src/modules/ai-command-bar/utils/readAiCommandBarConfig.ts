export type AiCommandBarConfig = {
  gatewayUrl: string;
  workspaceId: string;
};

const DEFAULT_WORKSPACE_ID = 'ws_demo';

export const readAiCommandBarConfig = (): AiCommandBarConfig => {
  const env = typeof window === 'undefined' ? undefined : window._env_;
  const gatewayUrl = readGatewayUrl(env?.REX_AI_GATEWAY_URL);
  const workspaceId = env?.REX_AI_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;

  return {
    gatewayUrl,
    workspaceId,
  };
};

const defaultGatewayUrl = (): string => {
  if (typeof window === 'undefined') {
    return 'http://localhost:8787';
  }

  const hostname = window.location.hostname;

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `http://${hostname}:8787`;
  }

  return 'http://localhost:8787';
};

const readGatewayUrl = (value: string | undefined): string => {
  const fallback = defaultGatewayUrl();
  const candidate = (value || fallback).replace(/\/+$/, '');

  try {
    const parsed = new URL(candidate);

    if (!isCredentialSafeGatewayUrl(parsed)) {
      return fallback;
    }

    return parsed.origin;
  } catch {
    return fallback;
  }
};

const isCredentialSafeGatewayUrl = (parsed: URL): boolean => {
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = isLoopbackHostname(hostname);

  if (parsed.protocol === 'http:' && !loopback) {
    return false;
  }

  if (typeof window === 'undefined') {
    return loopback;
  }

  const pageHost = window.location.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase();

  if (loopback) {
    return isLoopbackHostname(pageHost);
  }

  return parsed.protocol === 'https:' && hostname === pageHost;
};

const isLoopbackHostname = (hostname: string): boolean => {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
};
