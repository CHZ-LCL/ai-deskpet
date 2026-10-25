import { L } from '../i18n';
import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import { testsPrompt } from '../ai/prompts';
import { extractSignature } from '../docs/docTargets';
import type { PetHost } from '../pet/host';
import { detectTestFramework, testLanguageFor } from '../testing/frameworks';
import { extractCode } from '../util';
import { focusPet, presentPatch, snippetFromRange } from './assist';
import { enclosingRange } from './debug';

export function registerTestCommands(host: PetHost): vscode.Disposable[] {
  return [vscode.commands.registerCommand(CMD.tests, () => generateTests(host))];
}

/**
 * 生成单元测试：按项目实际使用的框架选文件位置和写法，
 * 先把“要覆盖的分支”列出来，再给完整测试代码。
 */
async function generateTests(host: PetHost): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    host.say(L('先打开要测试的文件。', `Open the file to test first.`), { action: 'think' });
    return;
  }
  const document = editor.document;

  const range = editor.selection.isEmpty
    ? await enclosingRange(document, editor.selection.active.line)
    : new vscode.Range(editor.selection.start, editor.selection.end);
  const snippet = snippetFromRange(document, range);

  if (snippet.code.trim().length < 20) {
    host.say(L('选中一个函数或一段有逻辑的代码，我才能写测试。', `Select a function or a chunk of logic so I can write tests.`), { action: 'think' });
    return;
  }

  const framework = await detectTestFramework(document.languageId, snippet.relativePath);
  const suggested = framework.fileFor(snippet.relativePath);
  const signature = extractSignature(document, range, document.languageId).text;

  await focusPet();
  const reply = await host.prompt(
    L(
      `为 ${snippet.relativePath} 生成测试（${framework.label}）`,
      `Generate tests for ${snippet.relativePath} (${framework.label})`,
    ),
    testsPrompt({
      file: snippet.relativePath,
      languageId: document.languageId,
      signature,
      code: snippet.code,
      framework: framework.label,
      idiom: framework.idiom,
      suggestedFile: suggested,
    }),
    { action: 'think' },
  );
  if (!reply.trim()) {
    return;
  }

  const { code } = extractCode(reply);
  if (!code.trim()) {
    host.say(L('模型没有给出测试代码，再说一次试试？', `The model did not return test code. Try asking again?`), { action: 'alert' });
    return;
  }

  const plan = reply
    .split('\n')
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .slice(0, 6)
    .map((line) => line.replace(/^\s*[-*]\s+/, ''));

  const testLanguage = testLanguageFor(document.languageId);
  const existing = await findExistingTest(suggested);
  if (existing) {
    const testDocument = await vscode.workspace.openTextDocument(existing);
    const end = new vscode.Position(testDocument.lineCount, 0);
    const wrapper = [
      L('【问题】现有测试没有覆盖这个函数的关键分支', '【问题】The existing tests do not cover the key branches of this function'),
      L('【原因】缺少边界与异常用例，后续改动容易回归', '【原因】Boundary and error cases are missing, so later changes can regress'),
      L(
        `【方案】${plan.length ? plan.join('\n') : '新增正常 / 边界 / 异常用例'}`,
        `【方案】${plan.length ? plan.join('\n') : 'Add happy-path, boundary, and error cases'}`,
      ),
      L('【影响】只新增测试代码，不改产品逻辑', '【影响】Adds tests only; no production logic changes'),
      '',
      '```' + testLanguage,
      code,
      '```',
    ].join('\n');

    await presentPatch(
      host,
      testDocument,
      snippetFromRange(testDocument, new vscode.Range(end, end)),
      wrapper,
      L('补充测试', 'Add tests'),
      { autoDiff: true },
    );
    return;
  }

  // 还没有测试文件：先预览，再让用户决定是否落盘
  const preview = await vscode.workspace.openTextDocument({ content: code, language: testLanguage });
  await vscode.window.showTextDocument(preview, { preview: false });

  const folders = vscode.workspace.workspaceFolders;
  const createLabel = L('创建文件', 'Create file');
  const previewLabel = L('仅预览', 'Preview only');
  const items = folders?.length ? [createLabel, previewLabel] : [previewLabel];
  const choice = await vscode.window.showInformationMessage(
    L(
      `测试已生成（${framework.label}），建议保存为 ${suggested}`,
      `Tests generated (${framework.label}); suggested path: ${suggested}`,
    ),
    ...items,
  );

  if (choice === createLabel && folders?.length) {
    const target = vscode.Uri.joinPath(folders[0].uri, suggested);
    try {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(code));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), {
        preview: false,
      });
      host.say(L(`测试写好了：${suggested}`, `Tests are ready: ${suggested}`), { action: 'happy' });
    } catch (error) {
      void vscode.window.showErrorMessage(
        L(
          `创建测试文件失败：${error instanceof Error ? error.message : String(error)}`,
          `Could not create the test file: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}

async function findExistingTest(suggested: string): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const uri = vscode.Uri.joinPath(folder.uri, suggested);
  try {
    await vscode.workspace.fs.stat(uri);
    return uri;
  } catch {
    return undefined;
  }
}
