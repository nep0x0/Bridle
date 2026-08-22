/**
 * bridle kernel — Context.
 *
 * A Context is a repository of services and a bus for typed events.
 * Registrations are reversible effects: everything a plugin installs
 * during setup is tagged with the plugin's name and unwound on unmount.
 *
 * Clean-room implementation of the cordis-style paradigm (context,
 * service injection, typed events with emit/waterfall/parallel/serial
 * dispatch, reversible effects). No third-party plugin framework code.
 */

import type {
  Disposable,
  ServiceMap,
} from "./types.ts";

/** Thrown by `requireService` when a required key is never provided. */
export class MissingServiceError extends Error {
  constructor(public readonly key: string) {
    super(`required service "${key}" is not provided`);
    this.name = "MissingServiceError";
  }
}

interface EffectRecord {
  owner: string;
  dispose: Disposable;
}

interface ListenerRecord {
  owner: string;
  fn: (...args: never[]) => unknown;
}

/** A plugin is a named unit that mounts into a Context. It may declare
 *  service requirements; the context resolves them before setup runs. */
export interface PluginDef {
  /** Unique owner tag — every registration made during setup is tagged
   *  with it and unwound on unmount. */
  name: string;
  /** Service keys this plugin needs before setup runs. */
  requires?: readonly string[];
  setup(ctx: PluginContext): void | Promise<void>;
}

/** What a plugin's setup receives: the shared context surface plus
 *  owner-tagged registration helpers. */
export interface PluginContext {
  provide<K extends keyof ServiceMap & string>(
    key: K,
    value: ServiceMap[K],
  ): void;
  peek<K extends keyof ServiceMap & string>(key: K): ServiceMap[K] | undefined;
  service<K extends keyof ServiceMap & string>(key: K): Promise<ServiceMap[K]>;
  requireService<K extends keyof ServiceMap & string>(
    key: K,
  ): ServiceMap[K];
  emit<A extends unknown[]>(event: string, ...args: A): void;
  waterfall<V>(event: string, initial: V, ...rest: unknown[]): V;
  parallel<A extends unknown[]>(event: string, ...args: A): Promise<void>;
  serial<R, A extends unknown[]>(event: string, ...args: A): Promise<R[]>;
  effect(dispose: Disposable): Disposable;
  on(event: string, fn: (...args: never[]) => unknown): Disposable;
  mount(plugin: PluginDef): Promise<void>;
}

export class Context {
  #services = new Map<string, unknown>();
  #waiters = new Map<string, Array<(v: unknown) => void>>();
  #effects: EffectRecord[] = [];
  #listeners = new Map<string, Set<ListenerRecord>>();
  /** Plugins currently mounted, in mount order. */
  readonly mounted = new Set<string>();

  // ── services ─────────────────────────────────────────────────────────

  provide<K extends keyof ServiceMap & string>(key: K, value: ServiceMap[K]): void {
    if (this.#services.has(key)) {
      throw new Error(`service "${key}" is already provided`);
    }
    this.#services.set(key, value);
    const waiters = this.#waiters.get(key);
    if (waiters) {
      this.#waiters.delete(key);
      for (const wake of waiters) wake(value);
    }
  }

  peek<K extends keyof ServiceMap & string>(key: K): ServiceMap[K] | undefined {
    return this.#services.get(key) as ServiceMap[K] | undefined;
  }

  service<K extends keyof ServiceMap & string>(key: K): Promise<ServiceMap[K]> {
    const existing = this.peek(key);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<ServiceMap[K]>((resolve) => {
      let list = this.#waiters.get(key);
      if (!list) {
        list = [];
        this.#waiters.set(key, list);
      }
      list.push(resolve as (v: unknown) => void);
    });
  }

  requireService<K extends keyof ServiceMap & string>(key: K): ServiceMap[K] {
    const value = this.peek(key);
    if (value === undefined) throw new MissingServiceError(key);
    return value;
  }

  // ── effects (root forms: untagged, refused) ──────────────────────────

  effect(_dispose: Disposable): Disposable {
    throw new Error(
      "ctx.effect() is only available on a plugin's scoped context — use mount()",
    );
  }

  on(_event: string, _fn: (...args: never[]) => unknown): Disposable {
    throw new Error(
      "ctx.on() is only available on a plugin's scoped context — use mount()",
    );
  }

