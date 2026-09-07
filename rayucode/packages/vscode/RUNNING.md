# Rayucode extension — running it in development

Scoped to the VS Code extension at `rayucode/packages/vscode`. Every command and
number here was run against this repository.

For **releasing** to the Marketplace, see [PUBLISHING.md](./PUBLISHING.md). This
document is about developing.

---

## TL;DR

```bash
# once
cd /home/rayu/rayu/rayu-cli
npm install
cd rayu && bun install && cd ..
npm run build                      # ~4 min: builds rayu, then the extension

# every time
code /home/rayu/rayu/rayu-cli/rayucode
# press F5 → "Run Rayucode Extension"
```

F5 opens a second VS Code window with the extension loaded. Open the Rayu icon in
its Activity Bar.

If something does not work, the two commands that answer most questions are
`npm run build` from the repo root, and reading the **Rayucode** output channel in
the second window.

---

## 1. What you are building

Five artifacts ship inside the VSIX. Knowing which is which explains every command
below:

| Artifact | Built from | Role |
|----------|-----------|------|
| `dist/extension.js` | `packages/vscode/src` (+ `@rayucode/core`) | extension host bundle (CJS) |
| `dist/webview.js` / `.css` | `packages/vscode/src/webview` | the Agent Panel front end (browser IIFE, React) |
| `dist/rayu-vscode-host.js` | **`rayu/src/entrypoints/vscodeHost.ts`** | the engine, spawned as a child process (~24 MB) |
| `dist/build-info.json` | generated at build | engine version + sha256 + `protocolVersion` |

### The engine is the extension's own binary

`dist/rayu-vscode-host.js` is **not** a copy of `rayu/dist/rayu.js`. It is a
separate bundle built from `rayu/src` by `rayu/scripts/build-vscode-host.ts`, with
its own entrypoint. `rayu/dist/rayu.js` belongs to the CLI and is never shipped in
the VSIX.

Both are built from the same source and delegate to the same `main()`, so they have
identical capabilities. The invariant `rayu/test/vscodeHost.test.ts` asserts is that
the CLI and the host report the **same inventory by name** when given the same input
and environment — not a fixed count. Counts move with what is installed: an isolated
config reports 56 tools / 37 commands / 16 skills, while a machine with one extra
skill in `~/.rayu/skills` reports 38 commands / 17 skills from the same binary. Tools
(56) are stable because they are compiled in.

What differs between the two binaries is the launch contract. The host entrypoint
owns its flags in `REQUIRED_FLAGS`:

```
--print --input-format=stream-json --output-format=stream-json --verbose
--permission-prompt-tool=stdio
```

That last flag is load-bearing. `getCanUseToolFn` in `rayu/src/cli/print.ts`
branches on it: `stdio` sends a `can_use_tool` control request to the extension,
while **undefined decides permissions locally**. Without it the engine silently
approves or denies on its own and no permission prompt ever reaches the panel.

### A second rayu artifact is imported, not shipped

`rayu/dist/rayu-lib.js` (~471 KB) is the shared library surface built from
`rayu/src/entrypoints/library.ts`. The extension imports it at build time so the
extension and the CLI run the same auth, endpoint, provider-config and session-file
code instead of two drifting copies. It is bundled **into** `dist/extension.js`.

**Consequence: the extension cannot be built before rayu is built.** It needs the
engine to spawn and the library to import.

---

## 2. First-time setup

```bash
cd /home/rayu/rayu/rayu-cli
npm install
cd rayu && bun install && cd ..
npm run build
```

**The `bun install` must come after `npm install`.** npm writes into
`rayu/node_modules`; `bun install` restores rayu's pinned tree. Reversed, rayu's
typecheck reports errors in files nobody touched. If you ever see that, run
`cd rayu && bun install`.

`npm run build` at the root does the whole chain in dependency order:

```
agent-protocol → rayu-core → web-bridge-client
  → rayu (rayu.js + rayu-lib.js + rayu-vscode-host.js)
  → @rayucode/core → the extension
```

Expect roughly 4 minutes. The 24 MB engine bundle dominates.

---

## 3. Run it

### F5 — the normal way

```bash
code /home/rayu/rayu/rayu-cli/rayucode
```

Two launch configurations exist:

| Configuration | preLaunchTask | Use when |
|---|---|---|
| **Run Rayucode Extension** | `npm: build` | normally — it rebuilds first |
| **Watch & Run Rayucode Extension** | *none* | you are iterating and already have watch running |

**"Watch & Run" does not build anything.** It launches whatever is currently in
`dist/`. Start the watcher yourself first (Terminal → Run Task → `npm: watch`), and
make sure a full `npm run build` has run at least once — otherwise it launches an
empty or stale `dist/`.

Also note `npm run watch` runs **only esbuild**, not `stage:engine`. It rebuilds
`extension.js` and `webview.js` on save but never re-stages the engine, which is
correct: the engine only changes when you rebuild `rayu`.

### As an installed extension

```bash
cd /home/rayu/rayu/rayu-cli/rayucode/packages/vscode
npm run package
code --install-extension rayucode-0.1.1.vsix
```

