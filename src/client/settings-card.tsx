/**
 * The dsh-memory settings card: edits the `memory` namespace (a nested
 * section — capture/dream/brief/llm/redact) from the plugin-configuration
 * section (the `settings.plugin.item` seat).
 *
 * Self-contained card chrome (disclosure header, staged fields grouped by
 * section, save/discard footer) following the plugin-card store pattern of
 * the DSH plugin configuration section; styles live in `styles.ts` and use
 * the DSH design tokens so the card follows the active theme. Plus a
 * "Dream now" trigger that bumps `dream.requestSeq` — the Host's existing
 * watcher fires a Dream run without any save.
 */
import { useRef, useState, type ReactNode } from 'react';
import { createSnapshotStore, type SettingsScope, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemorySettings } from '../settings.ts';
import type { SettingsCardKey } from './locales.ts';
import {
  booleanField,
  CardForm,
  numberField,
  selectField,
  textField,
  type CardActions,
  type CardFieldState,
  type CardShell,
  type SettingsApi,
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
  dreamEnabled: CardFieldState;
  dreamUseLlm: CardFieldState;
  dreamInterval: CardFieldState;
  dreamMaxLlmCalls: CardFieldState;
  dreamMaxWallMs: CardFieldState;
  briefEnabled: CardFieldState;
  briefMaxBytes: CardFieldState;
  briefProjectK: CardFieldState;
  briefGlobalK: CardFieldState;
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

/** Bridges the `memory` scope onto the card's staged form. */
export class MemorySettingsCardController {
  private readonly form: CardForm<MemorySettings>;
  private readonly store: SnapshotStore<MemorySettingsCardState>;

  /**
   * @param scope - the bound settings scope for the `memory` namespace.
   * @param api - the connection api face used for path mutations.
   */
  constructor(
    private readonly scope: SettingsScope<MemorySettings>,
    private readonly api: SettingsApi,
  ) {
    this.form = new CardForm<MemorySettings>(scope, 'memory', api, [
      booleanField(['enabled']),
      selectField(['capture', 'mode'], ['off', 'explicit', 'auto']),
      booleanField(['capture', 'useLlm']),
      numberField(['capture', 'turnTailChars'], 1),
      numberField(['capture', 'minTurnContentChars'], 0),
      booleanField(['dream', 'enabled']),
      booleanField(['dream', 'useLlm']),
      numberField(['dream', 'intervalMinutes'], 5),
      numberField(['dream', 'maxLlmCalls'], 0),
      numberField(['dream', 'maxWallMs'], 5000),
      booleanField(['brief', 'enabled']),
      numberField(['brief', 'maxBytes'], 512),
      numberField(['brief', 'projectK'], 0),
      numberField(['brief', 'globalK'], 0),
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
      dreamEnabled: this.form.field('dream.enabled'),
      dreamUseLlm: this.form.field('dream.useLlm'),
      dreamInterval: this.form.field('dream.intervalMinutes'),
      dreamMaxLlmCalls: this.form.field('dream.maxLlmCalls'),
      dreamMaxWallMs: this.form.field('dream.maxWallMs'),
      briefEnabled: this.form.field('brief.enabled'),
      briefMaxBytes: this.form.field('brief.maxBytes'),
      briefProjectK: this.form.field('brief.projectK'),
      briefGlobalK: this.form.field('brief.globalK'),
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
        return this.api
          .settings.mutate({
            ns: 'memory',
            ops: [{ op: 'set', path: ['dream', 'requestSeq'], value: seq + 1 }],
          })
          .then(() => undefined) as Promise<void>;
      },
    };
  }
}

/** Props the renderer binds for the dsh-memory plugin-configuration card. */
export type MemorySettingsCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsLocale<'dsh-memory'> & InjectFace<MemorySettingsCardFace>;

/** Card chrome: a disclosure header naming the plugin and what its settings govern, the controls, and the save that writes them. */
function SettingsCard(props: {
  t: (key: SettingsCardKey) => string;
  titleKey: SettingsCardKey;
  descriptionKey: SettingsCardKey;
  state: CardShell;
  onSave: () => void;
  onDiscard: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { state } = props;
  if (!state.available) return null;
  const title = props.t(props.titleKey);
  const blocked = !state.dirty || state.invalid || state.saving;
  return (
    <li className={open ? 'dshMemCard dshMemCardOpen' : 'dshMemCard'}>
      <button
        type="button"
        className="dshMemHeader"
        aria-expanded={open}
        aria-label={`${props.t(open ? 'chrome.collapse' : 'chrome.expand')}: ${title}`}
        title={props.t(props.descriptionKey)}
        onClick={() => setOpen(!open)}
      >
        <span className="dshMemHeadText">
          <span className="dshMemName">{title}</span>
          <span className="dshMemDescription">{props.t(props.descriptionKey)}</span>
        </span>
        {state.dirty ? (
          <span className="dshMemPending" title={props.t('chrome.unsaved')}>
            {props.t('chrome.unsaved')}
          </span>
        ) : null}
        <span className={open ? 'dshMemChevron dshMemChevronOpen' : 'dshMemChevron'}>▾</span>
      </button>
      {open ? (
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
      ) : null}
    </li>
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

/** A staged value field; `numeric` only hints the keypad, which drafts a field accepts is decided by its spec. */
function ValueField(props: FieldProps & { numeric?: boolean; placeholder?: string }) {
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
        inputMode={props.numeric === true ? 'numeric' : undefined}
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
 * Render the dsh-memory card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
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
  return (
    <SettingsCard
      t={t}
      titleKey="card.title"
      descriptionKey="card.description"
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
    </SettingsCard>
  );
}
