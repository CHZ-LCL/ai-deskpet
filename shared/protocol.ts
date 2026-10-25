/**
 * 扩展宿主 (extension host) 与 webview 之间的消息协议。
 * 这个文件会被两端同时引用，任何字段改动都要两边同步。
 */

export type PetAction = 'idle' | 'happy' | 'think' | 'alert' | 'sleep' | 'wave' | 'shy';

export type RendererKind = 'builtin' | 'image' | 'live2d' | 'vrm';

export type SoundSlot = 'click' | 'happy' | 'alert' | 'error' | 'switch';

/** 主动提醒的打扰程度 */
export type InterruptionLevel = 'quiet' | 'balanced' | 'chatty';

export type AdviceAction = 'apply' | 'diff' | 'copy' | 'dismiss';

export interface AdviceCard {
  id: string;
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  problem: string;
  cause: string;
  plan: string;
  impact: string;
}

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface ProblemItem {
  line: number;
  column: number;
  severity: ProblemSeverity;
  message: string;
  source?: string;
}

export interface PetAssets {
  /** 单张图片形象的 url */
  imageUri?: string;
  /** 随插件分发的默认立绘（放到 assets/default/ 自动生效） */
  builtinImageUri?: string;
  /** Live2D 的 .model3.json / .model.json 的 url */
  live2dModelUri?: string;
  /** Cubism Core 脚本 url（由用户提供） */
  cubismCoreUri?: string;
  /** 3D 模型 url (.vrm / .glb) */
  vrmModelUri?: string;
  /** 音效槽位 -> url */
  sounds: Partial<Record<SoundSlot, string>>;
}

export interface PetConfig {
  name: string;
  renderer: RendererKind;
  scale: number;
  volume: number;
  tts: boolean;
  ttsRate: number;
  assets: PetAssets;
  aiProviderLabel: string;
  aiModel: string;
  /** 项目索引状态文案，例如「1234 文件 · 5678 块」 */
  contextLabel?: string;
  /** 主动提醒的打扰程度 */
  interruption: InterruptionLevel;
  /** 按需加载的渲染器脚本地址（webview 资源 url） */
  rendererScripts: { live2d?: string; vrm?: string };
}

export interface PetSnapshot {
  affection: number;
  level: number;
  mood: PetAction;
  totalClicks: number;
  totalChats: number;
  daysTogether: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  error?: boolean;
}

export interface AssetItem {
  id: string;
  name: string;
  kind: RendererKind;
  source: 'builtin' | 'user' | 'workspace';
  /** 预览图 url（图片形象直接复用） */
  previewUri?: string;
  /** 是否是当前正在使用的形象 */
  active?: boolean;
}

export interface SoundItem {
  id: string;
  name: string;
  uri: string;
  source: 'builtin' | 'user';
}

/** 宿主 -> webview */
export type HostMessage =
  | {
      type: 'init';
      config: PetConfig;
      snapshot: PetSnapshot;
      history: ChatMessage[];
      assets: AssetItem[];
      sounds: SoundItem[];
      busy: boolean;
      busyLabel?: string;
    }
  | { type: 'config'; config: PetConfig }
  | { type: 'snapshot'; snapshot: PetSnapshot }
  | { type: 'chatUser'; message: ChatMessage }
  | { type: 'chatStart'; id: string }
  | { type: 'chatDelta'; id: string; text: string }
  | { type: 'chatEnd'; id: string; text: string; message: ChatMessage; speak?: boolean }
  | { type: 'chatError'; id: string; message: string }
  | {
      type: 'say';
      text: string;
      action?: PetAction;
      ttl?: number;
      speak?: boolean;
      actions?: Array<{ label: string; command?: string; send?: string }>;
    }
  | { type: 'react'; action: PetAction; sound?: SoundSlot }
  | { type: 'busy'; busy: boolean; label?: string }
  | { type: 'assets'; assets: AssetItem[]; sounds: SoundItem[] }
  | { type: 'notice'; text: string; kind?: 'info' | 'warn' | 'error' }
  | {
      /* 主动提醒：quiet=true 时只写入对话，不弹气泡 */
      type: 'nudge';
      text: string;
      quiet: boolean;
      action?: PetAction;
      actions?: Array<{ label: string; command?: string; send?: string }>;
    }
  | { type: 'advice'; advice: AdviceCard }
  | { type: 'adviceDone'; id: string; action: AdviceAction; ok: boolean }
  | { type: 'problems'; file?: string; items: ProblemItem[] }
  | { type: 'openChat'; draft?: string };

/** webview -> 宿主 */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; id: string; text: string; mode: 'chat' | 'docs' }
  | { type: 'abort'; id: string }
  | { type: 'command'; command: string; args?: unknown }
  | { type: 'click' }
  | { type: 'switchPet'; id: string }
  | { type: 'switchSound'; slot: SoundSlot; id: string }
  | { type: 'adviceAction'; id: string; action: AdviceAction }
  | { type: 'clearHistory' }
  | { type: 'reloadAssets' };

export const CMD = {
  openPanel: 'deskpet.openPanel',
  focus: 'deskpet.focus',
  chat: 'deskpet.chat',
  explain: 'deskpet.explainSelection',
  teach: 'deskpet.teachSelection',
  explainDiagnostic: 'deskpet.explainDiagnostic',
  fixDiagnostic: 'deskpet.fixDiagnostic',
  analyzeFailure: 'deskpet.analyzeFailure',
  analyzeClipboard: 'deskpet.analyzeClipboard',
  reviewFile: 'deskpet.reviewFile',
  fix: 'deskpet.fixSelection',
  refactor: 'deskpet.refactorSelection',
  tests: 'deskpet.addTests',
  commitMessage: 'deskpet.commitMessage',
  searchDocs: 'deskpet.searchDocs',
  importModel: 'deskpet.importModel',
  importSound: 'deskpet.importSound',
  setApiKey: 'deskpet.setApiKey',
  resetPet: 'deskpet.resetPet',
  openSettings: 'deskpet.openSettings',
  reindex: 'deskpet.reindex',
} as const;

export const VIEW_ID = 'deskpet.petView';
export const CONFIG_SECTION = 'deskpet';
export const DIFF_SCHEME = 'deskpet-diff';
