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
  const candidate = (value || defaultGatewayUrl()).replace(/\/+$/, '');

  try {
    const parsed = new URL(candidate);

    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    ) {
      return candidate;
    }
  } catch {
    return defaultGatewayUrl();
  }

  return defaultGatewayUrl();
};
