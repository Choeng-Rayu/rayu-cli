// The EditorAdapter abstraction boundary (R13.3, R13.4).
//
// `EditorAdapter` is the ONLY editor-facing dependency the Core_Integration is
// permitted to reference (R13.1). A concrete editor host (the VS Code host
// being first) implements every member (R13.2). Because this is a plain
// TypeScript interface with zero `vscode` import, the core package builds with
// no editor dependency present (R13.5).
//
// Type definitions only.

/** A handle to something that can be torn down (editor-agnostic Disposable). */
export interface Disposable {
  dispose(): void;
}

/**
 * A handle to the displayed Agent_Panel surface. The host owns the concrete
 * view; the core drives it purely through message passing so the panel holds
 * no protocol logic (R3.1).
 */
export interface AgentPanelHandle {
  /** The session this panel is bound to. */
  readonly sessionKey: string;
  /** Bring the panel to the foreground. */
  reveal(): void;
  /** Push a host → webview message. */
  postMessage(message: unknown): Promise<boolean> | boolean;
  /** Subscribe to webview → host messages. */
  onDidReceiveMessage(listener: (message: unknown) => void): Disposable;
  /** Subscribe to panel disposal (user closed it). */
  onDidDispose(listener: () => void): Disposable;
  /** Dispose the panel. */
  dispose(): void;
}

// ----------------------------------------------------------------------------
// File edit application (R6)
// ----------------------------------------------------------------------------

/** A single file change within a {@link FileEditPlan}. */
export interface FileEditChange {
  /** Workspace-relative path of the target file. */
  path: string;
  /** Whether the change modifies an existing file or creates a new one. */
  kind: "modify" | "create";
  /** Hash of the file content captured when the proposal was generated (R6.3). */
  baseContentHash?: string;
  /** Full new file content to write. */
  newContent: string;
}

/** A set of file changes to apply together (R6.2). */
export interface FileEditPlan {
  changes: FileEditChange[];
}

/**
 * Outcome of applying a {@link FileEditPlan}. Each file is applied
 * independently: a per-file failure is recorded in `failed` and leaves all
 * other files untouched (R6.6); a stale base hash is recorded in `conflicts`
 * without modifying the file (R6.3).
 */
export interface ApplyResult {
  applied: string[];
  failed: { path: string; reason: string }[];
  conflicts: { path: string }[];
}

/** An on-disk snapshot of a file used for conflict detection (R6.3). */
export interface FileSnapshot {
  /** Workspace-relative path of the file. */
  path: string;
  /** Current file content. */
  content: string;
  /** Hash of `content`, compared against a change's `baseContentHash`. */
  contentHash: string;
}

// ----------------------------------------------------------------------------
// Workspace context (R9)
// ----------------------------------------------------------------------------

/** Which opt-in context pieces to include when assembling a prompt (R9.3, R9.4). */
export interface ContextOptions {
  includeActiveFile?: boolean;
  includeSelection?: boolean;
}

/** The active text selection and the file it belongs to (R9.4). */
export interface WorkspaceSelection {
  path: string;
  text: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Editor context gathered for a prompt. `workspaceRoot` is `null` when it
 * cannot be determined, in which case the prompt is sent without a root (R9.2).
 */
export interface WorkspaceContext {
  workspaceRoot: string | null;
  activeFilePath?: string;
  selection?: WorkspaceSelection;
  openFilePaths?: string[];
}

// ----------------------------------------------------------------------------
// The adapter interface
// ----------------------------------------------------------------------------

/**
 * The contract between Core_Integration and a concrete Editor_Host. Every
 * editor operation the core needs is routed through this interface (R13.4).
 */
export interface EditorAdapter {
  // Panel surface (R3.1)
  showAgentPanel(sessionKey: string): Promise<AgentPanelHandle>;

  // File edits (R6.2, R6.4, R6.5)
  applyFileEdits(edits: FileEditPlan): Promise<ApplyResult>;
  /** Read the current on-disk snapshot for conflict detection (R6.3). */
  readFileSnapshot(path: string): Promise<FileSnapshot | null>;

  // Workspace context (R9)
  getWorkspaceContext(options: ContextOptions): Promise<WorkspaceContext>;
  /** Whether the path is excluded by the workspace ignore configuration (R9.6). */
  isPathIgnored(path: string): Promise<boolean>;

  // Command registration (R14.1, R14.4)
  registerCommand(
    id: string,
    handler: (...args: unknown[]) => unknown,
  ): Disposable;

  // Secret storage (R8.4, R13.3)
  getSecret(key: string): Promise<string | undefined>;
  storeSecret(key: string, value: string): Promise<void>;

  // Diagnostics (R2.6, R15.3)
  log(channel: "protocol" | "lifecycle" | "error", message: string): void;

  // User-visible notifications with actions (R1.2, R2.5, R6.3, R15.1)
  showActionableMessage(
    level: "info" | "warn" | "error",
    text: string,
    actions: string[],
  ): Promise<string | undefined>;

  // Settings access (R1.1, R1.3, R9.3, R9.4, R15.4)
  getSetting<T>(key: string, fallback: T): T;
}