Reload the window afterwards. Useful for testing the real install path — notably
the `vscode://` sign-in deep link, which is routed by the **published extension
id** (`RayuCode.rayucode`) and so behaves differently from an
`--extensionDevelopmentPath` load.

### Then, in the editor

14 commands are contributed. The ones you need while developing:

| Command palette entry | What it does |
|---|---|
| `Rayucode: Open Agent Panel` | opens the Activity Bar panel |
| `Rayucode: Sign in to Rayu` | OAuth in the browser; writes `~/.rayu/rayu-auth.json` |
| `Rayucode: Add or switch AI provider (BYOK)` | provider setup; needed to see more than one model |
| `Rayucode: Start New Session` | fresh session — also restarts the engine |
| `Rayucode: Resume a previous session` | browse past transcripts |
| `Rayucode: Interrupt Current Turn` | stops the running turn |
| `@rayucode` in Chat | the chat participant |

Sign-in is shared with the CLI on purpose: one account, one machine, one token file
at `~/.rayu/rayu-auth.json` (mode `0600`). Signing in here signs in `rayu` in a
terminal too, and vice versa. There is deliberately no second credential store —
two would mean two refresh cycles racing to rotate the same refresh token.

---

## 4. The rebuild you need after each kind of edit

This is the part that wastes the most time when guessed at.

| You edited | Run |
|---|---|
| `packages/vscode/src` (host or webview) | `npm run build` in `packages/vscode`, or leave watch running |
| `packages/core/src` | **`npm run build:core` first**, then the extension |
| `rayu/src` | `cd rayu && bun run build:lib && bun run build:vscode-host`, then the extension |
| `packages/agent-protocol/src` | `npm run build` from the repo root — everything depends on it |
| anything, and you are unsure | `cd /home/rayu/rayu/rayu-cli && npm run build` |

### Two traps

**Editing `packages/core/src` without rebuilding core.** The extension typechecks
against core's *built* `.d.ts`. Add a new panel message and the vscode package will
report it as unknown until you run `npm run build:core`. The error names the message
type, which makes it look like a typo in your own code.

**Editing `rayu/src` and rebuilding only one artifact.** The engine and the library
are separate bundles from the same source. Rebuild only `build:vscode-host` and the
extension still imports the old library; rebuild only `build:lib` and the spawned
engine is stale. Both, or use the root build.

### Widening what the extension imports from `rayu/src`

Add the export to `rayu/src/entrypoints/library.ts`, then:

```bash
cd rayu && bun run build:lib && bun run boundary
```

The build **refuses** an export that reaches the Ink/React UI:

```
✗ dist/rayu-lib.js pulled in react/jsx-runtime.
```

That is not a limitation to route around — React cannot run in the extension host.
Find the offending edge with:

```bash
bun run scripts/analyze-boundary.ts --cut-candidates
```

Measured: `services/mcp/config.ts`, `utils/claudemd.ts`, `context.ts`, `commands.ts`
and `utils/path.ts` each cost ~20 MB and pull in React. Auth, provider config,
session-file helpers and the MCP string helpers are cheap — adding six
session-storage exports moved the bundle 466 KB → 471 KB. Measure, don't guess.

---

## 5. Debugging

### Where to look first

The **Rayucode** output channel in the second window logs lifecycle, protocol and
error events. Most "the panel does nothing" reports are one line in there.

### Drive the engine directly

This is the highest-value debugging technique in this repo, because it separates
"the engine did not send it" from "the panel did not render it". The engine reads
NDJSON on **stdin** — a positional prompt does nothing.

```bash
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n' \
  | node /home/rayu/rayu/rayu-cli/rayu/dist/rayu-vscode-host.js 2>/dev/null \
  | head -3
```

The first frame should be `system/init`, which carries the model, `permissionMode`,
`tools`, `slash_commands`, `mcp_servers`, `agents` and `skills`. Everything the
panel shows about capabilities comes from it.

To inspect one field:

```bash
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n' \
 | node .../rayu-vscode-host.js 2>/dev/null \
 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
     const f=d.split('\n').filter(Boolean).map(l=>JSON.parse(l));
     const i=f.find(m=>m.subtype==='init');
     console.log('model:',i.model,'| tools:',i.tools.length,'| cmds:',i.slash_commands.length);
   })"
# → model: user/main-model | tools: 56 | cmds: 38
```

### Simulate a first launch (signed out)

Point the engine at an empty config directory:

```bash
rm -rf /tmp/fresh && mkdir -p /tmp/fresh
printf '{"type":"user","message":{"role":"user","content":"hi"}}\n' \
  | RAYU_CONFIG_DIR=/tmp/fresh node .../rayu-vscode-host.js
```

With no credentials the engine emits the sign-in refusal as its **first frame and
exits 1** — it never sends `system/init`. Worth knowing, because it means a
signed-out panel has no model, no command catalog and no tools to display, and the
extension has to state that itself rather than wait for a frame that will not come.

### Most slash commands are filtered out in headless mode, by design

