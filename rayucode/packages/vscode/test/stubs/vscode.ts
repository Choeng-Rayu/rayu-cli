// A minimal in-memory stand-in for the `vscode` module, used ONLY by vitest.
//
// The extension host injects the real `vscode` at runtime; it is not an npm
// package, so any module that imports it cannot be loaded in a plain Node test.
// Previously that confined the vitest suite to modules with no `vscode` import
// at all — which left the new host surfaces (status bar, onboarding, code
// actions, chat participant) coverable only by the much slower extension-host
// integration suite.
//
// This stub closes that gap. It implements exactly the surface those modules
// touch, records what they did, and is wired in through `resolve.alias` in
// vitest.config.ts. It is NEVER bundled: esbuild keeps `vscode` external for the
// extension and the integration suite runs against the real API, so behavior
// that depends on genuine editor semantics is still verified there.
//
// Keep this file honest: stub only what is needed, and prefer recording calls
// over simulating editor behavior.

// ----------------------------------------------------------------------------
// Recording state (reset with `resetVscodeStub()`)
// ----------------------------------------------------------------------------

export interface StubTerminal {
  name: string;
  shown: boolean;
  sentText: string[];
  disposed: boolean;
}

export interface StubStatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: unknown;
  alignment: number;
  priority: number | undefined;
  shown: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface StubRecorder {
  terminals: StubTerminal[];
  statusBarItems: StubStatusBarItem[];
  executedCommands: { command: string; args: unknown[] }[];
  openedExternal: string[];
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  registeredWebviewViewProviders: { viewType: string; provider: unknown }[];
  registeredCodeActionProviders: { selector: unknown; provider: unknown }[];
  createdChatParticipants: { id: string; handler: unknown }[];
  informationMessages: { text: string; actions: string[] }[];
  warningMessages: { text: string; actions: string[] }[];
  errorMessages: { text: string; actions: string[] }[];
  /** Answer returned by the next show*Message call, if set. */
  nextMessageChoice: string | undefined;
  /** `chat` namespace availability, so the feature-detection path is testable. */
  chatAvailable: boolean;
  /** Value returned by `window.activeTextEditor`. */
  activeTextEditor: unknown;
  /** Value returned by `window.visibleTextEditors`. */
  visibleTextEditors: unknown[];
}

export const recorder: StubRecorder = createRecorder();

function createRecorder(): StubRecorder {
  return {
    terminals: [],
    statusBarItems: [],
    executedCommands: [],
    openedExternal: [],
    registeredCommands: new Map(),
    registeredWebviewViewProviders: [],
    registeredCodeActionProviders: [],
    createdChatParticipants: [],
    informationMessages: [],
    warningMessages: [],
    errorMessages: [],
    nextMessageChoice: undefined,
    chatAvailable: true,
    activeTextEditor: undefined,
    visibleTextEditors: [],
  };
}

/** Reset every recorded interaction. Call in `beforeEach`. */
export function resetVscodeStub(): void {
  Object.assign(recorder, createRecorder());
}

// ----------------------------------------------------------------------------
// Value types
// ----------------------------------------------------------------------------

export class Uri {
  readonly scheme: string;
  readonly path: string;
  readonly fsPath: string;

  private constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
    this.fsPath = path;
  }

  static file(path: string): Uri {
    return new Uri("file", path);
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(value);
    return match
      ? new Uri(match[1] as string, match[2] as string)
      : new Uri("file", value);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ""), ...segments].join("/");
    return new Uri(base.scheme, joined);
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startLine: number | Position,
    startCharacter: number | Position,
    endLine?: number,
    endCharacter?: number,
  ) {
    if (startLine instanceof Position && startCharacter instanceof Position) {
      this.start = startLine;
      this.end = startCharacter;
    } else {
      this.start = new Position(startLine as number, startCharacter as number);
      this.end = new Position(endLine ?? 0, endCharacter ?? 0);
    }
  }

  get isEmpty(): boolean {
    return (
      this.start.line === this.end.line &&
      this.start.character === this.end.character
    );
  }
}

