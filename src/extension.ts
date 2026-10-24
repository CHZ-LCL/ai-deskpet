import * as vscode from 'vscode';
import { API_KEY_SECRET } from './ai';
import { diffContentProvider, focusPet, registerAssistCommands } from './commands/assist';
import { DOCS_KEY_SECRET } from './docs/search';
import { AssetStore } from './pet/assets';
import { PetHost } from './pet/host';
import { PetPanel } from './pet/panel';
import { PetState } from './pet/state';
import { PetViewProvider } from './pet/viewProvider';
import { CMD, DIFF_SCHEME, VIEW_ID } from '../shared/protocol';

export function activate(context: vscode.ExtensionContext): void {
  const assets = new AssetStore(context);
  const state = new PetState(context);
  const host = new PetHost(context, assets, state);
  const viewProvider = new PetViewProvider(context, host);

  context.subscriptions.push(
    host,
    vscode.window.registerWebviewViewProvider(PetViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider),
  );

  const register = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register(CMD.openPanel, () => PetPanel.show(context, host));
  register(CMD.focus, () => focusPet());
  register(CMD.chat, async () => {
    await focusPet();
    host.openChat();
  });
  register(CMD.searchDocs, () => searchDocs(host));
  register(CMD.importModel, async () => {
    await assets.importFromDialog();
    await host.refreshAll();
  });
  register(CMD.importSound, async () => {
    await assets.importSound();
    await host.refreshAll();
  });
  register(CMD.setApiKey, () => setApiKey(context, host));
  register(CMD.resetPet, () => resetPet(host, state));
  register(CMD.openSettings, () => vscode.commands.executeCommand('workbench.action.openSettings', 'deskpet'));

  // 供 webview 使用的内部命令（不注册到命令面板）
  context.subscriptions.push(
    vscode.commands.registerCommand('deskpet.updateSetting', async (args: { key: string; value: unknown }) => {
      if (!args?.key) {
        return;
      }
      await vscode.workspace
        .getConfiguration('deskpet')
        .update(args.key, args.value, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('deskpet.openExternal', async (url: string) => {
      if (/^https?:\/\//i.test(url)) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    vscode.commands.registerCommand('deskpet.copyText', async (text: string) => {
      await vscode.env.clipboard.writeText(text);
    }),
  );

  context.subscriptions.push(...registerAssistCommands(host));

  registerReactions(context, host);
  registerStartup(context);
  registerFirstRun(context);

  // 任一设置变更都重新推送配置（形象、音效、TTS 等都靠这条链路生效）
  let refreshTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('deskpet')) {
        return;
      }
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      refreshTimer = setTimeout(() => void host.refreshAll(), 250);
    }),
  );
}

export function deactivate(): void {
  // 无额外清理：所有 disposables 由 context 统一管理
}

async function searchDocs(host: PetHost): Promise<void> {
  const query = await vscode.window.showInputBox({
    title: '桌宠查资料',
    prompt: '输入关键词，或直接粘贴文档地址',
    placeHolder: '例如：VS Code webview 加载本地 glb 模型 / https://example.com/docs',
    ignoreFocusOut: true,
  });
  if (!query?.trim()) {
    return;
  }
  await focusPet();
  await host.docs(query.trim());
}

async function setApiKey(context: vscode.ExtensionContext, host: PetHost): Promise<void> {
  const target = await vscode.window.showQuickPick(
    [
      { label: '$(key) AI 服务密钥', description: 'OpenAI / DeepSeek / 通义千问等云端接口使用', value: 'ai' },
      { label: '$(search) 文档搜索密钥', description: 'Tavily 或 Serper.dev，用于联网查资料', value: 'docs' },
      { label: '$(trash) 清除所有密钥', description: '从系统密钥库删除', value: 'clear' },
    ],
    { title: '要设置哪个密钥？' },
  );
  if (!target) {
    return;
  }

  if (target.value === 'clear') {
    await context.secrets.delete(API_KEY_SECRET);
    await context.secrets.delete(DOCS_KEY_SECRET);
    host.notice('已清除保存的密钥', 'info');
    return;
  }

  const key = await vscode.window.showInputBox({
    title: target.value === 'ai' ? 'AI 服务密钥' : '文档搜索密钥',
    prompt: '密钥会保存在 VS Code 的 SecretStorage（系统凭据库），不会写进 settings.json',
    password: true,
    ignoreFocusOut: true,
  });
  if (!key?.trim()) {
    return;
  }

  await context.secrets.store(target.value === 'ai' ? API_KEY_SECRET : DOCS_KEY_SECRET, key.trim());
  host.notice('密钥已保存', 'info');
  host.say(target.value === 'ai' ? '密钥收到，我这就试试能不能连上。' : '搜索密钥收到，以后查资料会更准。', {
    action: 'happy',
  });
  await host.refreshAll();
}

