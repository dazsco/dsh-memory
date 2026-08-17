/**
 * Staged form model behind the dsh-memory settings card — the plugin-card
 * store pattern of the DSH plugin-configuration section, adapted for a NESTED
 * settings section: every field is addressed by a path (e.g. `['capture',
 * 'useLlm']`) and writes go through the connection's `settings.mutate` with
 * path ops, so the user layer stays minimal (a field is stored only while the
 * user actually overrides it).
 *
 * A card stages what the user types and writes it only when they save. Each
 * settings write is a durable, revision-fenced document mutation, so staging
 * keeps what is on screen exactly what a save would store. A field shows its
 * effective value — user layer over composition layer over schema default —
 * and whether the user layer carries it (presence, not value equality, marks
 * an override).
 */
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';

/** The write one field's staged text performs when the card is saved. */
export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' };

/** How one field converts between its stored value and its draft text. */
export interface CardFieldSpec {
  /** Field path inside the namespace section, e.g. `['capture', 'useLlm']`. */
  path: readonly string[];
  /** Render a stored value as draft text; the empty string when the path carries none. */
  format: (value: unknown) => string;
  /**
   * The write this draft text stages, or undefined when the text is not a
   * value this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined;
}

/** One field as the card's control renders it. */
export interface CardFieldState {
  /** Draft text the control renders. */
  text: string;
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean;
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean;
}

/** Form state every plugin card shares. */
export interface CardShell {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean;
  /** Whether the Host document accepts writes. */
  writable: boolean;
  /** Whether the form holds edits that a save would write. */
  dirty: boolean;
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean;
  /** Whether a save is crossing the wire. */
  saving: boolean;
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean;
}

/** The write actions the card's slot entry injects. */
export interface CardActions {
  /** Stage draft text for one field (keyed by its dotted path). */
  edit: (key: string, text: string) => void;
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (key: string) => void;
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void;
  /** Drop every staged edit. */
  discard: () => void;
}

/** The settings face of the connection api the form writes through (a structural view of `IApiClient.settings`). */
export interface SettingsApi {
  settings: {
    mutate(payload: {
      ns: string;
      ops: (
        | { op: 'set'; path: string[]; value: unknown }
        | { op: 'unset'; path: string[] }
      )[];
      expectedRevision?: number;
    }): Promise<unknown>;
  };
}

/** Stable map key of one field path. */
export function keyOf(path: readonly string[]): string {
  return path.join('.');
}

/** Read a path from a plain-object tree (undefined when any segment is absent). */
export function pathValue(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const part of path) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Whether a plain-object tree carries a value at a path. */
export function pathHas(root: unknown, path: readonly string[]): boolean {
  let node: unknown = root;
  for (let i = 0; i < path.length; i++) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
    const part = path[i];
    if (part === undefined) return false;
    if (!Object.prototype.hasOwnProperty.call(node, part)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
}

/** A whole-number field with a minimum. An empty draft clears the field; a non-number or out-of-range draft blocks the save. */
export function numberField(path: readonly string[], min = 0): CardFieldSpec {
  return {
    path,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === '') return { kind: 'clear' };
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) return undefined;
      return { kind: 'set', value: parsed };
    },
  };
}

/** A free-text field. An empty draft clears the field, so emptying the control and saving is the same gesture as resetting it. */
export function textField(path: readonly string[]): CardFieldSpec {
  return {
    path,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim();
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
    },
  };
}

/** A boolean field, edited through true/false draft text; an empty draft inherits. */
export function booleanField(path: readonly string[]): CardFieldSpec {
  return {
    path,
    format: (value) => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === '') return { kind: 'clear' };
      if (trimmed === 'true') return { kind: 'set', value: true };
      if (trimmed === 'false') return { kind: 'set', value: false };
      return undefined;
    },
  };
}

/** A fixed-vocabulary field, edited through one of its value drafts; an empty draft inherits. */
export function selectField(path: readonly string[], options: readonly string[]): CardFieldSpec {
  return {
    path,
    format: (value) => (typeof value === 'string' && options.includes(value) ? value : ''),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === '') return { kind: 'clear' };
      return options.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined;
    },
  };
}

/** One field's staged edit. */
interface StagedEdit {
  /** Draft text the control renders. */
  text: string;
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean;
}

/**
 * Stages one card's edits over one (possibly nested) settings namespace and
 * writes them on save, one path op per field.
 *
 * The Host is the only authority on whether a value was accepted, so the
 * outcome is read back from the section rather than predicted here. A save
 * that did not land keeps its drafts, so the user can correct them instead of
 * retyping.
 */
export class CardForm<T> {
  private readonly specs: Map<string, CardFieldSpec>;
  private readonly staged = new Map<string, StagedEdit>();
  private readonly listeners = new Set<() => void>();
  private saving = false;
  private failed = false;

