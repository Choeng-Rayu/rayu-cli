import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const previousEnv = {
  nodeEnv: process.env.NODE_ENV,
  rayuEventLoggingUrl: process.env.RAYU_EVENT_LOGGING_URL,
  rayuTelemetry: process.env.RAYU_TELEMETRY,
}

afterEach(() => {
  if (previousEnv.nodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = previousEnv.nodeEnv
  }
  if (previousEnv.rayuEventLoggingUrl === undefined) {
    delete process.env.RAYU_EVENT_LOGGING_URL
  } else {
    process.env.RAYU_EVENT_LOGGING_URL = previousEnv.rayuEventLoggingUrl
  }
  if (previousEnv.rayuTelemetry === undefined) {
    delete process.env.RAYU_TELEMETRY
  } else {
    process.env.RAYU_TELEMETRY = previousEnv.rayuTelemetry
  }
})

describe('Rayu event logging endpoint', () => {
  test('remote event logging is disabled without a Rayu endpoint', async () => {
    delete process.env.NODE_ENV
    delete process.env.RAYU_EVENT_LOGGING_URL

    const { is1PEventLoggingEnabled } = await import(
      '../src/services/analytics/firstPartyEventLogger.ts'
    )

    expect(is1PEventLoggingEnabled()).toBe(false)
  })

  test('first-party event logging is permanently neutralized (cannot be re-enabled)', async () => {
    // De-risk: the 1P event logger was stubbed to a no-op and its network
    // exporter moved to un-use-code. Setting the old opt-in env vars must NOT
    // re-enable any telemetry egress.
    delete process.env.NODE_ENV
    process.env.RAYU_EVENT_LOGGING_URL = 'https://events.example.com'
    process.env.RAYU_TELEMETRY = '1'

    const {
      is1PEventLoggingEnabled,
      logEventTo1P,
      logGrowthBookExperimentTo1P,
      shutdown1PEventLogging,
      initialize1PEventLogging,
    } = await import('../src/services/analytics/firstPartyEventLogger.ts')

    expect(is1PEventLoggingEnabled()).toBe(false)
    // The no-op loggers/lifecycle must be safe to call.
    expect(() => logEventTo1P('tengu_test_event', { n: 1 })).not.toThrow()
    expect(() =>
      logGrowthBookExperimentTo1P({ experimentId: 'x', variationId: 0 }),
    ).not.toThrow()
    expect(() => initialize1PEventLogging()).not.toThrow()
    await shutdown1PEventLogging()
  })

  test('network exporter is removed from src and logger imports no OTEL/exporter', () => {
    const src = join(import.meta.dir, '..', 'src', 'services', 'analytics')
    // The HTTP exporter was moved to un-use-code (excluded from the build).
    expect(existsSync(join(src, 'firstPartyEventLoggingExporter.ts'))).toBe(false)
    const logger = readFileSync(join(src, 'firstPartyEventLogger.ts'), 'utf8')
    expect(logger).not.toMatch(/\bfrom\s+['"][^'"]*firstPartyEventLoggingExporter[^'"]*['"]/)
    expect(logger).not.toMatch(/\bfrom\s+['"]@opentelemetry\//)
  })
})
