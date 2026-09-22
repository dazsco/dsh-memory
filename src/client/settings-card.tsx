/**
 * The dsh-memory settings card: edits this plugin's live Config entry — the
 * nested `dsh-memory` namespace (capture/dream/brief/llm/redact) — on the
 * Plugins page, where the bundle and row configuration slots
 * (`plugins.bundle.config`, `plugins.row.config`) seat a plugin's own form.
 *
 * Self-contained card chrome (staged fields grouped by section, save/discard
 * footer) following the plugin-card store pattern of the DSH configuration
 * surface; styles live in `styles.ts` and use the DSH design tokens so the
 * card follows the active theme. Plus a "Dream now" trigger that bumps
 * `dream.requestSeq` — the Host's existing watcher fires a Dream run without
 * any save.
 */
import { useRef, useState, type ReactNode } from 'react';
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemorySettings } from '../settings.ts';
import type { SettingsCardKey } from './locales.ts';
import {
  booleanField,
  CardForm,
  numberField,
  ratioField,
  selectField,
  textField,
  type CardActions,
  type CardFieldState,
  type CardShell,
} from './settings-form.ts';
import { injectStyles } from './styles.ts';

// Styles must land during factory materialization so the module system's
// style bookkeeping (HMR) owns them.
injectStyles();

/** What the dsh-memory card renders. */
export interface MemorySettingsCardState extends CardShell {
  enabled: CardFieldState;
  captureMode: CardFieldState;
  captureUseLlm: CardFieldState;
  turnTailChars: CardFieldState;
  minTurnContentChars: CardFieldState;
  captureCompaction: CardFieldState;
  captureCompactionMaxChars: CardFieldState;
  captureHeuristic: CardFieldState;
  captureLlmMaxCalls: CardFieldState;
  captureLlmMinInterval: CardFieldState;
  dreamEnabled: CardFieldState;
  dreamUseLlm: CardFieldState;
  dreamInterval: CardFieldState;
  dreamMaxLlmCalls: CardFieldState;
  dreamMaxWallMs: CardFieldState;
  briefEnabled: CardFieldState;
  briefMaxBytes: CardFieldState;
  briefProjectK: CardFieldState;
  briefGlobalK: CardFieldState;
  recallK: CardFieldState;
  recallExpandLinks: CardFieldState;
  recallLinkDecay: CardFieldState;
  recallBriefIncludeSuperseded: CardFieldState;
  commandsEnabled: CardFieldState;
  budgetMaxCardBytes: CardFieldState;
  budgetMaxInboxLines: CardFieldState;
  maintenanceEnabled: CardFieldState;
  maintenanceStaleDays: CardFieldState;
  maintenanceStaleMaxImportance: CardFieldState;
  maintenanceMaxLiveCards: CardFieldState;
  maintenanceMaxArchivedCards: CardFieldState;
  maintenanceMaxAuditLines: CardFieldState;
  maintenanceMaxAccessLines: CardFieldState;
  maintenanceMaxInboxBytes: CardFieldState;
  llmProvider: CardFieldState;
  llmModel: CardFieldState;
  llmMaxOutputTokens: CardFieldState;
  llmTimeoutMs: CardFieldState;
  redactPii: CardFieldState;
  /** The live `dream.requestSeq`, for the "Dream now" trigger. */
  dreamSeq: number;
}

/** The registration-side face the card's slot entry injects. */
export interface MemorySettingsCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useMemorySettingsCard. */
    memorySettingsCard: SnapshotStore<MemorySettingsCardState>;
  };
  /** Bump `dream.requestSeq` so the Host fires a Dream run immediately. Resolves when the Host has committed the bump; rejects when it did not. */
  dreamNow: () => Promise<void>;
}

/** Bridges the live `dsh-memory` configuration entry onto the card's staged form. */
export class MemorySettingsCardController {
  private readonly form: CardForm<MemorySettings>;
  private readonly store: SnapshotStore<MemorySettingsCardState>;

