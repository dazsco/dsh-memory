/**
 * dsh-memory — the human-facing slash-command surface.
 *
 * DSH's `commands` service owns plugin-contributed composer commands; the
 * agent tools are model-facing, and the Memory page is the GUI surface. This
 * module adds the third: `/memory …`, typed by the HUMAN in the composer and
 * executed on the Host without a model turn.
 *
 *   /memory                     store + Dream status
 *   /memory status   | 状态      per-store counts, pending captures, last Dream
 *   /memory recall <query>  | 召回   ranked recall over project + global
 *   /memory search <query>  | 搜索   recall across EVERY known store
 *   /memory remember <text> | 写入   store a durable memory
 *   /memory forget <id>     | 遗忘   archive one memory (recoverable)
 *   /memory gc [confirm]    | 清理   capacity cleanup (dry run unless confirmed)
 *   /memory drop <slug>     | 删除库  permanently delete one project store
 *   /memory dream           | 整理   run one Dream consolidation now
 *   /memory help            | 帮助   usage
 *
 * This is the ONLY registered command. The row copy is Chinese because DSH
 * renders a host command's `description`/`input.hint` verbatim (a third-party
 * command gets no per-locale lookup), and Chinese subcommand aliases are
 * accepted alongside the English tokens.
 *
 * No runtime import of the commands package: the service is resolved through
 * the lenient `ctx.get('commands')` and consumed structurally, so the plugin
 * still loads in a composition without it (a single warning).
 */
import type { StoreLogger } from './store.ts';
import type { MemoryCore } from './core.ts';
import { maintenanceLimitsFrom } from './maintain.ts';
import type { MemorySettings } from './settings.ts';
import type { DreamEngine } from './dream.ts';
import { MemoryPolicyError } from './types.ts';

/** Command outcome shape accepted by the commands registry. */
type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string };

/** The `commands` service face dsh-memory consumes. */
export interface CommandsService {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string };
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
  }): () => void;
}

/** Agent/session context the registry hands to one invocation. */
export interface CommandInvocation {
  agent?: {
    id?: string;
    session?: {
      id?: string;
      header?: { cwd?: string };
    };
  } | null;
  readonly rawInput: string;
}

export interface CommandsCtx {
  get: (name: string) => unknown;
}

/**
 * Usage text for the `/memory help` reply. Chinese-first (the composer row is
 * localized too), but the subcommand TOKENS stay the literal English words —
 * they are what the user actually types.
 */
const HELP = [
  '/memory 状态 — 各记忆库卡片数、待整理候选、上次整理时间',
  '/memory 召回 <关键词> — 在当前项目库 + 全局库中检索',
  '/memory 搜索 <关键词> — 在全部已知记忆库中检索',
  '/memory 写入 <内容> — 写入一条长期记忆',
  '/memory 遗忘 <卡片id> — 归档一条记忆（可恢复）',
  '/memory 清理 [slug] [confirm] — 容量清理：试算（默认）或执行；归档过期/超限卡片并裁剪日志与归档',
  '/memory 删除库 <slug> — 永久删除一个项目记忆库（不可恢复；全局库不可删）',
  '/memory 整理 — 立即执行一次 Dream 整理',
  '',
  '（子命令也可用英文：status | recall | search | remember | forget | gc | drop | dream）',
].join('\n');

/**
 * The composer row's description. DSH renders a HOST command's `description`
 * verbatim (no per-locale lookup is available to a third-party command), so
 * the shipped copy is Chinese; the subcommand tokens stay literal.
 */
export const COMMAND_DESCRIPTION = '记忆库：状态 / 召回 / 写入 / 遗忘 / 清理 / 删除库 / 整理';

/** The composer row's input hint (shown after the command in the menu). */
export const COMMAND_HINT = '状态 | 召回 <关键词> | 写入 <内容> | 遗忘 <id> | 清理 [confirm] | 删除库 <slug> | 整理';

/**
 * Accepted subcommand spellings → canonical verb. Chinese aliases exist so the
 * help text and what the user types agree.
 */
const VERB_ALIASES: Readonly<Record<string, string>> = {
  状态: 'status',
  召回: 'recall',
  搜索: 'search',
  写入: 'remember',
  记住: 'remember',
  遗忘: 'forget',
  删除: 'forget',
  清理: 'gc',
  清理容量: 'gc',
  gc: 'gc',
  删除库: 'drop',
  删库: 'drop',
  drop: 'drop',
  整理: 'dream',
  帮助: 'help',
};

/** Trim the leading separator and surrounding whitespace off raw input. */
function payload(rawInput: string): string {
  return rawInput.replace(/^[\s:：]+/, '').trim();
}

/** First word (lowercased) + remainder of one command line. */
function splitVerb(input: string): { verb: string; rest: string } {
  const trimmed = input.trim();
  if (trimmed === '') return { verb: '', rest: '' };
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (match === null) return { verb: '', rest: '' };
  return { verb: (match[1] ?? '').toLowerCase(), rest: (match[2] ?? '').trim() };
}

