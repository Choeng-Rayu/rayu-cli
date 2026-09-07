# Implementation Plan: Rayucode / Copilot UI Design Specification (.md)

## Goal Description
The user requested to preserve the completed UI design into a comprehensive, standalone UI design specification document (`UI_DESIGN_SPEC.md`). This document will serve as the complete design system and implementation blueprint for building any new VS Code extension with the exact same Copilot Chat & Copilot Edits UI/UX, components, tokens, interactions, and protocols.

---

## User Review Required

> [!IMPORTANT]
> The UI design specification will be delivered as a complete, self-contained reference document [`rayucode/packages/vscode/UI_DESIGN_SPEC.md`](file:///home/rayu/rayu/rayu-cli/rayucode/packages/vscode/UI_DESIGN_SPEC.md). It will contain full CSS stylesheets, React component blueprints, design tokens, interaction flows, and wire protocol interfaces so it can be copied directly into any new VS Code extension project.

---

## Specification Document Structure

The resulting `UI_DESIGN_SPEC.md` will contain the following detailed sections:

### 1. Executive Summary & Design Principles
- **Dual Paradigm**: Unification of **Copilot Chat** (conversational history, request cards, assistant turns with sparkle avatars, expandable tool pills) and **Copilot Edits** (working-set review cards, per-file diff inspection, keep/undo batch controls).
- **Native VS Code Fidelity**: Zero hardcoded hex colors; 100% adherence to VS Code theme variables (`--vscode-*`) across Light, Dark, High-Contrast Dark, and High-Contrast Light themes.
- **Micro-Interactions**: Keyboard shortcuts (`Enter` to send, `Shift+Enter` for newline, `Shift+Tab` to cycle permission modes, `/` for slash commands, `@` for file mentions).

```
+-------------------------------------------------------------------------+
| [Header] Rayucode                                  [New Session Button] |
+-------------------------------------------------------------------------+
|                                                                         |
|  [Welcome Screen] (when transcript is empty)                            |
|       (Sparkle Icon)                                                    |
|     "What can I help with?"                                             |
|     [ /review_detail ] [ /keep ] [ /undo ] [ /plan ]                     |
|                                                                         |
|  [User Turn Card] (Right-aligned, requestBackground)                    |
|  +---------------------------------------------------------+ (User)     |
|  | "Refactor the authentication flow to use JWT"           |            |
|  +---------------------------------------------------------+            |
|                                                                         |
|  (Sparkle) [Assistant Turn]                                             |
|  I will inspect the existing auth handlers and update the tokens.       |
|                                                                         |
|  [Tool Activity Pill] (Expandable)                                      |
|  +-------------------------------------------------------------------+  |
|  | >_ bash: npm test                                  [DONE] [v]     |  |
|  +-------------------------------------------------------------------+  |
|                                                                         |
|  [Copilot Edits Review Card] (Working Set)                              |
|  +-------------------------------------------------------------------+  |
|  | 2 files changed (+42 -12)                [Keep All] [Undo All]   |  |
|  |-------------------------------------------------------------------|  |
|  | src/auth.ts (+30 -10)             [Diff] [Keep] [Undo]           |  |
|  | src/index.ts (+12 -2)             [Diff] [Keep] [Undo]           |  |
|  +-------------------------------------------------------------------+  |
|                                                                         |
+-------------------------------------------------------------------------+
| [Pinned Permission / Progress Bar]                                      |
| [Slash / Mention Popover Menu (when active)]                            |
| +---------------------------------------------------------------------+ |
| | [Composer Card]                                                     | |
| | "Ask Rayu or type / for commands..."                                | |
| |                                                                     | |
| | [Shield Plan v] [Model: Sonnet v] [Provider: Anthropic]       ( ^ ) | |
| +---------------------------------------------------------------------+ |
+-------------------------------------------------------------------------+
```

### 2. Design Token System (CSS Variables)
Complete specification of all VS Code CSS variables utilized:
- **Containers & Surfaces**: `--vscode-editorWidget-background`, `--vscode-editorWidget-border`, `--vscode-sideBar-background`, `--vscode-panel-border`
- **Chat Bubbles & Avatars**: `--vscode-chat-requestBackground`, `--vscode-chat-requestBorder`, `--vscode-chat-avatarBackground`, `--vscode-chat-avatarForeground`
- **Diff & Git Accents**: `--vscode-gitDecoration-addedResourceForeground`, `--vscode-gitDecoration-deletedResourceForeground`, `--vscode-inputValidation-warningBackground`, `--vscode-inputValidation-errorBackground`
- **Inputs & Controls**: `--vscode-input-background`, `--vscode-input-foreground`, `--vscode-input-border`, `--vscode-focusBorder`, `--vscode-button-background`, `--vscode-button-hoverBackground`
- **Typography & Radii**: `--vscode-font-family`, `--vscode-editor-font-family`, `--rc-radius: 6px-8px`, `--rc-gap: 8px`

### 3. Component Hierarchy & Blueprints
Detailed JSX structure, properties, and styling for each component:
1. **Welcome Screen & Prompt Chips**: Layout, icon badge, prompt insertion chips.
2. **User Request Bubble (`UserEntry`)**: Right-aligned bubble container, avatar positioning.
3. **Assistant Turn (`AssistantEntry`)**: Sparkle avatar, markdown prose styling, meta footer, streaming pulse dot.
4. **Tool Activity Pill (`ToolActionEntry`)**: Compact summary bar, status badges (`running`, `done`, `error`), collapsible parameters and output.
5. **Copilot Edits Review Card (`FileChangeReviewCard`)**: Diff stats (`+A -B`), per-file diff compare action (`git.openChange`), per-file keep/undo buttons, and global batch actions.
6. **Integrated Composer Card (`Composer`)**: Auto-resizing textarea, bottom toolbar pills (permission mode with shield icon, model picker, BYOK provider button), circular submit/stop button.
7. **Floating QuickPick Popover (`AutocompletePopover`)**: Filtered list for slash commands (`/`) and `@` file mentions with keyboard selection.

### 4. Wire Protocol & State Management
- Host-to-Webview message contracts: `addMessage`, `appendPartial`, `completeMessage`, `file_change_review`, `setModelInfo`, `showPermissionRequest`, `showToolAction`.
- Webview-to-Host message contracts: `submitPrompt`, `interrupt`, `selectPermissionMode`, `selectModel`, `openReviewDiff`, `openFile`, `openProviderSetup`.
- State Reducer model & view model transitions.

### 5. Drop-in Complete CSS Stylesheet
- The entire tested, clean CSS stylesheet containing all classes (`.copilot-turn`, `.copilot-composer-card`, `.copilot-review-card`, `.copilot-tool-pill`, `.copilot-popover`, etc.) ready to be copied into any new VS Code extension.

---

## Verification Plan

### Automated Tests
1. Verify document integrity and link correctness.
2. Ensure existing test suites across the monorepo remain completely green:
   - `npm test --workspace rayucode`
   - `npm run typecheck --workspace rayucode`
   - `npm run build --workspace rayucode`

### Manual Verification
1. Review [`rayucode/packages/vscode/UI_DESIGN_SPEC.md`](file:///home/rayu/rayu/rayu-cli/rayucode/packages/vscode/UI_DESIGN_SPEC.md) for completeness, readability, code samples, and drop-in usability.
