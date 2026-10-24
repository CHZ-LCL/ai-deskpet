import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type {
  ChatMessage,
  HostMessage,
  PetAction,
  PetConfig,
  PetSnapshot,
  SoundSlot,
  WebviewMessage,
} from '../../shared/protocol';
import { createProvider, readAiSettings } from '../ai';
import { collectEditorSnippet, formatSnippet, workspaceSummary } from '../ai/context';
import { buildSystemPrompt, docsNoSourcePrompt, docsPrompt } from '../ai/prompts';
import type { ChatTurn } from '../ai/types';
import { buildPetConfig } from '../config';
import { gatherSources } from '../docs/search';
import { truncate } from '../util';
import type { AssetStore } from './assets';
import type { PetState } from './state';

const HISTORY_KEY = 'deskpet.history.v1';
const MAX_HISTORY = 80;
const MAX_TURNS = 14;

const CLICK_LINES = [
  '在的！要我帮你看点什么？',
  '点点点，痒——',
  '这一行写累了就歇会儿，我盯着呢。',
  '报错别慌，把光标放到那儿，我来看看。',
  '刚保存的文件我看到了，挺整齐。',
  '要不要我陪你查查文档？',
];

const CODE_HINT = /(代码|函数|报错|错误|异常|这个|这段|这里|上面|文件|变量|类|接口|实现|测试|优化|重构|解释|修复|写个|写一|怎么|为什么|bug|error|code|function|api|type|import|traceback|exception)/i;

export interface SayOptions {
  action?: PetAction;
  ttl?: number;
  speak?: boolean;
  actions?: Array<{ label: string; command?: string; send?: string }>;
}

export interface TurnOptions {
  id?: string;
  userText?: string;
  request: string;
  speak?: boolean;
  action?: PetAction;
}

/**
 * 桌宠的“大脑接线板”：管理所有已打开的 webview、对话流、状态与素材刷新。
 * 侧边栏和编辑器标签页共用同一个实例，所以两边看到的是同一段对话。
 */