function cwdOf(invocation: CommandInvocation): string | null {
  const cwd = invocation.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

function sessionIdOf(invocation: CommandInvocation): string | undefined {
  const id = invocation.agent?.session?.id ?? invocation.agent?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** One compact hit line for command output. */
function hitLine(hit: { store: string; id: string; kind: string; title: string; snippet: string; score: number }): string {
  const snippet = hit.snippet !== '' ? ` — ${hit.snippet}` : '';
  return `- [${hit.kind}] ${hit.title}${snippet} (${hit.id} · ${hit.store} · ${hit.score})`;
}

/**
 * Register the slash commands for the caller's fiber lifetime. Absent
 * `commands` service degrades to a warning; a registration throw is contained.
 */
export function registerMemoryCommands(
  ctx: CommandsCtx,
  core: MemoryCore,
  getSettings: () => MemorySettings,
  engine: DreamEngine,
  logger: StoreLogger | null,
): (() => void) | null {
  const commands = ctx.get('commands') as CommandsService | undefined;
  if (!commands || typeof commands.register !== 'function') {
    logger?.warn('[dsh-memory] commands service unavailable; /memory command not registered');
    return null;
  }

  /** Execute one parsed `/memory` line. Never throws: errors become `kind:'error'`. */
  const run = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const st = getSettings();
    const split = splitVerb(payload(invocation.rawInput ?? ''));
    const verb = split.verb === '' ? 'status' : (VERB_ALIASES[split.verb] ?? split.verb);
    const rest = split.rest;
    try {
      switch (verb) {
        case 'help':
          return { kind: 'success', text: HELP };
        case 'status': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          const report = await core.status(true);
          const lines = report.stores.map(
            (s) =>
              `- ${s.slug} (${s.kind}): ${s.cards} cards · ${s.superseded} superseded · ${s.pendingInbox} pending · ${s.archived} archived`,
          );
          return {
            kind: 'success',
            text: [
              `dsh-memory: ${report.totals.cards} live cards across ${report.totals.stores} store(s), ${report.totals.pendingInbox} pending capture(s).`,
              `Last Dream: ${report.lastDream ?? 'never'}.`,
              ...lines,
            ].join('\n'),
          };
        }
        case 'recall':
        case 'search': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (rest === '') return { kind: 'error', text: `usage: /memory ${verb} <query>` };
          const cwd = cwdOf(invocation);
          const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
          const { hits } = await core.recall(rest, {
            projectSlug: project?.slug ?? null,
            scope: verb === 'search' ? 'all' : 'both',
            k: st.recall.k,
            expandLinks: st.recall.expandLinks,
            linkDecay: st.recall.linkDecay,
          });
          if (hits.length === 0) return { kind: 'success', text: `No memory matches “${rest}”.` };
          return { kind: 'success', text: [`${hits.length} memory match(es) for “${rest}”:`, ...hits.map(hitLine)].join('\n') };
        }
        case 'remember': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (rest === '') return { kind: 'error', text: 'usage: /memory remember <text>' };
          const out = await core.remember(
            {
              content: rest,
              scope: 'auto',
              cwd: cwdOf(invocation),
              maxBytes: st.budget.maxCardBytes,
              piiMode: st.redact.pii,
            },
            'command',
            sessionIdOf(invocation),
          );
          const warns = out.warnings.length > 0 ? ` (redacted: ${out.warnings.join(', ')})` : '';
          const note = out.note !== undefined ? `\n注意：${out.note}` : '';
          return { kind: 'success', text: `Remembered in ${out.slug}: ${out.card.title} (${out.card.id})${warns}${note}` };
        }
        case 'forget': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (rest === '') return { kind: 'error', text: 'usage: /memory forget <card-id> (archives; recoverable)' };
          const named = rest.split(/\s+/)[0] ?? '';
          const cwd = cwdOf(invocation);
          const project = cwd ? await core.projectStoreForCwd(cwd).catch(() => null) : null;
          if (/^m-\d{8}-[a-z0-9]{4,10}$/.test(named)) {
            const out = await core.forget({ id: named, projectSlug: project?.slug ?? null }, 'command', sessionIdOf(invocation));
            if (out.removed.length === 0) return { kind: 'error', text: `No card with id ${named} in this project or global memory.` };
            return { kind: 'success', text: `Archived ${out.removed.map((r) => `${r.id} (${r.slug})`).join(', ')}. Restore it from Settings → Memory → Archive.` };
          }
          const out = await core.forget({ query: rest, confirm: false, projectSlug: project?.slug ?? null }, 'command', sessionIdOf(invocation));
          const candidates = out.candidates ?? [];
          if (candidates.length === 0) return { kind: 'success', text: `No memory matches “${rest}”.` };
          return {
            kind: 'success',
            text: [
              `Dry run — would archive:`,
              ...candidates.map((c) => `- ${c.title} (${c.id} · ${c.slug} · ${c.score})`),
              'Re-run with an exact id: /memory forget <id>',
            ].join('\n'),
          };
        }
        case 'drop': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          const slug = (rest.split(/\s+/)[0] ?? '').trim();
          if (slug === '') {
            const projectSlugs = core.allStores().filter((s) => s.kind === 'project').map((s) => s.slug);
            return {
              kind: 'error',
              text: `usage: /memory 删除库 <slug>\n当前项目库：${projectSlugs.length > 0 ? projectSlugs.join(', ') : '（无）'}（全局库不可删除）`,
            };
          }
          if (slug === 'global') return { kind: 'error', text: '全局库不能删除（全局记忆请用逐张遗忘）' };
          if (core.storeBySlug(slug) === null) {
            const projectSlugs = core.allStores().filter((s) => s.kind === 'project').map((s) => s.slug);
            return {
              kind: 'error',
              text: `未知记忆库 “${slug}”。当前项目库：${projectSlugs.length > 0 ? projectSlugs.join(', ') : '（无）'}`,
            };
          }
          const res = await core.dropStore(slug, 'command', sessionIdOf(invocation));
          return {
            kind: 'success',
            text: `已永久删除记忆库 ${res.slug}：${res.liveCards} 张卡片 + ${res.archivedCards} 张归档 + 整理历史/收件箱/索引；注册表条目${res.registryRemoved ? '已' : '未'}清理。此操作不可恢复。`,
          };
        }
        case 'gc': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          const tokens = rest.split(/\s+/).filter((t) => t !== '');
          const isConfirm = (t: string): boolean => /^(confirm|--confirm|-y|yes|执行|确认)$/i.test(t);
          const apply = tokens.some(isConfirm);
          const slugToken = tokens.find((t) => !isConfirm(t)) ?? '';
          const slug = slugToken === '' || slugToken === 'all' || slugToken === '全部' ? null : slugToken;
          if (slug !== null && core.storeBySlug(slug) === null) {
            const slugs = core.allStores().map((s) => s.slug);
            return { kind: 'error', text: `未知记忆库 “${slug}”。当前记忆库：${slugs.join(', ')}` };
          }
          const report = await core.maintain({
            limits: maintenanceLimitsFrom(st),
            slugs: slug !== null ? [slug] : undefined,
            dryRun: !apply,
          });
          const lines = report.stores.map(
            (s) =>
              `- ${s.slug}: 归档 stale ${s.staleArchived} + 超限 ${s.budgetArchived} · 删归档 ${s.archivePruned} · ` +
              `审计 ${s.auditPruned} · 访问 ${s.accessPruned} · 收件箱 ${s.inboxDropped} · 约 ${s.bytesReclaimed}B`,
          );
          return {
            kind: 'success',
            text: [
              report.dryRun ? '容量清理试算（未改动任何文件）：' : '容量清理完成：',
              ...lines,
              report.dryRun ? '确认执行：/memory 清理 confirm（可加 slug 只清理一个库）' : '',
            ]
              .filter((l) => l !== '')
              .join('\n'),
          };
        }
        case 'dream': {
          if (!st.enabled) return { kind: 'error', text: 'dsh-memory is disabled (settings: memory.enabled=false).' };
          if (!st.dream.enabled) return { kind: 'error', text: 'Dream is disabled (settings: memory.dream.enabled=false).' };
          const res = await engine.runNow({ reason: 'command', llm: engine.llmForRun() });
          if (res.busy) return { kind: 'success', text: 'A Dream run is already in flight.' };
          const lines = res.stores.map((s) => `- ${s.slug}: +${s.added} ~${s.updated} =${s.noop} ↓${s.archived} ⊃${s.superseded} ⊘${s.blocked} link=${s.relinked} gc=${s.pruned}`);
          return { kind: 'success', text: [`Dream finished in ${res.durationMs} ms (llm calls: ${res.llmCalls}).`, ...lines].join('\n') };
        }
        default:
          return { kind: 'error', text: `Unknown /memory subcommand “${verb}”.\n${HELP}` };
      }
    } catch (err) {
      if (err instanceof MemoryPolicyError) return { kind: 'error', text: `Blocked by policy: ${err.reasons.join(', ')}` };
      return { kind: 'error', text: `memory command failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const disposers: (() => void)[] = [];
  try {
    if (getSettings().commands.enabled) {
      // Exactly ONE command: `/memory`, with subcommands. A second command
      // (`/remember`) was redundant — `/memory 写入 <内容>` covers it — and two
      // rows in the composer menu for one capability is just noise.
      disposers.push(
        commands.register({
          name: 'memory',
          description: COMMAND_DESCRIPTION,
          input: { hint: COMMAND_HINT },
          handler: run,
        }),
      );
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // disposal must never throw during fiber teardown
        }
      }
    };
  } catch (err) {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // ignore a partial rollback failure
      }
    }
    logger?.warn(`[dsh-memory] command registration failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
