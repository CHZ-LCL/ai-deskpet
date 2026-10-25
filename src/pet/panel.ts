import * as vscode from 'vscode';
import { resourceRoots } from '../config';
import { L } from '../i18n';
import { renderWebviewHtml } from './html';
import type { PetHost } from './host';

/**
 * 编辑器标签形态的桌宠：空间更大，适合看 Live2D / 3D 形象。
 */
export class PetPanel {
  private static current: vscode.WebviewPanel | undefined;

  static show(context: vscode.ExtensionContext, host: PetHost): void {
    if (PetPanel.current) {
      PetPanel.current.reveal(undefined, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'deskpet.panel',
      L('桌宠 · DeskPet', 'DeskPet'),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots(context),
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.svg');
    panel.webview.html = renderWebviewHtml(panel.webview, context);

    let attachment: vscode.Disposable | undefined;
    void host.attach(panel.webview).then((disposable) => {
      if (PetPanel.current !== panel) {
        disposable.dispose();
        return;
      }
      attachment = disposable;
    });

    panel.onDidDispose(() => {
      host.detach(panel.webview);
      attachment?.dispose();
      attachment = undefined;
      PetPanel.current = undefined;
    });

    PetPanel.current = panel;
  }
}
