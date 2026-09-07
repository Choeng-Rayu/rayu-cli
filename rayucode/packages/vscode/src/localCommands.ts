/**
 * Slash commands the EXTENSION serves itself.
 *
 * WHY THIS IS NECESSARY, NOT A SHORTCUT
 * `rayu/src/main.tsx:2555` filters the command registry for headless mode:
 *
 *     commands.filter(c => c.type === 'prompt' && !c.disableNonInteractive
 *                       || c.type === 'local' && c.supportsNonInteractive)
 *
 * Every `local-jsx` command is excluded, because a `local-jsx` command renders an
 * Ink dialog and there is no terminal to render it into. That is most of the
 * commands a user actually reaches for: `/login`, `/model`, `/permissions`,
 * `/plan`, `/mcp`, `/connect`, `/config`, `/diff`, `/resume`, `/agents`, `/help`.
 * The engine announces 37 commands out of 98 for exactly this reason.
 *
 * So sending `/login` to the engine did nothing — the command was not in its
 * registry, the text went nowhere, and the turn returned `result/success` with no
 * output. That is precisely what "the command is not working at all" looked like.
 *
 * The fix is not to force Ink into a webview. It is that a `local-jsx` command IS
 * a dialog, and providing the dialog is the extension's job. Each entry below maps
 * a command to the panel affordance that already implements it.
 *
 * Anything NOT listed here is forwarded to the engine unchanged, so the 37 real
 * headless commands and every skill keep working as prompt text.
 */

/** What the host should do for an intercepted command. */
export type LocalCommandAction =
  | { kind: "signIn" }
  | { kind: "openModelList" }
  | { kind: "setPermissionMode"; mode: string }
  | { kind: "newSession" }
  | { kind: "showMcp" }
  | { kind: "notice"; message: string };

/**
 * The commands the panel serves locally.
 *
 * Keyed without the leading slash. Kept small on purpose: a command belongs here
 * only when the extension genuinely implements it, because a wrong entry silently
 * shadows an engine command that would otherwise work.
 */
const LOCAL_COMMANDS: Record<string, LocalCommandAction> = {
  // Auth. The engine cannot run this headlessly at all, and the extension has a
  // full deep-link flow.
  login: { kind: "signIn" },

  // Model selection — the panel has a picker fed by the engine's model list.
  model: { kind: "openModelList" },

  // Permission modes. These map onto the engine's real modes, set through the
  // control protocol rather than by running the command.
  plan: { kind: "setPermissionMode", mode: "plan" },
  permissions: { kind: "setPermissionMode", mode: "default" },
  normal: { kind: "setPermissionMode", mode: "default" },

  // MCP management lives in the panel header.
  mcp: { kind: "showMcp" },

  // `/clear` is `local` with supportsNonInteractive:false — its own comment says
  // it "should just create a new session", which is what the panel does.
  clear: { kind: "newSession" },

  // Provider setup is not built yet (UI_PARITY flow 19). Saying so is better than
  // forwarding a command the engine will silently drop.
  connect: {
    kind: "notice",
    message:
      "Provider setup is not available in the panel yet. Run `rayu` in a terminal and use /connect, then reload the panel — the configuration is shared.",
  },

  // Reviewing pending file changes. Directs the user to the interactive File Changes card in the panel.
  review_detail: {
    kind: "notice",
    message:
      "Pending file changes are listed in the File Changes review card above. Click any file to compare its diff, or use Keep / Undo to accept or revert changes.",
  },
};

/**
 * Resolve a prompt to a local action, or null to forward it to the engine.
 *
 * Only an exact command with no arguments is intercepted. `/model sonnet` is a
 * request to switch directly and should reach whatever can honour it, rather than
 * being turned into "open the picker" and losing the argument.
 */
export function resolveLocalCommand(text: string): LocalCommandAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // An argument means the user asked for something more specific than the
  // dialog this would open.
  if (/\s/.test(trimmed)) return null;
  const name = trimmed.slice(1).toLowerCase();
  return LOCAL_COMMANDS[name] ?? null;
}

/** The command names the panel serves, for tests and for the palette to mark. */
export function locallyServedCommands(): string[] {
  return Object.keys(LOCAL_COMMANDS).sort();
}

/**
 * Whether text is a bare slash COMMAND rather than a prompt that happens to start
 * with a slash.
 *
 * This distinction is load-bearing. An absolute path is a perfectly ordinary thing
 * to type as a prompt — "/home/rayu/app/main.ts" — and it has no whitespace, so a
 * naive check would treat it as a command named `home/rayu/app/main.ts` and refuse
 * to send it. Command names are a single segment of word characters and dashes.
 */
export function isBareSlashCommand(text: string): boolean {
  return /^\/[a-z0-9][a-z0-9-]*$/i.test(text.trim());
}

/**
 * Decide whether a slash command will actually DO anything.
 *
 * Measured against the built host: the engine announces 37 of its 98 commands in
 * `system/init`, and a command outside that set is not in the headless registry —
 * it produces `result/success` with no output frames whatsoever. `/usage` and
 * `/context` are announced and return real text; `/version` and `/cost` are not
 * announced and return nothing at all. (`/cost` is hidden for subscribers, which is
 * why it drops out despite being `local` + `supportsNonInteractive`.)
 *
 * Silently succeeding while doing nothing is the worst possible outcome, and it is
 * what "the command is not working" looked like. So refuse, and say what is
 * available.
 *
 * Returns null when the command should be forwarded to the engine.
 */
export function unavailableCommandMessage(
  text: string,
  announced: readonly string[],
): string | null {
  if (!isBareSlashCommand(text)) return null;
  const name = text.trim().slice(1).toLowerCase();
  // Served by the panel itself.
  if (name in LOCAL_COMMANDS) return null;
  // Before `system/init` arrives, an empty list means "not known yet" rather than
  // "nothing is available" — refusing everything then would block real commands.
  if (announced.length === 0) return null;
  if (announced.some(candidate => candidate.toLowerCase() === name)) return null;

  const alternatives = [...announced].sort().slice(0, 12).join(", ");
  return (
    `/${name} is not available in the editor panel. ` +
    `Commands the engine can run here: ${alternatives}` +
    `${announced.length > 12 ? ", …" : ""}. ` +
    `The panel also handles: ${locallyServedCommands().map(c => "/" + c).join(", ")}.`
  );
}
