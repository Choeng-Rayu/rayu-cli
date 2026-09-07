/**
 * Commands the extension serves itself.
 *
 * WHY THIS EXISTS — the bug it fixes
 * `rayu/src/main.tsx:2555` filters the command registry for headless mode to
 * `prompt` commands plus `local` commands with `supportsNonInteractive`. Every
 * `local-jsx` command is excluded, because it renders an Ink dialog and there is
 * no terminal. Measured against the built host: the engine announces **37**
 * commands out of **98**, and the missing ones include `/login`, `/model`,
 * `/permissions`, `/plan`, `/mcp`, `/connect`, `/help`, `/config`, `/diff`,
 * `/resume` and `/agents`.
 *
 * So sending `/login` produced `result/success` with no output frames at all —
 * the command was not in the registry, and nothing reported that. From the panel
 * it looked like commands simply did not work, which is what was reported.
 *
 * The rule these tests pin: intercept ONLY what the extension genuinely
 * implements, and forward everything else unchanged. A wrong entry here silently
 * shadows an engine command that would otherwise work.
 */
import { describe, expect, it } from "vitest";

import {
  isBareSlashCommand,
  locallyServedCommands,
  resolveLocalCommand,
  unavailableCommandMessage,
} from "../src/localCommands.js";

describe("commands the engine cannot run headlessly are served locally", () => {
  it("/login opens the extension's sign-in", () => {
    // The most severe case: the engine's /login is local-jsx, so it could never
    // run headlessly, and sign-in is the one thing a new user must do.
    expect(resolveLocalCommand("/login")).toEqual({ kind: "signIn" });
  });

  it("/model opens the picker", () => {
    expect(resolveLocalCommand("/model")).toEqual({ kind: "openModelList" });
  });

  it("/plan and /permissions map onto the engine's real modes", () => {
    // Set through the control protocol rather than by running the command, since
    // set_permission_mode IS available headlessly.
    expect(resolveLocalCommand("/plan")).toEqual({
      kind: "setPermissionMode",
      mode: "plan",
    });
    expect(resolveLocalCommand("/permissions")).toEqual({
      kind: "setPermissionMode",
      mode: "default",
    });
  });

  it("/clear starts a new session, as its own source comment intends", () => {
    // commands/clear/index.ts: supportsNonInteractive: false, "Should just create
    // a new session".
    expect(resolveLocalCommand("/clear")).toEqual({ kind: "newSession" });
  });

  it("/mcp refreshes the server row", () => {
    expect(resolveLocalCommand("/mcp")).toEqual({ kind: "showMcp" });
  });

  it("/connect explains itself instead of silently doing nothing", () => {
    // Provider setup is not built yet (UI_PARITY flow 19). Forwarding it would
    // reproduce the original bug: a command that appears to work and does not.
    const action = resolveLocalCommand("/connect");
    expect(action?.kind).toBe("notice");
    expect((action as { message: string }).message).toContain("terminal");
  });

  it("is case-insensitive", () => {
    expect(resolveLocalCommand("/LOGIN")).toEqual({ kind: "signIn" });
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveLocalCommand("  /login  ")).toEqual({ kind: "signIn" });
  });
});

describe("everything else is forwarded to the engine unchanged", () => {
  it("a plain prompt is not intercepted", () => {
    expect(resolveLocalCommand("fix the parser")).toBeNull();
    expect(resolveLocalCommand("")).toBeNull();
  });

  it("an engine command the host does not implement is forwarded", () => {
    // /cost, /usage, /compact and every skill are real headless commands. The
    // engine must keep receiving them.
    for (const command of ["/cost", "/usage", "/compact", "/review", "/init"]) {
      expect(resolveLocalCommand(command), command).toBeNull();
    }
  });

  it("a command WITH an argument is forwarded, not turned into a dialog", () => {
    // `/model sonnet` asks to switch directly. Opening the picker would discard
    // the argument and quietly do the wrong thing.
    expect(resolveLocalCommand("/model sonnet")).toBeNull();
    expect(resolveLocalCommand("/login extra")).toBeNull();
  });

  it("a slash inside a sentence is not a command", () => {
    expect(resolveLocalCommand("use the a/b test")).toBeNull();
  });
});