  /** Register an effect attributed to `owner`. Disposers unwind LIFO per
   *  owner on unmount. */
  taggedEffect(owner: string, dispose: Disposable): Disposable {
    const record: EffectRecord = { owner, dispose };
    this.#effects.push(record);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const i = this.#effects.indexOf(record);
      if (i >= 0) this.#effects.splice(i, 1);
      dispose();
    };
  }

  /** Register an event listener as an effect owned by `owner`. */
  taggedOn(owner: string, event: string, fn: (...args: never[]) => unknown): Disposable {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const record: ListenerRecord = { owner, fn };
    set.add(record);
    return this.taggedEffect(owner, () => {
      set!.delete(record);
      if (set!.size === 0) this.#listeners.delete(event);
    });
  }

  /** Unmount a plugin: unwind its effects (LIFO), drop its listeners.
   *  Returns the number of effects disposed. */
  unmount(name: string): number {
    if (!this.mounted.has(name)) return 0;
    let n = 0;
    for (let i = this.#effects.length - 1; i >= 0; i--) {
      const rec = this.#effects[i]!;
      if (rec.owner !== name) continue;
      this.#effects.splice(i, 1);
      try {
        rec.dispose();
      } catch {
        // teardown must never break teardown
      }
      n++;
    }
    for (const set of this.#listeners.values()) {
      for (const rec of [...set]) {
        if (rec.owner === name) set.delete(rec);
      }
    }
    this.mounted.delete(name);
    return n;
  }

  /** Live effect count for a plugin (test/debug helper). */
  effectCount(owner?: string): number {
    if (owner === undefined) return this.#effects.length;
    return this.#effects.filter((r) => r.owner === owner).length;
  }

  // ── mounting ─────────────────────────────────────────────────────────

  async mount(plugin: PluginDef): Promise<void> {
    if (this.mounted.has(plugin.name)) {
      throw new Error(`plugin "${plugin.name}" is already mounted`);
    }
    for (const key of plugin.requires ?? []) {
      await this.service(key);
    }
    this.mounted.add(plugin.name);

    const scope: PluginContext = {
      provide: (key, value) => this.provide(key, value),
      peek: (key) => this.peek(key),
      service: (key) => this.service(key),
      requireService: (key) => this.requireService(key),
      emit: (event, ...args) => this.emit(event, ...args),
      waterfall: (event, initial, ...rest) =>
        this.waterfall(event, initial, ...rest),
      parallel: (event, ...args) => this.parallel(event, ...args),
      serial: (event, ...args) => this.serial(event, ...args),
      mount: (child) => this.mount(child),
      effect: (dispose) => this.taggedEffect(plugin.name, dispose),
      on: (event, fn) => this.taggedOn(plugin.name, event, fn),
    };

    try {
      await plugin.setup(scope);
    } catch (err) {
      // Failed setup must leave no residue.
      this.unmount(plugin.name);
      throw err;
    }
  }

  // ── events ───────────────────────────────────────────────────────────

  /** Fire-and-forget notification. Listeners observe in registration order. */
  emit<A extends unknown[]>(event: string, ...args: A): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const rec of [...set]) (rec.fn as (...a: A) => void)(...args);
  }

  /** Around-middleware. Each listener receives `(value, next)`; calling
   *  `next(v?)` delegates to the rest of the chain, returning without
   *  `next()` short-circuits. Returns the final value. */
  waterfall<V>(event: string, initial: V, ..._rest: unknown[]): V {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return initial;
    const chain = [...set];
    let index = -1;
    let current = initial;
    const run = (i: number): V => {
      if (i <= index) throw new Error("waterfall listener called next() twice");
      index = i;
      if (i >= chain.length) return current;
      const rec = chain[i]!;
      let delegated = false;
      const returned = (rec.fn as unknown as (v: V, next: (v?: V) => V) => V)(
        current,
        (v?: V) => {
          delegated = true;
          if (v !== undefined) current = v;
          return run(i + 1);
        },
      );
      return delegated ? ((returned as V) ?? current) : ((returned as V) ?? current);
    };
    return run(0);
  }

  /** Run all listeners concurrently; resolves when every one settles. */
  async parallel<A extends unknown[]>(event: string, ...args: A): Promise<void> {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return;
    await Promise.all(
      [...set].map((rec) => Promise.resolve((rec.fn as (...a: A) => unknown)(...args))),
    );
  }

  /** Run listeners sequentially in registration order, collecting results. */
  async serial<R, A extends unknown[]>(
    event: string,
    ...args: A
  ): Promise<R[]> {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return [];
    const out: R[] = [];
    for (const rec of [...set]) {
      out.push(await (rec.fn as unknown as (...a: A) => R)(...args));
    }
    return out;
  }

  /** Listener count for an event (test/debug helper). */
  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}
