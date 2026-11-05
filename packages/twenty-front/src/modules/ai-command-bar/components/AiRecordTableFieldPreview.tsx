import { useContext } from 'react';

import { AiRecordFieldPreview } from '@/ai-command-bar/components/AiRecordFieldPreview';
import { FieldContext } from '@/object-record/record-field/ui/contexts/FieldContext';

export const AiRecordTableFieldPreview = () => {
  const { recordId, fieldDefinition } = useContext(FieldContext);
  const fieldName = fieldDefinition?.metadata?.fieldName;

  if (!recordId || !fieldName) {
    return null;
  }

  return (
    <AiRecordFieldPreview recordId={recordId} fieldName={fieldName} compact />
  );
};
