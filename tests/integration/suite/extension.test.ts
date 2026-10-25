import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'your-publisher-id.ai-deskpet';

const EXPECTED_COMMANDS = [
  'deskpet.chat',
  'deskpet.focus',
  'deskpet.openPanel',
  'deskpet.explainSelection',
  'deskpet.teachSelection',
  'deskpet.fixSelection',
  'deskpet.explainDiagnostic',
  'deskpet.fixDiagnostic',
  'deskpet.fixAll',
  'deskpet.undoLastFix',
  'deskpet.fixHistory',
  'deskpet.rewriteFile',
  'deskpet.checkCapability',
  'deskpet.inlineChat',
  'deskpet.inlineApply',
  'deskpet.inlineDiff',
  'deskpet.addTests',
  'deskpet.generateDocs',
  'deskpet.checkDocs',
  'deskpet.reviewRules',
  'deskpet.modernize',
  'deskpet.analyzeClipboard',
  'deskpet.analyzeFailure',
  'deskpet.reindex',
  'deskpet.quickSetup',
  'deskpet.exportTheme',
  'deskpet.importTheme',
  'deskpet.clearWorkspaceTheme',
  'deskpet.updateSetting',
];

suite('AI DeskPet 扩展', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `找不到扩展 ${EXTENSION_ID}`);
    await extension.activate();
    assert.ok(extension.isActive, '扩展未激活');
  });

  test('关键命令全部注册', async () => {
    const commands = await vscode.commands.getCommands(true);
    const missing = EXPECTED_COMMANDS.filter((id) => !commands.includes(id));
    assert.deepEqual(missing, [], `缺少命令：${missing.join(', ')}`);
  });

  test('updateSetting 能写入并读回配置', async () => {
    const config = vscode.workspace.getConfiguration('deskpet');
    const original = config.get<string>('pet.name');

    await vscode.commands.executeCommand('deskpet.updateSetting', {
      key: 'pet.name',
      value: '集成测试宠物',
    });
    assert.equal(vscode.workspace.getConfiguration('deskpet').get('pet.name'), '集成测试宠物');

    await vscode.workspace
      .getConfiguration('deskpet')
      .update('pet.name', original ?? '小豆', vscode.ConfigurationTarget.Global);
  });

  test('可在 fixture 工作区建索引', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.ok(folders.length > 0, '测试工作区未打开');
    await vscode.commands.executeCommand('deskpet.reindex');
    // 命令内部 await 重建完成；能正常返回即视为通过
  });

  test('能打开桌宠编辑器面板', async () => {
    await vscode.commands.executeCommand('deskpet.openPanel');
    // 面板创建是同步的，但标签组刷新有一帧延迟
    await new Promise((resolve) => setTimeout(resolve, 300));

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const panel = tabs.find(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        (tab.input as vscode.TabInputWebview).viewType.includes('deskpet'),
    );
    assert.ok(panel, `没有找到桌宠标签页，当前标签：${tabs.map((tab) => tab.label).join(' | ')}`);
  });
});
