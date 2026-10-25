import { L } from '../i18n';
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { CMD, VIEW_ID } from '../../shared/protocol';
import type { AdviceAction, AdviceCard } from '../../shared/protocol';
import { parseAdvice } from '../ai/advice';
import { collectEditorSnippet, formatSnippet, type EditorSnippet } from '../ai/context';
import {
  commitPrompt,
  explainPrompt,
  fixPrompt,
  refactorPrompt,
  teachDepthLabel,
  teachPrompt,
  type TeachDepth,
} from '../ai/prompts';
import type { PetHost } from '../pet/host';
import { checkStyle, inferStyleProfile } from '../standards/profile';
import { getFixHistory } from '../history/fixHistory';
import { isPatchStale } from '../inline/patch';
import { truncate } from '../util';
import { baselineFor, verifyAfterEdit } from '../verify/verify';
import { showProposedDiff } from './diff';

const execFileAsync = promisify(execFile);

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
    host.say(L('先打开一个文件、选中一段代码，我才能看呀。', `Open a file and select some code first.`), { action: 'think' });
    await focusPet();
    return;
  }
  await focusPet();
  const label = snippet.hasSelection
    ? L(
        `讲解 ${snippet.relativePath} 第 ${snippet.startLine}-${snippet.endLine} 行`,
        `Explain ${snippet.relativePath} lines ${snippet.startLine}-${snippet.endLine}`,
      )
    : L(`讲解 ${snippet.relativePath} 附近的代码`, `Explain the code near ${snippet.relativePath}`);
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
    host.say(L('把光标放到出问题的地方，或选中一段代码，我来修。', `Put the cursor on the problem, or select some code, and I'll fix it.`), { action: 'think' });
    await focusPet();
    return;
  }
  await focusPet();

  const diagnostics = snippet.diagnostics.join('\n');
  const scope = snippet.hasSelection
    ? L(
        `${snippet.relativePath} 第 ${snippet.startLine}-${snippet.endLine} 行`,
        `${snippet.relativePath}, lines ${snippet.startLine}-${snippet.endLine}`,
      )
    : L(`${snippet.relativePath} 附近`, `near ${snippet.relativePath}`);
  const reply = await host.prompt(
    diagnostics
      ? L(`帮我看看 ${scope}（有报错）`, `Take a look at ${scope} (it has errors)`)
      : L(`帮我看看 ${scope}`, `Take a look at ${scope}`),
    `${fixPrompt(snippet.languageId, snippet.relativePath, diagnostics)}\n\n${formatSnippet(snippet)}`,
    { action: 'think' },
  );
  if (reply.trim()) {
    await offerReplacement(host, editor, snippet, reply, L('修复建议', 'Suggested fix'));
  }
}

async function refactor(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const snippet = editor ? collectEditorSnippet() : undefined;
  if (!editor || !snippet) {
    host.say(L('选中要重构的代码，我帮你收拾整齐。', `Select the code to refactor and I’ll tidy it up.`), { action: 'think' });
    await focusPet();
    return;
  }
  const goal = await vscode.window.showInputBox({
    title: L('重构目标（可留空）', 'Refactor goal (optional)'),
    placeHolder: L(
      '例如：拆成小函数、去掉重复逻辑、改用 async/await',
      'e.g. split into functions, remove duplication, switch to async/await',
    ),
    prompt: L('桌宠会按这个目标重写选中代码', 'DeskPet will rewrite the selection toward this goal'),
  });
  if (goal === undefined) {
    return;
  }
  await focusPet();
  const reply = await host.prompt(
    L(`重构 ${snippet.relativePath}（${goal || '更清晰'}）`, `Refactor ${snippet.relativePath} (${goal || 'cleaner'})`),
    `${refactorPrompt(snippet.languageId, goal)}\n\n${formatSnippet(snippet)}`,
    { action: 'think' },
  );
  if (reply.trim()) {
    await offerReplacement(host, editor, snippet, reply, L('重构建议', 'Refactor suggestion'));
  }
}