describe("the intercept list stays deliberately small", () => {
  it("covers only commands the extension actually implements", () => {
    expect(locallyServedCommands()).toEqual([
      "clear",
      "connect",
      "login",
      "mcp",
      "model",
      "normal",
      "permissions",
      "plan",
      "review_detail",
    ]);
  });

  it("does not shadow the headless commands the engine announces", () => {
    // A sample of the 37 the engine really serves. If one appeared here it would
    // stop reaching the engine, which is a regression disguised as a feature.
    const served = new Set(locallyServedCommands());
    for (const engineCommand of [
      "cost",
      "usage",
      "compact",
      "context",
      "review",
      "init",
      "agent",
      "logout",
      "insights",
    ]) {
      expect(served.has(engineCommand), `${engineCommand} must reach the engine`).toBe(
        false,
      );
    }
  });
});

describe("a command that would silently do nothing is refused instead", () => {
  /**
   * Measured against the built host: the engine announces 37 of 98 commands, and
   * anything outside that set returns `result/success` with NO output frames.
   * `/usage` and `/context` are announced and return real text; `/version` and
   * `/cost` are not and return nothing. Succeeding while doing nothing is the worst
   * outcome and is exactly what was reported as "commands don't work".
   */
  const ANNOUNCED = ["usage", "context", "compact", "init", "review"];

  it("refuses a command the engine does not announce", () => {
    const message = unavailableCommandMessage("/version", ANNOUNCED);
    expect(message).not.toBeNull();
    expect(message).toContain("not available");
    // and tells the user what IS available, rather than just failing
    expect(message).toContain("usage");
  });

  it("forwards a command the engine DOES announce", () => {
    for (const name of ANNOUNCED) {
      expect(unavailableCommandMessage(`/${name}`, ANNOUNCED), name).toBeNull();
    }
  });

  it("forwards a command the panel serves itself", () => {
    // These are intercepted earlier; they must not be reported as unavailable.
    for (const name of locallyServedCommands()) {
      expect(unavailableCommandMessage(`/${name}`, ANNOUNCED), name).toBeNull();
    }
  });

  it("mentions the panel-served commands too", () => {
    expect(unavailableCommandMessage("/version", ANNOUNCED)).toContain("/login");
  });

  it("stays silent before the catalog is known", () => {
    // An empty list means "not known yet", not "nothing is available". Refusing
    // everything during startup would block real commands.
    expect(unavailableCommandMessage("/usage", [])).toBeNull();
  });

  it("is case-insensitive about what is announced", () => {
    expect(unavailableCommandMessage("/USAGE", ANNOUNCED)).toBeNull();
  });

  it("leaves ordinary prompts alone", () => {
    expect(unavailableCommandMessage("fix the parser", ANNOUNCED)).toBeNull();
    expect(unavailableCommandMessage("/usage for last week", ANNOUNCED)).toBeNull();
  });
});

describe("an absolute path is not a command", () => {
  it("does not treat a file path as a slash command", () => {
    // "/home/rayu/app/main.ts" has no whitespace, so a naive check would call it a
    // command named `home/rayu/app/main.ts` and refuse to send a legitimate prompt.
    expect(isBareSlashCommand("/home/rayu/app/main.ts")).toBe(false);
    expect(unavailableCommandMessage("/home/rayu/app/main.ts", ["usage"])).toBeNull();
    expect(resolveLocalCommand("/home/rayu/app/main.ts")).toBeNull();
  });

  it("recognises a real command name", () => {
    expect(isBareSlashCommand("/login")).toBe(true);
    expect(isBareSlashCommand("/release-notes")).toBe(true);
    expect(isBareSlashCommand("/model2")).toBe(true);
  });

  it("rejects shapes that cannot be command names", () => {
    expect(isBareSlashCommand("/")).toBe(false);
    expect(isBareSlashCommand("/-leading-dash")).toBe(false);
    expect(isBareSlashCommand("/has.dot")).toBe(false);
    expect(isBareSlashCommand("not-a-command")).toBe(false);
  });
});
