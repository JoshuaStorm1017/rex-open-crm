import { refusal, type ActRefusal } from './types';
import type { OpenRecordContext } from './parse-request';
import type { ValidatedTool } from './validate-tool';

export type { OpenRecordContext };

// The model is only allowed to say "the open record". The id comes from the page
// the member is viewing, after this process has loaded that record.
export function bindOpenRecord(
  tool: ValidatedTool,
  openRecord: OpenRecordContext | undefined,
): ValidatedTool | ActRefusal {
  if (tool.name === 'update_record' && tool.input.useOpenRecord) {
    if (!openRecord) {
      return refusal(
        'ambiguous_intent',
        'This update refers to the open record, but no record is open.',
        { toolName: tool.name },
      );
    }

    if (tool.input.objectName !== openRecord.objectName) {
      return refusal(
        'invalid_request',
        `The open record is a ${openRecord.objectName}, not a ${tool.input.objectName}.`,
        { toolName: tool.name },
      );
    }

    const { useOpenRecord: _useOpenRecord, ...input } = tool.input;

    return {
      ...tool,
      input: { ...input, id: openRecord.recordId, query: undefined },
    };
  }

  if (tool.name === 'archive_record' && tool.input.useOpenRecord) {
    if (!openRecord) {
      return refusal(
        'ambiguous_intent',
        'This archive refers to the open record, but no record is open.',
        { toolName: tool.name },
      );
    }

    if (tool.input.objectName !== openRecord.objectName) {
      return refusal(
        'invalid_request',
        `The open record is a ${openRecord.objectName}, not a ${tool.input.objectName}.`,
        { toolName: tool.name },
      );
    }

    const { useOpenRecord: _useOpenRecord, ...input } = tool.input;

    return {
      ...tool,
      input: { ...input, id: openRecord.recordId, query: undefined },
    };
  }

  if (
    (tool.name === 'search_notes' ||
      tool.name === 'search_tasks' ||
      tool.name === 'search_activities') &&
    tool.input.useOpenRecord
  ) {
    if (!openRecord) {
      return refusal(
        'ambiguous_intent',
        'This read refers to the open record, but no record is open.',
        {
          toolName: tool.name,
        },
      );
    }

    const { useOpenRecord: _useOpenRecord, ...input } = tool.input;

    return {
      ...tool,
      input: { ...input, recordId: openRecord.recordId },
    };
  }

  if (tool.name === 'create_note' && tool.input.useOpenRecord) {
    if (!openRecord) {
      return refusal(
        'ambiguous_intent',
        'This note refers to the open record, but no record is open.',
        { toolName: tool.name },
      );
    }

    if (tool.input.targetObject !== openRecord.objectName) {
      return refusal(
        'invalid_request',
        `The open record is a ${openRecord.objectName}, not a ${tool.input.targetObject}.`,
        { toolName: tool.name },
      );
    }

    const { useOpenRecord: _useOpenRecord, ...input } = tool.input;

    return {
      ...tool,
      input: {
        ...input,
        targetId: openRecord.recordId,
        targetQuery: undefined,
      },
    };
  }

  return tool;
}
