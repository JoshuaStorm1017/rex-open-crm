import { ALLOWED_TOOL_NAMES, type AllowedToolName } from './types';

const ALLOWED_TOOL_NAME_SET = new Set<string>(ALLOWED_TOOL_NAMES);

export function isAllowedToolName(name: string): name is AllowedToolName {
  return ALLOWED_TOOL_NAME_SET.has(name);
}
