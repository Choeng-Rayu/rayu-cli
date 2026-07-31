# Fix Unpredictable Character Rendering — RAYU CLI Terminal Frontend

## Improved Prompt

As a senior software engineer, investigate and fix a rendering bug in the RAYU CLI terminal frontend.

**Symptom:** The RAYU CLI sometimes renders unpredictable / garbage characters in the terminal UI during launch or while running. These characters appear intermittently and are not part of the intended output.

**Scope to investigate:** `/home/rayu/rayu-cli/rayu/src/` — focus on the terminal renderer and frontend wiring. Key areas:
- `src/ink/` — the custom React reconciler (NOT standard npm `ink`): packed Int32 buffers, ANSI parser, Yoga layout, custom component primitives
- `src/entrypoints/cli.tsx` — bootstrap / fast-paths
- `src/main.tsx` — full interactive session wiring
- `src/components/` — 145+ UI components
- `src/constants/` — terminal-related constants (colors, glyphs, box-drawing chars)

## CRITICAL RULES (per RAYU.md / AGENTS.md)

### Rule 1: NO ASSUMPTIONS — Find Root Cause
Do NOT guess. Do NOT assume this is "just an encoding issue" or "a standard ink bug." This codebase uses a CUSTOM React reconciler with packed Int32 buffers and a custom ANSI parser — it is NOT standard npm `ink`. Behavior here diverges significantly from upstream Claude Code.

- ✅ READ the actual source: `src/ink/reconciler.ts`, the buffer packing logic, the ANSI parser, and the render path.
- ✅ Trace where bytes are written to stdout and how unicode / multi-byte characters are handled.
- ✅ Check how box-drawing glyphs and theme color tokens are emitted.
- ✅ Check `ORIGIN_MANIFEST.md` for which files are original Rayu vs derivative.
- ❌ DON'T guess from file names, docstrings, or "what it should be."
- ❌ DON'T assume upstream Claude Code rendering behavior applies.

### Rule 2: Search Before Writing
Before making ANY change, search (Grep + Glob, or Graphify) to find:
- Where unpredictable characters could originate: raw byte writes, incomplete ANSI escape sequences, buffer boundary splits in the Int32 packing, uninitialized buffers, race conditions between async writes and the render loop, locale/TERM mismatches, emoji or wide-character width miscalculations.
- Whether a similar fix or guard already exists.

### Rule 3: Reproduce Before Fixing
Reproduce the bug first. Capture the exact characters/bytes that appear (pipe output to a file, hexdump if needed). Identify the precise code path that emits them. A fix without a reproduced failure and root-cause trace is not acceptable.

## Requirements

1. **Reproduce** the unpredictable character output reliably (or identify the exact code path that produces it under the failure condition).
2. **Identify the root cause** — point to specific file:line in `src/ink/` (or related frontend code) with a clear explanation of why garbage characters are emitted.
3. **Fix the root cause** — do NOT mask the symptom (e.g., do not just strip non-ASCII or silence stderr). Fix the actual logic that produces wrong bytes.
4. **Do not regress** — the custom reconciler, packed Int32 buffers, and ANSI parser must keep working. Do not convert feature-gated `require()` to static `import` (it breaks compile-time DCE).
5. **Verify** with:
   - `bun run typecheck`
   - `bun run dev` (launch and exercise the UI; confirm the garbage characters no longer appear and the UI still renders correctly)
   - `bun test` (run any existing renderer/ink tests)

## Acceptance Criteria

- [ ] Root cause identified and documented with file:line references.
- [ ] Reproduction confirmed before the fix.
- [ ] Fix targets the root cause, not the symptom.
- [ ] `bun run typecheck` passes.
- [ ] `bun run dev` launches cleanly with no unpredictable characters.
- [ ] Existing UI rendering and the custom reconciler still work.
- [ ] No new duplication introduced (searched before writing).