import * as vscode from 'vscode';
import type {
  BackgroundStyle,
  Density,
  InterruptionLevel,
  MotionLevel,
  PetConfig,
  PetPersona,
  PetTheme,
  PetTone,
  QuickAction,
  RendererKind,
  ReplyLength,
  ThemeId,
} from '../shared/protocol';
import { DEFAULT_QUICK_ACTIONS } from '../shared/protocol';
import { providerLabel, readAiSettings } from './ai';
import type { AssetStore } from './pet/assets';

export async function buildPetConfig(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  assets: AssetStore,
  contextLabel?: string,
): Promise<PetConfig> {
  const config = vscode.workspace.getConfiguration('deskpet');
  const ai = await readAiSettings(context);

  const theme: PetTheme = {
    id: config.get<ThemeId>('ui.theme', 'mint'),
    accent: normalizeHex(config.get<string>('ui.accent', '#4ec9b0')),
    background: config.get<BackgroundStyle>('ui.background', 'grid'),
    motion: config.get<MotionLevel>('ui.motion', 'full'),
    density: config.get<Density>('ui.density', 'cozy'),
    nameplate: config.get<boolean>('ui.nameplate', true),
    customCss: (config.get<string>('ui.customCss', '') ?? '').slice(0, 12_000),
  };

  const persona: PetPersona = {
    userName: (config.get<string>('pet.userName', '') ?? '').trim().slice(0, 40),
    tone: config.get<PetTone>('pet.tone', 'warm'),
    replyLength: config.get<ReplyLength>('ai.replyLength', 'normal'),
  };

  const greeting = (config.get<string>('pet.greeting', '') ?? '').trim().slice(0, 200);

  return {
    name: config.get<string>('pet.name', '小豆'),
    renderer: config.get<RendererKind>('pet.renderer', 'builtin'),
    scale: config.get<number>('pet.scale', 1),
    volume: config.get<number>('pet.volume', 0.6),
    tts: config.get<boolean>('pet.tts', false),
    ttsRate: config.get<number>('pet.ttsRate', 1),
    assets: await assets.buildAssets(webview),
    aiProviderLabel: providerLabel(ai),
    aiModel: ai.model,
    contextLabel,
    interruption: config.get<InterruptionLevel>('pet.interruption', 'balanced'),
    theme,
    quickActions: normalizeQuickActions(config.get<QuickAction[]>('ui.quickActions', [])),
    persona,
    greeting: greeting || undefined,
    themeScope: {
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
      workspaceOverride: config.inspect('ui.theme')?.workspaceValue !== undefined,
    },
    rendererScripts: {
      live2d: webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'renderer-live2d.js'))
        .toString(),
      vrm: webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'renderer-vrm.js'))
        .toString(),
    },
  };
}

/**
 * webview 可访问的资源根目录：打包产物、内置素材、用户素材库、工作区（供自定义模型路径加载）。
 */
export function resourceRoots(context: vscode.ExtensionContext): vscode.Uri[] {  const roots = [
    vscode.Uri.joinPath(context.extensionUri, 'dist'),
    vscode.Uri.joinPath(context.extensionUri, 'assets'),
    context.globalStorageUri,
  ];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.push(folder.uri);
  }
  return roots;
}

function normalizeHex(input: string | undefined): string {
  const value = (input ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#4ec9b0';
}

function normalizeQuickActions(input: QuickAction[] | undefined): QuickAction[] {
  if (!Array.isArray(input)) {
    return [...DEFAULT_QUICK_ACTIONS];
  }
  const actions = input
    .filter((item) => item && typeof item.label === 'string' && item.label.trim())
    .slice(0, 10)
    .map((item) => ({
      label: item.label.trim().slice(0, 20),
      command: typeof item.command === 'string' ? item.command.trim().slice(0, 120) : undefined,
      text: typeof item.text === 'string' ? item.text.slice(0, 400) : undefined,
    }))
    .filter((item) => item.command || item.text);

  return actions.length ? actions : [...DEFAULT_QUICK_ACTIONS];
}
