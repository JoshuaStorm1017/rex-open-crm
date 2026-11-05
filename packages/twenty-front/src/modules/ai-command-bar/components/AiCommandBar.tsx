import { useLingui } from '@lingui/react/macro';
import { styled } from '@linaria/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { isPlainObject } from 'twenty-shared/utils';
import { themeCssVariables } from 'twenty-ui/theme';

import { aiCommandBarFieldPreviewState } from '@/ai-command-bar/states/aiCommandBarFieldPreviewState';
import {
  executeAiCommand,
  listAiSkills,
  proposeAiCapture,
  proposeAiCommand,
  proposeAiSkill,
  reproposeAiCommand,
  saveAiSkill,
  undoAiCommand,
  type AiAnswer,
  type AiCaptureSource,
  type AiCommandOutcome,
  type AiPlanView,
  type AiProposal,
  type AiProposalLine,
  type AiRecordLink,
  type AiSkill,
  type AiUndo,
} from '@/ai-command-bar/utils/aiCommandBarClient';
import { useSetAtomState } from '@/ui/utilities/state/jotai/hooks/useSetAtomState';
import { readOpenRecordFromPath } from '@/ai-command-bar/utils/readOpenRecordFromPath';
import { isAiCommandBarShortcut } from '@/ai-command-bar/utils/isAiCommandBarShortcut';
import { sidePanelNavigationStackState } from '@/side-panel/states/sidePanelNavigationStackState';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';
import {
  readAiCommandBarConfig,
  type AiCommandBarConfig,
} from '@/ai-command-bar/utils/readAiCommandBarConfig';
import { recordShowPath } from '@/ai-command-bar/utils/recordShowPath';
import { RootStackingContextZIndices } from '@/ui/layout/constants/RootStackingContextZIndices';

