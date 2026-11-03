/**
 * Stable machine identity for the `cli_hello` handshake.
 *
 * The backend keys a Web Bridge session row on `(userId, machineId)`, so this value
 * decides whether reconnecting looks like the SAME machine coming back or a new one
 * appearing. Getting that wrong is not cosmetic: a value that changes per process
 * would fill the studio's session picker with a fresh dead entry every time the user
 * restarted the CLI, and the picker would become unusable within a day.
 *
 * So the id is persisted, and deliberately NOT derived from anything that can change
 * under a machine's feet:
 *
 *  • not the hostname — laptops are renamed, and DHCP changes it on some networks;
 *  • not a MAC address — docking, VPNs and container runtimes all add and remove
 *    interfaces, and it is a real hardware identifier being sent to a server;
 *  • not the pid or cwd — those are per-process and per-invocation by definition.
 *
 * It is a random value written once. That makes it an opaque per-install handle
 * rather than a fingerprint, which is also the privacy-preferable answer: it tells
 * the backend "the same install as before" without telling it anything about the
 * hardware.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  MAX_HOSTNAME_CHARS,
  clampId,
  isValidMachineId,
} from "./protocol.js";

/** Filename the backend's own comment names: `~/.rayu/web-bridge.json`. */
export const WEB_BRIDGE_STATE_FILE = "web-bridge.json";

/** Shape of the persisted state file. */
export interface WebBridgeState {
  machineId: string;
}

/** Default directory: `~/.rayu`. Callers with their own config root pass it in. */
export function defaultStateDir(): string {
  return join(homedir(), ".rayu");
}

/**
 * Generate a fresh machine id.
 *
 * 24 hex characters from 12 random bytes: comfortably inside the backend's 6–64
 * character window, and 96 bits of entropy so two installs colliding is not a case
 * that needs handling. Hex rather than base64url because the charset is then a
 * strict subset of the backend's pattern with no escaping to think about.
 */
export function generateMachineId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Read the persisted machine id, creating and storing one on first use.
 *
 * Every failure path falls back to an EPHEMERAL id rather than throwing. A CLI that
 * refuses to start because it could not write a cache file would be trading a
 * cosmetic problem (a duplicate row in the session picker) for a fatal one, and the
 * bridge is an optional feature — it must never be able to break the REPL.
 *
 * `mode: 0o600` matches how the Telegram bridge stores its own state: the file is
 * not a secret, but it is an account-linked identifier and there is no reason for
 * other users on the machine to read it.
 */
export function resolveMachineId(stateDir: string = defaultStateDir()): string {
  const path = join(stateDir, WEB_BRIDGE_STATE_FILE);

  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WebBridgeState>;
      // Validate rather than trust: a hand-edited or half-written file would
      // otherwise fail much later, as a rejected handshake with no explanation.
      if (typeof parsed.machineId === "string" && isValidMachineId(parsed.machineId)) {
        return parsed.machineId;
      }
    }
  } catch {
    // Unreadable or malformed — fall through and rewrite it.
  }

  const machineId = generateMachineId();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ machineId }, null, 2), { mode: 0o600 });
  } catch {
    // Read-only home, or no home at all (some CI and container images). The id is
    // still returned so the session works; it just will not be stable across runs.
  }
  return machineId;
}

/**
 * The hostname to announce, clamped to the backend's column width.
 *
 * Falls back to a literal when the OS cannot answer, which happens in stripped
 * containers. An empty hostname would fail `cli_hello` validation and take the whole
 * bridge down over a display string.
 */
export function resolveHostname(): string {
  let name = "";
  try {
    name = hostname();
  } catch {
    name = "";
  }
  return clampId(name || "unknown-host", MAX_HOSTNAME_CHARS);
}
