# Remaining Work — Task 10 & 11

## Current State

**Completed:**
- ✅ Tasks 1–9 done and verified
- ✅ Protocol package: 24/24 tests pass (real-engine fixtures validated)
- ✅ Core: 189/189 tests pass (all stale expectations rewritten, new coverage added)
- ✅ Extension packaging: 26/26 tests pass (cliPath assertions removed)
- ✅ Markdown security: 67/67 XSS tests pass (adapted for React renderer)

**Remaining:** 
- webviewContract.test.ts (~7 failures) — renders markdown to check the output
- webviewResilience.test.ts (file won't load) — imports deleted `dom.js`
- CI test jobs (currently build+typecheck+packaging only)

---

## Task 10 (Part B): Finish Webview Tests

### 1. Fix `webviewContract.test.ts`

**Problem:** It imports `renderMarkdown` and asserts on the string output, but `renderMarkdown` now returns `ReactNode`.

**Solution:**
```typescript
// At the top of test/webviewContract.test.ts
import { renderToStaticMarkup } from "react-dom/server";

// Wrap every call:
const html = renderToStaticMarkup(renderMarkdown(source) as any);
// Then assert on `html` instead of the direct return.
```

**Location:** `/home/rayu/rayu/rayu-cli/rayucode/packages/vscode/test/webviewContract.test.ts`

**Run to verify:**
```bash
cd rayucode/packages/vscode
npx vitest run test/webviewContract.test.ts --reporter=basic
```

---

### 2. Rewrite `webviewResilience.test.ts`

**Problem:** It imports `../src/webview/dom.js`, which was deleted in Task 8.

**What it tested:** The old reconciler's fault tolerance — malformed panel messages, unknown item kinds, partial state updates.

**New approach:** Test the React components' resilience instead:
1. Mount `<App>` with vitest + `@testing-library/react`
2. Drive malformed messages through the view model
3. Assert the panel doesn't throw and degrades gracefully

**File to create:** Keep the same path, rewrite the content.

**Example structure:**
```typescript
// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../src/webview/App.js";
import { PanelViewModel } from "../src/webview/viewModel.js";

describe("webview resilience", () => {
  it("ignores an unrecognised host message type", () => {
    const vm = new PanelViewModel();
    const { container } = render(<App viewModel={vm} />);
    
    // Drive a message with an unknown type
    vm.handle({ type: "definitely_not_real" } as any);
    
    // Panel should not throw
    expect(container.querySelector(".panel")).toBeTruthy();
  });

  it("renders null for an unknown conversation item kind", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "addMessage",
      item: { kind: "not_a_real_kind", id: "x", seq: 1 },
    } as any);
    
    const { container } = render(<App viewModel={vm} />);
    // Should render without crashing; the unknown item produces nothing
    expect(container.querySelector(".transcript")).toBeTruthy();
  });

  // Add similar tests for partial/malformed items
});
```

**Dependencies needed:**
```bash
cd rayucode/packages/vscode
npm install --save-dev @testing-library/react jsdom
```

**Run to verify:**
```bash
npx vitest run test/webviewResilience.test.ts --reporter=basic
```

---

### 3. Test the New Task 9 Features

Create `test/webview-task9.test.ts` to cover:

#### a) Diff rendering
```typescript
import { describe, expect, it } from "vitest";
import { extractFileDiffs, isDiffableTool } from "../src/webview/diff.js";

describe("diff extraction", () => {
  it("extracts a Write as a whole-file addition", () => {
    const diffs = extractFileDiffs("Write", {
      file_path: "/test.ts",
      content: "line1\nline2",
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.wholeFile).toBe(true);
    expect(diffs[0]!.hunks[0]!.lines.every(l => l.kind === "add")).toBe(true);
  });

  it("extracts an Edit as a line diff", () => {
    const diffs = extractFileDiffs("Edit", {
      file_path: "/test.ts",
      old_string: "a\nb\nc",
      new_string: "a\nB\nc",
    });
    const lines = diffs[0]!.hunks[0]!.lines;
    expect(lines.filter(l => l.kind === "add")).toHaveLength(1);
    expect(lines.filter(l => l.kind === "remove")).toHaveLength(1);
  });

  it("returns empty for a malformed payload", () => {
    expect(extractFileDiffs("Edit", { file_path: "/x" })).toHaveLength(0);
  });

  it("identifies diffable tools", () => {
    expect(isDiffableTool("Write")).toBe(true);
    expect(isDiffableTool("Edit")).toBe(true);
    expect(isDiffableTool("MultiEdit")).toBe(true);
    expect(isDiffableTool("Bash")).toBe(false);
  });
});
```

#### b) View model message folding
```typescript
describe("viewModel handles new protocol messages", () => {
  it("replaces tool progress in place", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "toolProgress",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 5,
    });
    expect(vm.state.toolProgress?.elapsedSeconds).toBe(5);
    
    vm.handle({
      type: "toolProgress",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 10,
    });
    // Updated, not duplicated
    expect(vm.state.toolProgress?.elapsedSeconds).toBe(10);
  });

  it("clears tool progress when the turn stops", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "toolProgress", toolUseId: "t1", toolName: "Bash", elapsedSeconds: 5 });
    vm.handle({ type: "setGenerating", generating: false });
    expect(vm.state.toolProgress).toBeNull();
  });

  it("ignores rate limit 'allowed' but surfaces 'rejected'", () => {
    const vm = new PanelViewModel();
    vm.handle({ type: "rateLimit", status: "allowed" });
    expect(vm.state.rateLimit).toBeNull();
    
    vm.handle({ type: "rateLimit", status: "rejected" });
    expect(vm.state.rateLimit?.status).toBe("rejected");
  });

  it("appends a notice on compact boundary", () => {
    const vm = new PanelViewModel();
    vm.handle({
      type: "compactBoundary",
      trigger: "auto",
      preTokens: 50000,
    });
    const notices = vm.state.items.filter(i => i.kind === "notice");
    expect(notices.length).toBeGreaterThan(0);
  });
});
```

---

## Task 10 (Part C): Add CI Test Jobs

**File:** `.github/workflows/rayucode.yml`

**Location to add (after the `verify-vsix` step):**

```yaml
      - name: Test protocol package
        working-directory: packages/agent-protocol
        run: npm test

      - name: Test core
        working-directory: rayucode/packages/core
        run: npm test

      - name: Test extension
        working-directory: rayucode/packages/vscode
        run: npm test
```

**Why deferred until now:** The suites were stale (79 failures). Now they're green.

**Run locally first:**
```bash
cd /home/rayu/rayu/rayu-cli
npm run test --workspace @rayu-dev/agent-protocol
npm run test --workspace @rayucode/core
npm run test --workspace rayucode
```

All three should exit 0 before you push.

---

## Task 11: Close Triage & Cross-Platform

### 1. Review `TRIAGE.md` Section 5

**File:** `/home/rayu/rayu/rayu-cli/rayucode/TRIAGE.md`

**Action:** Confirm every item in "§5. Stale Test Expectations" is now resolved.

Expected state:
- ✅ Core: all 7 rewritten (D7 fail-safe, spawn signature, PERMISSION_MODES, agent-process frames)
- ✅ Extension: packaging 3 fixed, markdown 62 adapted, webviewContract ~7 need wrapping
- ⚠️ webviewResilience: needs full rewrite (you'll do this in 10.2 above)

Mark each as DONE in the triage doc.

---

### 2. Verify D4 is Fully Mitigated

**The issue:** Engine writes a 17-line banner to stdout before the NDJSON guard installs, breaking fresh installs.

**Mitigation applied:** `ensureFirstRunMarkerSuppressed()` pre-creates `~/.rayu/.installed` so the banner is skipped.

**Verify:**
```bash
cd rayucode/packages/vscode
npm run build
npm run package
code --install-extension rayucode-*.vsix --force

# In a terminal, with a FRESH $HOME:
export HOME=/tmp/fresh-home-$(date +%s)
export PATH=/usr/bin:/bin
node /path/to/extracted/vsix/extension/dist/rayu.js --print \
  --input-format=stream-json --output-format=stream-json --verbose \
  <<< '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}'
```

**Expected:** No non-JSON lines before `{"type":"system",...}`.

If the banner appears, the marker creation is not working. Check:
- `ensureFirstRunMarkerSuppressed` is called in `sessionManager.ts` before spawn
- The fake filesystem in tests mimics the real `fs` behaviour

---

### 3. Cross-Platform Smoke Test

**Platforms to verify:**
- ✅ Linux (your current environment)
- ⚠️ macOS (if available)
- ⚠️ Windows (if available)

**What to test on each:**
1. Install the VSIX
2. Open a workspace
3. Rayucode panel appears without errors
4. Submit a prompt, get a response
5. Approve a tool permission
6. Check the terminal sees no NDJSON parsing errors

**If you only have Linux:** Document this in TRIAGE.md or README and note that macOS/Windows are untested. The protocol and rendering are platform-agnostic, but PATH resolution and the spawned process behaviour can differ.

---

### 4. Update `TRIAGE.md` Disposition

At the bottom of the file, replace "§6. Disposition" with:

```markdown
## 6. Disposition

All verified defects are RESOLVED:

| ID | Summary | Resolution |
|----|---------|------------|
| D1 | `isSystemInit` missing subtype check | Fixed in Task 4: guards now check type AND subtype |
| D2 | `system/api_retry` invisible | Fixed in Task 4: routed + surfaced as actionable error |
| D3 | `result` union modelled as one shape | Fixed in Task 4: wire.ts exposes ResultSuccess/ResultError |
| D4 | First-run banner breaks NDJSON | Mitigated in Task 5: `.installed` marker pre-created |
| D5 | `system/init` hand-copy missing fields | Fixed in Task 3: real schema, no hand-copy |
| D6 | stub-rayu.mjs hand-written | Fixed in Task 4: stub emits schema-valid frames |
| D7 | ndjson skip-and-continue | Fixed in Task 4: fail-stop + 5-step fail-safe |
| D8 | 4 message types discarded | Fixed in Task 9: forwarded to panel |
| D9 | `apiKeySource` disjoint sets | Fixed in Task 3: schema widened to real values |
| D10.2 | internal `PermissionMode` rejected | Fixed in Task 3: schema includes all 8 modes |

**D10.1 and D10.3** (27 engine/schema shape mismatches) remain CATALOGUED, not fixed.
These require `rayu/src` changes, outside the agreed scope. They are NON-BLOCKING:
the extension works with the shapes the engine currently emits.

**Test status:**
- Protocol: 24/24
- Core: 189/189
- Extension: 26/26 (packaging) + 67/67 (markdown) + [webviewContract + webviewResilience pending]
- CI: build + typecheck + packaging + [tests pending]

**Cross-platform:** Verified on Linux. macOS/Windows untested [update as appropriate].

## 7. Remaining Recommendations

1. **D10.1 control requests:** 14 control-request subtypes exist in `rayu/src` but not in the schema. Once validated, these ops will be unreachable from the editor. Audit needed.

2. **Web components:** `@vscode-elements/*` were installed then dropped in Task 9 because their CSP behaviour is unverified. If you want them, confirm they work with `style-src ${cspSource}` (no `unsafe-inline`), or uninstall.

3. **Per-hunk diff selection:** Task 9 ships a diff VIEW. Partial approval needs a core change (`applyEngine.ts` must accept a hunk selection), deferred deliberately.
```

---

## Summary Checklist

```
Task 10:
  [ ] Fix webviewContract.test.ts (wrap renderMarkdown calls)
  [ ] Rewrite webviewResilience.test.ts (React + testing-library)
  [ ] Add webview-task9.test.ts (diff + new message folding)
  [ ] Add CI test jobs to .github/workflows/rayucode.yml
  [ ] Run `npm test` locally for all 3 packages, confirm green

Task 11:
  [ ] Review TRIAGE.md §5, mark stale tests DONE
  [ ] Verify D4 mitigation with fresh $HOME smoke test
  [ ] Cross-platform smoke test (or document Linux-only)
  [ ] Update TRIAGE.md §6 Disposition
  [ ] Final build + package + verify VSIX
```

---

## Commands Reference

```bash
# From repo root /home/rayu/rayu/rayu-cli

# Install any missing test deps
cd rayucode/packages/vscode
npm install --save-dev @testing-library/react jsdom

# Run individual test files
npx vitest run test/webviewContract.test.ts --reporter=basic
npx vitest run test/webviewResilience.test.ts --reporter=basic

# Run all extension tests
npm test

# Run all workspace tests
cd ../..
npm run test --workspace @rayu-dev/agent-protocol
npm run test --workspace @rayucode/core
npm run test --workspace rayucode

# Full verification before pushing
npm run build
npm run typecheck
npm run test
cd rayucode/packages/vscode && npm run package
```

---

## Notes

- The test structure is already proven: 280 passing tests show the approach works
- The webviewContract fix is mechanical (wrap 7 calls)
- webviewResilience is the only new authoring; use the existing session-manager.test.ts as a reference for harness setup
- CI test jobs are a 3-line addition; the scripts already exist in package.json

Once these are done, you'll have:
- 300+ tests, all green
- Full CI verification (build, typecheck, packaging, tests)
- A fully-bundled 5 MB VSIX with no external dependencies
- Protocol contract enforced at 3 validation points (package round-trip, build-info, live engine)
