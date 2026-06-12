# Slash Command Synchronization: Implementation Plan

## Objective
Sync the `/help` command output with the actual implemented slash commands in the Rayu CLI codebase. This ensures users see only commands that are functional and available, while all implemented commands are discoverable.

---## Findings

### **1. Current Slash Command Implementation**
Slash commands are implemented as `Command` objects and registered in:
- [`src/commands.ts`](/home/rayu/rayu-cli/rayu/src/commands.ts) (central registry)
- Dynamic sources: plugins, skills, workflows, MCP (loaded at runtime)
- **Total implemented commands (builtin + enabled features):**
  ```json
  [
    "add-dir", "advisor", "agents", "branch", "btw", "clear", "color", "compact", 
    "config", "copy", "context", "diff", "doctor", "effort", "exit", "files", 
    "heapDump", "help", "ide", "init", "keep", "keybindings", "mcp", "memory", 
    "telegram-bot", "disconnect-telegram", "model", "model-subagent", "collaborator-model",
    "model-image-generation", "model-video-generation", "connect", "install-skill", 
    "output-style", "plugin", "pr_comments", "reload-plugins", "rename", "review-detial", 
    "resume", "session", "skills", "stats", "status", "contactMe", 
    "tag", "theme", "feedback", "review", "collaborator-swarm", "ultraplan-local", 
    "ultrareview-local", "generate-image", "image-editor", "generate-video", "rewind",
    "security-review", "terminal-setup", "undo", "insights", "vim", 
    "thinkback", "thinkback-play", "permissions", "plan", "hooks", "export", "sandbox-toggle", 
    "tasks"
  ]
  ```
  **Feature-flagged commands (enabled at runtime):** `fork`, `buddy`, `proactive`, `brief`, `assistant`, `workflows`, `torch`, `ultraplan`, `subscribe-pr`, `peers`

### **2. `/help` Implementation**
- **Location:** [`src/commands/help/index.ts`](/home/rayu/rayu-cli/rayu/src/commands/help/index.ts)
- **UI Renderer:** [`src/components/HelpV2/HelpV2.tsx`](/home/rayu/rayu-cli/rayu/src/components/HelpV2/HelpV2.tsx)
  - Uses [`Commands.tsx`](/home/rayu/rayu-cli/rayu/src/components/HelpV2/Commands.tsx) to display a filtered subset of commands in tabs (General, Commands, Custom Commands).
  - The `Commands` component de-duplicates commands by name and sorts them alphabetically.
- **Logic for Command Display:** The `/help` UI fetches commands via `getCommands(cwd)` (from `src/commands.ts`) and filters out hidden commands (`isHidden: true`).

### **3. Gaps Identified**
#### **a) Discrepancies in Command Visibility**
- The `/help` UI **excludes** feature-flagged commands unless explicitly enabled in the current session (e.g., `ultraplan` appears only if `feature('ULTRAPLAN')` is true).
- Some commands are **hidden by default** (`isHidden: true`) and do not appear in `/help` even if implemented.
- **No centralized documentation** of hidden or feature-flagged commands exists in the `/help` UI.

#### **b) UI/UX Observations**
- The `General` tab (first tab in `/help`) only shows shortcuts and does not list commands.
- Custom commands (from plugins/skills) are grouped under "Custom Commands" but built-in commands are not categorized (e.g., no "File Operations" or "Version Control" groups).
- The `Commands` component **does not show descriptions for disabled/feature-flagged commands**, making it impossible for users to discover them.

#### **c) Dynamic Commands**
- Commands from plugins, skills, or MCP are **loaded at runtime** and included in the `/help` output only if enabled.
- No fallback mechanism exists to show disabled or unloaded commands (e.g., "This command is available if you install Plugin X").

### **4. Risk Areas**
- **UX Confusion:** Users may not discover feature-flagged or hidden commands (e.g., `ultraplan`, `fork`) even if they are functional.
- **Maintenance Burden:** Manually syncing `/help` with code changes is error-prone. New commands may be added but not documented in `/help`, or stale commands may persist.
- **Inconsistency:** The `Commands` component in `HelpV2.tsx` de-duplicates commands by name, which can hide context (e.g., which plugin provides a command).


