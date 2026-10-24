import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { CMD, DIFF_SCHEME, VIEW_ID } from '../../shared/protocol';
import { collectEditorSnippet, formatSnippet, type EditorSnippet } from '../ai/context';
import { commitPrompt, explainPrompt, fixPrompt, refactorPrompt, testPrompt } from '../ai/prompts';
import type { PetHost } from '../pet/host';
import { extractCode, truncate } from '../util';

const execFileAsync = promisify(execFile);

/** 虚拟文档内容：用于并排 diff 预览，不落盘。 */
const previews = new Map<string, string>();

export const diffContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri) {
    return previews.get(uri.path) ?? '';
  },
};

export async function focusPet(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  } catch {
    // 视图可能被用户移动到别处，忽略
  }
}

export function registerAssistCommands(host: PetHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.explain, () => explain(host)),
    vscode.commands.registerCommand(CMD.fix, () => fix(host)),
    vscode.commands.registerCommand(CMD.refactor, () => refactor(host)),
    vscode.commands.registerCommand(CMD.tests, () => addTests(host)),
    vscode.commands.registerCommand(CMD.commitMessage, () => commitMessage(host)),
  ];
}

async function explain(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const snippet = editor ? collectEditorSnippet() : undefined;
  if (!editor || !snippet) {
    host.say('先打开一个文件、选中一段代码，我才能看呀。', { action: 'think' });
    await focusPet();
    return;
  }
  await focusPet();
  const label = snippet.hasSelection
    ? `讲解 ${snippet.relativePath} 第 ${snippet.startLine}-${snippet.endLine} 行`
    : `讲解 ${snippet.relativePath} 附近的代码`;
  await host.prompt(
    label,
    `${explainPrompt(snippet.languageId, snippet.relativePath)}\n\n${formatSnippet(snippet)}`,
    { action: 'think' },
  );
}

async function fix(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const snippet = editor ? collectEditorSnippet() : undefined;
  if (!editor || !snippet) {
    host.say('把光标放到出问题的地方，或选中一段代码，我来修。', { action: 'think' });
    await focusPet();
    return;
  }
  await focusPet();

  const diagnostics = snippet.diagnostics.join('\n');
  const scope = snippet.hasSelection
    ? `${snippet.relativePath} 第 ${snippet.startLine}-${snippet.endLine} 行`
    : `${snippet.relativePath} 附近`;
  const reply = await host.prompt(
    `帮我看看 ${scope}${diagnostics ? '（有报错）' : ''}`,
    `${fixPrompt(snippet.languageId, snippet.relativePath, diagnostics)}\n\n${formatSnippet(snippet)}`,
    { action: 'think' },
  );
  if (reply.trim()) {
    await offerReplacement(host, editor, snippet, reply, '修复建议');
  }
}

async function refactor(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const snippet = editor ? collectEditorSnippet() : undefined;
  if (!editor || !snippet) {
    host.say('选中要重构的代码，我帮你收拾整齐。', { action: 'think' });
    await focusPet();
    return;
  }
  const goal = await vscode.window.showInputBox({
    title: '重构目标（可留空）',
    placeHolder: '例如：拆成小函数、去掉重复逻辑、改用 async/await',
    prompt: '桌宠会按这个目标重写选中代码',
  });
  if (goal === undefined) {
    return;
  }
  await focusPet();
  const reply = await host.prompt(
    `重构 ${snippet.relativePath}（${goal || '更清晰'}）`,
    `${refactorPrompt(snippet.languageId, goal)}\n\n${formatSnippet(snippet)}`,
    { action: 'think' },
  );
  if (reply.trim()) {
    await offerReplacement(host, editor, snippet, reply, '重构建议');
  }
}

async function addTests(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const snippet = editor ? collectEditorSnippet() : undefined;
  if (!editor || !snippet) {
    host.say('先选中一段代码，我来给它们写测试。', { action: 'think' });
    await focusPet();
    return;
  }
  await focusPet();
  const reply = await host.prompt(
    `为 ${snippet.relativePath} 写测试`,
    `${testPrompt(snippet.languageId, snippet.relativePath)}\n\n${formatSnippet(snippet)}`,
    { action: 'think' },
  );
  if (!reply.trim()) {
    return;
  }
  const { code } = extractCode(reply);
  const document = await vscode.workspace.openTextDocument({
    content: code,
    language: testLanguageFor(snippet.languageId),
  });
  await vscode.window.showTextDocument(document, { preview: false });
  host.say('测试写好了，记得保存到项目里，再跑一遍看看。', { action: 'happy' });
}

