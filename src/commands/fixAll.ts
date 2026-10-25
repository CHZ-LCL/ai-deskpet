import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { parseAdvice } from '../ai/advice';
import { fixAllPrompt } from '../ai/prompts';
import { getFixHistory } from '../history/fixHistory';
import { restoreFix, showFixDiff } from '../history/restore';
import { isFullFileRewrite } from '../history/util';
import type { PetHost } from '../pet/host';
import { focusPet, presentPatch, snippetFromRange } from './assist';
import { enclosingRange } from './debug';

export function registerFixAllCommand(host: PetHost): vscode.Disposable[] {
  return [vscode.commands.registerCommand(CMD.fixAll, () => fixAll(host))];
}

/**
 * 一键修复：把一个文件里的错误一次性交给模型，要求返回完整文件并直接应用。
 * 应用后立刻给“撤销 / 查看差异”，同时写入修改历史。
 */
async function fixAll(host: PetHost): Promise<void> {
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
  if (before.length > 24_000 || document.lineCount > 500) {
    host.say('文件有点大，整文件重写风险太高。建议用问题清单逐条修复。', { action: 'think' });
    return;
  }

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

  const actions = meta ? ['撤销', '查看差异'] : [];
  const choice = await vscode.window.showInformationMessage(
    `已一键修复 ${diagnostics.length} 处错误`,
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
