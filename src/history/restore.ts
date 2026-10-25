import * as vscode from 'vscode';
import { showProposedDiff } from '../commands/diff';
import { L } from '../i18n';
import type { FixHistory } from './fixHistory';

/** 把文件恢复成这条历史记录里的 before 版本。 */
export async function restoreFix(
  history: FixHistory,
  id: string,
  options: { confirmStale?: boolean } = {},
): Promise<boolean> {
  const entry = await history.get(id);
  if (!entry) {
    await vscode.window.showWarningMessage(
      L('这条修改历史已经失效。', 'This edit history entry is no longer valid.'),
    );
    return false;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
  const current = document.getText();

  if (current !== entry.after) {
    if (!options.confirmStale) {
      return false;
    }
    const restoreLabel = L('仍然回退', 'Restore anyway');
    const ok = await vscode.window.showWarningMessage(
      L(
        '文件在这之后又被修改过，回退会覆盖这些改动，确定吗？',
        'The file has changed since this edit. Restoring will overwrite those changes. Continue?',
      ),
      { modal: true },
      restoreLabel,
    );
    if (ok !== restoreLabel) {
      return false;
    }
  }

  const full = new vscode.Range(document.positionAt(0), document.positionAt(current.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, full, entry.before);
  if (!(await vscode.workspace.applyEdit(edit))) {
    await vscode.window.showWarningMessage(L('回退失败，请重试。', 'Restore failed — please try again.'));
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
    await vscode.window.showWarningMessage(
      L('这条修改历史已经失效。', 'This edit history entry is no longer valid.'),
    );
    return;
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.uri));
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  await showProposedDiff(document, fullRange, entry.before, L('回退预览', 'Restore preview'));
}
