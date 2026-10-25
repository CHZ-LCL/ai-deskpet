import * as vscode from 'vscode';
import { L, setLanguage } from '../../shared/i18n';
import { resolveLanguage } from '../i18n';
import { nonce } from '../util';

export function renderWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.css'));
  const cspSource = webview.cspSource;
  const n = nonce();

  // 首屏文案直接按当前语言渲染，英文用户不会先看到一帧中文
  const language = resolveLanguage();
  setLanguage(language);

  return `<!DOCTYPE html>
<html lang="${language === 'en' ? 'en' : 'zh-CN'}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${cspSource} data: blob:; media-src ${cspSource} data: blob:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}' ${cspSource}; font-src ${cspSource} data:; connect-src ${cspSource};"
  />
  <link rel="stylesheet" href="${styleUri}" />
  <title>${L('AI 桌宠')}</title>
</head>
<body data-theme-kind="vscode">
  <div id="app" class="app">
    <header class="toolbar" id="toolbar">
      <div class="toolbar-left">
        <span class="pet-name" id="pet-name">${L('桌宠')}</span>
        <span class="level-chip" id="level-chip" title="${L('好感等级')}">Lv.1</span>
      </div>
      <div class="toolbar-right">
        <button class="icon-btn" id="btn-gallery" title="${L('形象库')}">◍</button>
        <button class="icon-btn" id="btn-sound" title="${L('音效库')}">♪</button>
        <button class="icon-btn" id="btn-standards" title="${L('代码规范')}">§</button>
        <button class="icon-btn" id="btn-palette" title="${L('个性化')}">✧</button>
        <button class="icon-btn" id="btn-settings" title="${L('设置')}">⚙</button>
        <button class="icon-btn" id="btn-open-panel" title="${L('在编辑器标签中打开')}">⤢</button>
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
          <span class="unread-dot" id="unread-dot" hidden title="${L('有新的提醒')}">0</span>
        </div>
        <div class="name-plate" id="name-plate">${L('桌宠')} · ${L('发呆中')}</div>
      </div>
      <div class="busy-veil" id="busy-veil" hidden><span class="spinner"></span><span id="busy-label">${L('思考中…')}</span></div>
    </main>

    <section class="chat" id="chat">
      <div class="chat-log" id="chat-log" aria-live="polite"></div>
      <div class="quick-actions" id="quick-actions"></div>
      <form class="composer" id="composer">
        <textarea id="input" rows="1" placeholder="${L('和桌宠聊聊…（Enter 发送 / Shift+Enter 换行）')}"></textarea>
        <button type="submit" class="send-btn" id="send-btn" title="${L('发送')}">↑</button>
      </form>
      <div class="chat-foot">
        <span id="model-chip" class="model-chip">${L('未配置')}</span>
        <span id="index-chip" class="index-chip" hidden></span>
        <button class="problem-chip" id="problem-chip" hidden title="${L('当前文件的问题')}">⚠ 0</button>
        <button class="link-btn" id="btn-ai">${L('AI 设置')}</button>
      </div>
    </section>

    <div class="drawer" id="drawer" hidden>
      <div class="drawer-head">
        <strong id="drawer-title">${L('形象库')}</strong>
        <button class="icon-btn" id="drawer-close" title="${L('关闭')}">✕</button>
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
