import { L } from '../i18n';
import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import type { FixMeta } from '../history/fixHistory';
import { getFixHistory } from '../history/fixHistory';
import { restoreFix } from '../history/restore';
import type { PetHost } from '../pet/host';
import {
  describeItems,
  diffDiagnostics,
  summarize,
  type DiagItem,
} from './diagnostics';

function severityOf(diagnostic: vscode.Diagnostic): DiagItem['severity'] {
  if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
    return 'error';
  }
  return diagnostic.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info';
}

function codeOf(diagnostic: vscode.Diagnostic): string {
  const code = diagnostic.code as unknown;
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  if (code && typeof code === 'object' && 'value' in (code as Record<string, unknown>)) {
    return String((code as Record<string, unknown>).value);
  }
  return '';
}

export function snapshotUri(uri: vscode.Uri, file: string, onlyErrors = true): DiagItem[] {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((diagnostic) => !onlyErrors || diagnostic.severity === vscode.DiagnosticSeverity.Error)
    .map((diagnostic) => ({
      file,
      line: diagnostic.range.start.line + 1,
      severity: severityOf(diagnostic),
      code: codeOf(diagnostic),
      message: diagnostic.message,
      source: diagnostic.source,
    }));
}

/** 修改前的基线：当前文件 + 依赖它的文件（最多 4 个）。 */
export function baselineFor(
  document: vscode.TextDocument,
  dependents: vscode.Uri[],
): Map<string, DiagItem[]> {
  const map = new Map<string, DiagItem[]>();
  const add = (uri: vscode.Uri) => {
    const key = uri.toString();
    if (!map.has(key)) {
      map.set(key, snapshotUri(uri, vscode.workspace.asRelativePath(uri, false)));
    }
  };
  add(document.uri);
  for (const dependent of dependents) {
    add(dependent);
  }
  return map;
}

/** 等待语言服务把诊断跑完：连续 settleMs 没变化就认为稳定。 */
async function waitStable(uri: vscode.Uri, timeoutMs: number, settleMs: number): Promise<DiagItem[]> {
  const file = vscode.workspace.asRelativePath(uri, false);
  const started = Date.now();
  let last = JSON.stringify(snapshotUri(uri, file));
  let changedAt = Date.now();

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const current = JSON.stringify(snapshotUri(uri, file));
    if (current !== last) {
      last = current;
      changedAt = Date.now();
    } else if (Date.now() - changedAt >= settleMs) {
      break;
    }
  }

  return JSON.parse(last) as DiagItem[];
}

/**
 * 修改后验证：对比修改前后的错误集合。
 * 没有新错误 → 状态栏悄悄提示；有新错误 → 弹一次警告，可回退或再修。
 */
export async function verifyAfterEdit(
  host: PetHost,
  document: vscode.TextDocument,
  baseline: Map<string, DiagItem[]>,
  meta?: FixMeta,
): Promise<{ introduced: DiagItem[]; fixed: DiagItem[] }> {
  const config = vscode.workspace.getConfiguration('deskpet');
  if (!config.get<boolean>('verify.afterEdit', true) || !baseline.size) {
    return { introduced: [], fixed: [] };
  }

  const timeoutMs = 8000;
  const settleMs = 700;
  const after = await Promise.all(
    [...baseline.keys()].map((key) => waitStable(vscode.Uri.parse(key), timeoutMs, settleMs)),
  );

  const beforeItems = [...baseline.values()].flat();
  const afterItems = after.flat();
  const diff = diffDiagnostics(beforeItems, afterItems);

  if (!diff.introduced.length) {
    vscode.window.setStatusBarMessage(
      L(
        `✓ 桌宠已验证：没有引入新的错误${diff.fixed.length ? `（顺手修掉 ${diff.fixed.length} 个）` : ''}`,
        `✓ DeskPet verified: no new errors${diff.fixed.length ? ` (fixed ${diff.fixed.length} along the way)` : ''}`,
      ),
      5000,
    );
    return diff;
  }

  const groups = summarize(diff.introduced)
    .map((group) => L(`${group.count} 个${group.label}`, `${group.count} ${group.label}`))
    .join(L('、', ', '));
  const files = new Set(diff.introduced.map((item) => item.file).filter(Boolean));

  host.notice(
    L(
      `修改引入了 ${diff.introduced.length} 个新错误（${groups}）${
        files.size > 1 ? `，涉及 ${files.size} 个文件` : ''
      }：\n${describeItems(diff.introduced, 4)}`,
      `This edit introduced ${diff.introduced.length} new errors (${groups})${
        files.size > 1 ? ` across ${files.size} files` : ''
      }:\n${describeItems(diff.introduced, 4)}`,
    ),
    'warn',
  );

  const fixAgain = L('再修一次', 'Fix again');
  const dismiss = L('忽略', 'Dismiss');
  const undoLabel = L('回退这次修改', 'Undo this edit');
  const buttons = [fixAgain, dismiss];
  if (meta) {
    buttons.unshift(undoLabel);
  }

  const choice = await vscode.window.showWarningMessage(
    L(
      `这次修改引入了 ${diff.introduced.length} 个新错误（${groups}）`,
      `This edit introduced ${diff.introduced.length} new errors (${groups})`,
    ),
    ...buttons,
  );

  if (choice === undoLabel && meta) {
    const history = getFixHistory();
    if (history && (await restoreFix(history, meta.id))) {
      host.say(L('已回退这次修改，回到修改前。', `Reverted this edit to the previous version.`), { action: 'shy' });
    }
  } else if (choice === fixAgain) {
    await vscode.commands.executeCommand(CMD.fixAll);
  }

  return diff;
}
