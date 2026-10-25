import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { CMD, DIFF_SCHEME, VIEW_ID } from '../../shared/protocol';
import type { AdviceAction, AdviceCard } from '../../shared/protocol';
import { parseAdvice } from '../ai/advice';
import { collectEditorSnippet, formatSnippet, type EditorSnippet } from '../ai/context';
import {
  commitPrompt,
  explainPrompt,
  fixPrompt,
  refactorPrompt,
  TEACH_DEPTH_LABEL,
  teachPrompt,
  type TeachDepth,
} from '../ai/prompts';
import type { PetHost } from '../pet/host';
import { checkStyle, inferStyleProfile } from '../standards/profile';
import { isPatchStale } from '../inline/patch';
import { truncate } from '../util';

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
    vscode.commands.registerCommand(CMD.teach, () => teach(host)),
    vscode.commands.registerCommand(CMD.fix, () => fix(host)),
    vscode.commands.registerCommand(CMD.refactor, () => refactor(host)),
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

async function teach(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const snippet = editor ? collectEditorSnippet() : undefined;
  if (!editor || !snippet) {
    host.say('选中一段代码，我按“逐行 / 逻辑 / 设计”给你讲透。', { action: 'think' });
    await focusPet();
    return;
  }

  const depth = await pickTeachDepth();
  if (!depth) {
    return;
  }

  await focusPet();
  const references = await referenceSummary(editor);
  const label = `讲透 ${snippet.relativePath}（${TEACH_DEPTH_LABEL[depth]}）`;
  await host.prompt(
    label,
    [
      teachPrompt(snippet.languageId, snippet.relativePath, depth, references),
      '',
      formatSnippet(snippet),
    ].join('\n'),
    { action: 'think' },
  );
}

async function pickTeachDepth(): Promise<TeachDepth | undefined> {
  const config = vscode.workspace.getConfiguration('deskpet');
  const preferred = config.get<TeachDepth>('teach.depth', 'line');
  const items: Array<vscode.QuickPickItem & { value: TeachDepth }> = [
    { label: '$(list-ordered) 逐行讲解', description: '按行号讲清每一行在做什么', value: 'line' },
    { label: '$(git-branch) 逻辑梳理', description: '按执行顺序拆步骤、标出副作用', value: 'logic' },
    { label: '$(lightbulb) 设计思路', description: '为什么这样设计、以后怎么扩展', value: 'design' },
  ];
  items.sort((left, right) => (left.value === preferred ? -1 : right.value === preferred ? 1 : 0));

  const picked = await vscode.window.showQuickPick(items, {
    title: '想怎么听？',
    placeHolder: '桌宠会按这个深度讲解选中代码',
  });
  return picked?.value;
}

/** 取光标处符号的引用位置，帮模型讲清“谁在用它”。 */
async function referenceSummary(editor: vscode.TextEditor): Promise<string> {
  try {
    const locations = (await vscode.commands.executeCommand(
      'vscode.executeReferenceProvider',
      editor.document.uri,
      editor.selection.active,
    )) as vscode.Location[] | undefined;
    if (!locations?.length) {
      return '';
    }
    return locations
      .slice(0, 8)
      .map((location) => {
        const rel = vscode.workspace.asRelativePath(location.uri, false);
        return `${rel}:${location.range.start.line + 1}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

export async function offerReplacement(
  host: PetHost,
  editor: vscode.TextEditor,
  snippet: EditorSnippet,
  reply: string,
  title: string,
): Promise<void> {
  await presentPatch(host, editor.document, snippet, reply, title);
}

/** 从任意文档 + 范围构造一个“可替换片段”，供报错修复等流程复用。 */
export function snippetFromRange(
  document: vscode.TextDocument,
  range: vscode.Range,
  diagnostics: string[] = [],
): EditorSnippet {
  return {
    fileName: document.fileName,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    code: document.getText(range),
    hasSelection: true,
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    range,
    diagnostics,
  };
}

/**
 * 把模型的回复变成一张“变更说明”卡片。
 * autoDiff 只给用户主动发起的修复流程用，避免凭空打开编辑器。
 */
export async function presentPatch(
  host: PetHost,
  document: vscode.TextDocument,
  snippet: EditorSnippet,
  reply: string,
  title: string,
  options: { autoDiff?: boolean } = {},
): Promise<void> {
  const parsed = parseAdvice(reply);
  if (!parsed.code.trim()) {
    return;
  }

  const id = crypto.randomUUID();
  const styleNotes = checkStyle(parsed.code, inferStyleProfile(document.getText()));
  const card: AdviceCard = {
    id,
    title,
    file: vscode.workspace.asRelativePath(document.uri, false),
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    problem: parsed.problem || '模型没有给出问题描述。',
    cause: parsed.cause,
    plan: parsed.plan,
    impact: [parsed.impact, styleNotes.length ? `风格提醒：${styleNotes.join('；')}` : '']
      .filter(Boolean)
      .join('\n'),
  };

  const item: PendingAdvice = {
    documentUri: document.uri,
    range: snippet.range,
    originalText: document.getText(snippet.range),
    code: parsed.code,
    card,
  };
  pendingAdvice.set(id, item);

  // 不是弹窗，而是在对话里放一张“变更说明”卡片，用户自己决定下一步
  host.presentAdvice(card);
  if (options.autoDiff) {
    await showDiff(item);
  }
}

interface PendingAdvice {
  documentUri: vscode.Uri;
  range: vscode.Range;
  originalText: string;
  code: string;
  card: AdviceCard;
}

const pendingAdvice = new Map<string, PendingAdvice>();

/** 把卡片上的「看差异 / 应用 / 复制 / 忽略」接到具体动作上。 */
export function bindAdviceActions(host: PetHost): void {
  host.setAdviceHandler(async (id, action: AdviceAction) => {
    const item = pendingAdvice.get(id);
    if (!item) {
      host.resolveAdvice(id, action, false);
      return;
    }

    if (action === 'apply') {
      const document = await vscode.workspace.openTextDocument(item.documentUri);
      // 用户看建议的这段时间里文件可能被改过，范围失效就拒绝应用
      if (isPatchStale(document.getText(item.range), item.originalText)) {
        host.resolveAdvice(id, action, false);
        host.notice('文件在你确认前发生了变化，请重新生成建议再应用。', 'warn');
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(item.documentUri, item.range, item.code);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        host.resolveAdvice(id, action, false);
        host.notice('替换没有成功，文件可能已经变化，请重新生成建议。', 'warn');
        return;
      }
      try {
        await document.save();
      } catch {
        // 保存失败时用户仍可手动保存
      }
      pendingAdvice.delete(id);
      host.resolveAdvice(id, action, true);
      host.say('已经按说明改好了，跑一下验证吧。', { action: 'happy' });
      return;
    }

    if (action === 'diff') {
      await showDiff(item);
      host.resolveAdvice(id, action, true);
      return;
    }

    if (action === 'copy') {
      await vscode.env.clipboard.writeText(item.code);
      host.resolveAdvice(id, action, true);
      return;
    }

    pendingAdvice.delete(id);
    host.resolveAdvice(id, action, true);
  });
}

async function showDiff(item: PendingAdvice): Promise<void> {
  const document = await vscode.workspace.openTextDocument(item.documentUri);
  await showProposedDiff(document, item.range, item.code, item.card.title);
}

/** 打开“原文 vs 建议”的并排 diff，供行内对话和规范整改复用。 */
export async function showProposedDiff(
  document: vscode.TextDocument,
  range: vscode.Range,
  code: string,
  title: string,
): Promise<void> {
  const full = document.getText();
  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
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

