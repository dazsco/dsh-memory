/**
 * dsh-memory — the "Memory" settings section.
 *
 * A settings-nav page (the `settings.section` seat) where the human can do
 * what the agent tools cannot: browse EVERY store (global + all projects),
 * search and filter one store's cards, read a card in full, write a new card
 * or a corrected version of one, inspect the pending capture inbox, the Dream
 * state and the append-only audit tail, and manage single cards — archive /
 * hard-delete (two-step confirm) from the detail panel, restore from the
 * archive tab. Mutations go through the Host's exact fetch routes and the SAME
 * store ops the agent tools use (single writer, audited, lock-protected); this
 * page never writes a file itself.
 *
 * "Dream now" POSTs /api/memory/dream (the engine the tool and CLI use) and
 * falls back to the existing `dream.requestSeq` trigger when the route is not
 * composed. Export downloads the Host's portable bundle; import POSTs one back.
 *
 * Data flows over the plugin's exact fetch routes (/api/memory/*) served by
 * the Host on the connection channel; everything is JSON, plain values,
 * already policy-clean before it ever landed on disk. Every transient status
 * is owned by a timer that the unmount teardown clears.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemorySettings } from '../settings.ts';
import type { MemoryCard, MemoryExportBundle, MemoryImportResult } from '../types.ts';
import type {
  BrowseArchiveList,
  BrowseAuditList,
  BrowseCardActionResult,
  BrowseCardDetail,
  BrowseCardList,
  BrowseCardSummary,
  BrowseDreamResult,
  BrowseInbox,
  BrowseSummary,
} from '../browse.ts';
import type { SettingsCardKey } from './locales.ts';
import { injectStyles } from './styles.ts';

// Styles must land during factory materialization so the module system's
// style bookkeeping (HMR) owns them.
injectStyles();

/** What the Memory section entry injects into the page. */
export interface MemoryPageInjected {
  /** Bump `dream.requestSeq` so the Host runs one Dream immediately. */
  dreamNow: () => Promise<void>;
}

/** Props the renderer binds for the Memory section. */
export type MemoryPageProps =
  PropsRuntime<'settings.section'> & PropsLocale<'dsh-memory'> & InjectFace<MemoryPageInjected>;

/** Bridges the live `dsh-memory` configuration entry onto the page's Dream trigger. */
export class MemoryPageController {
  constructor(private readonly form: ConfigForm<MemorySettings>) {}

  /** Bump the monotonic trigger; the Host's volatile-update watcher fires the run. */
  dreamNow(): Promise<void> {
    const value = this.form.getSnapshot().value;
    const seq = typeof value?.dream?.requestSeq === 'number' ? value.dream.requestSeq : 0;
    return this.form
      .mutate([{ op: 'set', path: ['dream', 'requestSeq'], value: seq + 1 }])
      .then((accepted) => {
        // A refused write or an unreachable Host is not a triggered run.
        if (!accepted) throw new Error('dsh-memory: the Host refused the Dream trigger');
      });
  }
}

// ── small plumbing ─────────────────────────────────────────────────────────

type Phase = 'loading' | 'error' | 'ready';

/** One data slice of the page. */
interface Slice<T> {
  phase: Phase;
  data?: T;
  error?: string;
}

type TFn = (key: SettingsCardKey, params?: Record<string, unknown>) => string;

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal';
}

async function failureOf(response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: unknown };
    detail = typeof body.error === 'string' ? body.error : '';
  } catch {
    // non-JSON error body — keep the status only
  }
  return new Error(detail === '' ? `HTTP ${response.status}` : detail);
}

/** One GET; the signal is optional so a one-shot read needs no controller. */
async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, hostBase()), {
    method: 'GET',
    signal,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw await failureOf(response);
  return (await response.json()) as T;
}

/** One per-card mutation (POST, small JSON body). Not abortable: short ops. */
async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(new URL(path, hostBase()), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failureOf(response);
  return (await response.json()) as T;
}

/**
 * One POST whose body is the JSON text as-is (an import bundle is large and
 * already JSON). Not abortable in the retry sense: the Host is the only writer.
 */
async function apiPostText<T>(path: string, text: string): Promise<T> {
  const response = await fetch(new URL(path, hostBase()), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: text,
  });
  if (!response.ok) throw await failureOf(response);
  return (await response.json()) as T;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return error instanceof Error ? error.message : String(error);
}