export class PetHost implements vscode.Disposable {
  private readonly webviews = new Set<vscode.Webview>();
  private readonly disposables: vscode.Disposable[] = [];
  private history: ChatMessage[];
  private busy = false;
  private busyLabel: string | undefined;
  private current: { id: string; cts: vscode.CancellationTokenSource } | undefined;
  private clickCount = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly assets: AssetStore,
    private readonly state: PetState,
  ) {
    this.history = this.context.globalState.get<ChatMessage[]>(HISTORY_KEY) ?? [];
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async attach(webview: vscode.Webview): Promise<vscode.Disposable> {
    this.webviews.add(webview);
    const sub = webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handle(webview, message);
    });
    this.disposables.push(sub);
    await this.sendInit(webview);
    return new vscode.Disposable(() => {
      this.webviews.delete(webview);
      sub.dispose();
    });
  }

  detach(webview: vscode.Webview): void {
    this.webviews.delete(webview);
  }

  dispose(): void {
    this.current?.cts.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.webviews.clear();
  }

  // ---------------------------------------------------------------- 对外能力

  /** 好感度变动并立刻同步给所有面板。 */
  touchAffection(delta: number): void {
    this.state.addAffection(delta);
    this.broadcast({ type: 'snapshot', snapshot: this.state.snapshot() });
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.persistHistory();
  }

  say(text: string, options: SayOptions = {}): void {
    const action = options.action ?? 'happy';
    this.state.setMood(action);
    this.broadcast({
      type: 'say',
      text,
      action,
      ttl: options.ttl ?? 9000,
      speak: options.speak,
      actions: options.actions,
    });
  }

  react(action: PetAction): void {
    this.state.setMood(action);
    this.broadcast({ type: 'react', action });
  }

  notice(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.broadcast({ type: 'notice', text, kind });
  }

  openChat(draft?: string): void {
    this.broadcast({ type: 'openChat', draft });
  }

  async refreshAll(): Promise<void> {
    for (const webview of this.webviews) {
      try {
        const config = await buildPetConfig(this.context, webview, this.assets);
        const [items, sounds] = await Promise.all([
          this.assets.listAssets(webview),
          this.assets.listSounds(webview),
        ]);
        this.post(webview, { type: 'config', config });
        this.post(webview, { type: 'assets', assets: items, sounds });
      } catch {
        // webview 可能已经销毁，忽略
      }
    }
    this.broadcast({ type: 'snapshot', snapshot: this.state.snapshot() });
  }

  /** 命令行/快捷按钮触发的问答：仍然走统一的流式通道。 */
  async prompt(userText: string, request: string, options: Omit<TurnOptions, 'userText' | 'request'> = {}): Promise<string> {
    return this.runTurn({ ...options, userText, request });
  }

  /** 命令行触发的资料查询。 */
  async docs(query: string, id = crypto.randomUUID()): Promise<void> {
    await this.runDocs(id, query);
  }

  async runTurn(options: TurnOptions): Promise<string> {
    if (this.busy) {
      this.say('等等，我还在想上一个问题…', { action: 'think' });
      return '';
    }

    const id = options.id ?? crypto.randomUUID();
    const priorHistory = [...this.history];
    if (options.userText) {
      const message: ChatMessage = {
        id: `${id}-u`,
        role: 'user',
        content: options.userText,
        at: Date.now(),
      };
      this.history.push(message);
      this.broadcast({ type: 'chatUser', message });
    }

    this.busy = true;
    this.busyLabel = '思考中…';
    this.broadcast({ type: 'busy', busy: true, label: this.busyLabel });
    this.broadcast({ type: 'chatStart', id });
    this.react('think');

    const cts = new vscode.CancellationTokenSource();
    this.current = { id, cts };
    let acc = '';

    try {
      const settings = await readAiSettings(this.context);
      const provider = createProvider(settings);
      const snapshot = this.state.snapshot();
      const system = [
        buildSystemPrompt({
          name: vscode.workspace.getConfiguration('deskpet').get<string>('pet.name', '小豆'),
          extra: vscode.workspace.getConfiguration('deskpet').get<string>('ai.extraInstructions', ''),
          level: snapshot.level,
          days: snapshot.daysTogether,
        }),
        `当前环境：${workspaceSummary()}；AI：${provider.label}。`,
      ].join('\n\n');

      const turns: ChatTurn[] = [{ role: 'system', content: system }];
      for (const message of priorHistory.slice(-MAX_TURNS)) {
        turns.push({ role: message.role, content: truncate(message.content, 4000) });
      }
      turns.push({ role: 'user', content: options.request });

      acc = await provider.chat(
        turns,
        (delta) => {
          acc += delta;
          this.broadcast({ type: 'chatDelta', id, text: delta });
        },
        cts.token,
      );

      if (cts.token.isCancellationRequested) {
        this.broadcast({ type: 'chatError', id, message: '已取消。' });
        return acc;
      }
      if (!acc.trim()) {
        throw new Error('模型没有返回内容。请检查模型是否加载成功，或换一个模型试试。');
      }

      const message: ChatMessage = {
        id,
        role: 'assistant',
        content: acc,
        at: Date.now(),
      };
      this.history.push(message);
      await this.persistHistory();

      const ttsEnabled = vscode.workspace.getConfiguration('deskpet').get<boolean>('pet.tts', false);
      this.broadcast({
        type: 'chatEnd',
        id,
        text: acc,
        message,
        speak: options.speak ?? ttsEnabled,
      });

      const before = this.state.snapshot();
      this.state.recordChat();
      this.state.addAffection(4);
      const after = this.state.snapshot();
      this.broadcast({ type: 'snapshot', snapshot: after });
      this.react(options.action ?? 'happy');
      if (after.level > before.level) {
        this.say(`好感度升级到 Lv.${after.level} 啦，我会更努力帮你的！`, { action: 'shy' });
      }

      return acc;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.broadcast({ type: 'chatError', id, message: text });
      this.react('alert');
      return acc;
    } finally {
      this.busy = false;
      this.busyLabel = undefined;
      this.current = undefined;
      cts.dispose();
      this.broadcast({ type: 'busy', busy: false });
    }
  }

  // ---------------------------------------------------------------- 消息处理

  private async handle(webview: vscode.Webview, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.sendInit(webview);
        break;
      case 'send':
        await this.handleUserSend(message.id, message.text, message.mode);
        break;
      case 'abort':
        if (this.current?.id === message.id) {
          this.current.cts.cancel();
        }
        break;
      case 'click':
        this.handleClick();
        break;
      case 'command':
        await vscode.commands.executeCommand(message.command, message.args);
        break;
      case 'switchPet':
        await this.assets.switchAsset(message.id);
        await this.refreshAll();
        this.say('换好新形象啦，看看合不合身？', { action: 'shy' });
        break;
      case 'switchSound': {
        if (message.id === '__none__') {
          await this.assets.unbindSound(message.slot);
          await this.refreshAll();
          this.say('这个场景改用内置音效啦。', { action: 'happy' });
          break;
        }
        const sounds = await this.assets.listSounds(webview);
        const item = sounds.find((sound) => sound.id === message.id);
        if (item) {
          const filePath = vscode.Uri.parse(item.uri).fsPath;
          await this.assets.bindSound(message.slot, filePath);
          await this.refreshAll();
          this.say('音效换好了，点我试试？', { action: 'happy' });
        }
        break;
      }
      case 'clearHistory':
        await this.clearHistory();
        this.say('对话记录清空啦，从头开始。', { action: 'idle' });
        break;
      case 'reloadAssets':
        await this.refreshAll();
        break;
      default:
        break;
    }
  }

  private async handleUserSend(id: string, text: string, mode: 'chat' | 'docs'): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (this.busy) {
      this.say('我还在想上一个问题，稍等我一下～', { action: 'think' });
      return;
    }

    if (mode === 'docs') {
      await this.runDocs(id, trimmed);
      return;
    }

    const snippet = collectEditorSnippet(5000);
    const includeCode = snippet && (snippet.hasSelection || CODE_HINT.test(trimmed));
    const request = includeCode
      ? `${trimmed}\n\n[当前编辑器上下文]\n${formatSnippet(snippet)}`
      : trimmed;

    await this.runTurn({ id, userText: trimmed, request });
  }

  private async runDocs(id: string, query: string): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    this.current = { id, cts };
    this.busy = true;
    this.broadcast({ type: 'busy', busy: true, label: '查资料中…' });
    this.broadcast({ type: 'chatStart', id });
    this.broadcast({
      type: 'chatUser',
      message: { id: `${id}-u`, role: 'user', content: `📚 ${query}`, at: Date.now() },
    });
    this.history.push({ id: `${id}-u`, role: 'user', content: `📚 ${query}`, at: Date.now() });

    try {
      const { sources } = await gatherSources(this.context, query, cts.token);
      if (cts.token.isCancellationRequested) {
        this.broadcast({ type: 'chatError', id, message: '已取消。' });
        return;
      }
      const languageId = vscode.window.activeTextEditor?.document.languageId ?? 'text';
      const request = sources.length
        ? docsPrompt(query, sources)
        : docsNoSourcePrompt(query, languageId);

      this.busy = false;
      const answer = await this.runTurn({ id, request, speak: false });
      if (answer && sources.length) {
        const links = sources.map((source, index) => `[资料 ${index + 1}](${source.url})`).join(' · ');
        this.broadcast({ type: 'notice', text: `参考：${links}` });
      }
    } catch (error) {
      this.broadcast({
        type: 'chatError',
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busy = false;
      this.current = undefined;
      cts.dispose();
      this.broadcast({ type: 'busy', busy: false });
    }
  }

  private handleClick(): void {
    this.state.recordClick();
    this.state.addAffection(1);
    this.clickCount += 1;
    this.broadcast({ type: 'snapshot', snapshot: this.state.snapshot() });
    if (this.clickCount % 5 === 0) {
      const line = CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)];
      this.say(line, { action: 'shy', ttl: 5000 });
    }
  }

  private async sendInit(webview: vscode.Webview): Promise<void> {
    const config: PetConfig = await buildPetConfig(this.context, webview, this.assets);
    const [items, sounds] = await Promise.all([
      this.assets.listAssets(webview),
      this.assets.listSounds(webview),
    ]);
    const snapshot: PetSnapshot = this.state.snapshot();
    this.post(webview, {
      type: 'init',
      config,
      snapshot,
      history: this.history.slice(-30),
      assets: items,
      sounds,
      busy: this.busy,
      busyLabel: this.busyLabel,
    });
  }

  private post(webview: vscode.Webview, message: HostMessage): void {
    void webview.postMessage(message);
  }

  private broadcast(message: HostMessage): void {
    for (const webview of this.webviews) {
      void webview.postMessage(message);
    }
  }

  private async persistHistory(): Promise<void> {
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    await this.context.globalState.update(HISTORY_KEY, this.history);
  }
}