async function offerReplacement(
  host: PetHost,
  editor: vscode.TextEditor,
  snippet: EditorSnippet,
  reply: string,
  title: string,
): Promise<void> {
  const document = editor.document;
  const { code } = extractCode(reply);
  if (!code.trim()) {
    return;
  }

  const summary = reply.replace(/```[\s\S]*?```/g, '').trim();
  const choice = await vscode.window.showInformationMessage(
    `桌宠给出了${title}${summary ? `：${truncate(summary, 120)}` : ''}`,
    { modal: false },
    '应用替换',
    '查看差异',
    '复制代码',
  );

  if (choice === '应用替换') {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, snippet.range, code);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      await document.save();
      host.say('已经帮你改好啦，跑一下看看？', { action: 'happy' });
    } else {
      host.say('替换没成功，可能是文件被改过了，再来一次？', { action: 'alert' });
    }
    return;
  }

  if (choice === '查看差异') {
    await showDiff(document, snippet, code, title);
    return;
  }

  if (choice === '复制代码') {
    await vscode.env.clipboard.writeText(code);
    host.say('代码已经复制到剪贴板。', { action: 'happy' });
  }
}

async function showDiff(
  document: vscode.TextDocument,
  snippet: EditorSnippet,
  code: string,
  title: string,
): Promise<void> {
  const full = document.getText();
  const start = document.offsetAt(snippet.range.start);
  const end = document.offsetAt(snippet.range.end);
  const proposed = full.slice(0, start) + code + full.slice(end);

  const ext = path.extname(document.fileName) || '.txt';
  const id = `/${crypto.randomUUID()}${ext}`;
  previews.set(id, proposed);
  const right = vscode.Uri.parse(`${DIFF_SCHEME}:${id}`);
  await vscode.commands.executeCommand(
    'vscode.diff',
    document.uri,
    right,
    `${title} · ${path.basename(document.fileName)}`,
    { preview: true },
  );
}

// ------------------------------------------------------------------ Git

interface GitAPI {
  repositories: Array<{
    inputBox: { value: string };
    state: { HEAD?: { name?: string } };
  }>;
}

async function commitMessage(host: PetHost): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    host.say('没有打开工作区，找不到 Git 仓库。', { action: 'alert' });
    return;
  }
  const cwd = folder.uri.fsPath;

  let diff = '';
  try {
    diff = (await execFileAsync('git', ['--no-pager', 'diff', '--cached'], { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;
    if (!diff.trim()) {
      diff = (await execFileAsync('git', ['--no-pager', 'diff'], { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;
    }
  } catch (error) {
    host.say('读不到 git diff，确认这个目录是 Git 仓库。', { action: 'alert' });
    return;
  }
  if (!diff.trim()) {
    host.say('暂存区和工作区都没有改动，先写点代码吧。', { action: 'think' });
    return;
  }

  let branch = '';
  try {
    branch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
  } catch {
    // 忽略
  }

  await focusPet();
  const reply = await host.prompt(
    '帮我写一条 Git 提交信息',
    commitPrompt(truncate(diff, 14_000), branch),
    { action: 'think' },
  );
  const message = reply
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .trim();
  if (!message) {
    return;
  }

  await vscode.env.clipboard.writeText(message);
  const action = await vscode.window.showInformationMessage(
    `提交信息已复制：${message.split('\n')[0]}`,
    '填入 Git 提交框',
    '复制全文',
  );
  if (action === '填入 Git 提交框') {
    await fillScmInput(message);
  } else if (action === '复制全文') {
    await vscode.env.clipboard.writeText(message);
  }
}

async function fillScmInput(message: string): Promise<void> {
  try {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitAPI }>('vscode.git');
    if (!extension) {
      return;
    }
    if (!extension.isActive) {
      await extension.activate();
    }
    const api = extension.exports.getAPI(1);
    const repo = api.repositories[0];
    if (repo) {
      repo.inputBox.value = message;
    }
  } catch {
    // 没装 Git 扩展时静默失败，剪贴板里已经有内容了
  }
}

function testLanguageFor(languageId: string): string {
  const map: Record<string, string> = {
    typescriptreact: 'typescript',
    javascriptreact: 'javascript',
    vue: 'javascript',
    svelte: 'javascript',
  };
  return map[languageId] ?? languageId;
}
