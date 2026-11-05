import { useLingui } from '@lingui/react/macro';
import { styled } from '@linaria/react';
import { themeCssVariables } from 'twenty-ui/theme';

import { aiCommandBarFieldPreviewState } from '@/ai-command-bar/states/aiCommandBarFieldPreviewState';
import { type AiProposalChange } from '@/ai-command-bar/utils/aiCommandBarClient';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';

type AiRecordFieldPreviewProps = {
  recordId: string;
  fieldName: string;
  compact?: boolean;
};

export const AiRecordFieldPreview = ({
  recordId,
  fieldName,
  compact = false,
}: AiRecordFieldPreviewProps) => {
  const { t } = useLingui();
  const changes = useAtomStateValue(aiCommandBarFieldPreviewState);
  const matches = changes.filter(
    (change) =>
      change.recordId === recordId &&
      (change.metadataField === fieldName || change.field === fieldName),
  );

  if (matches.length === 0) {
    return null;
  }

  const several = matches.length > 1;

  return (
    <>
      {matches.map((match) => {
        const part = fieldPart(match, fieldName, several);
        const text = compact
          ? t`Proposed ${part}${proposedValue(match)}`
          : t`Proposed change: ${part}${match.summary}`;

        return compact ? (
          <StyledCompact key={changeKey(match)} role="status">
            {text}
          </StyledCompact>
        ) : (
          <StyledPreview key={changeKey(match)} role="status">
            {text}
          </StyledPreview>
        );
      })}
    </>
  );
};

const fieldPart = (
  match: AiProposalChange,
  fieldName: string,
  several: boolean,
): string => {
  if (!match.field) {
    return '';
  }

  if (match.field !== fieldName || several) {
    return `${match.field}: `;
  }

  return '';
};

const proposedValue = (match: AiProposalChange): string => {
  if (match.proposed === null) {
    return 'archived';
  }

  if (typeof match.proposed === 'number') {
    return match.proposed.toLocaleString('en-US');
  }

  return match.proposed;
};

const changeKey = (match: AiProposalChange): string =>
  `${match.recordId}-${match.field ?? 'archive'}`;

const StyledPreview = styled.p`
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.xs};
  margin: ${themeCssVariables.spacing[1]} 0 0;
`;

const StyledCompact = styled.span`
  color: ${themeCssVariables.font.color.secondary};
  flex-shrink: 0;
  font-size: ${themeCssVariables.font.size.xs};
  margin-left: ${themeCssVariables.spacing[2]};
`;
