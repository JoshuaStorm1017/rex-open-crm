import type { EffectRequest } from './types';

export function buildPrompt(request: EffectRequest): string {
  if (request.role === 'writer' && request.kind === 'agent_launch') {
    return [
      'Implement the pinned task.',
      'Return code only. The pipeline chooses the next state.',
      `Objective: ${request.objective}`,
      `Acceptance: ${request.acceptance.join('; ')}`,
      `Repository: ${request.repository}`,
      `Base: ${request.baseSha}`,
      `Context: ${request.contextId}@${request.contextVersion} ${request.contextHash}`,
    ].join('\n');
  }

  if (request.kind === 'agent_follow_up') {
    return [
      'Repair the pinned task using the review findings already in this conversation.',
      'Do not approve your own change. The pipeline chooses the next state.',
      `Objective: ${request.objective}`,
      `Head: ${request.headSha ?? 'none'}`,
      `Context: ${request.contextId}@${request.contextVersion} ${request.contextHash}`,
    ].join('\n');
  }

  if (request.role === 'reviewer') {
    return [
      'Fresh independent review of the pinned head.',
      'You are not the writer. Do not reuse the writer conversation.',
      'Return a verdict of accept or reject with findings.',
      'The pipeline chooses the next state.',
      `Head: ${request.headSha ?? 'none'}`,
      `Objective: ${request.objective}`,
    ].join('\n');
  }

  return [
    'Run the trusted checks for the pinned head.',
    'The pipeline accepts structured command evidence only.',
    `Head: ${request.headSha ?? 'none'}`,
  ].join('\n');
}
