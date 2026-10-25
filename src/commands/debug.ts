import { L } from '../i18n';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { diagnosticPrompt, failurePrompt, fixPrompt, reviewPrompt } from '../ai/prompts';
import { looksLikeFailure, parseFailure, type ParsedFailure } from '../debug/stackTrace';
import { getLastFailure } from '../debug/terminalLog';
import type { PetHost } from '../pet/host';
import { focusPet, presentPatch, snippetFromRange } from './assist';

interface FrameHit {
  file: string;
  line: number;
  uri: vscode.Uri;
}

export function registerDebugCommands(host: PetHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.explainDiagnostic, (args?: { line?: number }) =>
      explainDiagnostic(host, args?.line),
    ),
    vscode.commands.registerCommand(CMD.fixDiagnostic, (args?: { line?: number }) =>
      fixDiagnostic(host, args?.line),
    ),
    vscode.commands.registerCommand(CMD.analyzeFailure, () => analyzeLastFailure(host)),
    vscode.commands.registerCommand(CMD.analyzeClipboard, () => analyzeClipboard(host)),
    vscode.commands.registerCommand(CMD.reviewFile, () => reviewFile(host)),
  ];
}

// ------------------------------------------------------------------ 诊断解释

async function explainDiagnostic(host: PetHost, line?: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say(L('先打开出错的文件，再用这个命令。', `Open the file with the error first, then run this command.`), { action: 'think' });
    return;
  }

  const targetLine = line ?? editor.selection.active.line + 1;
  const picked = pickDiagnostics(editor.document, targetLine);
  if (!picked.length) {
    host.say(L(`第 ${targetLine} 行附近没有诊断信息。`, `No diagnostics near line ${targetLine}.`), { action: 'think' });
    return;
  }

  await focusPet();
  const range = await enclosingRange(editor.document, targetLine - 1);
  const snippet = snippetFromRange(editor.document, range, picked.map(describeDiagnostic));
  await host.prompt(
    L(
      `解释 ${snippet.relativePath} 第 ${targetLine} 行的报错`,
      `Explain the error at ${snippet.relativePath}:${targetLine}`,
    ),
    diagnosticPrompt(picked.map(toPromptDiagnostic), toPromptSnippet(snippet)),
    { action: 'think' },
  );
}

async function fixDiagnostic(host: PetHost, line?: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say(L('先打开出错的文件，再用这个命令。', `Open the file with the error first, then run this command.`), { action: 'think' });
    return;
  }

  const targetLine = line ?? editor.selection.active.line + 1;
  const picked = pickDiagnostics(editor.document, targetLine);
  if (!picked.length) {
    host.say(L(`第 ${targetLine} 行附近没有诊断信息。`, `No diagnostics near line ${targetLine}.`), { action: 'think' });
    return;
  }

  await focusPet();
  const range = await enclosingRange(editor.document, targetLine - 1);
  const snippet = snippetFromRange(editor.document, range, picked.map(describeDiagnostic));
  const reply = await host.prompt(
    L(
      `修 ${snippet.relativePath} 第 ${targetLine} 行的报错`,
      `Fix the error at ${snippet.relativePath}:${targetLine}`,
    ),
    [
      fixPrompt(snippet.languageId, snippet.relativePath, picked.map(describeDiagnostic).join('\n')),
      '',
      L(
        `代码（第 ${snippet.startLine}-${snippet.endLine} 行，整段替换）：`,
        `Code (lines ${snippet.startLine}-${snippet.endLine}, replace the whole block):`,
      ),
      '```' + snippet.languageId,
      snippet.code,
      '```',
    ].join('\n'),
    { action: 'think' },
  );

  if (reply.trim()) {
    await presentPatch(host, editor.document, snippet, reply, L('报错修复', 'Error fix'), {
      autoDiff: vscode.workspace.getConfiguration('deskpet').get<boolean>('fix.autoDiff', true),
    });
  }
}

// ------------------------------------------------------------------ 堆栈 / 日志

async function analyzeClipboard(host: PetHost): Promise<void> {
  const text = await vscode.env.clipboard.readText();
  if (!text.trim()) {
    host.say(L('剪贴板是空的。先把报错日志或堆栈复制过来吧。', `The clipboard is empty. Copy an error log or stack trace first.`), { action: 'think' });
    return;
  }
  await analyzeText(host, text, L('剪贴板', 'Clipboard'));
}

