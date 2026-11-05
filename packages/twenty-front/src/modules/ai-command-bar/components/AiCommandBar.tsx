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
      choiceId?: string;
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
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const [wasOpen, setWasOpen] = useState(initialOpen);
  const resolvedConfig = config ?? readAiCommandBarConfig();
  const [open, setOpen] = useState(initialOpen);
  const [phase, setPhase] = useState<Phase>({ name: 'compose', draft: '' });
  const executing = phase.name === 'executing';
  const busy = phase.name === 'planning' || executing;

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

      if (wasOpen) {
        launcherRef.current?.focus();
      }

      return;
    }

    setWasOpen(true);
    inputRef.current?.focus();
  }, [open, wasOpen]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !executing) {
        event.preventDefault();
        invalidatePreview();
        setOpen(false);
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const dialog = dialogRef.current;

      if (dialog === null) {
        return;
      }

      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), a[href]',
        ),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (first === undefined || last === undefined) {
        return;
      }

      const active = document.activeElement;

      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [executing, open]);

  useEffect(() => {
    if (phase.name === 'preview') {
      confirmRef.current?.focus();
    }
  }, [phase.name]);

  const readGeneration = () => inputRef.current?.dataset.generation ?? '0';

  const invalidatePreview = () => {
    const input = inputRef.current;

    if (input === null) {
      return;
    }

    input.dataset.generation = String(
      Number(input.dataset.generation ?? '0') + 1,
    );
  };

  const close = () => {
    if (executing) {
      return;
    }

    invalidatePreview();
    setOpen(false);
  };

  const propose = async (draft: string) => {
    const intent = draft.trim();

    if (intent.length === 0) {
      return;
    }

    const generation = String(Number(readGeneration()) + 1);
    const input = inputRef.current;

    if (input !== null) {
      input.dataset.generation = generation;
    }

    setPhase({ name: 'planning', draft });

    const outcome = await proposeAiCommand(resolvedConfig, intent, fetchImpl);

    if (generation !== readGeneration()) {
      return;
    }

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
    choiceId?: string,
  ) => {
    const generation = readGeneration();

    setPhase({ name: 'executing', draft, proposal });

    const outcome = await executeAiCommand(
      resolvedConfig,
      proposal.id,
      idempotencyKey,
      fetchImpl,
      choiceId,
    );

    if (generation !== readGeneration()) {
      return;
    }

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
        <StyledLauncher
          ref={launcherRef}
          type="button"
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+Shift+K Meta+Shift+K"
          onClick={() => setOpen(true)}
        >
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
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={hintId}
            aria-busy={busy}
          >
            <StyledTitle id={titleId}>{t`AI command`}</StyledTitle>
            <StyledHint
              id={hintId}
            >{t`Ctrl+Shift+K or ⌘⇧K. Writes wait for confirmation.`}</StyledHint>
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
                    if (event.key === 'Escape' && !executing) {
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
              <StyledNotice role="status">{t`Proposing actions…`}</StyledNotice>
            )}
            {phase.name === 'executing' && (
              <StyledNotice role="status">{t`Working…`}</StyledNotice>
            )}
            {(phase.name === 'preview' || phase.name === 'executing') && (
              <>
                <StyledSummary>{phase.proposal.summary}</StyledSummary>
                {phase.name === 'preview' && phase.proposal.choice && (
                  <StyledChoices>
                    <legend>{phase.proposal.choice.prompt}</legend>
                    {phase.proposal.choice.candidates.map((candidate) => (
                      <label key={candidate.id}>
                        <input
                          type="radio"
                          name="ai-record-choice"
                          value={candidate.id}
                          checked={phase.choiceId === candidate.id}
                          onChange={() =>
                            setPhase({
                              ...phase,
                              choiceId: candidate.id,
                            })
                          }
                        />
                        {candidate.label}
                      </label>
                    ))}
                  </StyledChoices>
                )}
                {!phase.proposal.choice && (
                  <StyledList>
                    {phase.proposal.lines.map((line, index) => (
                      <li key={`${index}-${line.tool}`}>{line.summary}</li>
                    ))}
                  </StyledList>
                )}
              </>
            )}
            {phase.name === 'preview' && (
              <StyledActions>
                <StyledPrimary
                  ref={confirmRef}
                  type="button"
                  disabled={Boolean(phase.proposal.choice) && !phase.choiceId}
                  onClick={() =>
                    void confirm(
                      phase.proposal,
                      phase.idempotencyKey,
                      phase.draft,
                      phase.choiceId,
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
                    {phase.links.map((link) => {
                      const path = recordShowPath(link.objectName, link.id);

                      return (
                        <li key={`${link.objectName}-${link.id}`}>
                          {path ? (
                            <Link to={path}>{link.label}</Link>
                          ) : (
                            link.label
                          )}
                        </li>
                      );
                    })}
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

const StyledChoices = styled.fieldset`
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.sm};
  display: flex;
  flex-direction: column;
  font-size: ${themeCssVariables.font.size.sm};
  gap: ${themeCssVariables.spacing[2]};
  margin: 0;
  padding: ${themeCssVariables.spacing[3]};

  legend {
    padding: 0 ${themeCssVariables.spacing[1]};
  }

  label {
    align-items: center;
    display: flex;
    gap: ${themeCssVariables.spacing[2]};
  }
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
