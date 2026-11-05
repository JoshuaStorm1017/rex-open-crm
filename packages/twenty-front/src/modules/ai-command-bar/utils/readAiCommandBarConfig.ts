export type AiCommandBarConfig = {
  gatewayUrl: string;
  workspaceId: string;
  actor: string;
  bearerToken?: string;
};

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787';
const DEFAULT_WORKSPACE_ID = 'ws_demo';
const DEFAULT_ACTOR = 'workspace-member';

export const readAiCommandBarConfig = (): AiCommandBarConfig => {
  const env = typeof window === 'undefined' ? undefined : window._env_;
  const gatewayUrl = readGatewayUrl(env?.REX_AI_GATEWAY_URL);
  const workspaceId = env?.REX_AI_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;
  const bearerToken = env?.REX_AI_GATEWAY_TOKEN || undefined;

  return {
    gatewayUrl,
    workspaceId,
    bearerToken,
    actor: readActor(),
  };
};

const readActor = (): string => {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_ACTOR;
  }

  try {
    const raw = localStorage.getItem('currentUserState');

    if (!raw) {
      return DEFAULT_ACTOR;
    }

    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'email' in parsed &&
      typeof parsed.email === 'string' &&
      parsed.email.trim().length > 0
    ) {
      return parsed.email.trim().slice(0, 80);
    }
  } catch {
    return DEFAULT_ACTOR;
  }

  return DEFAULT_ACTOR;
};

const readGatewayUrl = (value: string | undefined): string => {
  const candidate = (value || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');

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
    return DEFAULT_GATEWAY_URL;
  }

  return DEFAULT_GATEWAY_URL;
};
