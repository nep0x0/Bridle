/**
 * bridle kernel — entry point.
 *
 * Extend `ServiceMap` and `EventMap` via declaration merging to give your
 * harness's seams typed keys:
 *
 *   declare module '@bridle/kernel' {
 *     interface ServiceMap { tools: ToolsApi; llm: LlmApi }
 *     interface EventMap {
 *       'tools/pre-execute': WaterfallEvent<ToolRequest>;
 *     }
 *   }
 */

export {
  Context,
  MissingServiceError,
} from "./context.ts";
export type {
  PluginContext,
  PluginDef,
} from "./context.ts";
export type {
  Disposable,
  EmitListener,
  EventMap,
  EventName,
  SerialListener,
  ServiceMap,
  WaterfallEvent,
  WaterfallListener,
} from "./types.ts";