`rayu/src/main.tsx` filters the command registry for headless mode to `prompt`
commands plus `local` commands with `supportsNonInteractive`. Every `local-jsx`
command is excluded, because it renders an Ink dialog and there is no terminal.

So the engine announces only a subset — around **37–38 of 98**, varying with
installed skills — and anything outside that set returns `result/success` with **no
output frames at all**. Do not hardcode the number; read `slash_commands` from
`system/init`, which is what the panel does. `/usage` and `/context` work; `/login`,
`/model` and `/version` produce nothing. The panel serves the important
ones itself — see `src/localCommands.ts`. If you add a command, decide which of the
three routes it takes: panel-served, forwarded, or refused with an explanation.

---

## 6. Verify before you push

```bash
cd /home/rayu/rayu/rayu-cli/rayucode
npm run typecheck                                   # host + webview
npm run typecheck:tests --workspace packages/vscode
npm run test                                        # unit
cd packages/vscode && npm run test:integration      # real VS Code host
npm run package
```

Current baselines:

| Check | Expected |
|---|---|
| `npm run typecheck` (×2 configs) | 0 errors |
| unit | **211** `@rayucode/core` + **522** vscode |
| integration | **46 passing** |
| VSIX | **13 files, ~5.3 MB** |

Integration tests need a display; headless CI needs `xvfb-run -a`.

If you touched `rayu/src`, also run its gates — they are separate:

```bash
cd /home/rayu/rayu/rayu-cli/rayu
bun run typecheck:ci   # must report "No new type errors" against the 1552 baseline
bun test               # 2 pre-existing failures are expected
bun run boundary
```

`typecheck:ci` compares against a **baseline** of known errors rather than
requiring zero, because `rayu/src` is a large partial-source tree. "No new type
errors" is the pass condition.

The VSIX contains **13 files**: 11 you can list with `npm run ls:package`, plus the
two metadata files `vsce` adds. What ships is controlled by **`.vscodeignore`**, not
by `files` in `package.json` — adding a Markdown file at the package root is enough
to change the count. `RUNNING.md`, `PUBLISHING.md` and `UI_PARITY.md` are excluded;
`CHANGELOG.md` ships, because the Marketplace renders it.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Could not resolve "@rayu-dev/rayu-cli/lib"` | the library surface was never built | `cd rayu && bun run build:lib` |
| A new panel message is "not assignable" / unknown | the extension typechecks against core's built `.d.ts` | `npm run build:core` |
| `The argument 'filename' must be a file URL object … Received undefined` | an ESM `createRequire(import.meta.url)` reached the CJS host bundle | both esbuild configs set `define: { "import.meta.url": "__filename" }` — keep it |
| `Invalid or unexpected token` on line 2 of the engine | two shebangs — the build banner adds one | never put a shebang in `vscodeHost.ts` |
| Panel shows `Model Loading…` forever | signed out: the engine exits before sending `system/init` | sign in; the panel should offer a Sign in button |
| Signing in appears to change nothing | the engine had already exited; it must be restarted | handled — sign-in now restarts it. If it recurs, check the output channel |
| A tool says it needs permission but no prompt appears | the engine was launched without `--permission-prompt-tool=stdio` | it is in `REQUIRED_FLAGS`; confirm the staged engine is current |
| `Cannot set permission mode to bypassPermissions…` | bypass-class modes are fixed at launch | selecting one now confirms and relaunches with `--permission-mode` |
| A slash command silently does nothing | it is not in the engine's announced `slash_commands` | see §5; add it to `localCommands.ts` or expect the refusal |
| Only one model in the picker | no provider configured | `Rayucode: Add or switch AI provider (BYOK)` |
| Sign-in deep link never arrives | the authority must equal the published id | must be `rayucode.rayucode`; a test pins it against `package.json` |
| Integration tests fail with a null Activity Bar provider | a previous activation still holds the contributed view id | handled by `releasePublishedViewRegistration()`; if it recurs, a suite is activating without releasing first |
| rayu typecheck reports errors in files you never touched | an `npm install` wrote into `rayu/node_modules` | `cd rayu && bun install` |

---

## 8. Command reference

```bash
# from rayucode/packages/vscode
npm run build              # esbuild the artifacts + stage the engine
npm run watch              # esbuild only, rebuild on save (does NOT stage the engine)
npm run typecheck          # host + webview
npm run typecheck:tests    # test sources
npm run test               # vitest unit
npm run test:integration   # real VS Code host (needs a display)
npm run package            # → .vsix
npm run ls:package         # list what would ship
npm run stage:engine       # re-copy the engine + regenerate build-info.json

# from rayucode
npm run build:core         # @rayucode/core — required before the extension sees its changes

# from rayu (Bun, not npm)
bun run build              # dist/rayu.js         — the CLI, not shipped in the VSIX
bun run build:lib          # dist/rayu-lib.js     — the imported library surface
bun run build:vscode-host  # dist/rayu-vscode-host.js — the extension's engine
bun run boundary           # assert the library surface stays UI-free

# from the repo root — everything, in dependency order
npm run build
```
