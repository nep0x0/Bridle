/**
 * bridle kernel — types.
 */

export type Disposable = () => void;

/** Service key map — extend via declaration merging:
 *
 *  declare module '@bridle/kernel' {
 *    interface ServiceMap { tools: ToolsApi }
 *  }
 */
export interface ServiceMap {
  [key: string]: unknown;
}

/** Event payload map — extend via declaration merging:
 *
 *  declare module '@bridle/kernel' {
 *    interface EventMap {
 *      'tools/pre-execute': WaterfallEvent<ToolRequest>;
 *      'session/appended': { id: number };
 *    }
 *  }
 */
export interface EventMap {
  [event: string]: unknown;
}

export type EventName<K extends EventMap> = Extract<keyof K, string>;

/** Marker helper for declaring waterfall events in the EventMap. */
export interface WaterfallEvent<V> {
  readonly __waterfall: V;
}

/** A waterfall listener wraps a value: call next() to delegate (possibly
 *  after mutating), or return without calling next() to short-circuit. */
export type WaterfallListener<V> = (
  value: V,
  next: (v?: V) => V,
) => V;

export type EmitListener<A extends unknown[]> = (...args: A) => void;

export type SerialListener<A extends unknown[], R> = (
  ...args: A
) => R | Promise<R>;
