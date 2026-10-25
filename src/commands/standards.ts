import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { refactorPrompt, rulesPrompt } from '../ai/prompts';
import type { PetHost } from '../pet/host';
import { countBySeverity, formatFindings, scanCode } from '../standards/patterns';
import { focusPet, presentPatch, snippetFromRange } from './assist';
import { enclosingRange } from './debug';

const MAX_SCAN_CHARS = 24_000;

export function registerStandardsCommands(host: PetHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.reviewRules, () => reviewRules(host)),
    vscode.commands.registerCommand(CMD.modernize, () => modernize(host)),
  ];
}

/**
 * 规范检查：先做确定性扫描（快、可解释），再让模型判断哪些值得改并给一个补丁。
 * 扫描结果直接列在对话里，即使模型不给力，用户也能看到具体行号和规则。
 */
async function reviewRules(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say('先打开要检查的文件。', { action: 'think' });
    return;
  }

  const document = editor.document;
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const lastLine = document.lineAt(document.lineCount - 1);
  const scanRange = hasSelection
    ? new vscode.Range(selection.start, selection.end)
    : new vscode.Range(0, 0, document.lineCount - 1, lastLine.text.length);

  const code = document.getText(scanRange).slice(0, MAX_SCAN_CHARS);
  if (!code.trim()) {
    host.say('这里没有可检查的代码。', { action: 'think' });
    return;
  }

  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const findings = scanCode(code, document.languageId, relative, {
    lineOffset: scanRange.start.line,
  });

  if (!findings.length) {
    host.say('本地规则扫描没发现明显问题。要做更深的逻辑检查，可以用「体检当前文件」。', {
      action: 'happy',
    });
    return;
  }

  const counts = countBySeverity(findings);
  host.notice(
    `规范扫描：高 ${counts.high} · 中 ${counts.medium} · 低 ${counts.low}` +
      (hasSelection ? `（选中 ${scanRange.start.line + 1}-${scanRange.end.line + 1} 行）` : ''),
  );

  await focusPet();
  const target = hasSelection
    ? scanRange
    : await enclosingRange(document, Math.max(0, findings[0].line - 1));
  const snippet = snippetFromRange(document, target);

  const reply = await host.prompt(
    `规范检查 ${relative}：${findings.length} 处线索`,
    rulesPrompt(
      relative,
      document.languageId,
      formatFindings(findings),
      snippet.code,
      hasSelection ? '选中片段' : '当前文件',
    ),
    { action: 'think' },
  );

  if (reply.trim()) {
    await presentPatch(host, document, snippet, reply, '规范整改', { autoDiff: true });
  }
}

/** 现代化重构：把“更简洁 / 更快 / 更现代”作为固定目标，附上扫描线索。 */
async function modernize(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say('先打开要重构的文件。', { action: 'think' });
    return;
  }
  const document = editor.document;
  const selection = editor.selection;
  if (selection.isEmpty) {
    host.say('先选中要现代化的代码段，我按规范包重写。', { action: 'think' });
    await focusPet();
    return;
  }

  const snippet = snippetFromRange(document, new vscode.Range(selection.start, selection.end));
  const findings = scanCode(snippet.code, document.languageId, snippet.relativePath, {
    lineOffset: selection.start.line,
  });
  const counts = countBySeverity(findings);

  await focusPet();
  const reply = await host.prompt(
    `现代化重构 ${snippet.relativePath}（${findings.length} 处线索）`,
    [
      refactorPrompt(
        snippet.languageId,
        '改用更现代、更简洁、性能更好的写法，同时保持行为不变，并遵守团队规范',
      ),
      '',
      `本地扫描线索（高 ${counts.high} / 中 ${counts.medium} / 低 ${counts.low}）：`,
      formatFindings(findings),
      '',
      `代码（第 ${snippet.startLine}-${snippet.endLine} 行，整段替换）：`,
      '```' + snippet.languageId,
      snippet.code,
      '```',
    ].join('\n'),
    { action: 'think' },
  );

  if (reply.trim()) {
    await presentPatch(host, document, snippet, reply, '现代化重构', { autoDiff: true });
  }
}
