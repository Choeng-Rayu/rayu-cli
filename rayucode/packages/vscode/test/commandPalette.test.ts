/**
 * Slash-command palette — UI_PARITY.md flow 10.
 *
 * The property that matters: every entry comes from what the ENGINE announced.
 * The extension used to hardcode four commands (`explain`, `fix`, `review`,
 * `test`) of which only `review` existed among the engine's 98, so the palette is
 * driven by `commandCatalog` (from the `initialize` response) with `slashCommands`
 * (from `system/init`) as the fallback for names that arrive first.
 *
 * Dispatch needs no protocol request: `/name args` as prompt text is how the CLI
 * REPL invokes both commands and skills.
 */
import { describe, expect, it } from "vitest";

import {
  PALETTE_LIMIT,
  matchSlashCommands,
  type PaletteCommand,
} from "../src/webview/commandPalette.js";

const catalog: PaletteCommand[] = [
  { name: "cost", description: "Show token cost", argumentHint: "" },
  { name: "commit", description: "Commit changes", argumentHint: "<message>" },
  { name: "compact", description: "Compact the conversation", argumentHint: "" },
  { name: "clear", description: "Start a new session", argumentHint: "" },
  { name: "model", description: "Pick a model", argumentHint: "" },
];

describe("the palette only appears when a command is being chosen", () => {
  it("is hidden without a leading slash", () => {
    expect(matchSlashCommands("cost", catalog, [])).toEqual([]);
    expect(matchSlashCommands("", catalog, [])).toEqual([]);
    expect(matchSlashCommands("fix this /cost", catalog, [])).toEqual([]);
  });

  it("shows everything for a bare slash", () => {
    expect(matchSlashCommands("/", catalog, []).map((c) => c.name)).toEqual([
      "cost",
      "commit",
      "compact",
      "clear",
      "model",
    ]);
  });

  it("hides once whitespace is typed, because an argument is being written", () => {
    // `/commit fix the parser` is a command with an argument, not a search.
    expect(matchSlashCommands("/commit ", catalog, [])).toEqual([]);
    expect(matchSlashCommands("/commit fix the parser", catalog, [])).toEqual([]);
  });
});

describe("matching", () => {
  it("filters by prefix", () => {
    expect(matchSlashCommands("/co", catalog, []).map((c) => c.name)).toEqual([
      "cost",
      "commit",
      "compact",
    ]);
  });

  it("is case-insensitive", () => {
    expect(matchSlashCommands("/CO", catalog, []).map((c) => c.name)).toEqual([
      "cost",
      "commit",
      "compact",
    ]);
  });

  it("matches a prefix, not a substring", () => {
    // `omm` appears inside `commit`; offering it would make the list feel random.
    expect(matchSlashCommands("/omm", catalog, [])).toEqual([]);
  });

  it("returns an exact match", () => {
    expect(matchSlashCommands("/model", catalog, []).map((c) => c.name)).toEqual([
      "model",
    ]);
  });

  it("returns nothing for an unknown command", () => {
    expect(matchSlashCommands("/notacommand", catalog, [])).toEqual([]);
  });

  it("caps the list so a 98-command engine cannot fill the panel", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `cmd${i}`,
      description: "",
      argumentHint: "",
    }));
    expect(matchSlashCommands("/cmd", many, [])).toHaveLength(PALETTE_LIMIT);
  });

  it("carries the description and argument hint through", () => {
    const [commit] = matchSlashCommands("/commit", catalog, []);
    expect(commit).toEqual({
      name: "commit",
      description: "Commit changes",
      argumentHint: "<message>",
    });
  });
});

describe("the name-only fallback", () => {
  it("is used before the catalog arrives", () => {
    // system/init announces names with the handshake; the catalog needs an
    // initialize round-trip. Showing names immediately beats showing nothing.
    expect(matchSlashCommands("/co", [], ["cost", "commit", "model"])).toEqual([
      { name: "cost", description: "", argumentHint: "" },
      { name: "commit", description: "", argumentHint: "" },
    ]);
  });

  it("is ignored once the catalog is present", () => {
    // The catalog is strictly richer; mixing the two would show duplicates.
    const out = matchSlashCommands("/cost", catalog, ["cost", "somethingElse"]);
    expect(out).toEqual([
      { name: "cost", description: "Show token cost", argumentHint: "" },
    ]);
  });

  it("yields nothing when the engine announced nothing", () => {
    // Before the handshake there is no palette — and critically, no invented
    // commands to fall back on.
    expect(matchSlashCommands("/", [], [])).toEqual([]);
  });
});