  /**
   * @param scope - the shared configuration form for this plugin's entry.
   */
  constructor(private readonly scope: ConfigForm<MemorySettings>) {
    this.form = new CardForm<MemorySettings>(scope, [
      booleanField(['enabled']),
      selectField(['capture', 'mode'], ['off', 'explicit', 'auto']),
      booleanField(['capture', 'useLlm']),
      numberField(['capture', 'turnTailChars'], 1),
      numberField(['capture', 'minTurnContentChars'], 0),
      booleanField(['capture', 'compaction']),
      numberField(['capture', 'compactionMaxChars'], 200),
      booleanField(['capture', 'heuristic']),
      numberField(['capture', 'llmMaxCallsPerSession'], 0),
      numberField(['capture', 'llmMinIntervalMs'], 0),
      booleanField(['dream', 'enabled']),
      booleanField(['dream', 'useLlm']),
      numberField(['dream', 'intervalMinutes'], 5),
      numberField(['dream', 'maxLlmCalls'], 0),
      numberField(['dream', 'maxWallMs'], 5000),
      booleanField(['brief', 'enabled']),
      numberField(['brief', 'maxBytes'], 512),
      numberField(['brief', 'projectK'], 0),
      numberField(['brief', 'globalK'], 0),
      numberField(['recall', 'k'], 1),
      booleanField(['recall', 'expandLinks']),
      ratioField(['recall', 'linkDecay'], 0, 1),
      booleanField(['recall', 'briefIncludeSuperseded']),
      booleanField(['commands', 'enabled']),
      numberField(['budget', 'maxCardBytes'], 256),
      numberField(['budget', 'maxInboxLines'], 10),
      booleanField(['maintenance', 'enabled']),
      numberField(['maintenance', 'staleDays'], 0),
      numberField(['maintenance', 'staleMaxImportance'], 1),
      numberField(['maintenance', 'maxLiveCards'], 50),
      numberField(['maintenance', 'maxArchivedCards'], 0),
      numberField(['maintenance', 'maxAuditLines'], 100),
      numberField(['maintenance', 'maxAccessLines'], 100),
      numberField(['maintenance', 'maxInboxBytes'], 10000),
      textField(['llm', 'provider']),
      textField(['llm', 'model']),
      numberField(['llm', 'maxOutputTokens'], 16),
      numberField(['llm', 'timeoutMs'], 1000),
      selectField(['redact', 'pii'], ['off', 'warn', 'redact']),
    ]);
    this.store = this.form.bind(() => this.projection(), createSnapshotStore);
  }