---

## Approach
### **Chosen Approach: Auto-Generated Help Content**
**Why?**
- **Accuracy:** Derive `/help` content directly from the `Command[]` array returned by `getCommands(cwd)`. This ensures 1:1 parity between implemented and documented commands.
- **Sustainability:** No manual updates needed when commands are added, removed, or modified.
- **Transparency:** Show all commands, including disabled/feature-flagged ones, with clear indicators (e.g., "[disabled: requires feature flag]").

**Alternatives Considered:**
1. **Manual `/help` Updates:** Prone to human error and drift over time. Rejected for maintainability.
2. **Static Documentation:** Requires a separate file (e.g., `COMMANDS.md`) and doubles the maintenance burden. Rejected for sustainability.

### **Trade-offs**
- **Pro:** The auto-generated approach ensures `/help` is always in sync with the codebase.
- **Con:** Requires UI changes to show disabled/feature-flagged commands without clutter. Mitigated by adding clear visual indicators (e.g., dimmed text) and tooltips.


---

## Implementation Plan

### **Step 1: Prepare the Environment**
1. **Create `.rayu/swarm/` directory** (if it doesn’t exist).
2. **Add a `PA.md` file** (this file) to document the plan.
3. **Add `shared.json`** to track metadata (see below).


### **Step 2: Update `/help` Logic**
**Files to Modify:**
- [`src/components/HelpV2/HelpV2.tsx`](/home/rayu/rayu-cli/rayu/src/components/HelpV2/HelpV2.tsx)
- [`src/components/HelpV2/Commands.tsx`](/home/rayu/rayu-cli/rayu/src/components/HelpV2/Commands.tsx)
- [`src/commands/help/index.ts`](/home/rayu/rayu-cli/rayu/src/commands/help/index.ts) (if needed for structural changes)

**Changes:**
1. **Categorize Commands:**
   - Group commands into sections (e.g., "File Operations", "Version Control", "Model Management") using a new `category` field in `Command`.
   - Add a `getCommandCategory(cmd: Command)` helper to `src/commands.ts` to derive the category from the command name or source.

2. **Show Feature-Flagged/Disabled Commands:**
   - Add a `status` field to each command in the UI:
     - `enabled` (default): Fully functional.
     - `disabled`: Requires a feature flag or authentication.
     - `hidden`: Not shown unless explicitly enabled (e.g., internal commands).
   - Modify `Commands.tsx` to display disabled commands with dimmed text and a tooltip explaining how to enable them (e.g., "Feature flag: ULTRAPLAN").

3. **Update General Tab:**
   - Replace the current shortcuts-only content with a compact list of **commonly used commands** (top 5-10 by usage frequency).
   - Add a link to the full `Commands` tab for discoverability.

4. **Toolipps for Context:**
   - Add tooltips to commands to show:
     - Source (e.g., "Built-in", "Plugin: X", "MCP").
     - Status (e.g., "Disabled: requires feature flag Y").
     - For plugins: a link to the marketplace or installation instructions.


### **Step 3: Add Command Metadata**
**Files to Modify:**
- [`src/types/command.ts`](/home/rayu/rayu-cli/rayu/src/types/command.ts)

**Changes:**
1. Add a `category` field to the `Command` type to enable grouping in `/help`.
2. Add a `status` field to track whether a command is `enabled`, `disabled`, or `hidden`.
3. Add a `tooltip` field to provide dynamic context (e.g., "Feature flag: ULTRAPLAN").


### **Step 4: Update Command Registration**
**Files to Modify:**
- [`src/commands.ts`](/home/rayu/rayu-cli/rayu/src/commands.ts)
- Dynamic command loaders (e.g., `getSkillDirCommands`, `getPluginCommands`)

