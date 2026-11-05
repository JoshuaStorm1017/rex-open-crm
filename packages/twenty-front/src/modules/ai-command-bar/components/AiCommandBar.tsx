import { useLingui } from '@lingui/react/macro';
import { styled } from '@linaria/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { themeCssVariables } from 'twenty-ui/theme';

import {
  executeAiCommand,
  proposeAiCommand,
  type AiProposal,
  type AiRecordLink,
} from '@/ai-command-bar/utils/aiCommandBarClient';
import { isAiCommandBarShortcut } from '@/ai-command-bar/utils/isAiCommandBarShortcut';
import {
  readAiCommandBarConfig,
  type AiCommandBarConfig,
} from '@/ai-command-bar/utils/readAiCommandBarConfig';
import { recordShowPath } from '@/ai-command-bar/utils/recordShowPath';
import { RootStackingContextZIndices } from '@/ui/layout/constants/RootStackingContextZIndices';

type Phase =
  | { name: 'compose'; draft: string; notice?: string }
  | { name: 'planning'; draft: string }
  | {
      name: 'preview';
      draft: string;
      proposal: AiProposal;
      idempotencyKey: string;
    }
  | { name: 'executing'; draft: string; proposal: AiProposal }
  | { name: 'done'; links: AiRecordLink[] }
  | { name: 'refused'; draft: string; message: string };

type AiCommandBarProps = {
  config?: AiCommandBarConfig;
  fetchImpl?: typeof fetch;
  initialOpen?: boolean;
};

export const AiCommandBar = ({
  config,
  fetchImpl = fetch,
  initialOpen = false,
}: AiCommandBarProps) => {
  const { t } = useLingui();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const resolvedConfig = config ?? readAiCommandBarConfig();
  const [open, setOpen] = useState(initialOpen);
  const [phase, setPhase] = useState<Phase>({ name: 'compose', draft: '' });
  const busy = phase.name === 'planning' || phase.name === 'executing';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAiCommandBarShortcut(event) || busy) {
        return;
      }

      event.preventDefault();
      setOpen((current) => !current);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy]);

  useEffect(() => {
    if (!open) {
      setPhase({ name: 'compose', draft: '' });
      return;
    }

    inputRef.current?.focus();
  }, [open]);

  const close = () => setOpen(false);

  const propose = async (draft: string) => {
    const intent = draft.trim();

    if (intent.length === 0) {
      return;
    }

    setPhase({ name: 'planning', draft });

    const outcome = await proposeAiCommand(resolvedConfig, intent, fetchImpl);

    if (outcome.kind === 'message') {
      setPhase({ name: 'refused', draft, message: outcome.message });
      return;
    }

    setPhase({
      name: 'preview',
      draft,
      proposal: outcome.data,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const confirm = async (
    proposal: AiProposal,
    idempotencyKey: string,
    draft: string,
  ) => {
    setPhase({ name: 'executing', draft, proposal });

    const outcome = await executeAiCommand(
      resolvedConfig,
      proposal.tools,
      idempotencyKey,
      fetchImpl,
    );

    if (outcome.kind === 'message') {
      setPhase({ name: 'refused', draft, message: outcome.message });
      return;
    }

    setPhase({ name: 'done', links: outcome.data });
  };

  const cancelPreview = (draft: string) => {
    setPhase({
      name: 'compose',
      draft,
      notice: t`Cancelled. Nothing was changed.`,
    });
  };

  return (
    <>
      {!open && (
        <StyledLauncher type="button" onClick={() => setOpen(true)}>
          {t`AI command`}
          <StyledShortcut>{t`Ctrl+Shift+K`}</StyledShortcut>
        </StyledLauncher>
      )}
      {open && (
        <StyledOverlay
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              close();
            }
          }}
        >
          <StyledDialog
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-busy={busy}
          >
            <StyledTitle id={titleId}>{t`AI command`}</StyledTitle>
            <StyledHint>{t`Ctrl+Shift+K. Writes wait for confirmation.`}</StyledHint>
            {phase.name !== 'done' && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();

                  if (phase.name === 'compose') {
                    void propose(phase.draft);
                  }
                }}
              >
                <StyledInput
                  ref={inputRef}
                  aria-label={t`Command`}
                  value={phase.draft}
                  disabled={phase.name !== 'compose'}
                  placeholder={t`Add Acme Corp as a company and a $50k deal for Jane Doe`}
                  onChange={(event) => {
                    if (phase.name === 'compose') {
                      setPhase({ name: 'compose', draft: event.target.value });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && !busy) {
                      event.preventDefault();
                      close();
                    }
                  }}
                />
                {phase.name === 'compose' && (
                  <StyledActions>
                    <StyledPrimary
                      type="submit"
                      disabled={phase.draft.trim().length === 0}
                    >
                      {t`Propose`}
                    </StyledPrimary>
                  </StyledActions>
                )}
              </form>
            )}
            {phase.name === 'compose' && phase.notice && (
              <StyledNotice role="status">{phase.notice}</StyledNotice>
            )}
            {phase.name === 'planning' && (
              <StyledNotice>{t`Proposing actions…`}</StyledNotice>
            )}
            {phase.name === 'executing' && (
              <StyledNotice>{t`Working…`}</StyledNotice>
            )}
            {(phase.name === 'preview' || phase.name === 'executing') && (
              <>
                <StyledSummary>{phase.proposal.summary}</StyledSummary>
                <StyledList>
                  {phase.proposal.lines.map((line) => (
                    <li key={`${line.tool}-${line.summary}`}>{line.summary}</li>
                  ))}
                </StyledList>
              </>
            )}
            {phase.name === 'preview' && (
              <StyledActions>
                <StyledPrimary
                  type="button"
                  onClick={() =>
                    void confirm(
                      phase.proposal,
                      phase.idempotencyKey,
                      phase.draft,
                    )
                  }
                >
                  {t`Confirm`}
                </StyledPrimary>
                <StyledSecondary
                  type="button"
                  onClick={() => cancelPreview(phase.draft)}
                >
                  {t`Cancel`}
                </StyledSecondary>
              </StyledActions>
            )}
            {phase.name === 'refused' && (
              <>
                <StyledError role="alert">{phase.message}</StyledError>
                <StyledActions>
                  <StyledSecondary
                    type="button"
                    onClick={() =>
                      setPhase({ name: 'compose', draft: phase.draft })
                    }
                  >
                    {t`Back`}
                  </StyledSecondary>
                </StyledActions>
              </>
            )}
            {phase.name === 'done' && (
              <>
                <StyledSummary>{t`Done`}</StyledSummary>
                {phase.links.length === 0 ? (
                  <StyledNotice>{t`No matching records.`}</StyledNotice>
                ) : (
                  <StyledList>
                    {phase.links.map((link) => (
                      <li key={`${link.objectName}-${link.id}`}>
                        <Link to={recordShowPath(link.objectName, link.id)}>
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </StyledList>
                )}
                <StyledActions>
                  <StyledSecondary type="button" onClick={close}>
                    {t`Close`}
                  </StyledSecondary>
                </StyledActions>
              </>
            )}
          </StyledDialog>
        </StyledOverlay>
      )}
    </>
  );
};

