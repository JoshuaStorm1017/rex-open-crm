import { useLingui } from '@lingui/react/macro';
import { styled } from '@linaria/react';
import { themeCssVariables } from 'twenty-ui/theme';

import { aiCommandBarFieldPreviewState } from '@/ai-command-bar/states/aiCommandBarFieldPreviewState';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';

type AiRecordFieldPreviewProps = {
  recordId: string;
  fieldName: string;
};

export const AiRecordFieldPreview = ({
  recordId,
  fieldName,
}: AiRecordFieldPreviewProps) => {
  const { t } = useLingui();
  const changes = useAtomStateValue(aiCommandBarFieldPreviewState);
  const match = changes.find(
    (change) =>
      change.recordId === recordId &&
      (change.metadataField === fieldName || change.field === fieldName),
  );

  if (!match) {
    return null;
  }

  return (
    <StyledPreview role="status">
      {t`Proposed change: ${match.summary}`}
    </StyledPreview>
  );
};

const StyledPreview = styled.p`
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.xs};
  margin: ${themeCssVariables.spacing[1]} 0 0;
`;
