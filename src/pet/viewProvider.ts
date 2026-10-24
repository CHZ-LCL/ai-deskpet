import * as vscode from 'vscode';
import { VIEW_ID } from '../../shared/protocol';
import { resourceRoots } from '../config';
import { renderWebviewHtml } from './html';
import type { PetHost } from './host';

export class PetViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = VIEW_ID;

  private view?: vscode.WebviewView;
  private attachment?: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: PetHost,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots(this.context),
    };
    view.webview.html = renderWebviewHtml(view.webview, this.context);

    this.attachment?.dispose();
    this.attachment = undefined;
    void this.host.attach(view.webview).then((disposable) => {
      if (this.view === view) {
        this.attachment = disposable;
      } else {
        disposable.dispose();
      }
    });

    view.onDidDispose(() => {
      this.host.detach(view.webview);
      this.attachment?.dispose();
      this.attachment = undefined;
      this.view = undefined;
    });
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    void vscode.commands.executeCommand(`${PetViewProvider.viewType}.focus`);
  }
}
