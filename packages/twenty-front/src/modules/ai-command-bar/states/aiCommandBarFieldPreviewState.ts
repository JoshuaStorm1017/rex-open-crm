import { type AiProposalChange } from '@/ai-command-bar/utils/aiCommandBarClient';
import { createAtomState } from '@/ui/utilities/state/jotai/utils/createAtomState';

export const aiCommandBarFieldPreviewState = createAtomState<
  AiProposalChange[]
>({
  key: 'aiCommandBarFieldPreviewState',
  defaultValue: [],
});