  private projection(): MemorySettingsCardState {
    const value = this.scope.getSnapshot().value;
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      captureMode: this.form.field('capture.mode'),
      captureUseLlm: this.form.field('capture.useLlm'),
      turnTailChars: this.form.field('capture.turnTailChars'),
      minTurnContentChars: this.form.field('capture.minTurnContentChars'),
      captureCompaction: this.form.field('capture.compaction'),
      captureCompactionMaxChars: this.form.field('capture.compactionMaxChars'),
      captureHeuristic: this.form.field('capture.heuristic'),
      captureLlmMaxCalls: this.form.field('capture.llmMaxCallsPerSession'),
      captureLlmMinInterval: this.form.field('capture.llmMinIntervalMs'),
      dreamEnabled: this.form.field('dream.enabled'),
      dreamUseLlm: this.form.field('dream.useLlm'),
      dreamInterval: this.form.field('dream.intervalMinutes'),
      dreamMaxLlmCalls: this.form.field('dream.maxLlmCalls'),
      dreamMaxWallMs: this.form.field('dream.maxWallMs'),
      briefEnabled: this.form.field('brief.enabled'),
      briefMaxBytes: this.form.field('brief.maxBytes'),
      briefProjectK: this.form.field('brief.projectK'),
      briefGlobalK: this.form.field('brief.globalK'),
      recallK: this.form.field('recall.k'),
      recallExpandLinks: this.form.field('recall.expandLinks'),
      recallLinkDecay: this.form.field('recall.linkDecay'),
      recallBriefIncludeSuperseded: this.form.field('recall.briefIncludeSuperseded'),
      commandsEnabled: this.form.field('commands.enabled'),
      budgetMaxCardBytes: this.form.field('budget.maxCardBytes'),
      budgetMaxInboxLines: this.form.field('budget.maxInboxLines'),
      maintenanceEnabled: this.form.field('maintenance.enabled'),
      maintenanceStaleDays: this.form.field('maintenance.staleDays'),
      maintenanceStaleMaxImportance: this.form.field('maintenance.staleMaxImportance'),
      maintenanceMaxLiveCards: this.form.field('maintenance.maxLiveCards'),
      maintenanceMaxArchivedCards: this.form.field('maintenance.maxArchivedCards'),
      maintenanceMaxAuditLines: this.form.field('maintenance.maxAuditLines'),
      maintenanceMaxAccessLines: this.form.field('maintenance.maxAccessLines'),
      maintenanceMaxInboxBytes: this.form.field('maintenance.maxInboxBytes'),
      llmProvider: this.form.field('llm.provider'),
      llmModel: this.form.field('llm.model'),
      llmMaxOutputTokens: this.form.field('llm.maxOutputTokens'),
      llmTimeoutMs: this.form.field('llm.timeoutMs'),
      redactPii: this.form.field('redact.pii'),
      dreamSeq: typeof value?.dream?.requestSeq === 'number' ? value.dream.requestSeq : 0,
    };
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the dream trigger.
   */
  inject(): MemorySettingsCardFace {
    return {
      hooks: { memorySettingsCard: this.store },
      ...this.form.actions(),
      dreamNow: () => {
        const seq = this.projection().dreamSeq;
        return this.scope
          .mutate([{ op: 'set', path: ['dream', 'requestSeq'], value: seq + 1 }])
          .then((accepted) => {
            // A refused write or an unreachable Host is not a triggered run.
            if (!accepted) throw new Error('dsh-memory: the Host refused the Dream trigger');
          });
      },
    };
  }

  /** Release the card's subscription to the shared configuration form. */
  dispose(): void {
    this.form.dispose();
  }
}

/** Props the Plugins page binds for the dsh-memory configuration entry. */
export type MemorySettingsCardProps =
  PropsRuntime<'plugins.row.config'> & PropsLocale<'dsh-memory'> & InjectFace<MemorySettingsCardFace>;

/**
 * Card body: the read-only notice, the controls, and the save that writes
 * them. The hosting page draws the plugin title and one-liner, so this card
 * contributes no second header of its own.
 */
