import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type {
  AdviceAction,
  AdviceCard,
  ChatMessage,
  HostMessage,
  InterruptionLevel,
  PetAction,
  PetConfig,
  PetSnapshot,
  ProblemItem,
  SoundSlot,
  StandardsPack,
  WebviewMessage,
} from '../../shared/protocol';
import { createProvider, readAiSettings } from '../ai';
import { collectEditorSnippet, formatSnippet, workspaceSummary } from '../ai/context';
import { buildSystemPrompt, docsNoSourcePrompt, docsPrompt } from '../ai/prompts';
import type { ChatTurn } from '../ai/types';
import { buildPetConfig } from '../config';
import type { ProjectContext } from '../context/project';
import { gatherSources } from '../docs/search';
import { PACKS, readStandardsConfig, standardsBlock } from '../standards/rules';
import { truncate } from '../util';
import type { AssetStore } from './assets';
import type { PetState } from './state';

const HISTORY_KEY = 'deskpet.history.v1';
const MAX_HISTORY = 80;
const MAX_TURNS = 8;
const TURN_CHARS = 2500;

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
  /** 是否把项目级上下文（索引检索 + 符号定义）拼进请求 */
  useProjectContext?: boolean;
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
  private lastBubbleAt = 0;
  private bubbleTimes: number[] = [];
  private lastTypedAt = 0;
  private adviceHandler?: (id: string, action: AdviceAction) => Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly assets: AssetStore,
    private readonly state: PetState,
    private readonly project: ProjectContext,
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

  /** 供扩展记录“用户正在输入”，主动提醒会避开这个窗口。 */
  markTyping(): void {
    this.lastTypedAt = Date.now();
  }

  /**
   * 克制型主动提醒：按打扰等级、最近是否弹过、是否正在打字决定用气泡还是只写进对话。
   * 这样“有价值的信息”不会丢，但也不会一直抢焦点。
   */
  nudge(
    text: string,
    options: {
      priority?: 'low' | 'normal';
      action?: PetAction;
      actions?: Array<{ label: string; command?: string; send?: string }>;
    } = {},
  ): void {
    const level = vscode.workspace
      .getConfiguration('deskpet')
      .get<InterruptionLevel>('pet.interruption', 'balanced');
    const now = Date.now();
    this.bubbleTimes = this.bubbleTimes.filter((time) => now - time < 3_600_000);

    const typing = now - this.lastTypedAt < 5000;
    const recentBubble = now - this.lastBubbleAt < 4 * 60_000;
    const tooMany = this.bubbleTimes.length >= 6;

    const quiet =
      level === 'quiet' ||
      (level === 'balanced' && (options.priority === 'low' || typing || recentBubble || tooMany));

    if (!quiet) {
      this.lastBubbleAt = now;
      this.bubbleTimes.push(now);
    }

    this.broadcast({
      type: 'nudge',
      text,
      quiet,
      action: options.action ?? 'alert',
      actions: options.actions,
    });
  }

  setAdviceHandler(handler: (id: string, action: AdviceAction) => Promise<void>): void {
    this.adviceHandler = handler;
  }

  presentAdvice(advice: AdviceCard): void {
    this.broadcast({ type: 'advice', advice });
  }

  /** 当前文件的诊断快照：驱动面板底部的问题角标与清单。 */
  publishProblems(file: string | undefined, items: ProblemItem[]): void {
    this.broadcast({ type: 'problems', file, items });
  }

  /** 规范面板的数据：规则包开关 + 项目约定 + 自定义/白名单数量。 */
  standardsPayload(): { type: 'standards'; packs: StandardsPack[]; conventions: string[]; customCount: number; whitelistCount: number } {
    const config = readStandardsConfig();
    return {
      type: 'standards',
      packs: PACKS.map((pack) => ({
        id: pack.id,
        label: pack.label,
        description: pack.description,
        enabled: config.packs.includes(pack.id),
      })),
      conventions: this.project.getConventions(),
      customCount: config.custom.length,
      whitelistCount: config.whitelist.length,
    };
  }

  resolveAdvice(id: string, action: AdviceAction, ok: boolean): void {
    this.broadcast({ type: 'adviceDone', id, action, ok });
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
        const config = await buildPetConfig(this.context, webview, this.assets, this.project.label);
        const [items, sounds] = await Promise.all([
          this.assets.listAssets(webview),
          this.assets.listSounds(webview),
        ]);
        this.post(webview, { type: 'config', config });
        this.post(webview, { type: 'assets', assets: items, sounds });
        this.post(webview, this.standardsPayload());
      } catch {
        // webview 可能已经销毁，忽略
      }
    }
    this.broadcast({ type: 'snapshot', snapshot: this.state.snapshot() });
  }

  /** 命令行/快捷按钮触发的问答：仍然走统一的流式通道。 */
  async prompt(userText: string, request: string, options: Omit<TurnOptions, 'userText' | 'request'> = {}): Promise<string> {
    return this.runTurn({
      ...options,
      userText,
      request,
      useProjectContext: options.useProjectContext ?? true,
    });
  }

  /** 命令行触发的资料查询。 */
  async docs(query: string, id = crypto.randomUUID()): Promise<void> {
    await this.runDocs(id, query);
  }

  /**
   * 行内对话用的一次性问答：不写入侧边栏历史，但仍带项目上下文与团队规范。
   */
  async askInline(
    request: string,
    onDelta: (text: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<string> {
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
      standardsBlock(this.project.getConventions(), this.project.getStyleProfile()),
    ].join('\n\n');

    let bundle = '';
    try {
      bundle = await Promise.race([
        this.project.buildBundle({
          query: request,
          activeUri: vscode.window.activeTextEditor?.document.uri,
          maxChars: 5000,
        }),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 5000)),
      ]);
    } catch {
      // 索引不可用或超时就先不附带，行内对话要快
    }

    const messages: ChatTurn[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: bundle ? `${request}\n\n[项目上下文 · 自动检索]\n${bundle}` : request,
      },
    ];

    const cts = new vscode.CancellationTokenSource();
    const sub = token?.onCancellationRequested(() => cts.cancel());
    try {
      return await provider.chat(messages, onDelta, cts.token);
    } finally {
      sub?.dispose();
      cts.dispose();
    }
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
        standardsBlock(this.project.getConventions(), this.project.getStyleProfile()),
      ].join('\n\n');

      const turns: ChatTurn[] = [{ role: 'system', content: system }];
      for (const message of priorHistory.slice(-MAX_TURNS)) {
        turns.push({ role: message.role, content: truncate(message.content, TURN_CHARS) });
      }

      // 项目级上下文：索引检索 + 依赖邻居 + 符号定义，按预算拼装
      let request = options.request;
      if (options.useProjectContext) {
        const projectBlock = await this.collectProjectContext(options.request, id);
        if (projectBlock) {
          request = `${options.request}\n\n[项目上下文 · 本地索引自动检索，可能不完整]\n${projectBlock}`;
        }
      }
      turns.push({ role: 'user', content: request });

      acc = await provider.chat(
        turns,
        (delta) => {
          acc += delta;
          this.broadcast({ type: 'chatDelta', id, text: delta });
        },
        cts.token,
      );

      if (cts.token.isCancellationRequested) {
        if (!acc.trim()) {
          this.broadcast({ type: 'chatError', id, message: '已取消。' });
          return '';
        }
        // 已经生成的内容保留下来，不要因为点了停止就丢掉
        const partial: ChatMessage = {
          id,
          role: 'assistant',
          content: `${acc}\n\n> 已停止生成`,
          at: Date.now(),
        };
        this.history.push(partial);
        await this.persistHistory();
        this.broadcast({ type: 'chatEnd', id, text: acc, message: partial, speak: false });
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

  /**
   * 组装项目上下文；索引尚未建好时短暂等待，超时就先不附带，绝不阻塞对话。
   */
  private async collectProjectContext(query: string, id: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('deskpet');
    if (!config.get<boolean>('context.enabled', true)) {
      return '';
    }

    if (!this.project.ready) {
      this.busyLabel = '建立项目索引…';
      this.broadcast({ type: 'busy', busy: true, label: this.busyLabel });
    }

    try {
      const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000));
      const bundle = await Promise.race([
        this.project.buildBundle({
          query,
          activeUri: vscode.window.activeTextEditor?.document.uri,
          maxChars: config.get<number>('context.maxChars', 8000),
          includeDefinitions: true,
        }),
        timeout,
      ]);
      return bundle ?? '';
    } catch {
      return '';
    } finally {
      if (this.busy) {
        this.busyLabel = '思考中…';
        this.broadcast({ type: 'busy', busy: true, label: this.busyLabel });
      }
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
      case 'adviceAction':
        await this.adviceHandler?.(message.id, message.action);
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
          const filePath = await this.assets.resolveSoundPath(item.id);
          if (!filePath) {
            this.notice('音效文件找不到了，可能已被移动或删除。', 'warn');
            break;
          }
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

    await this.runTurn({ id, userText: trimmed, request, useProjectContext: Boolean(includeCode) });
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
      const { sources, searched } = await gatherSources(this.context, query, cts.token);
      if (cts.token.isCancellationRequested) {
        this.broadcast({ type: 'chatError', id, message: '已取消。' });
        return;
      }
      if (searched && !sources.length) {
        this.broadcast({ type: 'notice', text: '没有搜到可用资料，先凭已有知识回答（可能不是最新版本）。', kind: 'warn' });
      }
      const languageId = vscode.window.activeTextEditor?.document.languageId ?? 'text';
      const request = sources.length
        ? docsPrompt(query, sources)
        : docsNoSourcePrompt(query, languageId);

      this.busy = false;
      const answer = await this.runTurn({ id, request, speak: false, useProjectContext: false });
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
    const config: PetConfig = await buildPetConfig(this.context, webview, this.assets, this.project.label);
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
    this.post(webview, this.standardsPayload());
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
