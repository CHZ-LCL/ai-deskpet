import { L } from '../i18n';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { getFixHistory } from '../history/fixHistory';
import { restoreFix, showFixDiff } from '../history/restore';
import type { PetHost } from '../pet/host';

export function registerHistoryCommands(host: PetHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.undoLastFix, () => undoLast(host)),
    vscode.commands.registerCommand(CMD.fixHistory, () => showHistory(host)),
  ];
}

async function undoLast(host: PetHost): Promise<void> {
  const history = getFixHistory();
  const latest = history?.list()[0];
  if (!history || !latest) {
    host.say(L('还没有可以回退的 AI 修改。', `There are no AI edits to undo yet.`), { action: 'think' });
    return;
  }

  if (await restoreFix(history, latest.id)) {
    host.say(L('已经回到修改前的版本。', `Restored the version before the edit.`), { action: 'shy' });
  }
}

/** 滚动查看最近 30 条修改，选中后可回退或先看差异。 */
async function showHistory(host: PetHost): Promise<void> {
  const history = getFixHistory();
  const items = history?.list() ?? [];
  if (!history || !items.length) {
    host.say(L('修改历史是空的。做过 AI 修复后这里会自动记录。', `Edit history is empty. AI fixes are recorded here automatically.`), { action: 'think' });
    return;
  }

  const picked = await vscode.window.showQuickPick(
    items.map((meta) => {
      const uri = vscode.Uri.parse(meta.uri);
      return {
        label: `$(history) ${formatTime(meta.at)} · ${path.basename(uri.fsPath)}`,
        description: meta.title,
        detail: vscode.workspace.asRelativePath(uri, false),
        id: meta.id,
      };
    }),
    { title: 'AI 修改历史（最近 30 条）', placeHolder: '选中一条可回退到修改前' },
  );
  if (!picked) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `要回退到「${picked.description}」之前吗？`,
    '回退',
    '查看差异',
  );
  if (choice === '回退') {
    if (await restoreFix(history, picked.id)) {
      host.say(L('已回退。', `Undone.`), { action: 'shy' });
    }
  } else if (choice === '查看差异') {
    await showFixDiff(history, picked.id);
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
