import * as vscode from 'vscode';
import { shortenPath, truncate } from '../util';

export interface EditorSnippet {
  fileName: string;
  relativePath: string;
  languageId: string;
  code: string;
  hasSelection: boolean;
  startLine: number;
  endLine: number;
  /** 0 基、含首尾字符，用于后续替换 */
  range: vscode.Range;
  diagnostics: string[];
}

/**
 * 取当前编辑器里“用户正在看的东西”：选区优先，没有选区就取光标附近的上下文。
 */
export function collectEditorSnippet(maxChars = 8000): EditorSnippet | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const document = editor.document;
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;

  const range = hasSelection
    ? new vscode.Range(selection.start, selection.end)
    : caretWindow(document, selection.active.line, 60);

  const code = truncate(document.getText(range), maxChars);
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .slice(0, 12)
    .map((diagnostic) => {
      const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Info';
      const line = diagnostic.range.start.line + 1;
      return `[${severity}] 第 ${line} 行：${diagnostic.message}`;
    });

  return {
    fileName: document.fileName,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    code,
    hasSelection,
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    range,
    diagnostics,
  };
}

function caretWindow(document: vscode.TextDocument, line: number, radius: number): vscode.Range {
  const start = Math.max(0, line - radius);
  const end = Math.min(document.lineCount - 1, line + radius);
  return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
}

export function formatSnippet(snippet: EditorSnippet): string {
  const header = `文件：${snippet.relativePath}（${snippet.languageId}，第 ${snippet.startLine}-${snippet.endLine} 行）`;
  return `${header}\n\`\`\`${snippet.languageId}\n${snippet.code}\n\`\`\``;
}

export function workspaceSummary(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const names = folders.map((folder) => folder.name);
  const editor = vscode.window.activeTextEditor;
  const active = editor ? shortenPath(vscode.workspace.asRelativePath(editor.document.uri, false)) : '无';
  return `工作区：${names.length ? names.join('、') : '（未打开文件夹）'}；当前文件：${active}`;
}

export function activeLanguageId(): string {
  return vscode.window.activeTextEditor?.document.languageId ?? 'text';
}

/** 供“查资料”使用：把用户问题里出现的标识符补上语言线索。 */
export function docsQueryContext(): string {
  const config = vscode.workspace.getConfiguration('deskpet');
  const provider = config.get<string>('ai.provider', 'ollama');
  return `当前项目语言：${activeLanguageId()}；AI 提供方：${provider}`;
}