async function resetPet(host: PetHost, state: PetState): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    '确定要重置桌宠的好感度、互动记录和对话历史吗？',
    { modal: true },
    '重置',
  );
  if (choice !== '重置') {
    return;
  }
  await state.reset();
  await host.clearHistory();
  await host.refreshAll();
  host.say('我们重新认识一下吧，我是你的编程搭子。', { action: 'shy' });
}

function registerReactions(context: vscode.ExtensionContext, host: PetHost): void {
  const config = () => vscode.workspace.getConfiguration('deskpet');
  let lastActivity = Date.now();

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      lastActivity = Date.now();
      if (!config().get<boolean>('pet.reactOnSave', true) || document.uri.scheme !== 'file') {
        return;
      }
      host.touchAffection(1);
      host.react('happy');
    }),
  );

  let diagnosticsTimer: NodeJS.Timeout | undefined;
  const lastHint = new Map<string, number>();

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((event) => {
      if (!config().get<boolean>('pet.reactOnError', true)) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const activeUri = editor.document.uri.toString();
      if (!event.uris.some((uri) => uri.toString() === activeUri)) {
        return;
      }
      if (diagnosticsTimer) {
        clearTimeout(diagnosticsTimer);
      }
      diagnosticsTimer = setTimeout(() => {
        const errors = vscode.languages
          .getDiagnostics(editor.document.uri)
          .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
        if (!errors.length) {
          return;
        }
        const previous = lastHint.get(activeUri) ?? 0;
        if (Date.now() - previous < 120_000) {
          return;
        }
        lastHint.set(activeUri, Date.now());
        host.say(`这个文件有 ${errors.length} 处错误，要我看看吗？`, {
          action: 'alert',
          ttl: 12_000,
          actions: [
            { label: '帮我修', command: CMD.fix },
            { label: '先不用' },
          ],
        });
      }, 2500);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        lastActivity = Date.now();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === 'file') {
        lastActivity = Date.now();
      }
    }),
  );

  // 久坐提醒：只在持续编码时触发
  const timer = setInterval(() => {
    const minutes = config().get<number>('pet.breakReminderMinutes', 50);
    if (!minutes || minutes <= 0) {
      return;
    }
    const idleMinutes = (Date.now() - lastActivity) / 60_000;
    if (idleMinutes >= minutes) {
      lastActivity = Date.now();
      host.say(`已经连续写了 ${Math.round(idleMinutes)} 分钟啦，站起来接杯水、看看远处吧。`, {
        action: 'sleep',
        ttl: 15_000,
      });
    }
  }, 60_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
}

function registerStartup(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('deskpet');
  if (!config.get<boolean>('pet.showOnStartup', false)) {
    return;
  }
  const timer = setTimeout(() => {
    void vscode.commands.executeCommand('workbench.view.extension.deskpet');
  }, 1200);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)));
}

/** 首次安装时打个招呼，给一个明确的入口，而不是直接抢占侧边栏。 */
function registerFirstRun(context: vscode.ExtensionContext): void {
  const key = 'deskpet.welcomed.v1';
  if (context.globalState.get<boolean>(key)) {
    return;
  }
  const timer = setTimeout(async () => {
    await context.globalState.update(key, true);
    const choice = await vscode.window.showInformationMessage(
      'AI 桌宠已经住进编辑器了。左侧活动栏可以找到它，也可以按 Ctrl+Alt+P 直接叫它。',
      '打开桌宠',
      '先不用',
    );
    if (choice === '打开桌宠') {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }
  }, 2500);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)));
}
