// ─────────────────────────────────────────────────────────────────────────────
// First-party event logger — NEUTRALIZED STUB (Rayu de-risk).
//
// Upstream, this module batched internal analytics events and shipped them over
// the network (OpenTelemetry BatchLogRecordProcessor →
// FirstPartyEventLoggingExporter → HTTP POST to /api/event_logging/batch) and
// logged GrowthBook experiment exposures. That is Anthropic telemetry egress
// and has no place in Rayu.
//
// This stub preserves the EXACT public API (every export + signature) so the
// callers (sink.ts, gracefulShutdown, Feedback, bridge, computerUse) keep
// compiling and behaving, but it:
//   • imports no OpenTelemetry SDK and no FirstPartyEventLoggingExporter,
//   • makes zero network calls, creates no LoggerProvider, batches nothing,
//   • drops every event on the floor (logEventTo1P / logGrowthBookExperimentTo1P
//     are no-ops), and reports logging as disabled.
//
// The original implementation is preserved for reference at
// un-use-code/services/analytics/firstPartyEventLogger.original.ts (excluded
// from the build). The network exporter it used was moved to
// un-use-code/services/analytics/firstPartyEventLoggingExporter.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { GrowthBookUserAttributes } from './growthbook.js'

/**
 * Configuration for sampling individual event types. Retained for type
 * compatibility; the stub never samples or logs.
 */
export type EventSamplingConfig = {
  [eventName: string]: {
    sample_rate: number
  }
}

/** No sampling config in the stub. */
export function getEventSamplingConfig(): EventSamplingConfig {
  return {}
}

/** Null = "log at 100%", but nothing is ever logged, so this is inert. */
export function shouldSampleEvent(_eventName: string): number | null {
  return null
}

/** No logger provider to flush/shutdown. */
export async function shutdown1PEventLogging(): Promise<void> {}

/** First-party event logging is permanently disabled in Rayu. */
export function is1PEventLoggingEnabled(): boolean {
  return false
}

/** No-op: events are never logged or transmitted. */
export function logEventTo1P(
  _eventName: string,
  _metadata: Record<string, number | boolean | undefined> = {},
): void {}

/** GrowthBook experiment event data (retained for type compatibility). */
export type GrowthBookExperimentData = {
  experimentId: string
  variationId: number
  userAttributes?: GrowthBookUserAttributes
  experimentMetadata?: Record<string, unknown>
}

/** No-op: experiment exposures are never logged or transmitted. */
export function logGrowthBookExperimentTo1P(
  _data: GrowthBookExperimentData,
): void {}

/** No-op: no event-logging pipeline is initialized. */
export function initialize1PEventLogging(): void {}

/** No-op: nothing to reinitialize. */
export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {}
