/**
 * dsh-memory plugin, browser half.
 *
 * Registers the `memory` settings card into the plugin-configuration section
 * (`settings.plugin.item`), keyed by the settings namespace it edits — the
 * tab pairs the served namespace with the card registered under that key.
 * No other browser behavior: all memory logic lives on the Host.
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the settings-surface SlotMap merge and ctx.settingsScope.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
// Type-only: pulls the `settings.plugin.item` SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client';
// Type-only: pulls the `ctx.slots` SlotRegistry merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MemorySettings } from '../settings.ts';
import { en, zh, type SettingsCardKey } from './locales.ts';
import { MemorySettingsCard, MemorySettingsCardController } from './settings-card.tsx';

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
 * Plugin body: mount the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: dictionaries');

  // Bind the `memory` namespace; the card reads it reactively and writes it
  // through path ops (the section is nested, the scope's flat set() is not).
  const scope = ctx.settingsScope.bind<MemorySettings>({ namespace: SETTINGS_NS });
  const controller = new MemorySettingsCardController(scope);

  // Plugin configuration card: one staged form over the `memory` settings
  // namespace, contributed to the plugin-configuration section (Settings →
  // Plugins). `settings.plugin.item` is a keyed slot — the dispatch key is
  // the settings namespace the card edits.
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: SETTINGS_NS,
        locale: NS,
        inject: () => controller.inject(),
      },
      MemorySettingsCard,
    ),
  );
}
