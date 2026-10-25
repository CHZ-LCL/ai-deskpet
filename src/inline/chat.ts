import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { parseAdvice } from '../ai/advice';
import { checkStyle, inferStyleProfile } from '../standards/profile';
import { showProposedDiff } from '../commands/diff';
import { enclosingRange } from '../commands/debug';
import type { PetHost } from '../pet/host';
import { getFixHistory } from '../history/fixHistory';
import { baselineFor, verifyAfterEdit } from '../verify/verify';
import { isPatchStale } from './patch';
import { L } from '../i18n';

interface InlinePatch {
  uri: vscode.Uri;
  range: vscode.Range;
  originalText: string;
  code: string;
}

export interface InlineArgs {
  startLine?: number;
  startChar?: number;
  endLine?: number;
  endChar?: number;
  prompt?: string;
}

const pending = new Map<string, InlinePatch>();
const threads = new Map<string, vscode.CommentThread>();

/**
 * 行内对话：答案直接挂在代码旁的评论线程里，不切侧边栏。
 * 有补丁时在同一位置给出「应用修改 / 查看差异」，这是最少的上下文切换。
 */
export function registerInlineChat(context: vscode.ExtensionContext, host: PetHost): void {
  const controller = vscode.comments.createCommentController(
    'deskpet.inline',
    L('AI 桌宠', 'AI DeskPet'),
  );
  controller.options = {
    prompt: L('继续追问（当前版本只支持一次性回答）', 'Ask a follow-up (single-turn for now)'),
  };
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD.inlineChat, (args?: InlineArgs) => runInlineChat(host, controller, args)),
    vscode.commands.registerCommand(CMD.inlineApply, (args?: { id?: string }) => applyInline(args?.id, host)),
    vscode.commands.registerCommand(CMD.inlineDiff, (args?: { id?: string }) => diffInline(args?.id)),
  );
}

async function runInlineChat(
  host: PetHost,
  controller: vscode.CommentController,
  args?: InlineArgs,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const document = editor.document;

  const range = await resolveRange(editor, args);
  const code = document.getText(range);
  if (!code.trim()) {
    return;
  }

  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const question =
    args?.prompt ??
    (await vscode.window.showInputBox({
      title: L(`行内对话 · ${relative}:${range.start.line + 1}`, `Inline chat · ${relative}:${range.start.line + 1}`),
      prompt: L('想让桌宠做什么？', 'What should DeskPet do?'),
      placeHolder: L(
        '解释这段 / 重构成 async / 为什么这里会空指针…',
        'Explain this / refactor to async / why is this null…',
      ),
      ignoreFocusOut: true,
    }));
  if (!question?.trim()) {
    return;
  }

  const key = document.uri.toString();
  threads.get(key)?.dispose();

  const anchorLine = Math.min(range.start.line, document.lineCount - 1);
  const anchor = new vscode.Range(
    anchorLine,
    0,
    anchorLine,
    document.lineAt(anchorLine).text.length,
  );
  const thread = controller.createCommentThread(document.uri, anchor, []);
  thread.canReply = false;
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  thread.label = question.length > 36 ? `${question.slice(0, 36)}…` : question;
  threads.set(key, thread);

  const comment: vscode.Comment = {
    body: '',
    mode: vscode.CommentMode.Preview,
    author: { name: L('AI 桌宠', 'AI DeskPet') },
  };
  thread.comments = [comment];

  let text = '';
  let timer: NodeJS.Timeout | undefined;
  const render = (body: string) => {
    const markdown = new vscode.MarkdownString(body);
    markdown.isTrusted = { enabledCommands: [CMD.inlineApply, CMD.inlineDiff] };
    comment.body = markdown;
    thread.comments = [comment];
  };

  render(L('_思考中…_', '_Thinking…_'));

  const request = [
    question,
    '',
    L(
      `代码（${relative}，第 ${range.start.line + 1}-${range.end.line + 1} 行）：`,
      `Code (${relative}, lines ${range.start.line + 1}-${range.end.line + 1}):`,
    ),
    '```' + document.languageId,
    code,
    '```',
    '',
    L(
      '回答尽量短，代码放代码块。如果需要修改这段代码，请按【问题】【原因】【方案】【影响】组织，然后给出完整替换代码。',
      'Keep the answer short and put code in fenced blocks. If the code needs changing, organize it as 【问题】【原因】【方案】【影响】 and then give the complete replacement.',
    ),
  ].join('\n');

  let reply = '';
  try {
    reply = await host.askInline(request, (delta) => {
      text += delta;
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        render(`${text}\n\n${L('(生成中…)', '(generating…)')}`);
      }, 160);
    });
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    render(
      L(
        `**出错了**：${error instanceof Error ? error.message : String(error)}`,
        `**Error**: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return;
  }

  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }

  text = reply || text;
  const parsed = parseAdvice(text);
  const hasPatch = Boolean(parsed.code.trim()) && looksLikeMutation(question, text);

  if (!hasPatch) {
    render(text || L('_没有返回内容_', '_No content returned_'));
    return;
  }

  const id = crypto.randomUUID();
  pending.set(id, {
    uri: document.uri,
    range,
    originalText: code,
    code: parsed.code,
  });

  const notes = checkStyle(parsed.code, inferStyleProfile(document.getText()));
  const encoded = encodeURIComponent(JSON.stringify({ id }));
  const footer = [
    '',
    '---',
    L(
      `[应用修改](command:${CMD.inlineApply}?${encoded}) · [查看差异](command:${CMD.inlineDiff}?${encoded})`,
      `[Apply change](command:${CMD.inlineApply}?${encoded}) · [View diff](command:${CMD.inlineDiff}?${encoded})`,
    ),
    notes.length ? `\n${L('风格提醒', 'Style note')}: ${notes.join(L('；', '; '))}` : '',
  ].join('\n');

  // 小结 + 补丁放在同一条线程里，代码块可折叠阅读
  const summary = [
    parsed.problem ? `**${L('问题', 'Problem')}**${L('：', ': ')}${parsed.problem}` : '',
    parsed.cause ? `**${L('原因', 'Cause')}**${L('：', ': ')}${parsed.cause}` : '',
    parsed.plan ? `**${L('方案', 'Plan')}**${L('：', ': ')}${parsed.plan}` : '',
    parsed.impact ? `**${L('影响', 'Impact')}**${L('：', ': ')}${parsed.impact}` : '',
    '',
    '```' + document.languageId,
    parsed.code,
    '```',
    footer,
  ]
    .filter(Boolean)
    .join('\n');

  render(summary);

  // 评论里的命令链接未必在所有主题/版本可用，再给一个原生的轻提示兜底
  const applyLabel = L('应用修改', 'Apply change');
  const diffLabel = L('查看差异', 'View diff');
  const copyLabel = L('复制代码', 'Copy code');
  const choice = await vscode.window.showInformationMessage(
    L('桌宠给出了修改建议', 'DeskPet suggested a change'),
    applyLabel,
    diffLabel,
    copyLabel,
  );
  if (choice === applyLabel) {
    await applyInline(id);
  } else if (choice === diffLabel) {
    await diffInline(id);
  } else if (choice === copyLabel) {
    await vscode.env.clipboard.writeText(parsed.code);
    vscode.window.setStatusBarMessage(L('代码已复制', 'Code copied'), 3000);
  }
}