function SettingsCardBody(props: {
  t: (key: SettingsCardKey) => string;
  state: CardShell;
  onSave: () => void;
  onDiscard: () => void;
  children: ReactNode;
}) {
  const { state } = props;
  if (!state.available) {
    return <p className="dshMemUnavailable" role="status">{props.t('chrome.unavailable')}</p>;
  }
  const blocked = !state.dirty || state.invalid || state.saving;
  return (
    <section className="dshMemCard dshMemCardOpen">
      <div className="dshMemBody">
        {!state.writable ? (
          <p className="dshMemReadOnly" role="status">{props.t('chrome.readOnly')}</p>
        ) : null}
        {props.children}
        <div className="dshMemFooter">
          {state.failed ? (
            <p className="dshMemFailed" role="status">{props.t('chrome.saveFailed')}</p>
          ) : null}
          <button
            type="button"
            className="dshMemDiscard"
            disabled={!state.dirty || state.saving}
            onClick={props.onDiscard}
          >
            {props.t('chrome.discard')}
          </button>
          <button type="button" className="dshMemSave" disabled={blocked} onClick={props.onSave}>
            {props.t(!state.saving ? 'chrome.save' : 'chrome.saving')}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Props every field control needs regardless of its value type. */
interface FieldProps {
  id: string;
  label: string;
  hint: string;
  text: string;
  overridden: boolean;
  invalid: boolean;
  disabled: boolean;
  t: (key: SettingsCardKey) => string;
  onEdit: (text: string) => void;
  onReset: () => void;
}

/** A staged value field; `numeric`/`decimal` only hint the keypad, which drafts a field accepts is decided by its spec. */
function ValueField(props: FieldProps & { numeric?: boolean; decimal?: boolean; placeholder?: string }) {
  return (
    <div className="dshMemField">
      <div className="dshMemHead">
        <label className="dshMemLabel" htmlFor={props.id}>{props.label}</label>
        {props.overridden ? (
          <span className="dshMemBadges">
            <span className="dshMemBadge">{props.t('chrome.overridden')}</span>
            <button type="button" className="dshMemReset" disabled={props.disabled} onClick={props.onReset}>
              {props.t('chrome.reset')}
            </button>
          </span>
        ) : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? 'dshMemInput dshMemInputInvalid' : 'dshMemInput'}
        type="text"
        inputMode={props.decimal === true ? 'decimal' : props.numeric === true ? 'numeric' : undefined}
        aria-invalid={props.invalid || undefined}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => props.onEdit(event.target.value)}
      />
      <p className={props.invalid ? 'dshMemInvalid' : 'dshMemHint'}>
        {props.invalid ? props.t('chrome.invalidNumber') : props.hint}
      </p>
    </div>
  );
}

/** A staged option field: inherit / one of the field's options. */
function OptionField(props: FieldProps & { options: { value: string; label: string }[] }) {
  return (
    <div className="dshMemField">
      <div className="dshMemHead">
        <label className="dshMemLabel" htmlFor={props.id}>{props.label}</label>
        {props.overridden ? (
          <span className="dshMemBadges">
            <span className="dshMemBadge">{props.t('chrome.overridden')}</span>
            <button type="button" className="dshMemReset" disabled={props.disabled} onClick={props.onReset}>
              {props.t('chrome.reset')}
            </button>
          </span>
        ) : null}
      </div>
      <select
        id={props.id}
        className="dshMemSelect"
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => props.onEdit(event.target.value)}
      >
        <option value="">{props.t('chrome.inherit')}</option>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <p className={props.invalid ? 'dshMemInvalid' : 'dshMemHint'}>
        {props.invalid ? props.t('chrome.invalidNumber') : props.hint}
      </p>
    </div>
  );
}

/** A staged boolean field: inherit / on / off. */
function BooleanField(props: FieldProps) {
  return (
    <OptionField
      {...props}
      options={[
        { value: 'true', label: props.t('chrome.on') },
        { value: 'false', label: props.t('chrome.off') },
      ]}
    />
  );
}

/** One settings section of the card. */
function Group(props: { t: (key: SettingsCardKey) => string; titleKey: SettingsCardKey; children: ReactNode }) {
  return (
    <section className="dshMemGroup">
      <span className="dshMemGroupTitle">{props.t(props.titleKey)}</span>
      {props.children}
    </section>
  );
}

/** The transient phase of a "Dream now" trigger, for real button feedback. */
type DreamPhase = 'idle' | 'pending' | 'ok' | 'error';

/** How long the confirmed/failed button state lingers before returning to idle. */
const DREAM_PHASE_RESET_MS = 3000;

/**
 * Render the dsh-memory configuration entry.
 * @param props - the view the page asked for, locale copy, the card snapshot,
 * and its form actions.
 * @returns the one-liner for a summary view, or the settings form.
 */