const StyledLauncher = styled.button`
  align-items: center;
  background: ${themeCssVariables.background.primary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.md};
  bottom: ${themeCssVariables.spacing[4]};
  box-shadow: ${themeCssVariables.boxShadow.strong};
  color: ${themeCssVariables.font.color.primary};
  cursor: pointer;
  display: flex;
  font-family: ${themeCssVariables.font.family};
  font-size: ${themeCssVariables.font.size.sm};
  gap: ${themeCssVariables.spacing[2]};
  padding: ${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]};
  position: fixed;
  right: ${themeCssVariables.spacing[4]};
  z-index: ${RootStackingContextZIndices.AiCommandBar};
`;

const StyledShortcut = styled.span`
  color: ${themeCssVariables.font.color.tertiary};
  font-size: ${themeCssVariables.font.size.xs};
`;

const StyledOverlay = styled.div`
  align-items: flex-start;
  background: ${themeCssVariables.background.overlayPrimary};
  display: flex;
  height: 100%;
  justify-content: center;
  left: 0;
  padding-top: 12vh;
  position: fixed;
  top: 0;
  width: 100%;
  z-index: ${RootStackingContextZIndices.AiCommandBar};
`;

const StyledDialog = styled.div`
  background: ${themeCssVariables.background.primary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.md};
  box-shadow: ${themeCssVariables.boxShadow.strong};
  box-sizing: border-box;
  color: ${themeCssVariables.font.color.primary};
  display: flex;
  flex-direction: column;
  font-family: ${themeCssVariables.font.family};
  gap: ${themeCssVariables.spacing[3]};
  max-width: calc(100vw - 32px);
  padding: ${themeCssVariables.spacing[4]};
  width: 560px;
`;

const StyledTitle = styled.h2`
  font-size: ${themeCssVariables.font.size.md};
  font-weight: ${themeCssVariables.font.weight.semiBold};
  margin: 0;
`;

const StyledHint = styled.p`
  color: ${themeCssVariables.font.color.tertiary};
  font-size: ${themeCssVariables.font.size.xs};
  margin: 0;
`;

const StyledInput = styled.input`
  background: ${themeCssVariables.background.secondary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.sm};
  box-sizing: border-box;
  color: ${themeCssVariables.font.color.primary};
  font: inherit;
  padding: ${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]};
  width: 100%;
`;

const StyledActions = styled.div`
  display: flex;
  gap: ${themeCssVariables.spacing[2]};
  justify-content: flex-end;
`;

const StyledPrimary = styled.button`
  background: ${themeCssVariables.accent.primary};
  border: 0;
  border-radius: ${themeCssVariables.border.radius.sm};
  color: ${themeCssVariables.font.color.inverted};
  cursor: pointer;
  font: inherit;
  padding: ${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]};

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const StyledSecondary = styled.button`
  background: transparent;
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.sm};
  color: ${themeCssVariables.font.color.primary};
  cursor: pointer;
  font: inherit;
  padding: ${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]};
`;

const StyledSummary = styled.p`
  font-size: ${themeCssVariables.font.size.sm};
  margin: 0;
`;

const StyledList = styled.ul`
  display: flex;
  flex-direction: column;
  font-size: ${themeCssVariables.font.size.sm};
  gap: ${themeCssVariables.spacing[1]};
  margin: 0;
  padding-left: ${themeCssVariables.spacing[4]};
`;

const StyledNotice = styled.p`
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.sm};
  margin: 0;
`;

const StyledError = styled.p`
  color: ${themeCssVariables.font.color.danger};
  font-size: ${themeCssVariables.font.size.sm};
  margin: 0;
`;
