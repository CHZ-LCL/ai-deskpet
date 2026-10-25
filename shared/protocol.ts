/**
 * 扩展宿主 (extension host) 与 webview 之间的消息协议。
 * 这个文件会被两端同时引用，任何字段改动都要两边同步。
 */

export type PetAction = 'idle' | 'happy' | 'think' | 'alert' | 'sleep' | 'wave' | 'shy';

export type RendererKind = 'builtin' | 'image' | 'live2d' | 'vrm';

export type SoundSlot = 'click' | 'happy' | 'alert' | 'error' | 'switch';

export type PetTone = 'warm' | 'sharp' | 'concise' | 'chuuni';
export type ReplyLength = 'short' | 'normal' | 'detailed';

export type ThemeId =
  | 'auto'
  | 'mint'
  | 'sakura'
  | 'cyber'
  | 'mono'
  | 'amber'
  | 'ocean'
  | 'custom';

export type BackgroundStyle = 'grid' | 'plain' | 'none';
export type MotionLevel = 'full' | 'lite' | 'off';
export type Density = 'compact' | 'cozy' | 'comfortable';

export interface ThemePreset {
  id: ThemeId;
  label: string;
  accent: string;
  warm: string;
  glow: number;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'auto', label: '跟随 VS Code', accent: '', warm: '#ffb27a', glow: 0.55 },
  { id: 'mint', label: '薄荷', accent: '#4ec9b0', warm: '#ffb27a', glow: 0.55 },
  { id: 'sakura', label: '樱', accent: '#ff9db3', warm: '#ffd08a', glow: 0.5 },
  { id: 'cyber', label: '霓虹', accent: '#7c5cff', warm: '#22d3ee', glow: 0.7 },
  { id: 'mono', label: '极简', accent: '#c8c8c8', warm: '#9aa0a6', glow: 0.25 },
  { id: 'amber', label: '琥珀', accent: '#f0a35e', warm: '#ffd166', glow: 0.5 },
  { id: 'ocean', label: '深海', accent: '#3fa7ff', warm: '#6ee7d8', glow: 0.6 },
  { id: 'custom', label: '自定义', accent: '#4ec9b0', warm: '#ffb27a', glow: 0.55 },
];

export interface PetTheme {
  id: ThemeId;
  /** theme=custom 时使用的主色 */
  accent: string;
  background: BackgroundStyle;
  motion: MotionLevel;
  density: Density;
  nameplate: boolean;
  customCss: string;
}

export interface QuickAction {
  label: string;
  command?: string;
  text?: string;
}

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  { label: '讲解代码', command: 'deskpet.explainSelection' },
  { label: '讲透它', command: 'deskpet.teachSelection' },
  { label: '帮我修', command: 'deskpet.fixSelection' },
  { label: '写测试', command: 'deskpet.addTests' },
  { label: '补文档', command: 'deskpet.generateDocs' },
  { label: '查文档', text: '__docs__' },
];

export interface PetPersona {
  userName: string;
  tone: PetTone;
  replyLength: ReplyLength;
}


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

export interface StandardsPack {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
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
  theme: PetTheme;
  quickActions: QuickAction[];
  persona: PetPersona;
  greeting?: string;
  /** 主题写入范围（用于面板提示） */
  themeScope?: { hasWorkspace: boolean; workspaceOverride: boolean };
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
  | {
      type: 'standards';
      packs: StandardsPack[];
      conventions: string[];
      customCount: number;
      whitelistCount: number;
    }
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
  reviewRules: 'deskpet.reviewRules',
  modernize: 'deskpet.modernize',
  exportTheme: 'deskpet.exportTheme',
  importTheme: 'deskpet.importTheme',
  clearWorkspaceTheme: 'deskpet.clearWorkspaceTheme',
  fixAll: 'deskpet.fixAll',
  undoLastFix: 'deskpet.undoLastFix',
  fixHistory: 'deskpet.fixHistory',
  generateDocs: 'deskpet.generateDocs',
  checkDocs: 'deskpet.checkDocs',
  inlineChat: 'deskpet.inlineChat',
  inlineApply: 'deskpet.inlineApply',
  inlineDiff: 'deskpet.inlineDiff',
  quickSetup: 'deskpet.quickSetup',
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
