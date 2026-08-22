/**
 * bridle session — the durable event log.
 *
 * Adopted invariant (dsh): **model-visible means logged.** Anything that
 * reaches a model request must be reconstructable from this log. The agent
 * loop derives model history exclusively through `derive()`, so there is no
 * side channel.
 *
 * The log is append-only. Forking copies the prefix into a fresh log;
 * replay projects messages deterministically from events alone.
 */

import type { PluginContext } from "@bridle/kernel";

export interface SessionEvent<P = unknown> {
  /** Monotonic 1-based sequence within this log. */
  readonly id: number;
  readonly type: string;
  readonly ts: number;
  readonly payload: P;
}

export type Projector<M> = (events: ReadonlyArray<SessionEvent>) => M[];

export class SessionLog {
  #events: SessionEvent[] = [];
  #nextId = 1;

  constructor(
    /** Emits `session/appended` with the appended event (kernel event bus). */
    private readonly notify?: (event: SessionEvent) => void,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Append one durable fact. Returns the stored event. */
  append<P>(type: string, payload: P): SessionEvent<P> {
    const ev: SessionEvent<P> = {
      id: this.#nextId++,
      type,
      ts: this.clock(),
      payload,
    };
    this.#events.push(ev as SessionEvent);
    this.notify?.(ev as SessionEvent);
    return ev;
  }

  /** Defensive copy: callers cannot mutate the durable log. */
  all(): ReadonlyArray<SessionEvent> {
    return [...this.#events];
  }

  since(id: number): ReadonlyArray<SessionEvent> {
    return this.#events.filter((e) => e.id > id);
  }

  lastId(): number {
    return this.#nextId - 1;
  }

  /** Project durable events into model-visible messages. This is the ONLY
   *  sanctioned way to build model history. */
  derive<M>(project: Projector<M>): M[] {
    return project(this.#events);
  }

  /** Copy events up to `boundaryId` (default: all) into a fresh log that
   *  shares nothing mutable with this one. */
  fork(notify?: (event: SessionEvent) => void, boundaryId?: number): SessionLog {
    const child = new SessionLog(notify, this.clock);
    for (const e of this.#events) {
      if (boundaryId !== undefined && e.id > boundaryId) break;
      child.#events.push(e);
      child.#nextId = e.id + 1;
    }
    return child;
  }
}

/** Convenience projector: keep only events whose type passes `keep`,
 *  mapping each to a message shape. */
export function makeProjector<M>(
  keep: (type: string) => boolean,
  map: (e: SessionEvent) => M,
): Projector<M> {
  return (events) => events.filter((e) => keep(e.type)).map(map);
}

/** bridle plugin: provides the "sessions" service and mirrors every
 *  appended event onto the kernel bus as `session/appended`. */
export async function sessionPlugin(ctx: PluginContext): Promise<void> {
  const log = new SessionLog((ev) =>
    ctx.emit("session/appended", { id: ev.id, type: ev.type }),
  );
  ctx.provide("sessions", log);
}