export class Selection extends Range {}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");

  constructor(readonly value: string) {}
}

export class CodeAction {
  command?: { command: string; title: string; arguments?: unknown[] };
  isPreferred?: boolean;

  constructor(
    readonly title: string,
    readonly kind?: CodeActionKind,
  ) {}
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

// ----------------------------------------------------------------------------
// Namespaces
// ----------------------------------------------------------------------------

export const window = {
  createTerminal(name: string) {
    const terminal: StubTerminal = {
      name,
      shown: false,
      sentText: [],
      disposed: false,
    };
    recorder.terminals.push(terminal);
    return {
      name,
      show: () => {
        terminal.shown = true;
      },
      sendText: (text: string) => {
        terminal.sentText.push(text);
      },
      dispose: () => {
        terminal.disposed = true;
      },
    };
  },

  createStatusBarItem(alignment: number, priority?: number) {
    const item: StubStatusBarItem = {
      text: "",
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
      alignment,
      priority,
      shown: false,
      disposed: false,
      show() {
        item.shown = true;
      },
      hide() {
        item.shown = false;
      },
      dispose() {
        item.disposed = true;
      },
    };
    recorder.statusBarItems.push(item);
    return item;
  },

  createOutputChannel(name: string) {
    return {
      name,
      append: () => {},
      appendLine: () => {},
      replace: () => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
    };
  },

  registerWebviewViewProvider(viewType: string, provider: unknown) {
    recorder.registeredWebviewViewProviders.push({ viewType, provider });
    return { dispose: () => {} };
  },

  showInformationMessage(text: string, ...actions: string[]) {
    recorder.informationMessages.push({ text, actions });
    return Promise.resolve(recorder.nextMessageChoice);
  },

  showWarningMessage(text: string, ...actions: string[]) {
    recorder.warningMessages.push({ text, actions });
    return Promise.resolve(recorder.nextMessageChoice);
  },

  showErrorMessage(text: string, ...actions: string[]) {
    recorder.errorMessages.push({ text, actions });
    return Promise.resolve(recorder.nextMessageChoice);
  },

  get activeTextEditor() {
    return recorder.activeTextEditor;
  },

  get visibleTextEditors() {
    return recorder.visibleTextEditors;
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    recorder.registeredCommands.set(id, handler);
    return {
      dispose: () => {
        recorder.registeredCommands.delete(id);
      },
    };
  },
  executeCommand(command: string, ...args: unknown[]) {
    recorder.executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  },
};

export const languages = {
  registerCodeActionsProvider(selector: unknown, provider: unknown) {
    recorder.registeredCodeActionProviders.push({ selector, provider });
    return { dispose: () => {} };
  },
};

export const env = {
  openExternal(uri: Uri) {
    recorder.openedExternal.push(uri.toString());
    return Promise.resolve(true);
  },
};

export const workspace = {
  workspaceFolders: undefined as unknown,
  textDocuments: [] as unknown[],
  getConfiguration() {
    return {
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
      update: () => Promise.resolve(),
    };
  },
  asRelativePath(path: string): string {
    return path;
  },
};

export const extensions = {
  getExtension() {
    return undefined;
  },
  all: [] as unknown[],
};

/**
 * The `chat` namespace. `createChatParticipant` is replaced with `undefined`
 * when `recorder.chatAvailable` is false, so the participant module's feature
 * detection can be exercised.
 */
export const chat = {
  get createChatParticipant():
    | ((id: string, handler: unknown) => unknown)
    | undefined {
    if (!recorder.chatAvailable) {
      return undefined;
    }
    return (id: string, handler: unknown) => {
      recorder.createdChatParticipants.push({ id, handler });
      return {
        id,
        iconPath: undefined,
        dispose: () => {},
      };
    };
  },
};

export class FileSystemError extends Error {
  readonly code: string;
  constructor(code = "Unknown") {
    super(code);
    this.code = code;
  }
}
