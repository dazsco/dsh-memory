/**
 * dsh-memory plugin, browser half.
 *
 * Registers the `memory` settings card as a tab of the Plugins settings
 * section (`settings.plugins.tab`) and the Memory page into the settings nav
 * (`settings.section`). No memory LOGIC runs in the browser: every
 * read/write goes to the Host.
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the settings-surface SlotMap merge (`settings.section`,
// `settings.plugins.tab`) and ctx.settingsScope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
// Type-only: pulls the `ctx.slots` SlotRegistry merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MemorySettings } from '../settings.ts';
import { en, zh, type SettingsCardKey } from './locales.ts';
import { MemorySettingsCard, MemorySettingsCardController } from './settings-card.tsx';
import { MemoryPage, MemoryPageController } from './memory-page.tsx';

/** Dictionary namespace owned by this plugin. */
const NS = 'dsh-memory';

/** Settings namespace the Host plugin registers and the card edits. */
const SETTINGS_NS = 'memory';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-memory settings-card copy. */
    'dsh-memory': SettingsCardKey;
  }
}

/** Services required by this plugin. */
export const inject = ['slots', 'locale', 'settingsScope'];

/**
 * Plugin body: mount the settings card and the Memory page (browse +
 * per-card archive/delete/restore).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: dictionaries');

  // Bind the `memory` namespace; the card reads it reactively and writes it
  // through path ops (the section is nested, the scope's flat set() is not).
  // The Memory page reuses the same scope for its "Dream now" trigger.
  const scope = ctx.settingsScope.bind<MemorySettings>({ namespace: SETTINGS_NS });
  const controller = new MemorySettingsCardController(scope);
  const pageController = new MemoryPageController(scope);

  // Plugin configuration tab: one staged form over the `memory` settings
  // namespace, contributed to the Plugins settings section (Settings →
  // Plugins). `settings.plugins.tab` is a list slot — each contribution is a
  // tab whose body is its own component, so the card carries no dispatch key
  // any more (it binds the `memory` namespace itself through the scope).
  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'memory',
        order: 20,
        label: () => ctx.locale.bind(NS)('card.title'),
        locale: NS,
        inject: () => controller.inject(),
      },
      MemorySettingsCard,
    ),
  );

  // Memory page in the settings nav: browse every store (global + all
  // projects), search and read cards, inspect the inbox and Dream state, and
  // manage single cards (archive / delete / restore through the Host's exact
  // fetch routes — the same audited store ops the agent tools use).
  // `settings.section` is a list slot — the shell stacks one page per entry;
  // the label thunk re-resolves on locale change (the shell re-renders rows
  // when the locale revision moves). Ordered after the shipped sections.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'memory',
        order: 25,
        label: () => ctx.locale.bind(NS)('page.nav'),
        locale: NS,
        inject: () => ({ dreamNow: () => pageController.dreamNow() }),
      },
      MemoryPage,
    ),
  );
}
