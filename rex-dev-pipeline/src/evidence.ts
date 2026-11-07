import { isRecord } from './redact';
import {
  isCommitSha,
  type ImplementationArtifact,
  type MergeArtifact,
  type ReviewArtifact,
  type TestEvidence,
} from './types';

export type ParsedArtifact =
  | {
      ok: true;
      artifact:
        | ImplementationArtifact
        | TestEvidence
        | ReviewArtifact
        | MergeArtifact;
    }
  | { ok: false; reason: string };

export function parseArtifact(value: unknown): ParsedArtifact {
  if (typeof value === 'string') {
    return { ok: false, reason: 'untrusted_attestation' };
  }

  if (!isRecord(value) || typeof value.kind !== 'string') {
    return { ok: false, reason: 'untrusted_attestation' };
  }

  if (value.kind === 'implementation') {
    return parseImplementation(value);
  }

  if (value.kind === 'test_evidence') {
    return parseTestEvidence(value);
  }

  if (value.kind === 'review') {
    return parseReview(value);
  }

  if (value.kind === 'merge') {
    return parseMerge(value);
  }

  return { ok: false, reason: 'unknown_artifact' };
}

function parseImplementation(value: Record<string, unknown>): ParsedArtifact {
  if (
    typeof value.writerId !== 'string' ||
    typeof value.commitSha !== 'string' ||
    typeof value.summary !== 'string' ||
    typeof value.contextId !== 'string' ||
    typeof value.contextHash !== 'string' ||
    typeof value.contextVersion !== 'number' ||
    !Array.isArray(value.filesChanged)
  ) {
    return { ok: false, reason: 'implementation_artifact_invalid' };
  }

  if (!isCommitSha(value.commitSha)) {
    return { ok: false, reason: 'commit_sha_invalid' };
  }

  if (value.summary.trim() === '') {
    return { ok: false, reason: 'implementation_summary_required' };
  }

  const filesChanged = value.filesChanged.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim() !== '',
  );

  if (
    filesChanged.length !== value.filesChanged.length ||
    filesChanged.length === 0
  ) {
    return { ok: false, reason: 'files_changed_required' };
  }

  return {
    ok: true,
    artifact: {
      kind: 'implementation',
      writerId: value.writerId,
      commitSha: value.commitSha,
      summary: value.summary,
      filesChanged,
      contextId: value.contextId,
      contextVersion: value.contextVersion,
      contextHash: value.contextHash,
    },
  };
}

function parseTestEvidence(value: Record<string, unknown>): ParsedArtifact {
  if (
    value.result === 'YES' ||
    value.answer === 'YES' ||
    value.passed === 'YES' ||
    value.ok === 'YES'
  ) {
    return { ok: false, reason: 'untrusted_attestation' };
  }

  if (
    typeof value.commitSha !== 'string' ||
    typeof value.command !== 'string' ||
    typeof value.exitCode !== 'number' ||
    typeof value.passed !== 'number' ||
    typeof value.failed !== 'number' ||
    typeof value.outputDigest !== 'string'
  ) {
    return { ok: false, reason: 'untrusted_attestation' };
  }

  if (!isCommitSha(value.commitSha)) {
    return { ok: false, reason: 'commit_sha_invalid' };
  }

  if (value.command.trim() === '') {
    return { ok: false, reason: 'command_required' };
  }

  if (value.outputDigest.trim() === '') {
    return { ok: false, reason: 'digest_required' };
  }

  if (
    !Number.isInteger(value.exitCode) ||
    !Number.isInteger(value.passed) ||
    !Number.isInteger(value.failed)
  ) {
    return { ok: false, reason: 'untrusted_attestation' };
  }

  if (value.passed < 0 || value.failed < 0) {
    return { ok: false, reason: 'untrusted_attestation' };
  }

  if (value.exitCode === 0 && value.failed > 0) {
    return { ok: false, reason: 'inconsistent_evidence' };
  }

  if (value.exitCode === 0 && value.passed < 1) {
    return { ok: false, reason: 'no_test_evidence' };
  }

  return {
    ok: true,
    artifact: {
      kind: 'test_evidence',
      commitSha: value.commitSha,
      command: value.command,
      exitCode: value.exitCode,
      passed: value.passed,
      failed: value.failed,
      outputDigest: value.outputDigest,
    },
  };
}

function parseReview(value: Record<string, unknown>): ParsedArtifact {
  if (
    typeof value.commitSha !== 'string' ||
    typeof value.reviewerId !== 'string' ||
    typeof value.writerId !== 'string' ||
    (value.verdict !== 'accept' && value.verdict !== 'reject')
  ) {
    return { ok: false, reason: 'review_artifact_invalid' };
  }

  if (!isCommitSha(value.commitSha)) {
    return { ok: false, reason: 'commit_sha_invalid' };
  }

  const findings = Array.isArray(value.findings)
    ? value.findings.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];

  if (
    Array.isArray(value.findings) &&
    findings.length !== value.findings.length
  ) {
    return { ok: false, reason: 'review_artifact_invalid' };
  }

  return {
    ok: true,
    artifact: {
      kind: 'review',
      commitSha: value.commitSha,
      reviewerId: value.reviewerId,
      writerId: value.writerId,
      verdict: value.verdict,
      findings,
    },
  };
}

function parseMerge(value: Record<string, unknown>): ParsedArtifact {
  if (
    typeof value.commitSha !== 'string' ||
    typeof value.verified !== 'boolean'
  ) {
    return { ok: false, reason: 'merge_artifact_invalid' };
  }

  if (!isCommitSha(value.commitSha)) {
    return { ok: false, reason: 'commit_sha_invalid' };
  }

  return {
    ok: true,
    artifact: {
      kind: 'merge',
      commitSha: value.commitSha,
      verified: value.verified,
    },
  };
}
