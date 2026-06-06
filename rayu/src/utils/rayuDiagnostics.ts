// Rayu diagnostics: a lightweight, structured audit trail for bugs, issues, and
// potential vulnerabilities surfaced at runtime or during tests. Records are
// appended as JSONL to ~/.rayu/diagnostics.jsonl and (in debug/test mode) echoed
// to stderr, so problems can be reviewed and fixed in a later pass.
//
// SECURITY: never pass secrets (API keys, tokens) into `detail`/`context`.
// Callers reference providers by id, not by key value.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getRayuConfigHomeDir } from './envUtils.js'

export type DiagnosticKind = 'bug' | 'issue' | 'vulnerability'
export type DiagnosticSeverity = 'low' | 'medium' | 'high' | 'critical'

export type DiagnosticRecord = {
  ts: string
  kind: DiagnosticKind
  severity: DiagnosticSeverity
  /** Stable code, e.g. 'openai_adapter.tool_call_parse_failed'. */
  code: string
  message: string
  /** Structured, non-secret context. */
  context?: Record<string, unknown>
}

const FILE_NAME = 'diagnostics.jsonl'

function diagnosticsPath(): string {
  return join(getRayuConfigHomeDir(), FILE_NAME)
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === 'test' || !!process.env.BUN_TEST
}

function shouldEcho(): boolean {
  // Echo to stderr when explicitly debugging diagnostics, in debug mode, or in tests.
  return (
    isTestEnv() ||
    process.env.RAYU_DIAGNOSTICS === '1' ||
    !!process.env.DEBUG
  )
}

/**
 * Record a diagnostic. Best-effort and never throws — diagnostics must not
 * become a new failure source.
 */
export function recordDiagnostic(
  kind: DiagnosticKind,
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  const record: DiagnosticRecord = {
    ts: new Date().toISOString(),
    kind,
    severity,
    code,
    message,
    ...(context ? { context } : {}),
  }
  if (shouldEcho()) {
    // biome-ignore lint/suspicious/noConsole: intentional diagnostic output
    console.error(`[rayu:${kind}:${severity}] ${code} — ${message}`, context ?? '')
  }
  // Opt-out of file persistence (e.g. tests that don't want disk writes).
  if (process.env.RAYU_DIAGNOSTICS_NO_FILE === '1') return
  try {
    const dir = getRayuConfigHomeDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(diagnosticsPath(), JSON.stringify(record) + '\n')
  } catch {
    // Best-effort: swallow file errors so diagnostics never break the app.
  }
}

/** Convenience helpers. */
export const reportBug = (
  code: string,
  message: string,
  context?: Record<string, unknown>,
  severity: DiagnosticSeverity = 'medium',
): void => recordDiagnostic('bug', severity, code, message, context)

export const reportIssue = (
  code: string,
  message: string,
  context?: Record<string, unknown>,
  severity: DiagnosticSeverity = 'low',
): void => recordDiagnostic('issue', severity, code, message, context)

export const reportVulnerability = (
  code: string,
  message: string,
  context?: Record<string, unknown>,
  severity: DiagnosticSeverity = 'high',
): void => recordDiagnostic('vulnerability', severity, code, message, context)

/** Read back recorded diagnostics (used by tests and a future `rayu doctor`). */
export function readDiagnostics(): DiagnosticRecord[] {
  const path = diagnosticsPath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as DiagnosticRecord]
      } catch {
        return []
      }
    })
}
