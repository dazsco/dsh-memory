import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Config,
  MEMORY_NS,
  MemorySettingsSchema,
  defaultMemorySettings,
  readMemorySettings,
} from '../lib/testing.js';

/**
 * The DSH 0.1.7 settings contract: a plugin's settings ARE its Loader Config.
 * These tests pin the three facts the adaptation depends on — the namespace is
 * the row id, every section is a volatile reference, and the plain projection
 * consumers take is live and tolerant.
 */

test('settings: the namespace is the Loader row id the bundle patch inserts', () => {
  assert.equal(MEMORY_NS, 'dsh-memory');
});

test('settings: the exported Config is the memory schema (loader contract)', () => {
  assert.equal(Config, MemorySettingsSchema);
  assert.equal(typeof Config, 'function');
  assert.equal(typeof Config.toJSON, 'function');
});

test('settings: every section is volatile, and nothing else is declared', () => {
  const defaults = defaultMemorySettings();
  const dict = MemorySettingsSchema.dict;
  assert.ok(dict, 'the root schema is an object');
  assert.deepEqual(
    Object.keys(dict).sort(),
    Object.keys(defaults).sort(),
    'the schema declares exactly the settings the consumers read',
  );
  for (const key of Object.keys(defaults)) {
    assert.equal(dict[key].meta?.volatile, true, `${key} must be volatile (it is a live settings section)`);
  }
});

test('settings: the production defaults satisfy the schema and round-trip', () => {
  const resolved = MemorySettingsSchema(defaultMemorySettings());
  // Validation hands back one immutable reference per volatile section; the
  // projection must reproduce exactly the defaults the plugin ships.
  assert.deepEqual(readMemorySettings(resolved), defaultMemorySettings());
});

test('settings: reads are live — a committed value is visible on the next read', () => {
  const settings = defaultMemorySettings();
  const config = Object.fromEntries(Object.keys(settings).map((key) => [key, { get: () => settings[key] }]));
  assert.equal(readMemorySettings(config).enabled, true);
  settings.enabled = false;
  settings.dream = { ...settings.dream, requestSeq: 7 };
  const next = readMemorySettings(config);
  assert.equal(next.enabled, false, 'the kill switch is read live');
  assert.equal(next.dream.requestSeq, 7, 'a committed trigger is read live');
});

test('settings: sections come back as copies, never the runtime snapshot', () => {
  const settings = defaultMemorySettings();
  const config = Object.fromEntries(Object.keys(settings).map((key) => [key, { get: () => settings[key] }]));
  const first = readMemorySettings(config);
  first.capture.mode = 'off';
  first.dream.requestSeq = 99;
  const second = readMemorySettings(config);
  assert.equal(second.capture.mode, 'auto', 'a consumer edit does not leak into the runtime reference');
  assert.equal(second.dream.requestSeq, 0);
});

test('settings: a bare mount and unreadable references degrade to production defaults', () => {
  assert.deepEqual(readMemorySettings(undefined), defaultMemorySettings());
  assert.deepEqual(readMemorySettings(null), defaultMemorySettings());
  const broken = {
    enabled: { get: () => { throw new Error('detached reference'); } },
    capture: { get: () => { throw new Error('detached reference'); } },
  };
  const settings = readMemorySettings(broken);
  assert.equal(settings.enabled, true);
  assert.equal(settings.capture.mode, 'auto');
  assert.equal(settings.maintenance.maxLiveCards, 2000);
});
