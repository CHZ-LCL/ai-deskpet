import { L } from '../i18n';
import * as vscode from 'vscode';
import { CMD } from '../../shared/protocol';
import type {
  BackgroundStyle,
  Density,
  MotionLevel,
  PetTheme,
  QuickAction,
  ThemeId,
} from '../../shared/protocol';
import type { PetHost } from '../pet/host';
import { buildThemeFile, parseThemeFile, type ThemeFile } from '../theme/themeFile';

const UI_KEYS = [
  'ui.theme',
  'ui.accent',
  'ui.background',
  'ui.motion',
  'ui.density',
  'ui.nameplate',
  'ui.quickActions',
  'ui.customCss',
];

export function registerThemeCommands(host: PetHost, context: vscode.ExtensionContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.exportTheme, () => exportTheme(host, context)),
    vscode.commands.registerCommand(CMD.importTheme, () => importTheme(host)),
    vscode.commands.registerCommand(CMD.clearWorkspaceTheme, () => clearWorkspaceTheme(host)),
  ];
}

function readTheme(): PetTheme {
  const config = vscode.workspace.getConfiguration('deskpet');
  return {
    id: config.get<ThemeId>('ui.theme', 'mint'),
    accent: config.get<string>('ui.accent', '#4ec9b0'),
    background: config.get<BackgroundStyle>('ui.background', 'grid'),
    motion: config.get<MotionLevel>('ui.motion', 'full'),
    density: config.get<Density>('ui.density', 'cozy'),
    nameplate: config.get<boolean>('ui.nameplate', true),
    customCss: config.get<string>('ui.customCss', ''),
  };
}

async function exportTheme(host: PetHost, context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('deskpet');
  const file = buildThemeFile(
    readTheme(),
    config.get<QuickAction[]>('ui.quickActions', []),
    config.get<string>('pet.name', '小豆'),
  );

  const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.globalStorageUri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(base, 'deskpet-theme.json'),
    filters: { [L('桌宠主题', 'DeskPet theme')]: ['json'] },
    title: L('导出桌宠主题', 'Export DeskPet theme'),
  });
  if (!target) {
    return;
  }

  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(file, null, 2)));
  host.say(L('主题已导出，可以直接分享给同事。', `Theme exported — share it with your team.`), { action: 'happy' });
}

async function importTheme(host: PetHost): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [L('桌宠主题', 'DeskPet theme')]: ['json'] },
    title: L('导入桌宠主题', 'Import DeskPet theme'),
  });
  const uri = picked?.[0];
  if (!uri) {
    return;
  }

  let text = '';
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (error) {
    void vscode.window.showErrorMessage(
      L(
        `读取主题文件失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not read the theme file: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return;
  }

  const parsed = parseThemeFile(text);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(
      L(`主题文件无效：${parsed.error}`, `Invalid theme file: ${parsed.error}`),
    );
    return;
  }

  const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
  const scope = await vscode.window.showQuickPick(
    [
      {
        label: L('应用到全局', 'Apply globally'),
        description: L('所有工作区生效', 'Takes effect in every workspace'),
        target: vscode.ConfigurationTarget.Global,
      },
      {
        label: L('仅当前工作区', 'This workspace only'),
        description: hasWorkspace
          ? L('写入 .vscode/settings.json 级别', 'Written at .vscode/settings.json level')
          : L('当前未打开工作区，不可用', 'No workspace is open, so this is unavailable'),
        target: vscode.ConfigurationTarget.Workspace,
      },
    ].filter((item) => item.target !== vscode.ConfigurationTarget.Workspace || hasWorkspace),
    { title: L('主题应用到哪？', 'Where should the theme apply?') },
  );
  if (!scope) {
    return;
  }

  await applyThemeFile(parsed.file, scope.target);
  host.say(L(`主题「${parsed.file.name ?? '导入'}」已经换上了，看看合不合眼。`, `Theme “${parsed.file.name ?? 'imported'}” is applied — take a look.`), { action: 'shy' });
}

async function applyThemeFile(file: ThemeFile, target: vscode.ConfigurationTarget): Promise<void> {
  const config = vscode.workspace.getConfiguration('deskpet');
  await config.update('ui.theme', file.theme.id, target);
  await config.update('ui.accent', file.theme.accent, target);
  await config.update('ui.background', file.theme.background, target);
  await config.update('ui.motion', file.theme.motion, target);
  await config.update('ui.density', file.theme.density, target);
  await config.update('ui.nameplate', file.theme.nameplate, target);
  await config.update('ui.customCss', file.theme.customCss, target);
  if (file.quickActions?.length) {
    await config.update('ui.quickActions', file.quickActions, target);
  }
}

async function clearWorkspaceTheme(host: PetHost): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    host.say(L('没有打开工作区，没有可清除的覆盖。', `No workspace is open, so there is no override to clear.`), { action: 'think' });
    return;
  }

  const clearLabel = L('清除', 'Clear');
  const confirmed = await vscode.window.showWarningMessage(
    L(
      '清除当前工作区的主题覆盖，恢复使用全局设置？',
      'Clear this workspace’s theme override and go back to the global settings?',
    ),
    { modal: true },
    clearLabel,
  );
  if (confirmed !== clearLabel) {
    return;
  }

  const config = vscode.workspace.getConfiguration('deskpet');
  for (const key of UI_KEYS) {
    await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
  host.say(L('已恢复全局主题。', `Global theme restored.`), { action: 'happy' });
}