export function MemorySettingsCard(props: MemorySettingsCardProps) {
  const { t } = props;
  const state = props.useMemorySettingsCard((snapshot) => snapshot);
  const disabled = !state.writable;
  const shared = { t, disabled };
  const [dreamPhase, setDreamPhase] = useState<DreamPhase>('idle');
  const dreamReset = useRef<number | undefined>(undefined);
  const onDream = async (): Promise<void> => {
    if (dreamPhase !== 'idle') return;
    setDreamPhase('pending');
    let ok = false;
    try {
      await props.dreamNow();
      ok = true;
    } catch {
      ok = false;
    }
    setDreamPhase(ok ? 'ok' : 'error');
    window.clearTimeout(dreamReset.current);
    dreamReset.current = window.setTimeout(() => setDreamPhase('idle'), DREAM_PHASE_RESET_MS);
  };
  const dreamButtonClass =
    'dshMemDreamNow' +
    (dreamPhase === 'ok' ? ' dshMemDreamNowOk' : '') +
    (dreamPhase === 'error' ? ' dshMemDreamNowError' : '');
  // The row page asks for a one-liner first; only the page view draws controls.
  if (props.view === 'summary') return t('card.description');
  return (
    <SettingsCardBody
      t={t}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <Group t={t} titleKey="group.global">
        <BooleanField
          id="memory-enabled"
          label={t('field.enabled')}
          hint={t('field.enabledHint')}
          {...shared}
          {...state.enabled}
          onEdit={(text) => props.edit('enabled', text)}
          onReset={() => props.resetField('enabled')}
        />
      </Group>
      <Group t={t} titleKey="group.capture">
        <OptionField
          id="memory-capture-mode"
          label={t('field.captureMode')}
          hint={t('field.captureModeHint')}
          options={[
            { value: 'auto', label: 'auto' },
            { value: 'explicit', label: 'explicit' },
            { value: 'off', label: 'off' },
          ]}
          {...shared}
          {...state.captureMode}
          onEdit={(text) => props.edit('capture.mode', text)}
          onReset={() => props.resetField('capture.mode')}
        />
        <BooleanField
          id="memory-capture-use-llm"
          label={t('field.captureUseLlm')}
          hint={t('field.captureUseLlmHint')}
          {...shared}
          {...state.captureUseLlm}
          onEdit={(text) => props.edit('capture.useLlm', text)}
          onReset={() => props.resetField('capture.useLlm')}
        />
        <ValueField
          id="memory-turn-tail-chars"
          label={t('field.turnTailChars')}
          hint={t('field.turnTailCharsHint')}
          numeric
          {...shared}
          {...state.turnTailChars}
          onEdit={(text) => props.edit('capture.turnTailChars', text)}
          onReset={() => props.resetField('capture.turnTailChars')}
        />
        <ValueField
          id="memory-min-turn-chars"
          label={t('field.minTurnContentChars')}
          hint={t('field.minTurnContentCharsHint')}
          numeric
          {...shared}
          {...state.minTurnContentChars}
          onEdit={(text) => props.edit('capture.minTurnContentChars', text)}
          onReset={() => props.resetField('capture.minTurnContentChars')}
        />
        <BooleanField
          id="memory-capture-compaction"
          label={t('field.captureCompaction')}
          hint={t('field.captureCompactionHint')}
          {...shared}
          {...state.captureCompaction}
          onEdit={(text) => props.edit('capture.compaction', text)}
          onReset={() => props.resetField('capture.compaction')}
        />
        <ValueField
          id="memory-capture-compaction-max-chars"
          label={t('field.captureCompactionMaxChars')}
          hint={t('field.captureCompactionMaxCharsHint')}
          numeric
          {...shared}
          {...state.captureCompactionMaxChars}
          onEdit={(text) => props.edit('capture.compactionMaxChars', text)}
          onReset={() => props.resetField('capture.compactionMaxChars')}
        />
        <BooleanField
          id="memory-capture-heuristic"
          label={t('field.captureHeuristic')}
          hint={t('field.captureHeuristicHint')}
          {...shared}
          {...state.captureHeuristic}
          onEdit={(text) => props.edit('capture.heuristic', text)}
          onReset={() => props.resetField('capture.heuristic')}
        />
        <ValueField
          id="memory-capture-llm-max-calls"
          label={t('field.captureLlmMaxCalls')}
          hint={t('field.captureLlmMaxCallsHint')}
          numeric
          {...shared}
          {...state.captureLlmMaxCalls}
          onEdit={(text) => props.edit('capture.llmMaxCallsPerSession', text)}
          onReset={() => props.resetField('capture.llmMaxCallsPerSession')}
        />
        <ValueField
          id="memory-capture-llm-min-interval"
          label={t('field.captureLlmMinInterval')}
          hint={t('field.captureLlmMinIntervalHint')}
          numeric
          {...shared}
          {...state.captureLlmMinInterval}
          onEdit={(text) => props.edit('capture.llmMinIntervalMs', text)}
          onReset={() => props.resetField('capture.llmMinIntervalMs')}
        />
      </Group>
      <Group t={t} titleKey="group.dream">
        <BooleanField
          id="memory-dream-enabled"
          label={t('field.dreamEnabled')}
          hint={t('field.dreamEnabledHint')}
          {...shared}
          {...state.dreamEnabled}
          onEdit={(text) => props.edit('dream.enabled', text)}
          onReset={() => props.resetField('dream.enabled')}
        />
        <BooleanField
          id="memory-dream-use-llm"
          label={t('field.dreamUseLlm')}
          hint={t('field.dreamUseLlmHint')}
          {...shared}
          {...state.dreamUseLlm}
          onEdit={(text) => props.edit('dream.useLlm', text)}
          onReset={() => props.resetField('dream.useLlm')}
        />
        <ValueField
          id="memory-dream-interval"
          label={t('field.dreamInterval')}
          hint={t('field.dreamIntervalHint')}
          numeric
          {...shared}
          {...state.dreamInterval}
          onEdit={(text) => props.edit('dream.intervalMinutes', text)}
          onReset={() => props.resetField('dream.intervalMinutes')}
        />
        <ValueField
          id="memory-dream-max-llm-calls"
          label={t('field.dreamMaxLlmCalls')}
          hint={t('field.dreamMaxLlmCallsHint')}
          numeric
          {...shared}
          {...state.dreamMaxLlmCalls}
          onEdit={(text) => props.edit('dream.maxLlmCalls', text)}
          onReset={() => props.resetField('dream.maxLlmCalls')}
        />
        <ValueField
          id="memory-dream-max-wall"
          label={t('field.dreamMaxWallMs')}
          hint={t('field.dreamMaxWallMsHint')}
          numeric
          {...shared}
          {...state.dreamMaxWallMs}
          onEdit={(text) => props.edit('dream.maxWallMs', text)}
          onReset={() => props.resetField('dream.maxWallMs')}
        />
        <div className="dshMemField">
          <button
            type="button"
            className={dreamButtonClass}
            disabled={disabled || dreamPhase === 'pending'}
            onClick={() => void onDream()}
          >
            {dreamPhase === 'pending'
              ? t('chrome.dreamPending')
              : dreamPhase === 'ok'
                ? t('chrome.dreamOk')
                : dreamPhase === 'error'
                  ? t('chrome.dreamError')
                  : t('field.dreamNow')}
          </button>
          <p className="dshMemHint">{t('field.dreamNowHint')}</p>
          <p className="dshMemHint">
            {t('field.dreamSeq')}: <span className="dshMemDreamSeq">{state.dreamSeq}</span>
          </p>
        </div>
      </Group>
      <Group t={t} titleKey="group.brief">
        <BooleanField
          id="memory-brief-enabled"
          label={t('field.briefEnabled')}
          hint={t('field.briefEnabledHint')}
          {...shared}
          {...state.briefEnabled}
          onEdit={(text) => props.edit('brief.enabled', text)}
          onReset={() => props.resetField('brief.enabled')}
        />
        <ValueField
          id="memory-brief-max-bytes"
          label={t('field.briefMaxBytes')}
          hint={t('field.briefMaxBytesHint')}
          numeric
          {...shared}
          {...state.briefMaxBytes}
          onEdit={(text) => props.edit('brief.maxBytes', text)}
          onReset={() => props.resetField('brief.maxBytes')}
        />
        <ValueField
          id="memory-brief-project-k"
          label={t('field.briefProjectK')}
          hint={t('field.briefProjectKHint')}
          numeric
          {...shared}
          {...state.briefProjectK}
          onEdit={(text) => props.edit('brief.projectK', text)}
          onReset={() => props.resetField('brief.projectK')}
        />
        <ValueField
          id="memory-brief-global-k"
          label={t('field.briefGlobalK')}
          hint={t('field.briefGlobalKHint')}
          numeric
          {...shared}
          {...state.briefGlobalK}
          onEdit={(text) => props.edit('brief.globalK', text)}
          onReset={() => props.resetField('brief.globalK')}
        />
      </Group>
      <Group t={t} titleKey="group.recall">
        <ValueField
          id="memory-recall-k"
          label={t('field.recallK')}
          hint={t('field.recallKHint')}
          numeric
          {...shared}
          {...state.recallK}
          onEdit={(text) => props.edit('recall.k', text)}
          onReset={() => props.resetField('recall.k')}
        />
        <BooleanField
          id="memory-recall-expand-links"
          label={t('field.recallExpandLinks')}
          hint={t('field.recallExpandLinksHint')}
          {...shared}
          {...state.recallExpandLinks}
          onEdit={(text) => props.edit('recall.expandLinks', text)}
          onReset={() => props.resetField('recall.expandLinks')}
        />
        <ValueField
          id="memory-recall-link-decay"
          label={t('field.recallLinkDecay')}
          hint={t('field.recallLinkDecayHint')}
          decimal
          {...shared}
          {...state.recallLinkDecay}
          onEdit={(text) => props.edit('recall.linkDecay', text)}
          onReset={() => props.resetField('recall.linkDecay')}
        />
        <BooleanField
          id="memory-recall-brief-include-superseded"
          label={t('field.recallBriefIncludeSuperseded')}
          hint={t('field.recallBriefIncludeSupersededHint')}
          {...shared}
          {...state.recallBriefIncludeSuperseded}
          onEdit={(text) => props.edit('recall.briefIncludeSuperseded', text)}
          onReset={() => props.resetField('recall.briefIncludeSuperseded')}
        />
      </Group>
      <Group t={t} titleKey="group.budget">
        <ValueField
          id="memory-budget-max-card-bytes"
          label={t('field.budgetMaxCardBytes')}
          hint={t('field.budgetMaxCardBytesHint')}
          numeric
          {...shared}
          {...state.budgetMaxCardBytes}
          onEdit={(text) => props.edit('budget.maxCardBytes', text)}
          onReset={() => props.resetField('budget.maxCardBytes')}
        />
        <ValueField
          id="memory-budget-max-inbox-lines"
          label={t('field.budgetMaxInboxLines')}
          hint={t('field.budgetMaxInboxLinesHint')}
          numeric
          {...shared}
          {...state.budgetMaxInboxLines}
          onEdit={(text) => props.edit('budget.maxInboxLines', text)}
          onReset={() => props.resetField('budget.maxInboxLines')}
        />
      </Group>
      <Group t={t} titleKey="group.maintenance">
        <BooleanField
          id="memory-maintenance-enabled"
          label={t('field.maintenanceEnabled')}
          hint={t('field.maintenanceEnabledHint')}
          {...shared}
          {...state.maintenanceEnabled}
          onEdit={(text) => props.edit('maintenance.enabled', text)}
          onReset={() => props.resetField('maintenance.enabled')}
        />
        <ValueField
          id="memory-maintenance-stale-days"
          label={t('field.maintenanceStaleDays')}
          hint={t('field.maintenanceStaleDaysHint')}
          numeric
          {...shared}
          {...state.maintenanceStaleDays}
          onEdit={(text) => props.edit('maintenance.staleDays', text)}
          onReset={() => props.resetField('maintenance.staleDays')}
        />
        <ValueField
          id="memory-maintenance-stale-max-importance"
          label={t('field.maintenanceStaleMaxImportance')}
          hint={t('field.maintenanceStaleMaxImportanceHint')}
          numeric
          {...shared}
          {...state.maintenanceStaleMaxImportance}
          onEdit={(text) => props.edit('maintenance.staleMaxImportance', text)}
          onReset={() => props.resetField('maintenance.staleMaxImportance')}
        />
        <ValueField
          id="memory-maintenance-max-live-cards"
          label={t('field.maintenanceMaxLiveCards')}
          hint={t('field.maintenanceMaxLiveCardsHint')}
          numeric
          {...shared}
          {...state.maintenanceMaxLiveCards}
          onEdit={(text) => props.edit('maintenance.maxLiveCards', text)}
          onReset={() => props.resetField('maintenance.maxLiveCards')}
        />
        <ValueField
          id="memory-maintenance-max-archived-cards"
          label={t('field.maintenanceMaxArchivedCards')}
          hint={t('field.maintenanceMaxArchivedCardsHint')}
          numeric
          {...shared}
          {...state.maintenanceMaxArchivedCards}
          onEdit={(text) => props.edit('maintenance.maxArchivedCards', text)}
          onReset={() => props.resetField('maintenance.maxArchivedCards')}
        />
        <ValueField
          id="memory-maintenance-max-audit-lines"
          label={t('field.maintenanceMaxAuditLines')}
          hint={t('field.maintenanceMaxAuditLinesHint')}
          numeric
          {...shared}
          {...state.maintenanceMaxAuditLines}
          onEdit={(text) => props.edit('maintenance.maxAuditLines', text)}
          onReset={() => props.resetField('maintenance.maxAuditLines')}
        />
        <ValueField
          id="memory-maintenance-max-access-lines"
          label={t('field.maintenanceMaxAccessLines')}
          hint={t('field.maintenanceMaxAccessLinesHint')}
          numeric
          {...shared}
          {...state.maintenanceMaxAccessLines}
          onEdit={(text) => props.edit('maintenance.maxAccessLines', text)}
          onReset={() => props.resetField('maintenance.maxAccessLines')}
        />
        <ValueField
          id="memory-maintenance-max-inbox-bytes"
          label={t('field.maintenanceMaxInboxBytes')}
          hint={t('field.maintenanceMaxInboxBytesHint')}
          numeric
          {...shared}
          {...state.maintenanceMaxInboxBytes}
          onEdit={(text) => props.edit('maintenance.maxInboxBytes', text)}
          onReset={() => props.resetField('maintenance.maxInboxBytes')}
        />
      </Group>
      <Group t={t} titleKey="group.commands">
        <BooleanField
          id="memory-commands-enabled"
          label={t('field.commandsEnabled')}
          hint={t('field.commandsEnabledHint')}
          {...shared}
          {...state.commandsEnabled}
          onEdit={(text) => props.edit('commands.enabled', text)}
          onReset={() => props.resetField('commands.enabled')}
        />
      </Group>
      <Group t={t} titleKey="group.llm">
        <ValueField
          id="memory-llm-provider"
          label={t('field.llmProvider')}
          hint={t('field.llmProviderHint')}
          {...shared}
          {...state.llmProvider}
          onEdit={(text) => props.edit('llm.provider', text)}
          onReset={() => props.resetField('llm.provider')}
        />
        <ValueField
          id="memory-llm-model"
          label={t('field.llmModel')}
          hint={t('field.llmModelHint')}
          {...shared}
          {...state.llmModel}
          onEdit={(text) => props.edit('llm.model', text)}
          onReset={() => props.resetField('llm.model')}
        />
        <ValueField
          id="memory-llm-max-output"
          label={t('field.llmMaxOutputTokens')}
          hint={t('field.llmMaxOutputTokensHint')}
          numeric
          {...shared}
          {...state.llmMaxOutputTokens}
          onEdit={(text) => props.edit('llm.maxOutputTokens', text)}
          onReset={() => props.resetField('llm.maxOutputTokens')}
        />
        <ValueField
          id="memory-llm-timeout"
          label={t('field.llmTimeoutMs')}
          hint={t('field.llmTimeoutMsHint')}
          numeric
          {...shared}
          {...state.llmTimeoutMs}
          onEdit={(text) => props.edit('llm.timeoutMs', text)}
          onReset={() => props.resetField('llm.timeoutMs')}
        />
      </Group>
      <Group t={t} titleKey="group.redact">
        <OptionField
          id="memory-redact-pii"
          label={t('field.redactPii')}
          hint={t('field.redactPiiHint')}
          options={[
            { value: 'redact', label: 'redact' },
            { value: 'warn', label: 'warn' },
            { value: 'off', label: 'off' },
          ]}
          {...shared}
          {...state.redactPii}
          onEdit={(text) => props.edit('redact.pii', text)}
          onReset={() => props.resetField('redact.pii')}
        />
      </Group>
    </SettingsCardBody>
  );
}
