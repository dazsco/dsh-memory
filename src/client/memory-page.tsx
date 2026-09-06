/**
 * dsh-memory — the "Memory" settings section.
 *
 * A settings-nav page (the `settings.section` seat) where the human can do
 * what the agent tools cannot: browse EVERY store (global + all projects),
 * search one store's cards, read a card in full, inspect the pending capture
 * inbox and the Dream state, and manage single cards — archive / hard-delete
 * (two-step confirm) from the detail panel, restore from the archive tab.
 * Mutations go through the Host's exact fetch routes and the SAME store ops
 * the agent tools use (single writer, audited, lock-protected); this page
 * never writes a file itself. "Dream now" reuses the existing
 * `dream.requestSeq` trigger (same path as the settings card).
 *
 * Data flows over the plugin's exact fetch routes (/api/memory/*) served by
 * the Host on the connection channel; everything is JSON, plain values,
 * already policy-clean before it ever landed on disk.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { MemorySettings } from '../settings.ts';
import type { MemoryCard } from '../types.ts';
import type {
  BrowseArchiveList,
  BrowseCardDetail,
  BrowseCardList,
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

/** Bridges the `memory` settings scope onto the page's Dream trigger. */
export class MemoryPageController {
  constructor(private readonly scope: SettingsScope<MemorySettings>) {}

