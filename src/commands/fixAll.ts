import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { capabilityMatches, readCapability } from '../ai/capability';
import { readAiSettings } from '../ai';
import { parseAdvice } from '../ai/advice';
import { fixAllPrompt } from '../ai/prompts';
import { getFixHistory } from '../history/fixHistory';
import { restoreFix, showFixDiff } from '../history/restore';
import { isFullFileRewrite } from '../history/util';
import type { PetHost } from '../pet/host';
import { baselineFor, verifyAfterEdit } from '../verify/verify';
import { focusPet, presentPatch, snippetFromRange } from './assist';
import { enclosingRange } from './debug';

export function registerFixAllCommand(host: PetHost, context: vscode.ExtensionContext): vscode.Disposable[] {
  return [vscode.commands.registerCommand(CMD.fixAll, () => fixAll(host, context))];
}

/**
 * 一键修复：把一个文件里的错误一次性交给模型，要求返回完整文件并直接应用。
 * 应用后立刻给“撤销 / 查看差异”，同时写入修改历史。
 */
async function fixAll(host: PetHost, context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say('先打开要修复的文件。', { action: 'think' });
    return;
  }
  const document = editor.document;
  const config = vscode.workspace.getConfiguration('deskpet');
  const limit = Math.max(1, config.get<number>('fix.maxAutoDiagnostics', 6));

  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error)
    .slice(0, limit);

  if (!diagnostics.length) {
    host.say('这个文件没有错误，干净得很。', { action: 'happy' });
    return;
  }

  const before = document.getText();
  // 验证过整文件改写能力的模型，可以把上限放宽
  const settings = await readAiSettings(context);
  const record = readCapability(context);
  const verified = record?.passed === true && capabilityMatches(record, settings);
  const maxLines = verified ? Math.max(200, config.get<number>('rewrite.maxLines', 1200)) : 500;
  const maxChars = verified ? Math.max(10_000, config.get<number>('rewrite.maxChars', 48_000)) : 24_000;

  if (document.lineCount > maxLines || before.length > maxChars) {
    host.say(
      `文件有点大（${document.lineCount} 行），当前上限是 ${maxLines} 行 / ${maxChars} 字符。` +
        (verified ? '建议用问题清单逐条修复。' : '先运行「验证模型的全文修改能力」可以放宽到 1200 行。'),
      { action: 'think' },
    );
    return;
  }

  // 记录修改前的错误基线（当前文件 + 依赖它的文件）
  const baseline = baselineFor(document, host.dependentsOf(document.uri));

  await focusPet();
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const list = diagnostics
    .map((diagnostic) => `- 第 ${diagnostic.range.start.line + 1} 行 [error] ${diagnostic.message}`)
    .join('\n');

  const reply = await host.prompt(
    `一键修复 ${relative}（${diagnostics.length} 处错误）`,
    fixAllPrompt({
      file: relative,
      languageId: document.languageId,
      diagnostics: list,
      code: before,
    }),
    { action: 'think' },
  );
  if (!reply.trim()) {
    return;
  }

  const code = parseAdvice(reply).code;
  if (!isFullFileRewrite(before, code)) {
    host.notice('模型没有返回完整文件，改为给出补丁卡片，避免误删代码。', 'warn');
    const range = await enclosingRange(document, diagnostics[0].range.start.line);
    await presentPatch(host, document, snippetFromRange(document, range), reply, '报错修复', {
      autoDiff: true,
    });
    return;
  }

  const full = new vscode.Range(document.positionAt(0), document.positionAt(before.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, full, code);
  if (!(await vscode.workspace.applyEdit(edit))) {
    host.notice('应用失败，请重试。', 'warn');
    return;
  }

  const after = document.getText();
  const meta = await getFixHistory()?.add(
    document.uri,
    before,
    after,
    `一键修复 ${diagnostics.length} 处错误`,
  );

  try {
    await document.save();
  } catch {
    // 用户可以手动保存
  }

  host.say(`修好了 ${diagnostics.length} 处，检查一下有没有新问题。`, { action: 'happy' });

  const diff = await verifyAfterEdit(host, document, baseline, meta);
  if (diff.introduced.length) {
    // verifyAfterEdit 已经弹过「回退 / 再修一次」，这里不再重复提示
    return;
  }

  const actions = meta ? ['撤销', '查看差异'] : [];
  const choice = await vscode.window.showInformationMessage(
    `已一键修复 ${diagnostics.length} 处错误，验证通过`,
    ...actions,
  );

  const history = getFixHistory();
  if (!meta || !history) {
    return;
  }
  if (choice === '撤销') {
    if (await restoreFix(history, meta.id)) {
      vscode.window.setStatusBarMessage('已撤销一键修复', 3000);
    }
  } else if (choice === '查看差异') {
    await showFixDiff(history, meta.id);
  }
}
