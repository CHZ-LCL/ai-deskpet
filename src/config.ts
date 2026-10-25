import * as vscode from 'vscode';
import type { PetConfig, RendererKind } from '../shared/protocol';
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
export function resourceRoots(context: vscode.ExtensionContext): vscode.Uri[] {
  const roots = [
    vscode.Uri.joinPath(context.extensionUri, 'dist'),
    vscode.Uri.joinPath(context.extensionUri, 'assets'),
    context.globalStorageUri,
  ];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.push(folder.uri);
  }
  return roots;
}
