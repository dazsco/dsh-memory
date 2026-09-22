/**
 * dsh-memory plugin, browser half.
 *
 * Binds this plugin's live configuration entry and registers two surfaces:
 * the memory settings form into the Plugins page's own configuration seats
 * (`plugins.bundle.config` for the bundle, `plugins.row.config` for the row
 * the bundle declares), and the Memory page into the settings nav
 * (`settings.section`). No memory LOGIC runs in the browser: every read/write
 * goes to the Host.
 *
 * The configuration namespace is the Loader ROW id (`dsh-memory`), because
 * DSH 0.1.7 projects a plugin's own Config through `ctx.settings` under the
 * id of the entry that declares it.
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the settings-surface SlotMap merge (`settings.section`) and
// the ctx.configForms Context merge. Cross-plugin collaboration goes through
// the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
// Type-only: pulls the Plugins page's SlotMap merge (`plugins.bundle.config`,
// `plugins.row.config`). The row key is spelled here rather than imported: a
// cross-plugin VALUE import would inline (or require) another plugin's bundle,
// which the client module graph forbids.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MemorySettings } from '../settings.ts';
import { en, zh, type SettingsCardKey } from './locales.ts';
import { MemorySettingsCard, MemorySettingsCardController } from './settings-card.tsx';
import { MemoryPage, MemoryPageController } from './memory-page.tsx';

/** Dictionary namespace owned by this plugin. */
const NS = 'dsh-memory';

/**
 * Settings namespace the Host serves for this plugin: the id of the Loader row
 * this bundle's patch inserts, which is also the package name.
 */
const SETTINGS_NS = 'dsh-memory';

/** Plugin package name whose bundle page shows the configuration. */
const BUNDLE_NAME = 'dsh-memory';

/**
 * The Plugins page's key for one row's configuration: `<bundle package
 * name>#<row id>` (the page's `rowConfigKey` contract).
 */
const ROW_CONFIG_KEY = `${BUNDLE_NAME}#${SETTINGS_NS}`;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-memory settings-card copy. */
    'dsh-memory': SettingsCardKey;
  }
}

/** Services required by this plugin. */
export const inject = ['slots', 'locale', 'configForms'];

/**
 * Plugin body: mount the settings form on the Plugins page and the Memory page
 * (browse + per-card archive/delete/restore) in the settings nav.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: dictionaries');

  // Bind this plugin's configuration entry. The card reads it reactively and
  // writes it through path ops (every setting is nested under a section, which
  // the form's flat set() cannot address). The Memory page reuses the same
  // form for its "Dream now" trigger.
  const form = ctx.configForms.get<MemorySettings>(SETTINGS_NS);
  const controller = new MemorySettingsCardController(form);
  const pageController = new MemoryPageController(form);
  // The subscription belongs to this plugin's fiber: a client reload (HMR)
  // otherwise leaves one listener per generation on the shared form.
  ctx.effect(() => () => controller.dispose(), 'dsh-memory: form subscription');

  // The bundle's own page: the form the Plugins page renders between the
  // package description and its rows. Registered unconditionally — the browser
  // half only exists while this bundle's row is loaded, so the namespace it
  // binds is always the one the Host serves.
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: NS,
        inject: () => controller.inject(),
      },
      MemorySettingsCard,
    ),
  );

  // The single row this bundle declares: its configure control opens a page
  // whose body is the same form, and whose row one-liner is the entry's
  // `view: 'summary'`.
  ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
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
