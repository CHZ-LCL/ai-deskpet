import * as vscode from 'vscode';
import { showProposedDiff } from '../commands/assist';
import type { FixHistory } from './fixHistory';

/** 把文件恢复成这条历史记录里的 before 版本。 */
export async function restoreFix(
  history: FixHistory,
  id: string,
  options: { confirmStale?: boolean } = {},
): Promise<boolean> {
  const entry = await history.get(id);
  if (!entry) {
    await vscode.window.showWarningMessage('这条修改历史已经失效。');
    return false;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
  const current = document.getText();

  if (current !== entry.after) {
    if (!options.confirmStale) {
      return false;
    }
    const ok = await vscode.window.showWarningMessage(
      '文件在这之后又被修改过，回退会覆盖这些改动，确定吗？',
      { modal: true },
      '仍然回退',
    );
    if (ok !== '仍然回退') {
      return false;
    }
  }

  const full = new vscode.Range(document.positionAt(0), document.positionAt(current.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, full, entry.before);
  if (!(await vscode.workspace.applyEdit(edit))) {
    await vscode.window.showWarningMessage('回退失败，请重试。');
    return false;
  }

  try {
    await document.save();
  } catch {
    // 用户可以手动保存
  }
  return true;
}

/** 并排看“当前版本 vs 回退后的版本”。 */
export async function showFixDiff(history: FixHistory, id: string): Promise<void> {
  const entry = await history.get(id);
  if (!entry) {
    await vscode.window.showWarningMessage('这条修改历史已经失效。');
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  await showProposedDiff(document, fullRange, entry.before, '回退预览');
}