function fmtDate(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Human byte size; unit symbols are locale-neutral. */
function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_KEYS: Record<string, SettingsCardKey> = {
  fact: 'kind.fact',
  preference: 'kind.preference',
  decision: 'kind.decision',
  procedure: 'kind.procedure',
  commitment: 'kind.commitment',
  observation: 'kind.observation',
  summary: 'kind.summary',
};

/** The 7 memory kinds in their canonical order (the filter/select vocabulary). */
const KIND_ORDER: readonly string[] = Object.keys(KIND_KEYS);

function kindLabel(kind: string, t: TFn): string {
  const key = KIND_KEYS[kind];
  return key !== undefined ? t(key) : kind;
}

/** Split a comma-separated tag draft into the list the Host normalizes. */
function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** The importance draft: an integer 1–10, or undefined to keep the stored value. */
function parseImportance(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : undefined;
}

/** Whether an importance draft is present but not an integer 1–10. */
function importanceInvalid(text: string): boolean {
  return text.trim() !== '' && parseImportance(text) === undefined;
}

/** Transient status lifetime, for every mutation's settle/error note. */
const NOTE_RESET_MS = 6000;

/** Stable empty page, so the filter memos keep their identity between renders. */
const NO_CARDS: BrowseCardSummary[] = [];

/** One transient status line: the text and whether it reports a failure. */
interface Note {
  text: string;
  error: boolean;
}

type DreamPhase = 'idle' | 'pending' | 'ok' | 'error';

/** One armed detail-panel mutation (v2): first click arms, second executes. */
interface DetailAction {
  op: 'archive' | 'hard-delete';
  armed: boolean;
  pending: boolean;
  error: string | null;
}

/** The editable draft of one card (the detail panel's Edit mode). */
interface CardDraft {
  content: string;
  kind: string;
  tags: string;
  importance: string;
}

const EMPTY_DRAFT: CardDraft = { content: '', kind: 'fact', tags: '', importance: '' };

/** The detail panel's Edit mode binding. */
interface EditBinding {
  /** The live draft, or null while the card is read-only. */
  draft: CardDraft | null;
  /** Whether a save is crossing the wire. */
  pending: boolean;
  /** The transient outcome note of the last save, if any. */
  note: Note | null;
  onStart: () => void;
  onChange: (patch: Partial<CardDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}

// ── per-store Dream summary ────────────────────────────────────────────────

/** `+added ~updated ↓superseded` per store, for the transient Dream status. */
function dreamSummary(result: BrowseDreamResult, t: TFn): string {
  if (result.busy) return t('page.dreamBusy');
  const rows: string[] = [];
  for (const store of result.stores) {
    const touched =
      store.added + store.updated + store.superseded + store.archived + store.blocked + store.relinked;
    if (touched === 0 && store.error === '') continue;
    const delta = `+${store.added} ~${store.updated} ↓${store.superseded}`;
    rows.push(store.error === '' ? `${store.slug} ${delta}` : `${store.slug} ${delta} ⚠ ${store.error}`);
  }
  if (rows.length === 0) return t('page.dreamNoChanges');
  return `${rows.join(' · ')} · ${t('page.dreamDuration', { ms: result.durationMs })}`;
}

// ── export / import plumbing (browser only) ────────────────────────────────

/** `dsh-memory-export-YYYY-MM-DD.json` for the day the export runs. */
function exportFileName(at: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `dsh-memory-export-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`;
}

/** Trigger a browser download for one JSON value; the object URL is revoked as soon as the click returns. */
function downloadJson(value: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── detail ─────────────────────────────────────────────────────────────────

/** One meta row of the card detail. */
function MetaRow(props: { label: string; value: string }) {
  return (
    <div className="dshMemDetailRow">
      <dt className="dshMemDetailLabel">{props.label}</dt>
      <dd className="dshMemDetailValue">{props.value}</dd>
    </div>
  );
}

/** One totals cell of the stats header. */
function StatCell(props: { label: string; value: string }) {
  return (
    <div className="dshMemStat">
      <dt className="dshMemStatLabel">{props.label}</dt>
      <dd className="dshMemStatValue">{props.value}</dd>
    </div>
  );
}

/** The shared kind/tags/importance triple of the create and update forms. */
function DraftFields(props: {
  idPrefix: string;
  draft: CardDraft;
  t: TFn;
  disabled: boolean;
  onChange: (patch: Partial<CardDraft>) => void;
}) {
  const { idPrefix, draft, t, disabled, onChange } = props;
  const kindId = `${idPrefix}-kind`;
  const tagsId = `${idPrefix}-tags`;
  const importanceId = `${idPrefix}-importance`;
  return (
    <>
      <div className="dshMemDraftRow">
        <label className="dshMemDraftLabel" htmlFor={kindId}>{t('page.meta.kind')}</label>
        <select
          id={kindId}
          className="dshMemSelect"
          value={draft.kind}
          disabled={disabled}
          onChange={(event) => onChange({ kind: event.target.value })}
        >
          {KIND_ORDER.map((kind) => (
            <option key={kind} value={kind}>{kindLabel(kind, t)}</option>
          ))}
        </select>
      </div>
      <div className="dshMemDraftRow">
        <label className="dshMemDraftLabel" htmlFor={tagsId}>{t('page.meta.tags')}</label>
        <input
          id={tagsId}
          className="dshMemInput"
          type="text"
          value={draft.tags}
          placeholder={t('page.new.tagsHint')}
          disabled={disabled}
          onChange={(event) => onChange({ tags: event.target.value })}
        />
      </div>
      <div className="dshMemDraftRow">
        <label className="dshMemDraftLabel" htmlFor={importanceId}>{t('page.meta.importance')}</label>
        <input
          id={importanceId}
          className={importanceInvalid(draft.importance) ? 'dshMemInput dshMemInputInvalid' : 'dshMemInput'}
          type="text"
          inputMode="numeric"
          value={draft.importance}
          placeholder={t('page.new.importanceHint')}
          disabled={disabled}
          onChange={(event) => onChange({ importance: event.target.value })}
        />
      </div>
      {importanceInvalid(draft.importance) ? (
        <p className="dshMemInvalid">{t('page.edit.importanceInvalid')}</p>
      ) : null}
    </>
  );
}

/** The full card: content (or the Edit form), front-matter grid, then the per-card actions. */
function CardDetail(props: {
  card: MemoryCard;
  t: TFn;
  action: DetailAction | null;
  onAction: (op: 'archive' | 'hard-delete') => void;
  onCancelAction: () => void;
  edit: EditBinding;
}) {
  const { card, t, action, onAction, onCancelAction, edit } = props;
  const busy = action !== null && action.pending;
  const draft = edit.draft;
  const editing = draft !== null;
  return (
    <article className="dshMemDetailCard">
      <h3 className="dshMemDetailTitle">{card.title}</h3>
      {editing && draft !== null ? (
        <div className="dshMemEdit">
          <label className="dshMemDraftLabel" htmlFor="dshMemEditContent">{t('page.edit.content')}</label>
          <textarea
            id="dshMemEditContent"
            className="dshMemTextArea"
            value={draft.content}
            disabled={edit.pending}
            onChange={(event) => edit.onChange({ content: event.target.value })}
          />
          <DraftFields
            idPrefix="dshMemEdit"
            draft={draft}
            t={t}
            disabled={edit.pending}
            onChange={edit.onChange}
          />
          <p className="dshMemHint">{t('page.edit.hint')}</p>
          <div className="dshMemDetailActions">
            <button
              type="button"
              className="dshMemPageBtn"
              disabled={edit.pending || draft.content.trim() === ''}
              onClick={edit.onSave}
            >
              {edit.pending ? t('page.edit.saving') : t('page.edit.save')}
            </button>
            <button type="button" className="dshMemPageBtn" disabled={edit.pending} onClick={edit.onCancel}>
              {t('page.edit.cancel')}
            </button>
            {draft.content.trim() === '' ? (
              <span className="dshMemActionHint">{t('page.edit.empty')}</span>
            ) : null}
          </div>
        </div>
      ) : card.body !== '' ? (
        <p className="dshMemDetailBody">{card.body}</p>
      ) : null}
      <dl className="dshMemDetailGrid">
        <MetaRow label={t('page.meta.kind')} value={kindLabel(card.kind, t)} />
        <MetaRow label={t('page.meta.importance')} value={`${card.importance}/10`} />
        <MetaRow label={t('page.meta.confidence')} value={card.confidence.toFixed(2)} />
        <MetaRow
          label={t('page.meta.tags')}
          value={card.tags.length > 0 ? card.tags.map((tag) => `#${tag}`).join(' ') : t('page.meta.none')}
        />
        <MetaRow label={t('page.meta.created')} value={fmtDate(card.created)} />
        <MetaRow label={t('page.meta.updated')} value={fmtDate(card.updated)} />
        <MetaRow label={t('page.meta.lastAccessed')} value={fmtDate(card.lastAccessed)} />
        <MetaRow label={t('page.meta.accessCount')} value={String(card.accessCount)} />
        <MetaRow
          label={t('page.meta.validity')}
          value={
            card.validUntil === null
              ? t('page.valid.active')
              : `${t('page.valid.superseded')} · ${fmtDate(card.validUntil)}`
          }
        />
        <MetaRow
          label={t('page.meta.supersedes')}
          value={card.supersedes.length > 0 ? card.supersedes.join(', ') : t('page.meta.none')}
        />
        <MetaRow label={t('page.meta.links')} value={card.links.length > 0 ? card.links.join(', ') : t('page.meta.none')} />
        <MetaRow
          label={t('page.meta.source')}
          value={card.source.session !== '' ? card.source.session : t('page.meta.none')}
        />
      </dl>
      {edit.note !== null ? (
        <p
          className={edit.note.error ? 'dshMemActionError' : 'dshMemActionOk'}
          role={edit.note.error ? 'alert' : 'status'}
        >
          {edit.note.text}
        </p>
      ) : null}
      {editing ? null : (
        <div className="dshMemDetailActions">
          {action === null ? (
            <>
              <button type="button" className="dshMemPageBtn" disabled={busy} onClick={edit.onStart}>
                {t('page.edit')}
              </button>
              <button
                type="button"
                className="dshMemPageBtn"
                disabled={busy}
                onClick={() => onAction('archive')}
              >
                {t('page.action.archive')}
              </button>
              <button
                type="button"
                className="dshMemPageBtn dshMemPageBtnDanger"
                disabled={busy}
                onClick={() => onAction('hard-delete')}
              >
                {t('page.action.hardDelete')}
              </button>
              <span className="dshMemActionHint">{t('page.action.hint')}</span>
            </>
          ) : (
            <>
              <button
                type="button"
                className="dshMemPageBtn dshMemPageBtnDanger dshMemPageBtnDangerArmed"
                disabled={busy}
                onClick={() => onAction(action.op)}
              >
                {busy
                  ? t('page.action.pending')
                  : action.op === 'hard-delete'
                    ? t('page.action.confirmHardDelete')
                    : t('page.action.confirmArchive')}
              </button>
              <button type="button" className="dshMemPageBtn" disabled={busy} onClick={onCancelAction}>
                {t('page.action.cancel')}
              </button>
              {action.error !== null ? (
                <p className="dshMemActionError" role="alert">
                  {t('page.action.error')}: {action.error}
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
    </article>
  );
}

// ── the page ───────────────────────────────────────────────────────────────

/**
 * Render the Memory section (browse, filter, edit, audit, Dream, export/import).
 * @param props - locale copy and the injected Dream trigger.
 * @returns the page.
 */
export function MemoryPage(props: MemoryPageProps) {
  const { t } = props;
  const [refreshKey, setRefreshKey] = useState(0);
  const [summary, setSummary] = useState<Slice<BrowseSummary>>({ phase: 'loading' });
  const [storeSlug, setStoreSlug] = useState<string | null>(null);
  const [tab, setTab] = useState<'cards' | 'inbox' | 'archive' | 'audit'>('cards');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [cards, setCards] = useState<Slice<BrowseCardList>>({ phase: 'loading' });
  const [inbox, setInbox] = useState<Slice<BrowseInbox>>({ phase: 'loading' });
  const [archive, setArchive] = useState<Slice<BrowseArchiveList>>({ phase: 'loading' });
  const [audit, setAudit] = useState<Slice<BrowseAuditList>>({ phase: 'loading' });
  const [cardId, setCardId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Slice<BrowseCardDetail>>({ phase: 'loading' });
  const [dreamPhase, setDreamPhase] = useState<DreamPhase>('idle');
  const [dreamNote, setDreamNote] = useState<Note | null>(null);
  const dreamReset = useRef<number | undefined>(undefined);
  // Per-card actions (first click arms, second executes).
  const [action, setAction] = useState<DetailAction | null>(null);
  const actionReset = useRef<number | undefined>(undefined);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreErrorReset = useRef<number | undefined>(undefined);
  // Card editing (detail panel), new-card form, export/import.
  const [editDraft, setEditDraft] = useState<CardDraft | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [editNote, setEditNote] = useState<Note | null>(null);
  const editReset = useRef<number | undefined>(undefined);
  const [newOpen, setNewOpen] = useState(false);
  const [newDraft, setNewDraft] = useState<CardDraft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [createNote, setCreateNote] = useState<Note | null>(null);
  const createReset = useRef<number | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [ioNote, setIoNote] = useState<Note | null>(null);
  const ioReset = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(true);

  // One teardown owns every timer this page arms, so an unmount can never
  // leave a status reset running (StrictMode re-runs re-arm `mounted`).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(dreamReset.current);
      window.clearTimeout(actionReset.current);
      window.clearTimeout(restoreErrorReset.current);
      window.clearTimeout(editReset.current);
      window.clearTimeout(createReset.current);
      window.clearTimeout(ioReset.current);
    };
  }, []);

  // ── summary (mount + manual refresh) ───────────────────────────────────
  useEffect(() => {
    const signal = new AbortController();
    setSummary({ phase: 'loading' });
    void (async () => {
      try {
        const data = await apiGet<BrowseSummary>('/api/memory/summary', signal.signal);
        if (signal.signal.aborted) return;
        setSummary({ phase: 'ready', data });
        setStoreSlug((current) => {
          if (data.stores.length === 0) return null;
          if (current !== null && data.stores.some((s) => s.slug === current)) return current;
          const first = data.stores[0];
          return first !== undefined ? first.slug : null;
        });
      } catch (error) {
        if (signal.signal.aborted) return;
        setSummary({ phase: 'error', error: messageOf(error) });
      }
    })();
    return () => signal.abort();
  }, [refreshKey]);

  // ── card list (debounced on the query; kind/tag filter client-side) ────
  useEffect(() => {
    if (tab !== 'cards' || storeSlug === null) return;
    const signal = new AbortController();
    const timer = window.setTimeout(() => {
      setCards({ phase: 'loading' });
      void (async () => {
        const params = new URLSearchParams({ store: storeSlug });
        const q = query.trim();
        if (q !== '') params.set('query', q);
        try {
          const data = await apiGet<BrowseCardList>(`/api/memory/cards?${params.toString()}`, signal.signal);
          if (!signal.signal.aborted) setCards({ phase: 'ready', data });
        } catch (error) {
          if (signal.signal.aborted) return;
          setCards({ phase: 'error', error: messageOf(error) });
        }
      })();
    }, 200);
    return () => {
      window.clearTimeout(timer);
      signal.abort();
    };
  }, [storeSlug, query, tab, refreshKey]);

  // ── inbox (per store, cards tab inactive) ──────────────────────────────
  useEffect(() => {
    if (tab !== 'inbox' || storeSlug === null) return;
    const signal = new AbortController();
    setInbox({ phase: 'loading' });
    void (async () => {
      try {
        const data = await apiGet<BrowseInbox>(`/api/memory/inbox?store=${encodeURIComponent(storeSlug)}`, signal.signal);
        if (!signal.signal.aborted) setInbox({ phase: 'ready', data });
      } catch (error) {
        if (signal.signal.aborted) return;
        setInbox({ phase: 'error', error: messageOf(error) });
      }
    })();
    return () => signal.abort();
  }, [storeSlug, tab, refreshKey]);

  // ── archived cards (per store, archive tab) ─────────────────────────────
  useEffect(() => {
    if (tab !== 'archive' || storeSlug === null) return;
    const signal = new AbortController();
    setArchive({ phase: 'loading' });
    void (async () => {
      try {
        const data = await apiGet<BrowseArchiveList>(
          `/api/memory/archive?store=${encodeURIComponent(storeSlug)}`,
          signal.signal,
        );
        if (!signal.signal.aborted) setArchive({ phase: 'ready', data });
      } catch (error) {
        if (signal.signal.aborted) return;
        setArchive({ phase: 'error', error: messageOf(error) });
      }
    })();
    return () => signal.abort();
  }, [storeSlug, tab, refreshKey]);

  // ── audit tail (per store, audit tab; the Host serves it newest first) ──
  useEffect(() => {
    if (tab !== 'audit' || storeSlug === null) return;
    const signal = new AbortController();
    setAudit({ phase: 'loading' });
    void (async () => {
      try {
        const data = await apiGet<BrowseAuditList>(
          `/api/memory/audit?store=${encodeURIComponent(storeSlug)}`,
          signal.signal,
        );
        if (!signal.signal.aborted) setAudit({ phase: 'ready', data });
      } catch (error) {
        if (signal.signal.aborted) return;
        setAudit({ phase: 'error', error: messageOf(error) });
      }
    })();
    return () => signal.abort();
  }, [storeSlug, tab, refreshKey]);

  // ── one card in full ───────────────────────────────────────────────────
  useEffect(() => {
    if (cardId === null || storeSlug === null) return;
    const signal = new AbortController();
    setDetail({ phase: 'loading' });
    void (async () => {
      try {
        const data = await apiGet<BrowseCardDetail>(
          `/api/memory/card?store=${encodeURIComponent(storeSlug)}&id=${encodeURIComponent(cardId)}`,
          signal.signal,
        );
        if (!signal.signal.aborted) setDetail({ phase: 'ready', data });
      } catch (error) {
        if (signal.signal.aborted) return;
        setDetail({ phase: 'error', error: messageOf(error) });
      }
    })();
    return () => signal.abort();
  }, [cardId, storeSlug, refreshKey]);

  const noteLater = useCallback(
    (timer: { current: number | undefined }, clear: () => void): void => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(clear, NOTE_RESET_MS);
    },
    [],
  );

  // ── Dream now: POST the exact engine route, settings trigger as fallback ─
  const onDream = useCallback(async () => {
    if (dreamPhase !== 'idle') return;
    setDreamPhase('pending');
    setDreamNote(null);
    let phase: DreamPhase = 'error';
    let note: Note;
    try {
      const result = await apiPost<BrowseDreamResult>('/api/memory/dream', {});
      if (!mounted.current) return;
      phase = 'ok';
      note = { text: dreamSummary(result, t), error: false };
      setRefreshKey((k) => k + 1);
    } catch (postError) {
      // The POST route is not composed (or refused): fall back to the
      // `dream.requestSeq` trigger the settings card uses.
      try {
        await props.dreamNow();
        if (!mounted.current) return;
        phase = 'ok';
        note = { text: t('page.dreamOk'), error: false };
        setRefreshKey((k) => k + 1);
      } catch {
        if (!mounted.current) return;
        note = { text: `${t('page.dreamError')}: ${messageOf(postError)}`, error: true };
      }
    }
    setDreamPhase(phase);
    setDreamNote(note);
    noteLater(dreamReset, () => {
      setDreamPhase('idle');
      setDreamNote(null);
    });
  }, [dreamPhase, props, t, noteLater]);

  // ── per-card mutation: first click arms, second click executes ─────────
  const dismissAction = useCallback((): void => {
    window.clearTimeout(actionReset.current);
    setAction(null);
  }, []);

  const onAction = useCallback(
    (op: 'archive' | 'hard-delete'): void => {
      if (storeSlug === null || cardId === null) return;
      const current = action;
      if (current !== null && current.pending) return;
      if (current === null || current.op !== op || !current.armed) {
        // First click: arm the confirm (auto-disarms after a few seconds).
        setAction({ op, armed: true, pending: false, error: null });
        window.clearTimeout(actionReset.current);
        actionReset.current = window.setTimeout(() => setAction(null), 5000);
        return;
      }
      // Armed: execute against the exact store + card.
      void (async () => {
        setAction({ op, armed: true, pending: true, error: null });
        try {
          await apiPost('/api/memory/card/forget', {
            store: storeSlug,
            id: cardId,
            hard: op === 'hard-delete',
          });
          if (!mounted.current) return;
          window.clearTimeout(actionReset.current);
          setAction(null);
          setEditDraft(null);
          setCardId(null); // the card is gone — close the detail
          setRefreshKey((k) => k + 1); // re-fetch roster + lists
        } catch (error) {
          if (!mounted.current) return;
          setAction({ op, armed: true, pending: false, error: messageOf(error) });
        }
      })();
    },
    [storeSlug, cardId, action],
  );

  // ── restore one archived card ──────────────────────────────────────────
  const onRestore = useCallback(
    (id: string): void => {
      if (storeSlug === null || restoringId !== null) return;
      setRestoringId(id);
      void (async () => {
        try {
          await apiPost('/api/memory/card/restore', { store: storeSlug, id });
          if (!mounted.current) return;
          setRestoreError(null);
          window.clearTimeout(restoreErrorReset.current);
          setRefreshKey((k) => k + 1);
        } catch (error) {
          if (!mounted.current) return;
          setRestoreError(messageOf(error));
          window.clearTimeout(restoreErrorReset.current);
          restoreErrorReset.current = window.setTimeout(() => setRestoreError(null), NOTE_RESET_MS);
        } finally {
          if (mounted.current) setRestoringId(null);
        }
      })();
    },
    [storeSlug, restoringId],
  );

  // ── create one card from the Cards tab ─────────────────────────────────
  const onCreate = useCallback((): void => {
    if (storeSlug === null || creating) return;
    const content = newDraft.content.trim();
    if (content === '') return;
    setCreating(true);
    setCreateNote(null);
    void (async () => {
      try {
        const result = await apiPost<BrowseCardActionResult>('/api/memory/card/remember', {
          store: storeSlug,
          content,
          kind: newDraft.kind,
          tags: parseTags(newDraft.tags),
          importance: parseImportance(newDraft.importance),
        });
        if (!mounted.current) return;
        setCreating(false);
        setNewDraft({ ...EMPTY_DRAFT, kind: newDraft.kind });
        setCreateNote({
          text: result.title !== undefined && result.title !== ''
            ? `${t('page.new.ok')} ${result.title}`
            : t('page.new.ok'),
          error: false,
        });
        noteLater(createReset, () => setCreateNote(null));
        setRefreshKey((k) => k + 1);
      } catch (error) {
        if (!mounted.current) return;
        setCreating(false);
        setCreateNote({ text: `${t('page.new.error')}: ${messageOf(error)}`, error: true });
        noteLater(createReset, () => setCreateNote(null));
      }
    })();
  }, [storeSlug, creating, newDraft, t, noteLater]);

  // ── edit mode over the open card ───────────────────────────────────────
  const startEdit = useCallback((): void => {
    if (detail.phase !== 'ready' || detail.data === undefined) return;
    const card = detail.data.card;
    setEditDraft({
      content: `${card.title}\n${card.body}`.trim(),
      kind: card.kind,
      tags: card.tags.join(', '),
      importance: String(card.importance),
    });
    setEditPending(false);
    setEditNote(null);
    window.clearTimeout(editReset.current);
  }, [detail]);

  const patchEdit = useCallback((patch: Partial<CardDraft>): void => {
    setEditDraft((current) => (current === null ? null : { ...current, ...patch }));
  }, []);

  const cancelEdit = useCallback((): void => {
    window.clearTimeout(editReset.current);
    setEditDraft(null);
    setEditPending(false);
    setEditNote(null);
  }, []);

  const onSaveEdit = useCallback((): void => {
    if (storeSlug === null || cardId === null || editDraft === null || editPending) return;
    const content = editDraft.content.trim();
    if (content === '') return;
    const editingId = cardId;
    setEditPending(true);
    setEditNote(null);
    void (async () => {
      try {
        const result = await apiPost<BrowseCardActionResult>('/api/memory/card/update', {
          store: storeSlug,
          id: editingId,
          content,
          kind: editDraft.kind,
          tags: parseTags(editDraft.tags),
          importance: parseImportance(editDraft.importance),
        });
        if (!mounted.current) return;
        const replaced = result.superseded !== undefined && result.superseded.length > 0
          ? result.superseded[0]
          : editingId;
        setEditDraft(null);
        setEditPending(false);
        setEditNote({
          text: `${t('page.edit.ok')} · ${t('page.edit.superseded', { id: replaced ?? editingId })}`,
          error: false,
        });
        noteLater(editReset, () => setEditNote(null));
        // The corrected version is a NEW card id: follow it so the panel shows
        // what the Host actually wrote.
        setCardId(result.id);
        setRefreshKey((k) => k + 1);
      } catch (error) {
        if (!mounted.current) return;
        setEditPending(false);
        setEditNote({ text: `${t('page.edit.error')}: ${messageOf(error)}`, error: true });
        noteLater(editReset, () => setEditNote(null));
      }
    })();
  }, [storeSlug, cardId, editDraft, editPending, t, noteLater]);

  // ── export the selected store (or every store) as a JSON download ──────
  const onExport = useCallback((): void => {
    if (exporting) return;
    setExporting(true);
    setIoNote(null);
    void (async () => {
      try {
        const params = new URLSearchParams();
        if (storeSlug !== null) params.set('store', storeSlug);
        const search = params.toString();
        const bundle = await apiGet<MemoryExportBundle>(
          `/api/memory/export${search === '' ? '' : `?${search}`}`,
        );
        if (!mounted.current) return;
        const name = exportFileName(new Date());
        downloadJson(bundle, name);
        setExporting(false);
        setIoNote({ text: t('page.export.ok', { name }), error: false });
        noteLater(ioReset, () => setIoNote(null));
      } catch (error) {
        if (!mounted.current) return;
        setExporting(false);
        setIoNote({ text: `${t('page.export.error')}: ${messageOf(error)}`, error: true });
        noteLater(ioReset, () => setIoNote(null));
      }
    })();
  }, [exporting, storeSlug, t, noteLater]);

  // ── import one bundle file ─────────────────────────────────────────────
  const onImportFile = useCallback(
    (file: File): void => {
      if (importing) return;
      setImporting(true);
      setIoNote(null);
      void (async () => {
        try {
          const text = await file.text();
          if (!mounted.current) return;
          const result = await apiPostText<MemoryImportResult>('/api/memory/import', text);
          if (!mounted.current) return;
          setImporting(false);
          setIoNote({
            text: t('page.import.ok', {
              added: result.totals.added,
              skipped: result.totals.skipped,
              replaced: result.totals.replaced,
              rejected: result.totals.rejected,
            }),
            error: false,
          });
          noteLater(ioReset, () => setIoNote(null));
          setRefreshKey((k) => k + 1);
        } catch (error) {
          if (!mounted.current) return;
          setImporting(false);
          setIoNote({ text: `${t('page.import.error')}: ${messageOf(error)}`, error: true });
          noteLater(ioReset, () => setIoNote(null));
        }
      })();
    },
    [importing, t, noteLater],
  );

  const selectStore = (slug: string): void => {
    if (slug === storeSlug) return;
    setStoreSlug(slug);
    setQuery('');
    setKindFilter('');
    setTagFilter('');
    setCardId(null);
    dismissAction();
    cancelEdit();
  };
  const selectCard = (id: string): void => {
    setCardId((current) => (current === id ? null : id));
    dismissAction();
    cancelEdit();
  };
  const clearFilters = (): void => {
    setKindFilter('');
    setTagFilter('');
  };

  const dreamLabel =
    dreamPhase === 'pending'
      ? t('page.dreamPending')
      : dreamPhase === 'ok'
        ? t('page.dreamOk')
        : dreamPhase === 'error'
          ? t('page.dreamError')
          : t('page.dreamNow');
  const dreamButtonClass =
    'dshMemPageBtn' +
    (dreamPhase === 'ok' ? ' dshMemPageBtnOk' : '') +
    (dreamPhase === 'error' ? ' dshMemPageBtnError' : '');

  const summaryData = summary.phase === 'ready' ? summary.data : undefined;
  const selectedStore = summaryData?.stores.find((s) => s.slug === storeSlug);

  // ── derived card view (server page + client-side kind/tag filter) ──────
  const cardList = cards.phase === 'ready' && cards.data !== undefined ? cards.data.cards : NO_CARDS;
  const visibleCards = useMemo(
    () =>
      cardList.filter(
        (entry) =>
          (kindFilter === '' || entry.kind === kindFilter) &&
          (tagFilter === '' || entry.tags.includes(tagFilter)),
      ),
    [cardList, kindFilter, tagFilter],
  );
  const filtering = kindFilter !== '' || tagFilter !== '' || query.trim() !== '';

  // Tag options: the store's top tags plus whatever the fetched page carries.
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of selectedStore?.topTags ?? []) counts.set(row.tag, row.count);
    for (const entry of cardList) {
      for (const tag of entry.tags) if (!counts.has(tag)) counts.set(tag, 0);
    }
    // Keep the active filter selectable even after a refresh drops its tag.
    if (tagFilter !== '' && !counts.has(tagFilter)) counts.set(tagFilter, 0);
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([tag, count]) => ({ tag, count }));
  }, [selectedStore, cardList, tagFilter]);

  // The selected store's kind histogram, canonical kinds first.
  const kindRows = useMemo(() => {
    const kinds = selectedStore?.kinds ?? {};
    const rows: { kind: string; count: number }[] = [];
    const seen = new Set<string>();
    for (const kind of KIND_ORDER) {
      const count = kinds[kind];
      if (typeof count === 'number' && count > 0) {
        rows.push({ kind, count });
        seen.add(kind);
      }
    }
    for (const [kind, count] of Object.entries(kinds)) {
      if (seen.has(kind)) continue;
      if (typeof count === 'number' && count > 0) rows.push({ kind, count });
    }
    return rows;
  }, [selectedStore]);

  const editBinding: EditBinding = {
    draft: editDraft,
    pending: editPending,
    note: editNote,
    onStart: startEdit,
    onChange: patchEdit,
    onSave: onSaveEdit,
    onCancel: cancelEdit,
  };

  return (
    <div className="dshMemPage">
      <header className="dshMemPageHead">
        <div className="dshMemPageHeadText">
          <h2 className="dshMemPageTitle">{t('page.title')}</h2>
          <p className="dshMemPageSub">{t('page.description')}</p>
        </div>
        <div className="dshMemPageActions">
          <button type="button" className="dshMemPageBtn" onClick={() => setRefreshKey((k) => k + 1)}>
            {t('page.refresh')}
          </button>
          <button
            type="button"
            className="dshMemPageBtn"
            disabled={exporting}
            onClick={onExport}
          >
            {exporting ? t('page.export.pending') : t('page.export')}
          </button>
          <button
            type="button"
            className="dshMemPageBtn"
            disabled={importing}
            onClick={() => fileInput.current?.click()}
          >
            {importing ? t('page.import.pending') : t('page.import')}
          </button>
          <button
            type="button"
            className={dreamButtonClass}
            disabled={dreamPhase === 'pending'}
            onClick={() => void onDream()}
          >
            {dreamLabel}
          </button>
        </div>
      </header>
      <input
        ref={fileInput}
        className="dshMemFileInput"
        type="file"
        accept="application/json,.json"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = '';
          if (file !== null) onImportFile(file);
        }}
      />
      {ioNote !== null ? (
        <p className={ioNote.error ? 'dshMemPageError' : 'dshMemPageNote'} role={ioNote.error ? 'alert' : 'status'}>
          {ioNote.text}
        </p>
      ) : null}
      {dreamNote !== null ? (
        <p className={dreamNote.error ? 'dshMemPageError' : 'dshMemPageNote'} role={dreamNote.error ? 'alert' : 'status'}>
          {dreamNote.text}
        </p>
      ) : null}

      {summary.phase === 'error' ? (
        <p className="dshMemPageError" role="alert">
          {t('page.errorLoad')}: {summary.error}
        </p>
      ) : null}
      {summary.phase === 'loading' ? <p className="dshMemPageEmpty">{t('page.loading')}</p> : null}

      {summaryData !== undefined ? (
        <>
          <p className="dshMemPageMeta">
            <span className={summaryData.enabled ? 'dshMemPageOk' : 'dshMemPageWarn'}>
              {summaryData.enabled ? t('page.enabled') : t('page.disabled')}
            </span>
            <span>
              {t('page.lastDream')}:{' '}
              {summaryData.lastDream !== null ? fmtDate(summaryData.lastDream) : t('page.never')}
            </span>
          </p>

          <dl className="dshMemStats">
            <StatCell label={t('page.stats.stores')} value={String(summaryData.totals.stores)} />
            <StatCell label={t('page.stats.cards')} value={String(summaryData.totals.cards)} />
            <StatCell label={t('page.stats.superseded')} value={String(summaryData.totals.superseded)} />
            <StatCell label={t('page.stats.pending')} value={String(summaryData.totals.pendingInbox)} />
            <StatCell label={t('page.stats.archived')} value={String(summaryData.totals.archived)} />
            <StatCell label={t('page.stats.bytes')} value={fmtBytes(summaryData.totals.bytes)} />
          </dl>

          {summaryData.stores.length === 0 ? (
            <p className="dshMemPageEmpty">{t('page.noStores')}</p>
          ) : (
            <>
              <div className="dshMemStoreRow">
                {summaryData.stores.map((store) => {
                  const active = store.slug === storeSlug;
                  return (
                    <button
                      key={store.slug}
                      type="button"
                      className={active ? 'dshMemStoreChip dshMemStoreChipActive' : 'dshMemStoreChip'}
                      aria-pressed={active}
                      onClick={() => selectStore(store.slug)}
                    >
                      <span className="dshMemStoreName">
                        {store.kind === 'global' ? t('page.globalStore') : (store.projectPath ?? store.slug)}
                      </span>
                      <span className="dshMemStoreCount">
                        {store.cards} {t('page.storeCards')} · {store.superseded} {t('page.storeSuperseded')} ·{' '}
                        {store.pendingInbox} {t('page.storePending')} · {store.archived} {t('page.storeArchived')} ·{' '}
                        {fmtBytes(store.bytes)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {selectedStore !== undefined ? (
                <section className="dshMemStorePane">
                  <div className="dshMemPaneStats">
                    <div className="dshMemPaneStatBlock">
                      <span className="dshMemPaneStatTitle">{t('page.stats.kinds')}</span>
                      <span className="dshMemChipRow">
                        {kindRows.length === 0 ? (
                          <span className="dshMemHint">{t('page.meta.none')}</span>
                        ) : (
                          kindRows.map((row) => (
                            <span key={row.kind} className="dshMemKindChip">
                              {kindLabel(row.kind, t)}
                              <span className="dshMemKindCount">{row.count}</span>
                            </span>
                          ))
                        )}
                      </span>
                    </div>
                    <div className="dshMemPaneStatBlock">
                      <span className="dshMemPaneStatTitle">{t('page.stats.topTags')}</span>
                      <span className="dshMemChipRow">
                        {selectedStore.topTags.length === 0 ? (
                          <span className="dshMemHint">{t('page.meta.none')}</span>
                        ) : (
                          selectedStore.topTags.map((row) => (
                            <button
                              key={row.tag}
                              type="button"
                              className={
                                tagFilter === row.tag ? 'dshMemTagChip dshMemTagChipActive' : 'dshMemTagChip'
                              }
                              aria-pressed={tagFilter === row.tag}
                              onClick={() => {
                                setTagFilter((current) => (current === row.tag ? '' : row.tag));
                                setTab('cards');
                              }}
                            >
                              #{row.tag}
                              <span className="dshMemTagCount">{row.count}</span>
                            </button>
                          ))
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="dshMemPaneTabs">
                    <button
                      type="button"
                      className={tab === 'cards' ? 'dshMemPaneTab dshMemPaneTabActive' : 'dshMemPaneTab'}
                      aria-pressed={tab === 'cards'}
                      onClick={() => setTab('cards')}
                    >
                      {t('page.tabCards')}
                    </button>
                    <button
                      type="button"
                      className={tab === 'inbox' ? 'dshMemPaneTab dshMemPaneTabActive' : 'dshMemPaneTab'}
                      aria-pressed={tab === 'inbox'}
                      onClick={() => setTab('inbox')}
                    >
                      {t('page.tabInbox')}
                      {inbox.phase === 'ready' && inbox.data !== undefined ? ` (${inbox.data.count})` : ''}
                    </button>
                    <button
                      type="button"
                      className={tab === 'archive' ? 'dshMemPaneTab dshMemPaneTabActive' : 'dshMemPaneTab'}
                      aria-pressed={tab === 'archive'}
                      onClick={() => setTab('archive')}
                    >
                      {t('page.tabArchive')}
                      {selectedStore !== undefined ? ` (${selectedStore.archived})` : ''}
                    </button>
                    <button
                      type="button"
                      className={tab === 'audit' ? 'dshMemPaneTab dshMemPaneTabActive' : 'dshMemPaneTab'}
                      aria-pressed={tab === 'audit'}
                      onClick={() => setTab('audit')}
                    >
                      {t('page.tabAudit')}
                      {audit.phase === 'ready' && audit.data !== undefined ? ` (${audit.data.entries.length})` : ''}
                    </button>
                  </div>

                  {tab === 'cards' ? (
                    <>
                      <input
                        className="dshMemSearch"
                        type="search"
                        placeholder={t('page.searchPlaceholder')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      <div className="dshMemFilters">
                        <label className="dshMemFilterLabel" htmlFor="dshMemFilterKind">
                          {t('page.filter.kind')}
                        </label>
                        <select
                          id="dshMemFilterKind"
                          className="dshMemSelect"
                          value={kindFilter}
                          onChange={(event) => setKindFilter(event.target.value)}
                        >
                          <option value="">{t('page.filter.kindAll')}</option>
                          {KIND_ORDER.map((kind) => (
                            <option key={kind} value={kind}>{kindLabel(kind, t)}</option>
                          ))}
                        </select>
                        <label className="dshMemFilterLabel" htmlFor="dshMemFilterTag">
                          {t('page.filter.tag')}
                        </label>
                        <select
                          id="dshMemFilterTag"
                          className="dshMemSelect"
                          value={tagFilter}
                          onChange={(event) => setTagFilter(event.target.value)}
                        >
                          <option value="">{t('page.filter.tagAll')}</option>
                          {tagOptions.map((row) => (
                            <option key={row.tag} value={row.tag}>
                              {row.count > 0 ? `#${row.tag} (${row.count})` : `#${row.tag}`}
                            </option>
                          ))}
                        </select>
                        {kindFilter !== '' || tagFilter !== '' ? (
                          <button
                            type="button"
                            className="dshMemPageBtn dshMemPageBtnSmall"
                            onClick={clearFilters}
                          >
                            {t('page.filter.clear')}
                          </button>
                        ) : null}
                        {filtering ? (
                          <span className="dshMemFilterCount">
                            {t('page.filter.active', {
                              shown: visibleCards.length,
                              total: cards.data?.total ?? cardList.length,
                            })}
                          </span>
                        ) : null}
                      </div>

                      <div className="dshMemNew">
                        <button
                          type="button"
                          className="dshMemPageBtn dshMemPageBtnSmall"
                          aria-expanded={newOpen}
                          onClick={() => setNewOpen(!newOpen)}
                        >
                          {newOpen ? t('page.new.collapse') : t('page.new')}
                        </button>
                        {newOpen ? (
                          <div className="dshMemDraft">
                            <label className="dshMemDraftLabel" htmlFor="dshMemNewContent">
                              {t('page.new.content')}
                            </label>
                            <textarea
                              id="dshMemNewContent"
                              className="dshMemTextArea"
                              value={newDraft.content}
                              placeholder={t('page.new.contentPlaceholder')}
                              disabled={creating}
                              onChange={(event) => setNewDraft((current) => ({ ...current, content: event.target.value }))}
                            />
                            <DraftFields
                              idPrefix="dshMemNew"
                              draft={newDraft}
                              t={t}
                              disabled={creating}
                              onChange={(patch) => setNewDraft((current) => ({ ...current, ...patch }))}
                            />
                            <p className="dshMemHint">{t('page.new.hint')}</p>
                            {createNote !== null ? (
                              <p
                                className={createNote.error ? 'dshMemActionError' : 'dshMemActionOk'}
                                role={createNote.error ? 'alert' : 'status'}
                              >
                                {createNote.text}
                              </p>
                            ) : null}
                            <div className="dshMemDetailActions">
                              <button
                                type="button"
                                className="dshMemPageBtn"
                                disabled={creating || newDraft.content.trim() === ''}
                                onClick={onCreate}
                              >
                                {creating ? t('page.new.pending') : t('page.new.submit')}
                              </button>
                              <button
                                type="button"
                                className="dshMemPageBtn"
                                disabled={creating}
                                onClick={() => {
                                  setNewDraft(EMPTY_DRAFT);
                                  setNewOpen(false);
                                  window.clearTimeout(createReset.current);
                                  setCreateNote(null);
                                }}
                              >
                                {t('page.action.cancel')}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {cards.phase === 'loading' ? <p className="dshMemPageEmpty">{t('page.loading')}</p> : null}
                      {cards.phase === 'error' ? (
                        <p className="dshMemPageError" role="alert">
                          {t('page.errorLoad')}: {cards.error}
                        </p>
                      ) : null}
                      {cards.phase === 'ready' && cards.data !== undefined ? (
                        <>
                          {cards.data.truncated ? (
                            <p className="dshMemPageNote">
                              {t('page.truncated', { shown: cards.data.cards.length, total: cards.data.total })}
                            </p>
                          ) : null}
                          {visibleCards.length === 0 ? (
                            <p className="dshMemPageEmpty">
                              {filtering ? t('page.noMatches') : t('page.noCards')}
                            </p>
                          ) : (
                            <ul className="dshMemCardList">
                              {visibleCards.map((entry) => (
                                <li key={entry.id}>
                                  <button
                                    type="button"
                                    className={cardId === entry.id ? 'dshMemCardRow dshMemCardRowActive' : 'dshMemCardRow'}
                                    onClick={() => selectCard(entry.id)}
                                  >
                                    <span className="dshMemCardRowTitle">{entry.title}</span>
                                    <span className="dshMemCardRowMeta">
                                      {kindLabel(entry.kind, t)} · ★{entry.importance}
                                      {entry.validUntil !== null ? ` · ${t('page.valid.superseded')}` : ''} ·{' '}
                                      {fmtDate(entry.updated)}
                                      {entry.tags.length > 0 ? ` · ${entry.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
                                      {entry.score !== null ? ` · ${entry.score}` : ''}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : null}

                      {cardId !== null ? (
                        <div className="dshMemCardDetail">
                          {detail.phase === 'loading' ? <p className="dshMemPageEmpty">{t('page.loading')}</p> : null}
                          {detail.phase === 'error' ? (
                            <p className="dshMemPageError" role="alert">
                              {t('page.errorLoad')}: {detail.error}
                            </p>
                          ) : null}
                          {detail.phase === 'ready' && detail.data !== undefined ? (
                            <CardDetail
                              card={detail.data.card}
                              t={t}
                              action={action}
                              onAction={onAction}
                              onCancelAction={dismissAction}
                              edit={editBinding}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : tab === 'inbox' ? (
                    <>
                      {inbox.phase === 'loading' ? <p className="dshMemPageEmpty">{t('page.loading')}</p> : null}
                      {inbox.phase === 'error' ? (
                        <p className="dshMemPageError" role="alert">
                          {t('page.errorLoad')}: {inbox.error}
                        </p>
                      ) : null}
                      {inbox.phase === 'ready' && inbox.data !== undefined ? (
                        inbox.data.entries.length === 0 ? (
                          <p className="dshMemPageEmpty">{t('page.noInbox')}</p>
                        ) : (
                          <ul className="dshMemCardList">
                            {[...inbox.data.entries].reverse().map((entry, index) => (
                              <li key={`${entry.ts}-${index}`} className="dshMemInboxRow">
                                <span className="dshMemInboxVia">{entry.via}</span>
                                <span className="dshMemInboxTs">{fmtDate(entry.ts)}</span>
                                <span className="dshMemInboxContent">{entry.content}</span>
                              </li>
                            ))}
                          </ul>
                        )
                      ) : null}
                    </>
                  ) : tab === 'archive' ? (
                    <>
                      {archive.phase === 'loading' ? <p className="dshMemPageEmpty">{t('page.loading')}</p> : null}
                      {archive.phase === 'error' ? (
                        <p className="dshMemPageError" role="alert">
                          {t('page.errorLoad')}: {archive.error}
                        </p>
                      ) : null}
                      {restoreError !== null ? (
                        <p className="dshMemPageError" role="alert">
                          {t('page.action.error')}: {restoreError}
                        </p>
                      ) : null}
                      {archive.phase === 'ready' && archive.data !== undefined ? (
                        archive.data.cards.length === 0 ? (
                          <p className="dshMemPageEmpty">{t('page.noArchive')}</p>
                        ) : (
                          <ul className="dshMemCardList">
                            {archive.data.cards.map((entry) => (
                              <li key={entry.id} className="dshMemArchiveRow">
                                <span className="dshMemArchiveText">
                                  <span className="dshMemArchiveTitle">{entry.title}</span>
                                  <span className="dshMemArchiveMeta">
                                    {kindLabel(entry.kind, t)} · {t('page.archivedAt')} {fmtDate(entry.archivedAt)}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  className="dshMemPageBtn dshMemPageBtnSmall"
                                  disabled={restoringId !== null}
                                  onClick={() => onRestore(entry.id)}
                                >
                                  {restoringId === entry.id ? t('page.action.restoring') : t('page.action.restore')}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )
                      ) : null}
                    </>
                  ) : (
                    <>
                      {audit.phase === 'loading' ? <p className="dshMemPageEmpty">{t('page.loading')}</p> : null}
                      {audit.phase === 'error' ? (
                        <p className="dshMemPageError" role="alert">
                          {t('page.errorLoad')}: {audit.error}
                        </p>
                      ) : null}
                      {audit.phase === 'ready' && audit.data !== undefined ? (
                        audit.data.entries.length === 0 ? (
                          <p className="dshMemPageEmpty">{t('page.noAudit')}</p>
                        ) : (
                          <>
                            <div className="dshMemAuditHead">
                              <span>{t('page.audit.time')}</span>
                              <span>{t('page.audit.op')}</span>
                              <span>{t('page.audit.via')}</span>
                              <span>{t('page.audit.id')}</span>
                              <span>{t('page.audit.detail')}</span>
                            </div>
                            <ul className="dshMemAuditList">
                              {audit.data.entries.map((entry, index) => (
                                <li key={`${entry.ts}-${entry.op}-${index}`} className="dshMemAuditRow">
                                  <span className="dshMemAuditTime">{fmtDate(entry.ts)}</span>
                                  <span className="dshMemAuditOp">{entry.op}</span>
                                  <span className="dshMemAuditVia">{entry.via}</span>
                                  <span className="dshMemAuditId">{entry.id ?? t('page.meta.none')}</span>
                                  <span className="dshMemAuditDetail">
                                    {entry.detail ?? t('page.meta.none')}
                                    {entry.session !== null && entry.session !== '' ? ` · ${entry.session}` : ''}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )
                      ) : null}
                    </>
                  )}
                </section>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