  /** Bump the monotonic trigger; the Host watcher fires the run. */
  dreamNow(): Promise<void> {
    const value = this.scope.getSnapshot().value;
    const seq = typeof value?.dream?.requestSeq === 'number' ? value.dream.requestSeq : 0;
    return this.scope
      .mutate([{ op: 'set', path: ['dream', 'requestSeq'], value: seq + 1 }])
      .then(() => undefined) as Promise<void>;
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

type TFn = (key: SettingsCardKey) => string;

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

async function apiGet<T>(path: string, signal: AbortSignal): Promise<T> {
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

function messageOf(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return error instanceof Error ? error.message : String(error);
}

function fmtDate(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
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

function kindLabel(kind: string, t: TFn): string {
  const key = KIND_KEYS[kind];
  return key !== undefined ? t(key) : kind;
}

type DreamPhase = 'idle' | 'pending' | 'ok' | 'error';

/** One armed detail-panel mutation (v2): first click arms, second executes. */
interface DetailAction {
  op: 'archive' | 'hard-delete';
  armed: boolean;
  pending: boolean;
  error: string | null;
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

/** The full card: content, front-matter grid, then the per-card actions. */
function CardDetail(props: {
  card: MemoryCard;
  t: TFn;
  action: DetailAction | null;
  onAction: (op: 'archive' | 'hard-delete') => void;
  onCancelAction: () => void;
}) {
  const { card, t, action, onAction, onCancelAction } = props;
  const busy = action !== null && action.pending;
  return (
    <article className="dshMemDetailCard">
      <h3 className="dshMemDetailTitle">{card.title}</h3>
      {card.body !== '' ? <p className="dshMemDetailBody">{card.body}</p> : null}
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
      <div className="dshMemDetailActions">
        {action === null ? (
          <>
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
    </article>
  );
}

// ── the page ───────────────────────────────────────────────────────────────

/**
 * Render the Memory section (browse + per-card archive/delete/restore).
 * @param props - locale copy and the injected Dream trigger.
 * @returns the page.
 */
export function MemoryPage(props: MemoryPageProps) {
  const { t } = props;
  const [refreshKey, setRefreshKey] = useState(0);
  const [summary, setSummary] = useState<Slice<BrowseSummary>>({ phase: 'loading' });
  const [storeSlug, setStoreSlug] = useState<string | null>(null);
  const [tab, setTab] = useState<'cards' | 'inbox' | 'archive'>('cards');
  const [query, setQuery] = useState('');
  const [cards, setCards] = useState<Slice<BrowseCardList>>({ phase: 'loading' });
  const [inbox, setInbox] = useState<Slice<BrowseInbox>>({ phase: 'loading' });
  const [archive, setArchive] = useState<Slice<BrowseArchiveList>>({ phase: 'loading' });
  const [cardId, setCardId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Slice<BrowseCardDetail>>({ phase: 'loading' });
  const [dreamPhase, setDreamPhase] = useState<DreamPhase>('idle');
  const dreamReset = useRef<number | undefined>(undefined);
  // v2 per-card actions
  const [action, setAction] = useState<DetailAction | null>(null);
  const actionReset = useRef<number | undefined>(undefined);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreErrorReset = useRef<number | undefined>(undefined);

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

  // ── card list (debounced on the query) ─────────────────────────────────
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
  }, [cardId, storeSlug]);

  // ── Dream trigger (same mechanism as the settings card) ────────────────
  const onDream = useCallback(async () => {
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
    dreamReset.current = window.setTimeout(() => setDreamPhase('idle'), 3000);
  }, [dreamPhase, props]);

  // ── per-card mutation (v2): first click arms, second click executes ────
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
          window.clearTimeout(actionReset.current);
          setAction(null);
          setCardId(null); // the card is gone — close the detail
          setRefreshKey((k) => k + 1); // re-fetch roster + lists
        } catch (error) {
          setAction({ op, armed: true, pending: false, error: messageOf(error) });
        }
      })();
    },
    [storeSlug, cardId, action],
  );

  // ── restore one archived card (v2) ─────────────────────────────────────
  const onRestore = useCallback(
    (id: string): void => {
      if (storeSlug === null || restoringId !== null) return;
      setRestoringId(id);
      void (async () => {
        try {
          await apiPost('/api/memory/card/restore', { store: storeSlug, id });
          setRestoreError(null);
          window.clearTimeout(restoreErrorReset.current);
          setRefreshKey((k) => k + 1);
        } catch (error) {
          setRestoreError(messageOf(error));
          window.clearTimeout(restoreErrorReset.current);
          restoreErrorReset.current = window.setTimeout(() => setRestoreError(null), 6000);
        } finally {
          setRestoringId(null);
        }
      })();
    },
    [storeSlug, restoringId],
  );

  useEffect(
    () => () => {
      window.clearTimeout(dreamReset.current);
      window.clearTimeout(actionReset.current);
      window.clearTimeout(restoreErrorReset.current);
    },
    [],
  );

  const selectStore = (slug: string): void => {
    if (slug === storeSlug) return;
    setStoreSlug(slug);
    setQuery('');
    setCardId(null);
    dismissAction();
  };
  const selectCard = (id: string): void => {
    setCardId((current) => (current === id ? null : id));
    dismissAction();
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
            className={dreamButtonClass}
            disabled={dreamPhase === 'pending'}
            onClick={() => void onDream()}
          >
            {dreamLabel}
          </button>
        </div>
      </header>

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
                        {store.cards} {t('page.storeCards')} · {store.pendingInbox} {t('page.storePending')} ·{' '}
                        {store.archived} {t('page.storeArchived')}
                      </span>
                    </button>
                  );
                })}
              </div>

              {selectedStore !== undefined ? (
                <section className="dshMemStorePane">
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
                      {cards.phase === 'loading' ? <p className="dshMemPageEmpty">{t('page.loading')}</p> : null}
                      {cards.phase === 'error' ? (
                        <p className="dshMemPageError" role="alert">
                          {t('page.errorLoad')}: {cards.error}
                        </p>
                      ) : null}
                      {cards.phase === 'ready' && cards.data !== undefined ? (
                        cards.data.cards.length === 0 ? (
                          <p className="dshMemPageEmpty">
                            {query.trim() === '' ? t('page.noCards') : t('page.noMatches')}
                          </p>
                        ) : (
                          <ul className="dshMemCardList">
                            {cards.data.cards.map((entry) => (
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
                        )
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
                  ) : (
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
