import { type AiProposalCreate } from '@/ai-command-bar/utils/aiCommandBarClient';
import { createAtomState } from '@/ui/utilities/state/jotai/utils/createAtomState';

export const aiCommandBarCreatePreviewState = createAtomState<
  AiProposalCreate[]
>({
  key: 'aiCommandBarCreatePreviewState',
  defaultValue: [],
});