**Changes:**
1. Derive the `category` for each command based on its name or source (e.g., `model` commands → "Model Management").
2. Derive the `status` for each command:
   - `disabled` if gated by a feature flag or availability check.
   - `hidden` if `isHidden: true`.
   - Default to `enabled`.
3. Add helpers to `src/commands.ts`:
   - `getCommandCategory(cmd: Command): string`
   - `getCommandStatus(cmd: Command): 'enabled' | 'disabled' | 'hidden'`
   - `getCommandTooltip(cmd: Command): string`


### **Step 5: Update UI Components**
**Files to Modify:**
- [`src/components/HelpV2/Commands.tsx`](/home/rayu/rayu-cli/rayu/src/components/HelpV2/Commands.tsx)

**Changes:**
1. Replace the flat command list with a categorizedaccordion or tabbed interface (e.g., "Built-in", "Plugins", "Disabled").
2. Add visual indicators for `disabled` and `hidden` commands:
   - Disabled: Dimmed text + tooltip.
   - Hidden: Only shown if explicitly toggled (e.g., via a "Show hidden commands" checkbox).
3. Show tooltips for additional context (e.g., feature flags, plugin sources).


### **Step 6: Verify Changes**
**Validation Steps:**
1. Run the CLI and trigger `/help`. Confirm:
   - All enabled commands appear in their respective categories.
   - Disabled/feature-flagged commands appear with tooltips.
   - No duplicates or stale commands are present.
2. Enable/disable a feature flag (e.g., `ULTRAPLAN`) and verify the `/help` output updates accordingly.
3. Test with custom commands (plugins/skills) to ensure they appear under "Custom Commands".
4. Run unit tests for:
   - `getCommands(cwd)`
   - `getCommandCategory`, `getCommandStatus`, `getCommandTooltip` helpers.
   - UI rendering in `HelpV2.tsx` and `Commands.tsx`.
5. Manually test edge cases:
   - Feature flags not enabled.
   - Commands with `isHidden: true`.
   - Commands from plugins/MCP.


### **Step 7: Cleanup**
1. Remove hardcoded command lists from `/help` documentation (if any exist in the codebase).
2. Update any stale comments or documentation that reference specific commands.


---

## Critical Files
1. [`src/commands.ts`](/home/rayu/rayu-cli/rayu/src/commands.ts) - Central command registry and helpers.
2. [`src/components/HelpV2/HelpV2.tsx`](/home/rayu/rayu-cli/rayu/src/components/HelpV2/HelpV2.tsx) - Main `/help` UI component.
3. [`src/components/HelpV2/Commands.tsx`](/home/rayu/rayu-cli/rayu/src/components/HelpV2/Commands.tsx) - Renders command lists.
4. [`src/types/command.ts`](/home/rayu/rayu-cli/rayu/src/types/command.ts) - Type definitions for `Command`.
5. [`src/commands/help/index.ts`](/home/rayu/rayu-cli/rayu/src/commands/help/index.ts) - `/help` command definition.


---

## Risks & Open Questions
1. **UX Clutter:** Showing disabled/feature-flagged commands may overwhelm users. Mitigated by:
   - Using dimmed text and tooltips to reduce visual noise.
   - Categorization to group related commands.
2. **Performance:** Large numbers of commands (e.g., from plugins) may slow down `/help` rendering. Mitigated by:
   - Virtualized rendering in the `Commands` component.
   - Lazy-loading categories.
3. **Feature Flag Logic:** Determining if a command is `disabled` requires checking `feature()` flags at runtime. This adds complexity to `getCommandStatus`.
4. **Backward Compatibility:** Changes to `Command` type (e.g., adding `category`/`status`) may break existing code. Mitigated by making fields optional.
5. **Localization:** Tooltips and category names may need i18n support in the future. Deferred for now.

**Open Questions:**
- Should hidden commands (e.g., internal/`ANT`-only) ever appear in `/help`?
- How should commands from MCP (e.g., dynamically loaded skills) be categorized?
- Should `/help` include a search/filter bar for large command sets?