async function analyzeLastFailure(host: PetHost): Promise<void> {
  const failure = getLastFailure();
  if (!failure) {
    host.say(L('最近没有捕获到失败的命令输出。也可以直接复制报错，用「分析剪贴板里的报错」。', `No failed command output was captured recently. You can also copy the error and use “Analyze clipboard error”.`), {
      action: 'think',
    });
    return;
  }
  const exit =
    typeof failure.exitCode === 'number'
      ? L(`（退出码 ${failure.exitCode}）`, ` (exit code ${failure.exitCode})`)
      : '';
  await analyzeText(host, failure.output, L(`命令失败${exit}`, `Command failed${exit}`));
}

async function analyzeText(host: PetHost, text: string, sourceLabel: string): Promise<void> {
  const failure = parseFailure(text);
  if (!failure) {
    // 没有堆栈也允许分析纯日志，只是无法自动定位文件
    const fallback: ParsedFailure = {
      language: 'unknown',
      message: text.split('\n').find((line) => line.trim())?.trim().slice(0, 160) ?? '',
      frames: [],
      raw: text,
    };
    await runFailureFlow(host, fallback, sourceLabel);
    return;
  }
  await runFailureFlow(host, failure, sourceLabel);
}

async function runFailureFlow(host: PetHost, failure: ParsedFailure, sourceLabel: string): Promise<void> {
  await focusPet();

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const hits: FrameHit[] = [];
  for (const frame of failure.frames.slice(0, 5)) {
    const hit = await resolveFrame(frame.file, frame.line, root);
    if (hit && !hits.some((item) => item.uri.toString() === hit.uri.toString() && item.line === hit.line)) {
      hits.push(hit);
    }
  }

  let primaryDoc: vscode.TextDocument | undefined;
  let primarySnippet: ReturnType<typeof snippetFromRange> | undefined;
  let related = '';

  if (hits.length) {
    const primary = hits[0];
    try {
      primaryDoc = await vscode.workspace.openTextDocument(primary.uri);
      const range = await enclosingRange(primaryDoc, Math.max(0, primary.line - 1));
      primarySnippet = snippetFromRange(primaryDoc, range);
      host.notice(
        L(
          `已定位：${vscode.workspace.asRelativePath(primary.uri, false)}:${primary.line}`,
          `Located: ${vscode.workspace.asRelativePath(primary.uri, false)}:${primary.line}`,
        ) +
          (hits.length > 1
            ? L(`，另有 ${hits.length - 1} 处调用位置`, ` (+${hits.length - 1} more call sites)`)
            : ''),
      );
      related = await relatedSnippets(hits.slice(1));
    } catch {
      primaryDoc = undefined;
      primarySnippet = undefined;
    }
  } else {
    host.notice(L('堆栈里没有定位到工作区内的文件，这次只做解释，不会自动改代码。', `No workspace file was located in the stack trace, so this will only explain — no code changes.`), 'warn');
  }

  const reply = await host.prompt(
    L(
      `${sourceLabel}：${failure.message.slice(0, 90) || '分析报错'}`,
      `${sourceLabel}: ${failure.message.slice(0, 90) || 'analyze the error'}`,
    ),
    failurePrompt(
      { language: failure.language, message: failure.message, raw: failure.raw },
      primarySnippet ? toPromptSnippet(primarySnippet) : undefined,
      related,
    ),
    { action: 'think' },
  );

  if (reply.trim() && primaryDoc && primarySnippet) {
    await presentPatch(host, primaryDoc, primarySnippet, reply, L('报错修复', 'Error fix'), {
      autoDiff: vscode.workspace.getConfiguration('deskpet').get<boolean>('fix.autoDiff', true),
    });
  }
}

async function relatedSnippets(hits: FrameHit[]): Promise<string> {
  const blocks: string[] = [];
  for (const hit of hits.slice(0, 2)) {
    try {
      const document = await vscode.workspace.openTextDocument(hit.uri);
      const start = Math.max(0, hit.line - 5);
      const end = Math.min(document.lineCount, hit.line + 4);
      const text = document.getText(new vscode.Range(start, 0, end, 0)).trim();
      if (text) {
        blocks.push(
          `${vscode.workspace.asRelativePath(hit.uri, false)}:${hit.line}\n\`\`\`${document.languageId}\n${text}\n\`\`\``,
        );
      }
    } catch {
      // 打不开就跳过
    }
  }
  return blocks.join('\n\n');
}

