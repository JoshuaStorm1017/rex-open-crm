import { useLingui } from '@lingui/react/macro';
import { styled } from '@linaria/react';
import { themeCssVariables } from 'twenty-ui/theme';

import { aiCommandBarCreatePreviewState } from '@/ai-command-bar/states/aiCommandBarCreatePreviewState';
import { type AiProposalCreateCell } from '@/ai-command-bar/utils/aiCommandBarClient';
import { RECORD_TABLE_COLUMN_CHECKBOX_WIDTH_CLASS_NAME } from '@/object-record/record-table/constants/RecordTableColumnCheckboxWidthClassName';
import { RECORD_TABLE_COLUMN_DRAG_AND_DROP_WIDTH_CLASS_NAME } from '@/object-record/record-table/constants/RecordTableColumnDragAndDropWidthClassName';
import { RECORD_TABLE_ROW_HEIGHT } from '@/object-record/record-table/constants/RecordTableRowHeight';
import { useRecordTableContextOrThrow } from '@/object-record/record-table/contexts/RecordTableContext';
import { useIsRecordTableCheckboxColumnHidden } from '@/object-record/record-table/hooks/useIsRecordTableCheckboxColumnHidden';
import { isRecordTableDragColumnHiddenComponentState } from '@/object-record/record-table/states/isRecordTableDragColumnHiddenComponentState';
import { getRecordTableColumnFieldWidthClassName } from '@/object-record/record-table/utils/getRecordTableColumnFieldWidthClassName';
import { useAtomComponentStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomComponentStateValue';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';

const COLUMN_TO_CELL: Record<string, AiProposalCreateCell['field']> = {
  name: 'name',
  emails: 'email',
  email: 'email',
  domainName: 'domain',
  domain: 'domain',
  amount: 'amount',
  stage: 'stage',
};

export type AiGhostColumn = {
  fieldName: string;
  index: number;
};

type AiRecordTableGhostRowsProps = {
  objectName: string;
  columns?: AiGhostColumn[];
  showDrag?: boolean;
  showCheckbox?: boolean;
};

export const AiRecordTableGhostRows = ({
  objectName,
  columns,
  showDrag = false,
  showCheckbox = false,
}: AiRecordTableGhostRowsProps) => {
  const { t } = useLingui();
  const aiCommandBarCreatePreview = useAtomStateValue(
    aiCommandBarCreatePreviewState,
  );
  const rows = aiCommandBarCreatePreview.filter(
    (create) => create.objectName === objectName,
  );

  if (rows.length === 0) {
    return null;
  }

  return (
    <>
      {rows.map((row) => {
        const cells = row.cells ?? [
          { field: 'name' as const, value: row.label },
        ];
        const aligned = columns && columns.length > 0;

        return (
          <StyledGhost
            key={`${row.objectName}-${row.label}-${row.summary}`}
            role="row"
            aria-label={t`Proposed ${row.objectName} ${row.label}`}
          >
            {showDrag && (
              <StyledCell
                aria-hidden
                className={RECORD_TABLE_COLUMN_DRAG_AND_DROP_WIDTH_CLASS_NAME}
              />
            )}
            {showCheckbox && (
              <StyledCell
                aria-hidden
                className={RECORD_TABLE_COLUMN_CHECKBOX_WIDTH_CLASS_NAME}
              />
            )}
            {aligned
              ? columns.map((column) => {
                  const value = cellValue(cells, column.fieldName);

                  return (
                    <StyledCell
                      key={`${column.index}-${column.fieldName}`}
                      role="cell"
                      aria-label={
                        value
                          ? `${column.fieldName}: ${value}`
                          : column.fieldName
                      }
                      className={getRecordTableColumnFieldWidthClassName(
                        column.index,
                      )}
                    >
                      {value}
                    </StyledCell>
                  );
                })
              : cells.map((cell) => (
                  <StyledCell
                    key={cell.field}
                    role="cell"
                    aria-label={`${cell.field}: ${cell.value}`}
                  >
                    {cell.value}
                  </StyledCell>
                ))}
          </StyledGhost>
        );
      })}
    </>
  );
};

export const AiRecordTableGhostRowsConnected = () => {
  const { objectNameSingular, objectMetadataItem, visibleRecordFields } =
    useRecordTableContextOrThrow();
  const isRecordTableDragColumnHidden = useAtomComponentStateValue(
    isRecordTableDragColumnHiddenComponentState,
  );
  const checkboxHidden = useIsRecordTableCheckboxColumnHidden();
  const columns = visibleRecordFields.map((field, index) => ({
    fieldName:
      objectMetadataItem.fields.find(
        (item) => item.id === field.fieldMetadataItemId,
      )?.name ?? '',
    index,
  }));

  return (
    <AiRecordTableGhostRows
      objectName={objectNameSingular}
      columns={columns}
      showDrag={!isRecordTableDragColumnHidden}
      showCheckbox={!checkboxHidden}
    />
  );
};

const cellValue = (
  cells: AiProposalCreateCell[],
  fieldName: string,
): string => {
  const field = COLUMN_TO_CELL[fieldName];

  if (!field) {
    return '';
  }

  return cells.find((cell) => cell.field === field)?.value ?? '';
};

const StyledGhost = styled.div`
  align-items: stretch;
  box-sizing: border-box;
  color: ${themeCssVariables.font.color.secondary};
  display: flex;
  flex-direction: row;
  font-size: ${themeCssVariables.font.size.sm};
  height: ${RECORD_TABLE_ROW_HEIGHT}px;
`;

const StyledCell = styled.div`
  align-items: center;
  box-sizing: border-box;
  display: flex;
  overflow: hidden;
  padding-inline: ${themeCssVariables.spacing[2]};
  white-space: nowrap;
`;