  /**
   * @param scope - the bound settings scope for this card's namespace.
   * @param ns - the settings namespace (must match `scope`).
   * @param api - the connection api face used for path mutations.
   * @param specs - the section fields this card edits.
   */
  constructor(
    private readonly scope: SettingsScope<T>,
    private readonly ns: string,
    private readonly api: SettingsApi,
    specs: CardFieldSpec[],
  ) {
    this.specs = new Map(specs.map((spec) => [keyOf(spec.path), spec]));
    this.scope.subscribe(() => this.publish());
  }

  /** Publish a projection of this form, rebuilt whenever the scope or a draft changes. */
  bind<S>(project: () => S, createStore: (init: S) => SnapshotStore<S>): SnapshotStore<S> {
    const store = createStore(project());
    this.listeners.add(() => store.set(project()));
    return store;
  }

  /** Read the card-level state: what the Host serves, and what a save would do. */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot();
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.plan().length > 0,
      invalid: this.plan().some((item) => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    };
  }

  /** Read one field's state from the effective section and its staged draft. */
  field(key: string): CardFieldState {
    const spec = this.specOf(key);
    const staged = this.staged.get(key);
    if (staged === undefined) {
      return {
        text: spec.format(this.sectionValue(spec.path)),
        overridden: this.stored(spec.path),
        invalid: false,
      };
    }
    const write = staged.clear ? ({ kind: 'clear' } as const) : spec.parse(staged.text);
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    };
  }

  /** The actions the card's slot registration injects. */
  actions(): CardActions {
    return {
      edit: (key, text) => this.stage(key, { text, clear: false }),
      resetField: (key) => {
        const spec = this.specOf(key);
        this.stage(key, { text: spec.format(this.baseValue(spec.path)), clear: true });
      },
      save: () => void this.save(),
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return;
        this.staged.clear();
        this.failed = false;
        this.publish();
      },
    };
  }

  /**
   * Write every staged edit (one path op per field, one mutate call per field),
   * then re-seed from what the Host accepted.
   * @returns settlement after every write and the read-back.
   */
  async save(): Promise<void> {
    const plan = this.plan();
    const writes = plan.flatMap((item) => (item.run === undefined ? [] : [item.run]));
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
    // Snapshot the fields this save writes, so edits staged while it is in
    // flight survive: only the staged keys this save actually wrote are cleared.
    const fields = new Set(plan.map((item) => item.key));
    this.saving = true;
    this.failed = false;
    this.publish();
    let landed = true;
    for (const write of writes) {
      landed = (await write()) && landed;
    }
    if (landed) {
      for (const field of fields) this.staged.delete(field);
    }
    this.saving = false;
    this.failed = !landed;
    this.publish();
  }

  /**
   * Every staged edit a save would write. An entry whose draft is not a value
   * its field accepts carries no write: the form is still dirty, and the save
   * refuses rather than dropping the edit. A staged edit that matches the
   * effective section is not a write at all.
   */
  private plan(): { key: string; run: (() => Promise<boolean>) | undefined }[] {
    const plan: { key: string; run: (() => Promise<boolean>) | undefined }[] = [];
    for (const [key, staged] of this.staged) {
      const spec = this.specOf(key);
      if (staged.clear) {
        if (this.stored(spec.path)) plan.push({ key, run: () => this.clear(spec.path) });
        continue;
      }
      if (staged.text === spec.format(this.sectionValue(spec.path))) continue;
      const write = spec.parse(staged.text);
      if (write === undefined) plan.push({ key, run: undefined });
      else if (write.kind === 'clear') plan.push({ key, run: () => this.clear(spec.path) });
      else plan.push({ key, run: () => this.store(spec.path, write.value) });
    }
    return plan;
  }

  private async clear(path: readonly string[]): Promise<boolean> {
    await this.mutate({ op: 'unset', path });
    return !this.pathInUser(path);
  }

  private async store(path: readonly string[], value: unknown): Promise<boolean> {
    await this.mutate({ op: 'set', path, value });
    const user = this.scope.getSnapshot().user;
    return pathHas(user, path) && pathValue(user, path) === value;
  }

  private async mutate(op: { op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] }): Promise<void> {
    const revision = this.scope.getSnapshot().revision;
    await this.api.settings.mutate({
      ns: this.ns,
      ops: [
        op.op === 'set'
          ? { op: 'set' as const, path: [...op.path], value: op.value }
          : { op: 'unset' as const, path: [...op.path] },
      ],
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }

  private stage(key: string, edit: StagedEdit): void {
    this.specOf(key); // unknown keys are a programming error; fail loudly
    this.staged.set(key, edit);
    this.failed = false;
    this.publish();
  }

  private specOf(key: string): CardFieldSpec {
    const spec = this.specs.get(key);
    if (spec === undefined) throw new Error(`settings card has no field ${key}`);
    return spec;
  }

  private sectionValue(path: readonly string[]): unknown {
    return pathValue(this.scope.getSnapshot().value, path);
  }

  private baseValue(path: readonly string[]): unknown {
    return pathValue(this.scope.getSnapshot().base, path);
  }

  private pathInUser(path: readonly string[]): boolean {
    return pathHas(this.scope.getSnapshot().user, path);
  }

  private stored(path: readonly string[]): boolean {
    return this.pathInUser(path);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
