import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DIFF_SCHEME } from '../../shared/protocol';

/** 虚拟文档内容：用于并排 diff 预览，不落盘。 */
const previews = new Map<string, string>();

export const diffContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri) {
    return previews.get(uri.path) ?? '';
  },
};

/** 打开“原文 vs 建议”的并排 diff，供变更卡片、行内对话、回退预览复用。 */
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