type Phase =
  | { name: 'compose'; draft: string; notice?: string }
  | { name: 'planning'; draft: string; lines: AiProposalLine[] }
  | {
      name: 'preview';
      draft: string;
      proposal: AiProposal;
      idempotencyKey: string;
      choiceId?: string;
      choiceIds: Record<string, string>;
      blocked?: boolean;
      blockMessage?: string;
      answer?: AiAnswer;
    }
  | {
      name: 'executing';
      draft: string;
      proposal: AiProposal;
      progress?: string;
    }
  | { name: 'answer'; draft: string; answer: AiAnswer }
  | {
      name: 'done';
      links: AiRecordLink[];
      undo?: AiUndo;
      undos?: AiUndo[];
      notice?: string;
      status?: string;
      confirmedPlanId?: string;
    }
  | { name: 'undoing'; draft: string; links: AiRecordLink[]; undo: AiUndo }
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
  const routeRecord = readOpenRecordFromPath(useLocation().pathname);
  const panelPath = useAtomStateValue(sidePanelNavigationStackState).at(-1)
    ?.routedLocation?.pathname;
  const panelRecord = panelPath ? readOpenRecordFromPath(panelPath) : undefined;
  const openRecord = panelRecord ?? routeRecord;
  const [open, setOpen] = useState(initialOpen);
  const [phase, setPhase] = useState<Phase>({ name: 'compose', draft: '' });
  const [skillName, setSkillName] = useState('');
  const [skills, setSkills] = useState<AiSkill[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureSource, setCaptureSource] = useState<AiCaptureSource>('card');
  const [captureText, setCaptureText] = useState('');
  const canListen = speechRecognitionAvailable();
  const setFieldPreview = useSetAtomState(aiCommandBarFieldPreviewState);
  const executing = phase.name === 'executing' || phase.name === 'undoing';
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
      setFieldPreview([]);
      setPhase({ name: 'compose', draft: '' });

      if (wasOpen) {
        launcherRef.current?.focus();
      }

      return;
    }

    setWasOpen(true);
    inputRef.current?.focus();
  }, [open, setFieldPreview, wasOpen]);

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
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]',
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

    setFieldPreview([]);
    setPhase({ name: 'planning', draft, lines: [] });

    const outcome = await proposeAiCommand(
      resolvedConfig,
      intent,
      fetchImpl,
      openRecord,
      (lines) => {
        if (generation !== readGeneration()) {
          return;
        }

        setPhase({ name: 'planning', draft, lines });
      },
    );

    if (generation !== readGeneration()) {
      return;
    }

    showPlan(draft, outcome);
  };

  const showPlan = (draft: string, outcome: AiCommandOutcome<AiPlanView>) => {
    if (outcome.kind === 'message' || outcome.kind === 'stale') {
      setFieldPreview([]);
      setPhase({
        name: 'refused',
        draft,
        message:
          outcome.kind === 'message'
            ? outcome.message
            : 'The AI gateway returned an unexpected plan.',
      });
      return;
    }

    if (!outcome.data.proposal) {
      setFieldPreview([]);
      setPhase({
        name: 'answer',
        draft,
        answer: outcome.data.answer ?? {
          summary: 'No matching records.',
          records: [],
        },
      });
      return;
    }

    setFieldPreview(outcome.data.proposal.changes ?? []);
    setPhase({
      name: 'preview',
      draft,
      proposal: outcome.data.proposal,
      idempotencyKey: crypto.randomUUID(),
      choiceIds: {},
      ...(outcome.data.answer ? { answer: outcome.data.answer } : {}),
    });
  };

  const reloadPreview = async (
    current: Extract<Phase, { name: 'preview' }>,
  ) => {
    const generation = readGeneration();

    setPhase({ name: 'planning', draft: current.draft, lines: [] });
    const outcome = await reproposeAiCommand(
      resolvedConfig,
      current.proposal.id,
      fetchImpl,
    );

    if (generation !== readGeneration()) {
      return;
    }

    showPlan(current.draft, outcome);
  };

  const previewCapture = async () => {
    const text = captureText.trim();

    if (text.length === 0) {
      return;
    }

    const generation = String(Number(readGeneration()) + 1);
    const input = inputRef.current;

    if (input !== null) {
      input.dataset.generation = generation;
    }

    setFieldPreview([]);
    setPhase({ name: 'planning', draft: '', lines: [] });
    const outcome = await proposeAiCapture(
      resolvedConfig,
      captureSource,
      text,
      fetchImpl,
    );

    if (generation !== readGeneration()) {
      return;
    }

    showPlan('', outcome);
  };

  const loadSkills = async () => {
    setSkillsOpen(true);
    const outcome = await listAiSkills(resolvedConfig, fetchImpl);

    if (outcome.kind === 'data') {
      setSkills(outcome.data);
      return;
    }

    setPhase((current) =>
      current.name === 'compose'
        ? { ...current, notice: outcome.message }
        : current,
    );
  };

  const runSkill = async (skill: AiSkill) => {
    const generation = String(Number(readGeneration()) + 1);
    const input = inputRef.current;

    if (input !== null) {
      input.dataset.generation = generation;
    }

    setFieldPreview([]);
    setPhase({ name: 'planning', draft: skill.name, lines: [] });
    const outcome = await proposeAiSkill(resolvedConfig, skill.id, fetchImpl);

    if (generation !== readGeneration()) {
      return;
    }

    showPlan(skill.name, outcome);
  };

  const saveSkill = async (current: Extract<Phase, { name: 'done' }>) => {
    const name = skillName.trim();

    if (!current.confirmedPlanId || name.length === 0) {
      return;
    }

    const outcome = await saveAiSkill(
      resolvedConfig,
      name,
      current.confirmedPlanId,
      fetchImpl,
    );

    if (outcome.kind !== 'data') {
      setPhase({
        ...current,
        notice: outcome.message,
      });
      return;
    }

    setSkills((currentSkills) => [outcome.data, ...currentSkills]);
    setSkillName('');
    setPhase({
      ...current,
      notice: undefined,
      status: t`Saved. Run it from Saved skills. Confirm still applies.`,
    });
  };

  const listen = () => {
    const recognition = speechRecognition();

    if (!recognition || phase.name !== 'compose') {
      return;
    }

    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? '';

      if (transcript.trim().length > 0) {
        setCaptureSource('voice');
        setCaptureText(transcript.trim());
      }
    };
    recognition.onerror = () => {
      setPhase((current) =>
        current.name === 'compose'
          ? {
              ...current,
              notice: t`Dictation stopped. Paste the words instead.`,
            }
          : current,
      );
    };
    recognition.start();
  };

  const readCardFile = (file: File) => {
    const textFile =
      file.type.startsWith('text') ||
      file.name.endsWith('.txt') ||
      file.name.endsWith('.vcf');

    if (!textFile) {
      setPhase((current) =>
        current.name === 'compose'
          ? {
              ...current,
              notice: t`Paste the card text. A photo is not read.`,
            }
          : current,
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCaptureSource('card');
        setCaptureText(reader.result.slice(0, 2000));
      }
    };
    reader.readAsText(file);
  };

  const confirm = async (current: Extract<Phase, { name: 'preview' }>) => {
    if (current.blocked) {
      return;
    }

    const generation = readGeneration();
    const { proposal, idempotencyKey, draft } = current;
    const bulk =
      proposal.tools.filter(
        (tool) => isPlainObject(tool) && tool.name === 'update_record',
      ).length > 1;

    setPhase({ name: 'executing', draft, proposal });

    const outcome = await executeAiCommand(
      resolvedConfig,
      proposal.id,
      idempotencyKey,
      fetchImpl,
      current.proposal.choice?.groups ? undefined : current.choiceId,
      current.proposal.choice?.groups ? current.choiceIds : undefined,
      bulk
        ? (progress) => {
            if (generation !== readGeneration()) {
              return;
            }

            setPhase({ name: 'executing', draft, proposal, progress });
          }
        : undefined,
    );

    if (generation !== readGeneration()) {
      return;
    }

    if (outcome.kind === 'stale') {
      const nextProposal = { ...proposal, changes: outcome.changes };

      setFieldPreview(outcome.changes);
      setPhase({
        ...current,
        proposal: nextProposal,
        blocked: true,
        blockMessage: outcome.message,
      });
      return;
    }

    if (outcome.kind === 'message') {
      setFieldPreview([]);
      setPhase({ name: 'refused', draft, message: outcome.message });
      return;
    }

    setFieldPreview([]);
    setPhase({
      name: 'done',
      links: outcome.data.links,
      ...(outcome.data.undo ? { undo: outcome.data.undo } : {}),
      ...(outcome.data.undos ? { undos: outcome.data.undos } : {}),
      ...(outcome.data.confirmedPlanId
        ? { confirmedPlanId: outcome.data.confirmedPlanId }
        : {}),
    });
  };

  const undo = async (current: Extract<Phase, { name: 'done' }>) => {
    if (!current.undo) {
      return;
    }

    const generation = readGeneration();

    setPhase({
      name: 'undoing',
      draft: '',
      links: current.links,
      undo: current.undo,
    });

    const outcome = await undoAiCommand(
      resolvedConfig,
      current.undo.id,
      crypto.randomUUID(),
      fetchImpl,
    );

    if (generation !== readGeneration()) {
      return;
    }

    if (outcome.kind !== 'data') {
      setPhase({
        name: 'done',
        links: current.links,
        undo: current.undo,
        ...(current.undos ? { undos: current.undos } : {}),
        ...(current.confirmedPlanId
          ? { confirmedPlanId: current.confirmedPlanId }
          : {}),
        ...(current.status ? { status: current.status } : {}),
        notice: outcome.message,
      });
      return;
    }

    if (outcome.data.next) {
      setPhase({
        name: 'done',
        links: current.links,
        undo: outcome.data.next,
        undos: outcome.data.undos ?? [outcome.data.next],
        notice: t`Undone. The next recent change can still be reversed.`,
      });
      return;
    }

    setPhase({
      name: 'compose',
      draft: '',
      notice: t`Undone. The last change was reversed.`,
    });
  };

  const cancelPreview = (draft: string) => {
    setFieldPreview([]);
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
            <StyledHint id={hintId}>
              {openRecord?.objectName === 'opportunity'
                ? t`Ctrl+Shift+K or ⌘⇧K. This deal is included. Writes wait for confirmation.`
                : openRecord?.objectName === 'person'
                  ? t`Ctrl+Shift+K or ⌘⇧K. This person is included. Writes wait for confirmation.`
                  : openRecord
                    ? t`Ctrl+Shift+K or ⌘⇧K. This company is included. Writes wait for confirmation.`
                    : t`Ctrl+Shift+K or ⌘⇧K. Writes wait for confirmation.`}
            </StyledHint>
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
                  placeholder={
                    openRecord?.objectName === 'opportunity'
                      ? t`Update this deal's stage to Proposal`
                      : openRecord?.objectName === 'person'
                        ? t`Add a note to this person: Followed up`
                        : openRecord
                          ? t`Update this company's domain to acme.example`
                          : t`Add Acme Corp as a company and a $50k deal for Jane Doe`
                  }
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
            {phase.name === 'compose' && (
              <StyledActions>
                <StyledSecondary
                  type="button"
                  onClick={() => setCaptureOpen((current) => !current)}
                >
                  {t`Card or voice`}
                </StyledSecondary>
                <StyledSecondary
                  type="button"
                  onClick={() => void loadSkills()}
                >
                  {t`Saved skills`}
                </StyledSecondary>
              </StyledActions>
            )}
            {phase.name === 'compose' && captureOpen && (
              <CaptureFields
                source={captureSource}
                text={captureText}
                canListen={canListen}
                onSource={setCaptureSource}
                onText={setCaptureText}
                onFile={readCardFile}
                onListen={listen}
                onPreview={() => void previewCapture()}
              />
            )}
            {phase.name === 'compose' && skillsOpen && (
              <SkillList
                skills={skills}
                onRun={(skill) => void runSkill(skill)}
              />
            )}
            {phase.name === 'planning' && (
              <>
                <StyledNotice role="status">{t`Proposing actions…`}</StyledNotice>
                {phase.lines.length > 0 && (
                  <StyledList>
                    {phase.lines.map((line, index) => (
                      <li key={`${index}-${line.tool}`}>{line.summary}</li>
                    ))}
                  </StyledList>
                )}
              </>
            )}
            {(phase.name === 'executing' || phase.name === 'undoing') && (
              <StyledNotice role="status">
                {phase.name === 'undoing'
                  ? t`Undoing…`
                  : (phase.progress ?? t`Working…`)}
              </StyledNotice>
            )}
            {(phase.name === 'preview' || phase.name === 'executing') && (
              <>
                <StyledSummary>{phase.proposal.summary}</StyledSummary>
                {phase.name === 'preview' && phase.answer && (
                  <AnswerList answer={phase.answer} />
                )}
                {phase.name === 'preview' &&
                  phase.proposal.warnings?.map((warning) => (
                    <StyledWarning
                      key={`${warning.code}-${warning.message}`}
                      role="status"
                    >
                      {warning.message}
                    </StyledWarning>
                  ))}
                {phase.name === 'preview' && phase.blockMessage && (
                  <StyledError role="alert">{phase.blockMessage}</StyledError>
                )}
                {phase.name === 'preview' &&
                  phase.proposal.choice?.groups?.map((group) => (
                    <StyledChoices key={group.id}>
                      <legend>{group.prompt}</legend>
                      {group.candidates.map((candidate) => (
                        <StyledChoice key={`${group.id}-${candidate.id}`}>
                          <label>
                            <input
                              type="radio"
                              name={`ai-record-choice-${group.id}`}
                              value={candidate.id}
                              checked={
                                phase.choiceIds[group.id] === candidate.id
                              }
                              onChange={() =>
                                setPhase({
                                  ...phase,
                                  choiceIds: {
                                    ...phase.choiceIds,
                                    [group.id]: candidate.id,
                                  },
                                })
                              }
                            />
                            <StyledChoiceText>
                              <span>{candidate.label}</span>
                              {candidate.detail && (
                                <StyledChoiceDetail>
                                  {candidate.detail}
                                </StyledChoiceDetail>
                              )}
                            </StyledChoiceText>
                          </label>
                          {candidate.action === 'create' && (
                            <StyledChoiceHint>{t`New record`}</StyledChoiceHint>
                          )}
                        </StyledChoice>
                      ))}
                    </StyledChoices>
                  ))}
                {phase.name === 'preview' &&
                  phase.proposal.choice &&
                  !phase.proposal.choice.groups && (
                    <StyledChoices>
                      <legend>{phase.proposal.choice.prompt}</legend>
                      {phase.proposal.choice.candidates.map((candidate) => (
                        <StyledChoice key={candidate.id}>
                          <label>
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
                            <StyledChoiceText>
                              <span>{candidate.label}</span>
                              {candidate.detail && (
                                <StyledChoiceDetail>
                                  {candidate.detail}
                                </StyledChoiceDetail>
                              )}
                            </StyledChoiceText>
                          </label>
                          {candidate.action === 'create' && (
                            <StyledChoiceHint>{t`New record`}</StyledChoiceHint>
                          )}
                        </StyledChoice>
                      ))}
                    </StyledChoices>
                  )}
                {(!phase.proposal.choice ||
                  (phase.proposal.choice.groups &&
                    phase.proposal.lines.some(
                      (line) => line.summary !== phase.proposal.choice?.prompt,
                    ))) && (
                  <StyledList>
                    {phase.proposal.lines
                      .filter(
                        (line) =>
                          line.summary !== phase.proposal.choice?.prompt,
                      )
                      .map((line, index) => (
                        <li key={`${index}-${line.tool}`}>{line.summary}</li>
                      ))}
                    {phase.name === 'preview' &&
                      phase.proposal.changes?.map((change) => (
                        <li
                          key={`${change.recordId}-${change.field ?? 'archive'}`}
                        >
                          {change.summary}
                        </li>
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
                  disabled={
                    phase.blocked ||
                    (phase.proposal.choice?.groups
                      ? !phase.proposal.choice.groups.every(
                          (group) => phase.choiceIds[group.id],
                        )
                      : Boolean(phase.proposal.choice) && !phase.choiceId)
                  }
                  onClick={() => void confirm(phase)}
                >
                  {t`Confirm`}
                </StyledPrimary>
                <StyledSecondary
                  type="button"
                  onClick={() => cancelPreview(phase.draft)}
                >
                  {t`Cancel`}
                </StyledSecondary>
                {phase.blocked && (
                  <StyledSecondary
                    type="button"
                    onClick={() => void reloadPreview(phase)}
                  >
                    {t`Reload preview`}
                  </StyledSecondary>
                )}
              </StyledActions>
            )}
            {phase.name === 'answer' && (
              <>
                <AnswerList answer={phase.answer} />
                <StyledNotice role="status">
                  {t`Nothing was changed.`}
                </StyledNotice>
                <StyledActions>
                  <StyledSecondary type="button" onClick={close}>
                    {t`Close`}
                  </StyledSecondary>
                </StyledActions>
              </>
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
                {phase.status && (
                  <StyledNotice role="status">{phase.status}</StyledNotice>
                )}
                {phase.notice && (
                  <StyledError role="alert">{phase.notice}</StyledError>
                )}
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
                {(phase.undos ?? []).length > 1 && (
                  <StyledList>
                    {(phase.undos ?? []).map((item) => (
                      <li key={item.id}>{item.summary}</li>
                    ))}
                  </StyledList>
                )}
                {phase.confirmedPlanId && (
                  <StyledInput
                    aria-label={t`Skill name`}
                    value={skillName}
                    placeholder={t`Name this skill`}
                    onChange={(event) => setSkillName(event.target.value)}
                  />
                )}
                <StyledActions>
                  {phase.confirmedPlanId && (
                    <StyledSecondary
                      type="button"
                      disabled={skillName.trim().length === 0}
                      onClick={() => void saveSkill(phase)}
                    >
                      {t`Save skill`}
                    </StyledSecondary>
                  )}
                  {phase.undo && (
                    <StyledSecondary
                      type="button"
                      onClick={() => void undo(phase)}
                    >
                      {t`Undo`}
                    </StyledSecondary>
                  )}
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

const StyledTextArea = styled.textarea`
  background: ${themeCssVariables.background.secondary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.sm};
  box-sizing: border-box;
  color: ${themeCssVariables.font.color.primary};
  font: inherit;
  min-height: 96px;
  padding: ${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]};
  width: 100%;
`;

const StyledFileLabel = styled.label`
  align-items: center;
  color: ${themeCssVariables.font.color.secondary};
  cursor: pointer;
  display: inline-flex;
  font-size: ${themeCssVariables.font.size.sm};

  input {
    margin-left: ${themeCssVariables.spacing[2]};
  }
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

const StyledChoice = styled.div`
  align-items: center;
  display: flex;
  gap: ${themeCssVariables.spacing[2]};
  justify-content: space-between;
`;

const StyledChoiceText = styled.span`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[1]};
`;

const StyledChoiceDetail = styled.span`
  color: ${themeCssVariables.font.color.tertiary};
  font-size: ${themeCssVariables.font.size.xs};
`;

const StyledChoiceHint = styled.span`
  color: ${themeCssVariables.font.color.tertiary};
  font-size: ${themeCssVariables.font.size.xs};
`;

const StyledList = styled.ul`
  display: flex;
  flex-direction: column;
  font-size: ${themeCssVariables.font.size.sm};
  gap: ${themeCssVariables.spacing[1]};
  margin: 0;
  padding-left: ${themeCssVariables.spacing[4]};
`;

type SpeechResult = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechResult) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
};

const speechHost = (): {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
} =>
  window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };

const speechRecognitionAvailable = (): boolean => {
  const host = speechHost();

  return Boolean(host.SpeechRecognition ?? host.webkitSpeechRecognition);
};

const speechRecognition = (): SpeechRecognitionLike | undefined => {
  const host = speechHost();
  const Recognition = host.SpeechRecognition ?? host.webkitSpeechRecognition;

  return Recognition ? new Recognition() : undefined;
};

const CaptureFields = ({
  source,
  text,
  canListen,
  onSource,
  onText,
  onFile,
  onListen,
  onPreview,
}: {
  source: AiCaptureSource;
  text: string;
  canListen: boolean;
  onSource: (source: AiCaptureSource) => void;
  onText: (text: string) => void;
  onFile: (file: File) => void;
  onListen: () => void;
  onPreview: () => void;
}) => {
  const { t } = useLingui();

  return (
    <>
      <StyledChoices>
        <legend>{t`Card or voice`}</legend>
        <label>
          <input
            type="radio"
            name="ai-capture-source"
            checked={source === 'card'}
            onChange={() => onSource('card')}
          />
          {t`Card`}
        </label>
        <label>
          <input
            type="radio"
            name="ai-capture-source"
            checked={source === 'voice'}
            onChange={() => onSource('voice')}
          />
          {t`Voice`}
        </label>
      </StyledChoices>
      <StyledTextArea
        aria-label={t`Card or dictation`}
        value={text}
        placeholder={t`Paste a card, a vCard, or a short dictation`}
        onChange={(event) => onText(event.target.value)}
      />
      <StyledActions>
        <StyledFileLabel>
          {t`Card file`}
          <input
            aria-label={t`Card file`}
            type="file"
            accept="text/plain,.txt,.vcf,text/vcard"
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file) {
                onFile(file);
              }
            }}
          />
        </StyledFileLabel>
        {canListen && (
          <StyledSecondary type="button" onClick={onListen}>
            {t`Listen`}
          </StyledSecondary>
        )}
        <StyledPrimary
          type="button"
          disabled={text.trim().length === 0}
          onClick={onPreview}
        >
          {t`Preview capture`}
        </StyledPrimary>
      </StyledActions>
    </>
  );
};

const SkillList = ({
  skills,
  onRun,
}: {
  skills: AiSkill[];
  onRun: (skill: AiSkill) => void;
}) => {
  const { t } = useLingui();

  if (skills.length === 0) {
    return <StyledNotice>{t`No saved skills.`}</StyledNotice>;
  }

  return (
    <StyledList>
      {skills.map((skill) => (
        <li key={skill.id}>
          <span>
            {skill.name}
            {skill.tools.length > 0 ? ` (${skill.tools.join(', ')})` : ''}
          </span>{' '}
          <StyledSecondary type="button" onClick={() => onRun(skill)}>
            {t`Run`}
          </StyledSecondary>
        </li>
      ))}
    </StyledList>
  );
};

const AnswerList = ({ answer }: { answer: AiAnswer }) => (
  <>
    <StyledSummary>{answer.summary}</StyledSummary>
    {answer.records.length > 0 && (
      <StyledList>
        {answer.records.map((record) => (
          <li key={`${record.objectName}-${record.id}`}>
            {record.label}
            {record.detail ? ` — ${record.detail}` : ''}
          </li>
        ))}
      </StyledList>
    )}
  </>
);

const StyledNotice = styled.p`
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.sm};
  margin: 0;
`;

const StyledWarning = styled.p`
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.sm};
  margin: 0;
`;

const StyledError = styled.p`
  color: ${themeCssVariables.font.color.danger};
  font-size: ${themeCssVariables.font.size.sm};
  margin: 0;
`;