async function resolveRange(editor: vscode.TextEditor, args?: InlineArgs): Promise<vscode.Range> {
  if (args && typeof args.startLine === 'number' && typeof args.endLine === 'number') {
    const start = new vscode.Position(args.startLine, args.startChar ?? 0);
    const end = new vscode.Position(args.endLine, args.endChar ?? 0);
    return new vscode.Range(start, end);
  }
  if (!editor.selection.isEmpty) {
    return new vscode.Range(editor.selection.start, editor.selection.end);
  }
  return enclosingRange(editor.document, editor.selection.active.line);
}

function looksLikeMutation(question: string, reply: string): boolean {
  if (/重构|优化|改写|修复|改一下|重写|modern|refactor|fix|rewrite/i.test(question)) {
    return true;
  }
  return /【问题】|【原因】|【方案】/.test(reply);
}

async function applyInline(id?: string, host?: PetHost): Promise<void> {
  const item = id ? pending.get(id) : undefined;
  if (!item) {
    vscode.window.showWarningMessage(L('这条建议已经失效，请重新生成。', 'This suggestion is stale — please regenerate it.'));
    return;
  }

  const document = await vscode.workspace.openTextDocument(item.uri);
  if (isPatchStale(document.getText(item.range), item.originalText)) {
    vscode.window.showWarningMessage(
      L('代码在你确认前发生了变化，请重新生成建议。', 'The code changed before you confirmed — please regenerate the suggestion.'),
    );
    return;
  }

  const beforeText = document.getText();
  const baseline = host ? baselineFor(document, host.dependentsOf(document.uri)) : undefined;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(item.uri, item.range, item.code);
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showWarningMessage(L('替换失败，请重试。', 'Replacement failed — please try again.'));
    return;
  }
  const afterText = document.getText();
  const meta = await getFixHistory()?.add(item.uri, beforeText, afterText, L('行内修改', 'Inline edit'));
  try {
    await document.save();
  } catch {
    // 用户可以手动保存
  }
  pending.delete(id!);
  vscode.window.setStatusBarMessage(L('已应用桌宠的修改', 'DeskPet changes applied'), 4000);
  if (host && baseline) {
    void verifyAfterEdit(host, document, baseline, meta);
  }
}

async function diffInline(id?: string): Promise<void> {
  const item = id ? pending.get(id) : undefined;
  if (!item) {
    vscode.window.showWarningMessage(L('这条建议已经失效，请重新生成。', 'This suggestion is stale — please regenerate it.'));
    return;
  }
  const document = await vscode.workspace.openTextDocument(item.uri);
  await showProposedDiff(document, item.range, item.code, L('行内修改', 'Inline edit'));
}
