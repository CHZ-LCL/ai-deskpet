import * as vscode from 'vscode';
import { nonce } from '../util';

export function renderWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.css'));
  const cspSource = webview.cspSource;
  const n = nonce();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} data: blob:; media-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}' ${cspSource}; font-src ${cspSource} data:; connect-src ${cspSource};"
  />
  <link rel="stylesheet" href="${styleUri}" />
  <title>AI 桌宠</title>
</head>
<body data-theme-kind="vscode">
  <div id="app" class="app">
    <header class="toolbar" id="toolbar">
      <div class="toolbar-left">
        <span class="pet-name" id="pet-name">小豆</span>
        <span class="level-chip" id="level-chip" title="好感等级">Lv.1</span>
      </div>
      <div class="toolbar-right">
        <button class="icon-btn" id="btn-gallery" title="形象库">◍</button>
        <button class="icon-btn" id="btn-sound" title="音效库">♪</button>
        <button class="icon-btn" id="btn-settings" title="设置">⚙</button>
        <button class="icon-btn" id="btn-open-panel" title="在编辑器标签中打开">⤢</button>
      </div>
    </header>

    <main class="stage" id="stage">
      <div class="stage-glow"></div>
      <div class="pet-anchor" id="pet-anchor">
        <div class="pet-block">
          <div class="speech" id="speech" hidden>
            <div class="speech-text" id="speech-text"></div>
            <div class="speech-actions" id="speech-actions"></div>
          </div>
          <div class="pet-mount" id="pet-mount"></div>
        </div>
        <div class="name-plate" id="name-plate">小豆 · 发呆中</div>
      </div>
      <div class="busy-veil" id="busy-veil" hidden><span class="spinner"></span><span id="busy-label">思考中…</span></div>
    </main>

    <section class="chat" id="chat">
      <div class="chat-log" id="chat-log" aria-live="polite"></div>
      <div class="quick-actions" id="quick-actions">
        <button data-quick="explain">讲解代码</button>
        <button data-quick="fix">帮我修</button>
        <button data-quick="tests">写测试</button>
        <button data-quick="docs">查文档</button>
        <button data-quick="clear" class="ghost">清空</button>
      </div>
      <form class="composer" id="composer">
        <textarea id="input" rows="1" placeholder="和桌宠聊聊…（Enter 发送 / Shift+Enter 换行）"></textarea>
        <button type="submit" class="send-btn" id="send-btn" title="发送">↑</button>
      </form>
      <div class="chat-foot">
        <span id="model-chip" class="model-chip">未配置</span>
        <span id="index-chip" class="index-chip" hidden></span>
        <button class="link-btn" id="btn-ai">AI 设置</button>
      </div>
    </section>

    <div class="drawer" id="drawer" hidden>
      <div class="drawer-head">
        <strong id="drawer-title">形象库</strong>
        <button class="icon-btn" id="drawer-close" title="关闭">✕</button>
      </div>
      <div class="drawer-body" id="drawer-body"></div>
      <div class="drawer-foot" id="drawer-foot"></div>
    </div>

    <div class="toast" id="toast" hidden></div>
  </div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