async function teach(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const snippet = editor ? collectEditorSnippet() : undefined;
  if (!editor || !snippet) {
    host.say(L('选中一段代码，我按“逐行 / 逻辑 / 设计”给你讲透。', `Select some code and I’ll teach it line by line, by logic, or by design.`), { action: 'think' });
    await focusPet();
    return;
  }

  const depth = await pickTeachDepth();
  if (!depth) {
    return;
  }

  await focusPet();
  const references = await referenceSummary(editor);
  const depthLabel = teachDepthLabel(depth);
  const label = L(
    `讲透 ${snippet.relativePath}（${depthLabel}）`,
    `Teach ${snippet.relativePath} (${depthLabel})`,
  );
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
    {
      label: L('$(list-ordered) 逐行讲解', '$(list-ordered) Line by line'),
      description: L('按行号讲清每一行在做什么', 'Explain what each line does, by line number'),
      value: 'line',
    },
    {
      label: L('$(git-branch) 逻辑梳理', '$(git-branch) Logic walkthrough'),
      description: L('按执行顺序拆步骤、标出副作用', 'Steps in execution order, with side effects called out'),
      value: 'logic',
    },
    {
      label: L('$(lightbulb) 设计思路', '$(lightbulb) Design notes'),
      description: L('为什么这样设计、以后怎么扩展', 'Why it is designed this way and how to extend it'),
      value: 'design',
    },
  ];
  items.sort((left, right) => (left.value === preferred ? -1 : right.value === preferred ? 1 : 0));

  const picked = await vscode.window.showQuickPick(items, {
    title: L('想怎么听？', 'How do you want it explained?'),
    placeHolder: L('桌宠会按这个深度讲解选中代码', 'DeskPet will use this depth for the selection'),
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
    problem: parsed.problem || L('模型没有给出问题描述。', 'The model did not describe the problem.'),
    cause: parsed.cause,
    plan: parsed.plan,
    impact: [
      parsed.impact,
      styleNotes.length ? `${L('风格提醒', 'Style note')}：${styleNotes.join(L('；', '; '))}` : '',
    ]
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
        host.notice(L('文件在你确认前发生了变化，请重新生成建议再应用。', `The file changed before you confirmed. Regenerate the suggestion before applying.`), 'warn');
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(item.documentUri, item.range, item.code);
      const beforeText = document.getText();
      const baseline = baselineFor(document, host.dependentsOf(document.uri));
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        host.resolveAdvice(id, action, false);
        host.notice(L('替换没有成功，文件可能已经变化，请重新生成建议。', `The replacement failed — the file may have changed. Please regenerate the suggestion.`), 'warn');
        return;
      }
      const afterText = document.getText();
      const meta = await getFixHistory()?.add(item.documentUri, beforeText, afterText, item.card.title);
      try {
        await document.save();
      } catch {
        // 保存失败时用户仍可手动保存
      }
      pendingAdvice.delete(id);
      host.resolveAdvice(id, action, true);
      host.say(L('已经按说明改好了，跑一下验证吧。', `Applied the change as described — go ahead and verify it.`), { action: 'happy' });
      void verifyAfterEdit(host, document, baseline, meta);
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
    host.say(L('没有打开工作区，找不到 Git 仓库。', `No workspace is open, so I can’t find a Git repository.`), { action: 'alert' });
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
    host.say(L('读不到 git diff，确认这个目录是 Git 仓库。', `Could not read git diff. Make sure this directory is a Git repository.`), { action: 'alert' });
    return;
  }
  if (!diff.trim()) {
    host.say(L('暂存区和工作区都没有改动，先写点代码吧。', `Nothing staged or modified yet — write some code first.`), { action: 'think' });
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
    L('帮我写一条 Git 提交信息', 'Write a Git commit message for me'),
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
  const fillLabel = L('填入 Git 提交框', 'Fill the Git input box');
  const copyLabel = L('复制全文', 'Copy full message');
  const action = await vscode.window.showInformationMessage(
    L(
      `提交信息已复制：${message.split('\n')[0]}`,
      `Commit message copied: ${message.split('\n')[0]}`,
    ),
    fillLabel,
    copyLabel,
  );
  if (action === fillLabel) {
    await fillScmInput(message);
  } else if (action === copyLabel) {
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

