// Load a `.env` file from the extension directory and return the parsed
// key→value pairs. Used at activation to let developers point the bundled rayu
// engine at a local stack (RAYU_API_URL, RAYU_GATEWAY_URL, RAYU_WEB_URL) without
// touching shell profiles or VS Code launch.json.
//
// ── Rules ────────────────────────────────────────────────────────────────────
//   • Lines starting with `#` (ignoring leading whitespace) are comments.
//   • Blank lines are ignored.
//   • KEY=VALUE — the key is trimmed; the value is trimmed unless quoted.
//   • Quoted values: VALUE may be wrapped in single or double quotes; the quotes
//     are stripped and the inner text is used verbatim (no escape processing, no
//     newline expansion — keys in a .env file are a flat map, not a shell script).
//   • Lines without `=` are silently skipped.
//   • Duplicate keys: last definition wins.
//
// ── Security note ────────────────────────────────────────────────────────────
// The parsed values are merged into the child process environment ONLY — they
// never reach the network and they pass through the same Redactor that handles
// the rest of the agent's output. The `.env` file itself must never be packaged
// into the VSIX (.vscodeignore already excludes **/.env).

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Parse the content of a `.env` file into a key→value map.
 * Exported for unit testing.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    // Skip blank lines and comments.
    if (line.trim() === "" || /^\s*#/.test(line)) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    const rawValue = line.slice(eq + 1);
    result[key] = unquote(rawValue);
  }
  return result;
}

/**
 * Strip a matching pair of surrounding single or double quotes, then trim any
 * remaining whitespace. Unquoted values are simply trimmed.
 */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Load `<dir>/.env` and return the parsed entries.
 *
 * Returns an empty object when the file does not exist — absent `.env` is the
 * normal case for production installs and is not an error.
 *
 * @param dir  Directory to look in. Pass `context.extensionUri.fsPath` from
 *             the extension activation hook.
 */
export function loadDotEnv(dir: string): Record<string, string> {
  const envPath = path.join(dir, ".env");
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    // File absent or unreadable: not an error.
    return {};
  }
  return parseDotEnv(content);
}
