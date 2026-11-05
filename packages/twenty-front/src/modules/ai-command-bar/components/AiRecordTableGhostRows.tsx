import { useLingui } from '@lingui/react/macro';
import { styled } from '@linaria/react';
import { themeCssVariables } from 'twenty-ui/theme';

import { aiCommandBarCreatePreviewState } from '@/ai-command-bar/states/aiCommandBarCreatePreviewState';
import { RECORD_TABLE_ROW_HEIGHT } from '@/object-record/record-table/constants/RecordTableRowHeight';
import { useRecordTableContextOrThrow } from '@/object-record/record-table/contexts/RecordTableContext';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';

type AiRecordTableGhostRowsProps = {
  objectName: string;
};

export const AiRecordTableGhostRows = ({
  objectName,
}: AiRecordTableGhostRowsProps) => {
  const { t } = useLingui();
  const creates = useAtomStateValue(aiCommandBarCreatePreviewState);
  const rows = creates.filter((create) => create.objectName === objectName);

  if (rows.length === 0) {
    return null;
  }

  return (
    <>
      {rows.map((row) => (
        <StyledGhost
          key={`${row.objectName}-${row.label}-${row.summary}`}
          role="row"
        >
          {t`Proposed ${row.objectName} ${row.label}`}
          {row.summary.length > 0 ? ` · ${row.summary}` : ''}
        </StyledGhost>
      ))}
    </>
  );
};

export const AiRecordTableGhostRowsConnected = () => {
  const { objectNameSingular } = useRecordTableContextOrThrow();

  return <AiRecordTableGhostRows objectName={objectNameSingular} />;
};

const StyledGhost = styled.div`
  align-items: center;
  box-sizing: border-box;
  color: ${themeCssVariables.font.color.secondary};
  display: flex;
  font-size: ${themeCssVariables.font.size.sm};
  height: ${RECORD_TABLE_ROW_HEIGHT}px;
  padding-left: ${themeCssVariables.spacing[2]};
`;
