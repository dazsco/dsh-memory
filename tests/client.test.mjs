import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMemorySettings } from '../lib/testing.js';

/**
 * Browser-half smoke test, run WITHOUT a browser: the built `lib/client.js` is
 * loaded exactly as the client module system does (the bundle only registers a
 * lazy factory), the factory is materialized with a stub module table, and the
 * plugin is applied against a structural client context.
 *
 * This is the only automated coverage of the DSH 0.1.7 client adaptation: the
 * configuration form is bound through `ctx.configForms` and registered into the
 * Plugins page's keyed seats, and the card's staged fields must still line up
 * with the paths the Host accepts. The rendered page itself is not verified.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NS = 'dsh-memory';

/** Load the bundle the way the shell does and hand back its registered factory. */
function loadBundleFactory() {
  let registered;
  const previous = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registered = entry; } } };
  try {
    (0, eval)(readFileSync(join(root, 'lib', 'client.js'), 'utf8'));
  } finally {
    globalThis.window = previous;
  }
  assert.ok(registered, 'the bundle registered a factory');
  assert.equal(registered.id, NS, 'the factory is registered under the package name');
  return registered.factory;
}

/** Minimal module table: only the platform baseline this bundle requests. */
function stubModules() {
  const snapshots = (initial) => {
    let current = initial;
    const listeners = new Set();
    return {
      getSnapshot: () => current,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      set: (next) => { current = next; for (const listener of [...listeners]) listener(); },
    };
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  return {
    react: {
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
      useRef: (initial) => ({ current: initial }),
      useEffect: () => undefined,
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore: snapshots },
  };
}

/** The live configuration form the Host would serve for this entry. */
function fakeForm(settings) {
  const state = {
    status: 'ready',
    value: settings,
    base: settings,
    user: {},
    revision: 4,
    writable: true,
    mode: 'host',
  };
  const calls = [];
  return {
    calls,
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    mutate: async (ops) => { calls.push(ops); return true; },
  };
}

/** A structural client context recording every registration. */
function fakeCtx(form) {
  const registrations = [];
  const namespaces = [];
  const effects = [];
  const ctx = {
    effect: (setup, label) => { effects.push(label); const dispose = setup(); return () => { if (typeof dispose === 'function') dispose(); }; },
    locale: {
      register: () => () => undefined,
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, cb) => { cb(); },
      register: (options, component) => { registrations.push({ options, component }); return () => undefined; },
    },
    configForms: {
      get: (namespace) => { namespaces.push(namespace); return form; },
    },
  };
  return { ctx, registrations, namespaces, effects };
}

/** Depth-first search of a stubbed element tree for one predicate. */
function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

/**
 * Expand the stub tree the way React would: call every function component and
 * keep the host elements it returns. The field controls of this card live
 * inside its own small components, so a bare element walk would never see them.
 */
function render(node) {
  if (Array.isArray(node)) return node.flatMap((child) => render(child));
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return render(node.type({ ...node.props }));
  const children = render(node.props?.children);
  return { type: node.type, props: { ...node.props, ...(children === undefined ? {} : { children }) } };
}

function cardProps(registrations, form, overrides = {}) {
  const entry = registrations.find((r) => r.options.name === 'plugins.row.config');
  const injected = entry.options.inject();
  const store = injected.hooks.memorySettingsCard;
  return {
    view: 'page',
    t: (key) => key,
    useMemorySettingsCard: (selector) => selector(store.getSnapshot()),
    ...injected,
    form,
    ...overrides,
  };
}

