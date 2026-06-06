import { afterEach, describe, expect, test } from 'bun:test'

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

  test('remote event logging can be enabled by RAYU_EVENT_LOGGING_URL', async () => {
    delete process.env.NODE_ENV
    process.env.RAYU_EVENT_LOGGING_URL = 'https://events.example.com'
    process.env.RAYU_TELEMETRY = '1'

    const { is1PEventLoggingEnabled } = await import(
      '../src/services/analytics/firstPartyEventLogger.ts'
    )

    expect(is1PEventLoggingEnabled()).toBe(true)
  })
})
