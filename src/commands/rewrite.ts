import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { capabilityMatches, checkFullFileCapability, readCapability } from '../ai/capability';
import { readAiSettings } from '../ai';
import { parseAdvice } from '../ai/advice';
import { rewritePrompt } from '../ai/prompts';
import { isFullFileRewrite } from '../history/util';
import type { PetHost } from '../pet/host';
import { focusPet, presentPatch, snippetFromRange } from './assist';

export function registerRewriteCommands(
  host: PetHost,
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.rewriteFile, () => rewriteFile(host, context)),
    vscode.commands.registerCommand(CMD.checkCapability, () => checkCapability(host, context)),
  ];
}

async function checkCapability(host: PetHost, context: vscode.ExtensionContext): Promise<void> {
  const record = await checkFullFileCapability(context);
  const label = `${record.model}${record.passed ? '' : `：${record.notes}`}`;
  if (record.passed) {
    host.say(`模型通过整文件改写验证（${label}），现在可以放心用全文修改了。`, { action: 'happy' });
    void vscode.window.showInformationMessage(`整文件改写能力验证通过：${label}`);
  } else {
    host.say('这个模型的整文件改写还不稳定，先用逐条修复更安全。', { action: 'think' });
    void vscode.window.showWarningMessage(`整文件改写验证未通过：${label}`);
  }
}

/**
 * 全文修改：先确认模型有能力稳定输出完整文件，再放开较大文件的上限。
 * 结果仍然通过变更卡片 + diff 展示，应用后走统一的历史与验证。
 */
async function rewriteFile(host: PetHost, context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say('先打开要修改的文件。', { action: 'think' });
    return;
  }
  const document = editor.document;
  const config = vscode.workspace.getConfiguration('deskpet');
  const settings = await readAiSettings(context);

  const instruction = await vscode.window.showInputBox({
    title: '全文修改当前文件',
    prompt: '想怎么改？会重写整个文件，并先给你看 diff',
    placeHolder: '例如：把所有回调改成 async/await，保持行为不变',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }

  const record = readCapability(context);
  const verified = record?.passed === true && capabilityMatches(record, settings);

  if (!verified) {
    const choice = await vscode.window.showInformationMessage(
      '还没验证过这个模型的整文件改写能力，要先跑一次小测试吗？',
      '验证并继续',
      '取消',
    );
    if (choice !== '验证并继续') {
      return;
    }
    const result = await checkFullFileCapability(context);
    if (!result.passed) {
      host.notice(`整文件改写验证未通过：${result.notes}`, 'warn');
      return;
    }
  }

  const before = document.getText();
  const maxLines = Math.max(200, config.get<number>('rewrite.maxLines', 1200));
  const maxChars = Math.max(10_000, config.get<number>('rewrite.maxChars', 48_000));

  if (document.lineCount > maxLines || before.length > maxChars) {
    host.say(
      `文件超出全文修改上限（${document.lineCount} 行 / ${before.length} 字符，上限 ${maxLines} 行 / ${maxChars} 字符）。`,
      { action: 'think' },
    );
    return;
  }

  if (document.lineCount > 500) {
    const ok = await vscode.window.showWarningMessage(
      `这个文件有 ${document.lineCount} 行，全文重写会消耗较多 token 且可能变慢，继续吗？`,
      { modal: true },
      '继续',
    );
    if (ok !== '继续') {
      return;
    }
  }

  await focusPet();
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const reply = await host.prompt(
    `全文修改 ${relative}（${instruction.trim().slice(0, 40)}）`,
    rewritePrompt({
      file: relative,
      languageId: document.languageId,
      instruction: instruction.trim(),
      code: before,
    }),
    { action: 'think' },
  );
  if (!reply.trim()) {
    return;
  }

  const code = parseAdvice(reply).code;
  if (!code.trim()) {
    host.notice('模型没有给出代码。', 'warn');
    return;
  }
  if (!isFullFileRewrite(before, code)) {
    host.notice('模型返回的不是完整文件（可能被截断或丢了声明），这次不应用。可以重试或换更大的模型。', 'warn');
    return;
  }

  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(before.length));
  await presentPatch(host, document, snippetFromRange(document, fullRange), reply, '全文修改', {
    autoDiff: true,
  });
}