test('client: apply binds the row namespace and registers the Plugins-page seats', () => {
  const factory = loadBundleFactory();
  const exports = factory((specifier) => stubModules()[specifier]);
  const form = fakeForm(defaultMemorySettings());
  const { ctx, registrations, namespaces } = fakeCtx(form);

  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms']);
  exports.apply(ctx);

  assert.deepEqual(namespaces, [NS], 'the configuration form is bound to the row-id namespace');

  const bundle = registrations.find((r) => r.options.name === 'plugins.bundle.config');
  assert.ok(bundle, 'the bundle configuration seat is registered');
  assert.equal(bundle.options.key, NS);

  const row = registrations.find((r) => r.options.name === 'plugins.row.config');
  assert.ok(row, 'the row configuration seat is registered');
  assert.equal(row.options.key, `${NS}#${NS}`, 'keyed <package name>#<row id>');

  const page = registrations.find((r) => r.options.name === 'settings.section');
  assert.ok(page, 'the Memory page keeps its settings-nav seat');
  assert.equal(page.options.id, 'memory');
  assert.equal(typeof page.options.label, 'function', 'the nav label re-resolves on locale change');
});

test('client: the row summary view is a one-liner and the page view is the form', () => {
  const factory = loadBundleFactory();
  const exports = factory((specifier) => stubModules()[specifier]);
  const form = fakeForm(defaultMemorySettings());
  const { ctx, registrations } = fakeCtx(form);
  exports.apply(ctx);

  const component = registrations.find((r) => r.options.name === 'plugins.row.config').component;
  assert.equal(component(cardProps(registrations, form, { view: 'summary' })), 'card.description');

  const tree = render(component(cardProps(registrations, form)));
  assert.ok(find(tree, (node) => node.props?.className === 'dshMemSave'), 'the form carries its save control');
  assert.ok(find(tree, (node) => String(node.props?.className ?? '').includes('dshMemDreamNow')), 'the Dream-now trigger is rendered');
  assert.ok(find(tree, (node) => node.props?.id === 'memory-enabled'), 'the master switch is rendered');
  assert.ok(find(tree, (node) => node.props?.id === 'memory-maintenance-max-live-cards'), 'a nested maintenance field is rendered');
});

test('client: a staged edit is written as one path op on save', async () => {
  const factory = loadBundleFactory();
  const exports = factory((specifier) => stubModules()[specifier]);
  const form = fakeForm(defaultMemorySettings());
  const { ctx, registrations } = fakeCtx(form);
  exports.apply(ctx);

  const component = registrations.find((r) => r.options.name === 'plugins.row.config').component;
  const props = cardProps(registrations, form);
  const tree = render(component(props));

  // The control stages a draft; nothing is written until Save.
  const switchInput = find(tree, (node) => node.props?.id === 'memory-enabled' && typeof node.props?.onChange === 'function');
  assert.ok(switchInput, 'the master switch renders its control');
  switchInput.props.onChange({ target: { value: 'false' } });
  assert.equal(form.calls.length, 0, 'staging writes nothing');

  const save = find(tree, (node) => node.props?.className === 'dshMemSave');
  save.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(form.calls, [[{ op: 'set', path: ['enabled'], value: false }]]);
});

test('client: Dream now bumps the monotonic requestSeq through the same form', async () => {
  const factory = loadBundleFactory();
  const exports = factory((specifier) => stubModules()[specifier]);
  const settings = defaultMemorySettings();
  settings.dream = { ...settings.dream, requestSeq: 3 };
  const form = fakeForm(settings);
  const { ctx, registrations } = fakeCtx(form);
  exports.apply(ctx);

  const component = registrations.find((r) => r.options.name === 'plugins.row.config').component;
  const injected = registrations.find((r) => r.options.name === 'plugins.row.config').options.inject();
  await injected.dreamNow();
  assert.deepEqual(form.calls, [[{ op: 'set', path: ['dream', 'requestSeq'], value: 4 }]]);

  // A refused write is a failure, not a silent no-op.
  const refused = {
    ...form,
    mutate: async () => false,
  };
  const refusedFace = (() => {
    const { ctx: other, registrations: otherRegistrations } = fakeCtx(refused);
    const otherExports = factory((specifier) => stubModules()[specifier]);
    otherExports.apply(other);
    void ctx;
    void component;
    return otherRegistrations.find((r) => r.options.name === 'plugins.row.config').options.inject();
  })();
  await assert.rejects(() => refusedFace.dreamNow(), /refused/);
});
