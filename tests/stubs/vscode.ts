/**
 * 单元测试用的最小 vscode 桩。只实现被测模块真正用到的 API，
 * 配置通过 configStore 注入，测完用 resetConfig() 清空。
 */
export const configStore: Record<string, unknown> = {};

export const env = { language: 'en' };

export function resetConfig(values: Record<string, unknown> = {}): void {
  for (const key of Object.keys(configStore)) {
    delete configStore[key];
  }
  Object.assign(configStore, values);
}

export const workspace = {
  getConfiguration: () => ({
    get: (key: string, fallback?: unknown) => (key in configStore ? configStore[key] : fallback),
    update: async () => undefined,
  }),
  asRelativePath: (value: unknown) => (typeof value === 'string' ? value : String(value)),
  findFiles: async () => [],
  openTextDocument: async () => ({}),
  fs: {
    stat: async () => ({ size: 0 }),
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
  },
  onDidChangeConfiguration: () => new Disposable(),
  onDidSaveTextDocument: () => new Disposable(),
  onDidChangeTextDocument: () => new Disposable(),
};

export const commands = {
  executeCommand: async () => [] as unknown,
  registerCommand: () => new Disposable(),
};

export const window = {
  activeTextEditor: undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showTextDocument: async () => ({}),
  setStatusBarMessage: () => undefined,
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
};

export class Range {
  constructor(
    public readonly startLine: number,
    public readonly startCharacter: number,
    public readonly endLine: number,
    public readonly endCharacter: number,
  ) {}
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Selection {
  constructor(
    public readonly anchor: Position,
    public readonly active: Position,
  ) {}
  get isEmpty() {
    return this.anchor.line === this.active.line && this.anchor.character === this.active.character;
  }
}

export class Uri {
  constructor(public readonly fsPath: string) {}

  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static parse(value: string): Uri {
    return new Uri(value);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.fsPath, ...parts].join('/'));
  }

  toString(): string {
    return this.fsPath;
  }
}

export class Disposable {
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    this.onDispose?.();
  }
}

export class MarkdownString {
  constructor(public value = '') {}
  isTrusted: boolean | { enabledCommands: string[] } = false;
}

export const CommentMode = { Preview: 0, Editing: 1 };
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
export const SymbolKind = { File: 0, Module: 1, Class: 4, Method: 5, Constructor: 8, Function: 11 };
export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const ViewColumn = { One: 1, Beside: 2 };
export const languages = {
  getDiagnostics: () => [],
  onDidChangeDiagnostics: () => new Disposable(),
};
