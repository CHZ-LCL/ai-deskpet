import * as vscode from 'vscode';
import { API_KEY_SECRET } from './ai';
import { bindAdviceActions, focusPet, registerAssistCommands } from './commands/assist';
import { diffContentProvider } from './commands/diff';
import { registerDocCommands } from './commands/docs';
import { registerTestCommands } from './commands/tests';
import { registerThemeCommands } from './commands/theme';
import { registerFixAllCommand } from './commands/fixAll';
import { registerHistoryCommands } from './commands/history';
import { initFixHistory } from './history/fixHistory';
import { registerDebugCommands } from './commands/debug';
import { registerStandardsCommands } from './commands/standards';
import { registerInlineChat } from './inline/chat';
import { registerInlineCodeLens } from './inline/codeLens';
import { quickSetup, registerAutoSetup } from './ai/setup';
import { scanDocDrift } from './docs/docTargets';
import { registerTerminalCapture } from './debug/terminalLog';
import { ProjectContext } from './context/project';
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
  const project = new ProjectContext(context);
  initFixHistory(context);
  const host = new PetHost(context, assets, state, project);
  const viewProvider = new PetViewProvider(context, host);

  context.subscriptions.push(
    host,
    project,
    vscode.window.registerWebviewViewProvider(PetViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider),
  );

  project.onDidFinish = () => {
    void host.refreshAll();
  };

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
  register(CMD.quickSetup, () => quickSetup(context, host));
  register(CMD.resetPet, () => resetPet(host, state));
  register(CMD.reindex, async () => {
    await project.rebuild();
    host.notice(`项目索引完成：${project.label}`, 'info');
  });
  register(CMD.openSettings, () => vscode.commands.executeCommand('workbench.action.openSettings', 'deskpet'));

  // 供 webview 使用的内部命令（不注册到命令面板）
  context.subscriptions.push(
    vscode.commands.registerCommand('deskpet.updateSetting', async (args: { key: string; value: unknown; scope?: string }) => {
      if (!args?.key) {
        return;
      }
      const target =
        args.scope === 'workspace' && vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('deskpet').update(args.key, args.value, target);
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
  context.subscriptions.push(...registerDebugCommands(host));
  context.subscriptions.push(...registerStandardsCommands(host));
  context.subscriptions.push(...registerTestCommands(host));
  context.subscriptions.push(...registerDocCommands(host));
  context.subscriptions.push(...registerThemeCommands(host, context));
  context.subscriptions.push(...registerFixAllCommand(host));
  context.subscriptions.push(...registerHistoryCommands(host));
  registerInlineChat(context, host);
  registerInlineCodeLens(context);
  bindAdviceActions(host);

  registerTerminalCapture(context, (failure) => {
    if (!vscode.workspace.getConfiguration('deskpet').get<boolean>('debug.watchTerminal', true)) {
      return;
    }
    const exit = typeof failure.exitCode === 'number' ? `（退出码 ${failure.exitCode}）` : '';
    host.nudge(`命令失败了${exit}，要我看看报错吗？`, {
      priority: 'normal',
      action: 'alert',
      actions: [
        { label: '分析报错', command: CMD.analyzeFailure },
        { label: '先不用' },
      ],
    });
  });

  registerReactions(context, host, project);
  registerStartup(context);
  registerFirstRun(context);
  registerAutoSetup(context, host);

  // 后台建索引，别和激活流程抢时间
  const indexTimer = setTimeout(() => {
    if (vscode.workspace.getConfiguration('deskpet').get<boolean>('context.enabled', true)) {
      void project.ensureBuilt();
    }
  }, 2500);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(indexTimer)));

  // 任一设置变更都重新推送配置（形象、音效、TTS 等都靠这条链路生效）
  let refreshTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('deskpet')) {
        return;
      }
      if (event.affectsConfiguration('deskpet.context')) {
        void project.rebuild();
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

function registerReactions(context: vscode.ExtensionContext, host: PetHost, project: ProjectContext): void {
  const config = () => vscode.workspace.getConfiguration('deskpet');

  // 久坐提醒：按“连续编码时长”计时，中途休息会自动重新开始
  let codingSince = Date.now();
  let lastActivity = Date.now();
  const lastDocHint = new Map<string, number>();

  const maybeWarnDocDrift = (document: vscode.TextDocument) => {
    const text = document.getText();
    if (text.length > 300_000) {
      return;
    }
    const drift = scanDocDrift(text, document.languageId);
    if (!drift.length) {
      return;
    }
    const key = document.uri.toString();
    if (Date.now() - (lastDocHint.get(key) ?? 0) < 10 * 60_000) {
      return;
    }
    lastDocHint.set(key, Date.now());
    host.nudge(`这个文件有 ${drift.length} 处文档和签名对不上`, {
      priority: 'low',
      action: 'think',
      actions: [{ label: '查看', command: CMD.checkDocs }],
    });
  };
  const markActive = () => {
    const now = Date.now();
    if (now - lastActivity > 5 * 60_000) {
      // 超过 5 分钟没动过，视为休息过
      codingSince = now;
    }
    lastActivity = now;
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      markActive();
      if (document.uri.scheme === 'file') {
        void project.updateFile(document.uri);
        maybeWarnDocDrift(document);
      }
      if (!config().get<boolean>('pet.reactOnSave', true) || document.uri.scheme !== 'file') {
        return;
      }
      host.touchAffection(1);
      host.react('happy');
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        markActive();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === 'file') {
        markActive();
        host.markTyping();
      }
    }),
  );

  let diagnosticsTimer: NodeJS.Timeout | undefined;
  let deleteTimer: NodeJS.Timeout | undefined;
  const lastHint = new Map<string, number>();

  const publishProblems = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      host.publishProblems(undefined, []);
      return;
    }
    const items = vscode.languages
      .getDiagnostics(editor.document.uri)
      .slice(0, 20)
      .map((diagnostic) => ({
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        severity:
          diagnostic.severity === vscode.DiagnosticSeverity.Error
            ? ('error' as const)
            : diagnostic.severity === vscode.DiagnosticSeverity.Warning
              ? ('warning' as const)
              : ('info' as const),
        message: diagnostic.message,
        source: diagnostic.source,
      }));
    host.publishProblems(vscode.workspace.asRelativePath(editor.document.uri, false), items);
  };

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((event) => {
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
        publishProblems();

        if (!config().get<boolean>('pet.reactOnError', true)) {
          return;
        }
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
        host.nudge(`这个文件有 ${errors.length} 处错误，要我看看吗？`, {
          priority: 'normal',
          action: 'alert',
          actions: [
            { label: '帮我修', command: CMD.fix },
            { label: '讲透这段', command: CMD.teach },
          ],
        });
      }, 2000);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => publishProblems()),
  );

  const initialProblems = setTimeout(publishProblems, 2500);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(initialProblems)));

  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.exitCode === undefined || event.exitCode === 0) {
        return;
      }
      const name = event.execution.task.name;
      if (!/(build|compile|test|构建|编译|测试)/i.test(name)) {
        return;
      }
      host.react('alert');
      host.nudge(`「${name}」没有通过，要我帮你看看代码吗？`, {
        priority: 'normal',
        action: 'alert',
        actions: [
          { label: '讲解当前文件', command: CMD.explain },
          { label: '讲透这段', command: CMD.teach },
        ],
      });
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles(() => {
      // 删除会让依赖图失效，延迟重建一次即可
      if (deleteTimer) {
        clearTimeout(deleteTimer);
      }
      deleteTimer = setTimeout(() => void project.rebuild(), 4000);
    }),
  );

  // 久坐提醒：只在持续编码时触发
  const timer = setInterval(() => {
    const minutes = config().get<number>('pet.breakReminderMinutes', 50);
    const now = Date.now();
    if (now - lastActivity > 5 * 60_000) {
      // 人已经离开了，重新计时
      codingSince = now;
      lastActivity = now;
      return;
    }
    if (!minutes || minutes <= 0) {
      return;
    }
    if (now - codingSince >= minutes * 60_000) {
      host.nudge(`已经连续写了 ${Math.round((now - codingSince) / 60_000)} 分钟啦，站起来接杯水、看看远处吧。`, {
        priority: 'low',
        action: 'sleep',
      });
      codingSince = now;
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
