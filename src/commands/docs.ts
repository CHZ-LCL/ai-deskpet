import { L } from '../i18n';
import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { documentationPrompt } from '../ai/prompts';
import {
  docReplacementRange,
  docStyleFor,
  extractSignature,
  findEnclosingSymbol,
  scanDocDrift,
} from '../docs/docTargets';
import type { PetHost } from '../pet/host';
import { focusPet, presentPatch, snippetFromRange } from './assist';

export function registerDocCommands(host: PetHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.generateDocs, (args?: { line?: number }) =>
      generateDocs(host, args?.line),
    ),
    vscode.commands.registerCommand(CMD.checkDocs, () => checkDocs(host)),
  ];
}

/** 为函数/类生成或扩写文档注释，替换范围由语言决定（Python 是 docstring）。 */
async function generateDocs(host: PetHost, line?: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say(L('先打开要补文档的文件。', `Open the file to document first.`), { action: 'think' });
    return;
  }

  const document = editor.document;
  const targetLine = line ?? editor.selection.active.line;
  const symbol = await findEnclosingSymbol(document, targetLine);
  if (!symbol) {
    host.say(L('把光标放在函数或类里，我才能补文档。', `Put the cursor inside a function or class so I can add docs.`), { action: 'think' });
    return;
  }

  const signature = extractSignature(document, symbol.range, document.languageId);
  const { range, existing } = docReplacementRange(document, signature, document.languageId);
  const snippet = snippetFromRange(document, range);
  const style = docStyleFor(document.languageId);

  await focusPet();
  const reply = await host.prompt(
    `为 ${symbol.name} ${existing ? '扩写' : '补'}文档`,
    documentationPrompt({
      file: snippet.relativePath,
      languageId: document.languageId,
      style,
      signature: signature.text,
      existingDoc: existing?.text,
    }),
    { action: 'think' },
  );

  if (reply.trim()) {
    await presentPatch(host, document, snippet, reply, existing ? '文档扩写' : '文档注释', {
      autoDiff: true,
    });
  }
}

/** 找出文档与签名不一致的位置，让用户挑一处修。 */
async function checkDocs(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say(L('先打开要检查的文件。', `Open the file you want to check first.`), { action: 'think' });
    return;
  }

  const document = editor.document;
  const drift = scanDocDrift(document.getText(), document.languageId);
  if (!drift.length) {
    host.say(L('文档和签名是一致的，没发现需要补的地方。', `Docs match the signatures — nothing to update.`), { action: 'happy' });
    return;
  }

  host.notice(L(`发现 ${drift.length} 处文档与签名不一致`, `Found ${drift.length} places where docs and signatures disagree`));
  const picked = await vscode.window.showQuickPick(
    drift.map((item) => ({
      label: `L${item.line}  ${item.name}`,
      description: [
        item.missing.length ? `缺少：${item.missing.join('、')}` : '',
        item.extra.length ? `多余：${item.extra.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('；'),
      line: item.line,
    })),
    { title: '要补哪一处文档？', placeHolder: '选中后会生成注释并给出 diff' },
  );

  if (picked) {
    await generateDocs(host, picked.line - 1);
  }
}
