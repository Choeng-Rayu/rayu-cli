/**
 * Redacts credentials and other sensitive values from free-text before it is
 * logged, shared, or displayed. Pure and dependency-free.
 *
 * Extracted from the (removed) /feedback component so the shared redaction
 * logic remains available to callers such as the feedback survey's
 * transcript-share path. The /feedback command itself was moved to
 * un-use-code/ (it phoned home to Anthropic); this helper is provider-agnostic.
 */
export function redactSensitiveInfo(text: string): string {
  let redacted = text

  // Anthropic API keys (sk-ant...) with or without quotes
  redacted = redacted.replace(/"(sk-ant[^\s"']{24,})"/g, '"[REDACTED_API_KEY]"')
  redacted = redacted.replace(
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, string): no-match returns same string
    /(?<![A-Za-z0-9"'])(sk-ant-?[A-Za-z0-9_-]{10,})(?![A-Za-z0-9"'])/g,
    '[REDACTED_API_KEY]',
  )

  // AWS keys - AWSXXXX format
  redacted = redacted.replace(/AWS key: "(AWS[A-Z0-9]{20,})"/g, 'AWS key: "[REDACTED_AWS_KEY]"')
  // AWS AKIAXXX keys
  redacted = redacted.replace(/(AKIA[A-Z0-9]{16})/g, '[REDACTED_AWS_KEY]')

  // Google Cloud keys
  redacted = redacted.replace(
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    /(?<![A-Za-z0-9])(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_KEY]',
  )

  // Vertex AI service account keys
  redacted = redacted.replace(
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    /(?<![A-Za-z0-9])([a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com)(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_SERVICE_ACCOUNT]',
  )

  // Generic API keys in headers
  redacted = redacted.replace(/(["']?x-api-key["']?\s*[:=]\s*["']?)[^"',\s)}\]]+/gi, '$1[REDACTED_API_KEY]')

  // Authorization headers and Bearer tokens
  redacted = redacted.replace(/(["']?authorization["']?\s*[:=]\s*["']?(bearer\s+)?)[^"',\s)}\]]+/gi, '$1[REDACTED_TOKEN]')

  // AWS environment variables
  redacted = redacted.replace(/(AWS[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED_AWS_VALUE]')

  // GCP environment variables
  redacted = redacted.replace(/(GOOGLE[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED_GCP_VALUE]')

  // Environment variables with keys
  redacted = redacted.replace(/((API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED]')

  return redacted
}