async function resolveFrame(file: string, line: number, root: string | undefined): Promise<FrameHit | undefined> {
  const candidates: string[] = [];
  if (path.isAbsolute(file)) {
    candidates.push(file);
  } else if (root) {
    candidates.push(path.join(root, file));
  }

  for (const candidate of candidates) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      return { file, line, uri: vscode.Uri.file(candidate) };
    } catch {
      // 继续尝试下一种写法
    }
  }

  const base = path.basename(file);
  if (!base || base.includes('..')) {
    return undefined;
  }
  try {
    const found = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 5);
    if (!found.length) {
      return undefined;
    }
    const suffix = file.replace(/\\/g, '/').replace(/^\.\//, '');
    const matched = found.find((uri) => uri.fsPath.replace(/\\/g, '/').endsWith(suffix)) ?? found[0];
    return { file, line, uri: matched };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ 静态体检

async function reviewFile(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say(L('先打开要体检的文件。', `Open the file to review first.`), { action: 'think' });
    return;
  }
  const document = editor.document;
  if (document.getText().length > 60_000) {
    host.say(L('这个文件太大了，先选中要检查的片段再试。', `This file is too large. Select the part to check first.`), { action: 'think' });
    return;
  }

  await focusPet();
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  await host.prompt(
    L(`体检 ${relative}`, `Review ${relative}`),
    reviewPrompt(relative, document.languageId, document.getText()),
    { action: 'think' },
  );
}

// ------------------------------------------------------------------ 工具

/** 找到包含指定行的最小符号（函数/方法），控制替换范围。 */
export async function enclosingRange(document: vscode.TextDocument, line: number): Promise<vscode.Range> {
  try {
    const symbols = (await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    )) as vscode.DocumentSymbol[] | undefined;
    let best: vscode.Range | undefined;

    const walk = (items: vscode.DocumentSymbol[]) => {
      for (const symbol of items) {
        if (symbol.range.start.line <= line && symbol.range.end.line >= line) {
          if (!best || symbol.range.start.line >= best.start.line) {
            best = symbol.range;
          }
          if (symbol.children?.length) {
            walk(symbol.children as vscode.DocumentSymbol[]);
          }
        }
      }
    };
    walk(symbols ?? []);

    if (best && best.end.line - best.start.line <= 240) {
      return best;
    }
  } catch {
    // 语言服务不可用就退回行窗口
  }

  const start = Math.max(0, line - 10);
  const end = Math.min(document.lineCount - 1, line + 20);
  return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
}

function pickDiagnostics(document: vscode.TextDocument, line: number): vscode.Diagnostic[] {
  const all = vscode.languages.getDiagnostics(document.uri);
  if (!all.length) {
    return [];
  }
  const exact = all.filter((item) => item.range.start.line + 1 === line);
  if (exact.length) {
    return exact.slice(0, 3);
  }
  const nearest = [...all].sort(
    (left, right) =>
      Math.abs(left.range.start.line + 1 - line) - Math.abs(right.range.start.line + 1 - line),
  );
  return nearest.slice(0, 2);
}

function describeDiagnostic(diagnostic: vscode.Diagnostic): string {
  const severity =
    diagnostic.severity === vscode.DiagnosticSeverity.Error
      ? 'error'
      : diagnostic.severity === vscode.DiagnosticSeverity.Warning
        ? 'warning'
        : 'info';
  return `[${severity}] 第 ${diagnostic.range.start.line + 1} 行：${diagnostic.message}`;
}

function toPromptDiagnostic(diagnostic: vscode.Diagnostic) {  const severity =
    diagnostic.severity === vscode.DiagnosticSeverity.Error
      ? 'error'
      : diagnostic.severity === vscode.DiagnosticSeverity.Warning
        ? 'warning'
        : 'info';
  return {
    message: diagnostic.message,
    severity,
    source: diagnostic.source,
    line: diagnostic.range.start.line + 1,
  };
}

export function isFailureText(text: string): boolean {
  return looksLikeFailure(text);
}

function toPromptSnippet(snippet: ReturnType<typeof snippetFromRange>) {
  return {
    file: snippet.relativePath,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    languageId: snippet.languageId,
    code: snippet.code,
  };
}
