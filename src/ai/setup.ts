import { L } from '../i18n';
import * as vscode from 'vscode';
import type { PetHost } from '../pet/host';
import { API_KEY_SECRET } from './index';
import { listOpenAiModels } from './openai';

/** coder 类模型优先，减少“装完就能用”这一步的选择成本。 */
const PREFERENCE = [
  /qwen2\.5-coder/i,
  /qwen3-coder/i,
  /deepseek-coder/i,
  /deepseek-chat/i,
  /codellama/i,
  /starcoder/i,
];

function score(model: string): number {
  for (let index = 0; index < PREFERENCE.length; index += 1) {
    if (PREFERENCE[index].test(model)) {
      return index;
    }
  }
  return /coder/i.test(model) ? PREFERENCE.length : PREFERENCE.length + 1;
}

/**
 * 快速配置：连上当前接口，列出模型，按 coder 优先级排序让用户一键选中。
 * 失败了给出“下载 Ollama / 打开设置”的明确出口。
 */
export async function quickSetup(
  context: vscode.ExtensionContext,
  host: PetHost,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('deskpet');
  const provider = config.get<string>('ai.provider', 'ollama');

  if (provider === 'vscode-lm') {
    host.say(L('当前用的是 VS Code 语言模型，已经不需要额外配置了。', `You are using the VS Code Language Model API — no extra configuration is needed.`), { action: 'happy' });
    return;
  }

  const baseUrl = config.get<string>('ai.baseUrl', 'http://127.0.0.1:11434/v1');
  const apiKey = await context.secrets.get(API_KEY_SECRET);

  if (provider === 'openai' && !apiKey) {
    const choice = await vscode.window.showInformationMessage(
      '云端接口需要先设置密钥，再选择模型。',
      '设置密钥',
    );
    if (choice === '设置密钥') {
      await vscode.commands.executeCommand('deskpet.setApiKey');
    }
    return;
  }

  let models: string[];
  try {
    models = await listOpenAiModels(baseUrl, apiKey);
  } catch (error) {
    const action = provider === 'ollama' ? '下载 Ollama' : '打开设置';
    const choice = await vscode.window.showWarningMessage(
      `连不上 ${baseUrl}。${provider === 'ollama' ? '请确认 ollama serve 正在运行。' : ''}`,
      action,
    );
    if (choice === '下载 Ollama') {
      await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
    } else if (choice === '打开设置') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'deskpet.ai');
    }
    void error;
    return;
  }

  if (!models.length) {
    host.say(L('接口能连上，但没有返回可用模型。先 ollama pull 一个 coder 模型吧。', `The endpoint is reachable but returned no models. Try "ollama pull" for a coder model first.`), {
      action: 'think',
    });
    return;
  }

  const current = config.get<string>('ai.model', '');
  const sorted = [...models].sort((left, right) => score(left) - score(right) || left.localeCompare(right));
  const picked = await vscode.window.showQuickPick(
    sorted.map((model) => ({
      label: model,
      description: model === current ? '当前' : score(model) <= 5 ? '推荐' : '',
      picked: model === current,
    })),
    {
      title: 'AI 桌宠 · 快速配置',
      placeHolder: `当前模型：${current || '未设置'}`,
    },
  );
  if (!picked) {
    return;
  }

  await config.update('ai.model', picked.label, vscode.ConfigurationTarget.Global);
  host.say(L(`连上了，以后就用 ${picked.label}。`, `Connected — I'll use ${picked.label} from now on.`), { action: 'happy' });
}

/**
 * 首次安装后的自动探测：只在“本机接口可用、但当前模型不存在”时打扰一次。
 * 用 globalState 保证只问一次，问过就不再烦。
 */
export function registerAutoSetup(context: vscode.ExtensionContext, host: PetHost): void {
  const key = 'deskpet.autoSetup.v1';
  if (context.globalState.get<boolean>(key)) {
    return;
  }

  const timer = setTimeout(async () => {
    const config = vscode.workspace.getConfiguration('deskpet');
    const provider = config.get<string>('ai.provider', 'ollama');
    if (provider === 'vscode-lm') {
      await context.globalState.update(key, true);
      return;
    }

    const apiKey = await context.secrets.get(API_KEY_SECRET);
    if (provider === 'openai' && !apiKey) {
      return;
    }

    let models: string[] = [];
    try {
      models = await listOpenAiModels(
        config.get<string>('ai.baseUrl', 'http://127.0.0.1:11434/v1'),
        apiKey,
      );
    } catch {
      return;
    }

    const current = config.get<string>('ai.model', '');
    if (!models.length || models.includes(current)) {
      await context.globalState.update(key, true);
      return;
    }

    const best = [...models].sort((left, right) => score(left) - score(right))[0];
    const choice = await vscode.window.showInformationMessage(
      `检测到本机有 ${models.length} 个可用模型（推荐 ${best}），要自动配置桌宠吗？`,
      '使用推荐模型',
      '选择其它模型',
      '稍后',
    );
    await context.globalState.update(key, true);

    if (choice === '使用推荐模型') {
      await config.update('ai.model', best, vscode.ConfigurationTarget.Global);
      host.say(L(`已经切到 ${best}，直接问我就行。`, `Switched to ${best}. Just ask me anything.`), { action: 'happy' });
    } else if (choice === '选择其它模型') {
      await quickSetup(context, host);
    }
  }, 9000);

  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)));
}
