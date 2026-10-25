import type {
  AdviceAction,
  AssetItem,
  BackgroundStyle,
  Density,
  HostMessage,
  InterruptionLevel,
  MotionLevel,
  PetAction,
  PetConfig,
  PetSnapshot,
  PetTone,
  ProblemItem,
  QuickAction,
  ReplyLength,
  SoundItem,
  SoundSlot,
  StandardsPack,
  ThemeId,
  WebviewMessage,
} from '../shared/protocol';
import { CMD, THEME_PRESETS, defaultQuickActions } from '../shared/protocol';
import { AudioKit } from './audio';
import { L, getLanguage, setLanguage } from './i18n';
import { PetEngine } from './pet/engine';
import { ChatView } from './ui/chat';
import { debounce } from './util';
import './style.css';

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
};

const vscode = acquireVsCodeApi<{ greeted?: boolean; scope?: 'global' | 'workspace' }>();

const MOOD_LABEL: Record<PetAction, string> = {
  idle: '发呆中',
  happy: '心情不错',
  think: '思考中',
  alert: '警觉',
  sleep: '打盹中',
  shy: '害羞',
  wave: '打招呼',
};

const moodLabel = (mood: PetAction): string => L(MOOD_LABEL[mood] ?? MOOD_LABEL.idle);

/** 同一个中文在不同语境下英文不同（如「标准」「关闭」），这类词用显式取值。 */
const pick = (zh: string, en: string): string => (getLanguage() === 'en' ? en : zh);

const SOUND_SLOTS: Array<{ slot: SoundSlot; label: string }> = [
  { slot: 'click', label: '点击桌宠' },
  { slot: 'happy', label: '开心 / 保存成功' },
  { slot: 'alert', label: '提醒 / 报错' },
  { slot: 'error', label: '出错' },
  { slot: 'switch', label: '切换形象' },
];

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`缺少节点 #${id}`);
  }
  return node as T;
};

const dom = {
  petName: el('pet-name'),
  levelChip: el('level-chip'),
  stage: el('stage'),
  petMount: el('pet-mount'),
  petAnchor: el('pet-anchor'),
  unreadDot: el('unread-dot'),
  speech: el('speech'),
  speechText: el('speech-text'),
  speechActions: el('speech-actions'),
  namePlate: el('name-plate'),
  busyVeil: el('busy-veil'),
  busyLabel: el('busy-label'),
  chatLog: el('chat-log'),
  composer: el<HTMLFormElement>('composer'),
  input: el<HTMLTextAreaElement>('input'),
  sendBtn: el<HTMLButtonElement>('send-btn'),
  quick: el('quick-actions'),
  modelChip: el('model-chip'),
  indexChip: el('index-chip'),
  problemChip: el<HTMLButtonElement>('problem-chip'),
  drawer: el('drawer'),
  drawerTitle: el('drawer-title'),
  drawerBody: el('drawer-body'),
  drawerFoot: el('drawer-foot'),
  toast: el('toast'),
  btnAi: el('btn-ai'),
  btnGallery: el<HTMLButtonElement>('btn-gallery'),
  btnSound: el<HTMLButtonElement>('btn-sound'),
  btnStandards: el<HTMLButtonElement>('btn-standards'),
  btnPalette: el<HTMLButtonElement>('btn-palette'),
  btnSettings: el<HTMLButtonElement>('btn-settings'),
  btnOpenPanel: el<HTMLButtonElement>('btn-open-panel'),
  drawerClose: el<HTMLButtonElement>('drawer-close'),
};

const audio = new AudioKit();
const chat = new ChatView(dom.chatLog, () =>
  L('选中一段代码让我讲解，或者直接问我点什么。\nCtrl+Alt+E 讲解 · Ctrl+Alt+P 聊天'),
);
const engine = new PetEngine(dom.petMount, (text, kind) => toast(text, kind));

const state: {
  config?: PetConfig;
  snapshot?: PetSnapshot;
  assets: AssetItem[];
  sounds: SoundItem[];
  busy: boolean;
  busyLabel?: string;
  docsMode: boolean;
  requestId?: string;
  rendererKey: string;
  initialized: boolean;
  unread: number;
  problems: ProblemItem[];
  problemsFile?: string;
  scope: 'global' | 'workspace';
  standards?: {
    packs: StandardsPack[];
    conventions: string[];
    customCount: number;
    whitelistCount: number;
  };
} = {
  assets: [],
  sounds: [],
  busy: false,
  docsMode: false,
  rendererKey: '',
  initialized: false,
  unread: 0,
  problems: [],
  scope: vscode.getState()?.scope === 'workspace' ? 'workspace' : 'global',
};

// ------------------------------------------------------------------ 通信

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      onInit(message);
      break;
    case 'config':
      applyConfig(message.config);
      break;
    case 'snapshot':
      applySnapshot(message.snapshot);
      break;
    case 'chatUser':
      chat.addUser(message.message);
      break;
    case 'chatStart':
      state.requestId = message.id;
      chat.begin(message.id);
      setBusy(true, state.busyLabel ?? L('思考中…'));
      break;
    case 'chatDelta':
      chat.delta(message.id, message.text);
      break;
    case 'chatEnd':
      chat.finish(message.id, message.message.content);
      setBusy(false);
      state.requestId = undefined;
      if (message.speak) {
        audio.speak(message.text, state.config?.ttsRate ?? 1);
      }
      break;
    case 'chatError':
      chat.fail(message.id, message.message);
      setBusy(false);
      state.requestId = undefined;
      audio.play('error');
      break;
    case 'say':
      showSay(message.text, message.ttl ?? 9000, message.actions);
      // 只有动作、没有音效：说话时突然响一声会很吵
      if (message.action) {
        engine.play(message.action);
      }
      if (message.speak) {
        audio.speak(message.text, state.config?.ttsRate ?? 1);
      }
      break;
    case 'react':
      playAction(message.action);
      break;
    case 'busy':
      setBusy(message.busy, message.label);
      break;
    case 'assets':
      state.assets = message.assets;
      state.sounds = message.sounds;
      if (currentDrawer) {
        renderDrawer(currentDrawer);
      }
      break;
    case 'notice':
      chat.notice(message.text);
      toast(message.text, message.kind);
      break;
    case 'nudge':
      if (message.quiet) {
        chat.addNudge(message.text, message.actions);
        bumpUnread();
      } else {
        showSay(message.text, 9000, message.actions);
        engine.play(message.action ?? 'alert');
      }
      break;
    case 'advice':
      chat.addAdvice(message.advice);
      clearUnread();
      break;
    case 'adviceDone':
      chat.resolveAdvice(message.id, message.action, message.ok);
      break;
    case 'problems':
      state.problems = message.items;
      state.problemsFile = message.file;
      updateProblemChip();
      if (currentDrawer === 'problems') {
        renderProblems();
      }
      break;
    case 'standards':
      state.standards = {
        packs: message.packs,
        conventions: message.conventions,
        customCount: message.customCount,
        whitelistCount: message.whitelistCount,
      };
      if (currentDrawer === 'standards') {
        renderStandards();
      }
      break;
    case 'openChat':
      clearUnread();
      dom.input.focus();
      if (message.draft) {
        dom.input.value = message.draft;
        autoGrow();
      }
      break;
    default:
      break;
  }
});

function onInit(message: Extract<HostMessage, { type: 'init' }>): void {
  state.assets = message.assets;
  state.sounds = message.sounds;
  applyConfig(message.config);
  applySnapshot(message.snapshot);
  // attach 与 ready 可能各触发一次 init，第二次不能再清空正在流式输出的对话
  if (!state.initialized) {
    state.initialized = true;
    chat.clear();
    if (message.history.length) {
      chat.addHistory(message.history);
    }
    if (!vscode.getState()?.greeted) {
      vscode.setState({ ...(vscode.getState() ?? {}), greeted: true });
      window.setTimeout(() => {
        showSay(message.config.greeting || L('我在这儿，需要我陪你看段代码吗？'), 7000, [
          { label: L('讲解选中代码'), command: CMD.explain },
          { label: L('查资料'), send: '__docs__' },
        ]);
      }, 600);
    }
  }
  setBusy(message.busy, message.busyLabel);
}

// ------------------------------------------------------------------ 配置

function applyConfig(config: PetConfig): void {
  const languageChanged = config.language !== state.config?.language;
  setLanguage(config.language);
  state.config = config;
  dom.petName.textContent = config.name;
  dom.modelChip.textContent = config.aiProviderLabel;
  dom.modelChip.title = L('模型：{0}', config.aiModel);
  dom.indexChip.textContent = config.contextLabel ?? '';
  dom.indexChip.hidden = !config.contextLabel;
  dom.indexChip.title = config.contextLabel
    ? L('已索引项目：{0}', config.contextLabel)
    : L('项目索引未建立');
  audio.configure(config.volume, config.assets);
  applyAppearance(config);

  if (languageChanged) {
    applyStaticLanguage();
  } else if (state.snapshot) {
    applySnapshot(state.snapshot);
  }

  const rendererKey = [
    config.renderer,
    config.assets.builtinImageUri ?? '',
    config.assets.imageUri ?? '',
    config.assets.live2dModelUri ?? '',
    config.assets.vrmModelUri ?? '',
    config.assets.cubismCoreUri ?? '',
  ].join('|');

  if (rendererKey !== state.rendererKey) {
    state.rendererKey = rendererKey;
    void engine.apply(config);
  } else {
    engine.setScale(config.scale);
  }
}

let customStyle: HTMLStyleElement | undefined;

/** 语言变化时统一刷新静态文案（动态内容各自渲染时已经取过词条）。 */
function applyStaticLanguage(): void {
  document.title = L('AI 桌宠');
  dom.btnGallery.title = L('形象库');
  dom.btnSound.title = L('音效库');
  dom.btnStandards.title = L('代码规范');
  dom.btnPalette.title = L('个性化');
  dom.btnSettings.title = L('设置');
  dom.btnOpenPanel.title = L('在编辑器标签中打开');
  dom.drawerClose.title = L('关闭');
  dom.levelChip.title = L('好感等级');
  dom.unreadDot.title = L('有新的提醒');
  dom.btnAi.textContent = L('AI 设置');
  dom.input.placeholder = state.docsMode
    ? L('查资料：关键词或文档地址，Enter 发送…')
    : L('和桌宠聊聊…（Enter 发送 / Shift+Enter 换行）');
  dom.sendBtn.title = state.busy ? L('停止生成') : L('发送');

  quickSignature = '';
  updateProblemChip();
  chat.refreshEmpty();
  if (state.snapshot) {
    applySnapshot(state.snapshot);
  }
  if (currentDrawer) {
    renderDrawer(currentDrawer);
  }
}

/** 主题、背景、动效、排版、快捷按钮与自定义 CSS 都从这里落到 DOM 上。 */
function applyAppearance(config: PetConfig): void {
  const theme = config.theme;
  const preset = THEME_PRESETS.find((item) => item.id === theme.id) ?? THEME_PRESETS[1];
  const root = document.documentElement;

  const accent =
    theme.id === 'auto'
      ? 'var(--vscode-focusBorder, #4ec9b0)'
      : theme.id === 'custom'
        ? theme.accent
        : preset.accent;

  root.style.setProperty('--accent', accent);
  root.style.setProperty(
    '--accent-deep',
    theme.id === 'auto' ? 'color-mix(in srgb, var(--accent) 76%, #062620)' : darken(accent, 0.24),
  );
  root.style.setProperty('--warm', preset.warm);
  root.style.setProperty('--glow', String(preset.glow));

  document.body.dataset.bg = theme.background;
  document.body.dataset.motion = theme.motion;
  document.body.dataset.density = theme.density;
  document.body.classList.toggle('hide-nameplate', !theme.nameplate);

  applyCustomCss(theme.customCss);
  renderQuickActions(config.quickActions);
}

function darken(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    return '#2aa88f';
  }
  const value = Number.parseInt(match[1], 16);
  const base = { r: 6, g: 38, b: 32 };
  const mix = (channel: number, target: number) => Math.round(channel * (1 - amount) + target * amount);
  const r = mix((value >> 16) & 0xff, base.r);
  const g = mix((value >> 8) & 0xff, base.g);
  const b = mix(value & 0xff, base.b);
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

function applyCustomCss(css: string): void {
  if (!css.trim()) {
    customStyle?.remove();
    customStyle = undefined;
    return;
  }
  if (!customStyle) {
    customStyle = document.createElement('style');
    customStyle.id = 'deskpet-custom-css';
    document.head.appendChild(customStyle);
  }
  customStyle.textContent = css;
}

let quickSignature = '';

function renderQuickActions(actions: QuickAction[]): void {
  // 音量/缩放等设置也会触发 config 推送，没必要每次重建按钮
  const signature = JSON.stringify(actions);
  if (signature === quickSignature) {
    return;
  }
  quickSignature = signature;
  dom.quick.innerHTML = '';

  actions.forEach((action, index) => {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.dataset.actionIndex = String(index);
    if (state.docsMode && action.text === '__docs__') {
      button.classList.add('active');
    }
    dom.quick.appendChild(button);
  });

  const clear = document.createElement('button');
  clear.className = 'ghost';
  clear.dataset.quick = 'clear';
  clear.textContent = L('清空');
  dom.quick.appendChild(clear);
}

function segmented(
  name: string,
  options: Array<[string, string]>,
  current: string,
): string {  return `<div class="segmented" data-setting="${name}">${options
    .map(
      ([value, label]) =>
        `<button data-value="${value}" class="${value === current ? 'active' : ''}">${label}</button>`,
    )
    .join('')}</div>`;
}

function applySnapshot(snapshot: PetSnapshot): void {  state.snapshot = snapshot;
  dom.levelChip.textContent = `Lv.${snapshot.level}`;
  dom.levelChip.title = L(
    '好感度 {0} · 陪伴 {1} 天 · 互动 {2} 次',
    snapshot.affection,
    snapshot.daysTogether,
    snapshot.totalChats + snapshot.totalClicks,
  );
  const name = state.config?.name ?? L('桌宠');
  dom.namePlate.textContent = `${name} · ${moodLabel(snapshot.mood)}`;
}

let lastActionSound = 0;

function playAction(action: PetAction): void {
  engine.play(action);
  // 连续保存/报错时不要把音效叠成噪音
  const now = Date.now();
  if (now - lastActionSound < 1200) {
    return;
  }
  if (action === 'happy' || action === 'wave') {
    lastActionSound = now;
    audio.play('happy');
  } else if (action === 'alert') {
    lastActionSound = now;
    audio.play('alert');
  } else if (action === 'shy') {
    lastActionSound = now;
    audio.play('switch');
  }
}

function setBusy(busy: boolean, label?: string): void {
  state.busy = busy;
  if (label) {
    state.busyLabel = label;
  }
  dom.busyVeil.hidden = !busy;
  if (busy && label) {
    dom.busyLabel.textContent = label;
  }
  dom.sendBtn.textContent = busy ? '■' : '↑';
  dom.sendBtn.title = busy ? L('停止生成') : L('发送');
  dom.sendBtn.classList.toggle('is-stop', busy);
  if (!busy) {
    state.busyLabel = undefined;
  }
}

// ------------------------------------------------------------------ 气泡

let speechTimer: number | undefined;

function showSay(
  text: string,
  ttl = 9000,
  actions?: Array<{ label: string; command?: string; send?: string }>,
): void {
  dom.speechText.textContent = text;
  dom.speechActions.innerHTML = '';
  for (const action of actions ?? []) {
    const button = document.createElement('button');
    button.className = 'speech-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      hideSay();
      if (action.command) {
        post({ type: 'command', command: action.command });
      } else if (action.send === '__docs__') {
        setDocsMode(true);
        dom.input.focus();
      } else if (action.send) {
        dom.input.value = action.send;
        submit();
      }
    });
    dom.speechActions.appendChild(button);
  }
  dom.speech.hidden = false;
  syncSpeechSpace();

  if (speechTimer) {
    window.clearTimeout(speechTimer);
  }
  if (ttl > 0) {
    speechTimer = window.setTimeout(() => hideSay(), ttl);
  }
}

/** 气泡多高，就给舞台顶部留多少空间，避免挡住形象或留一片空白。 */
function syncSpeechSpace(): void {
  const space = dom.speech.hidden ? 12 : dom.speech.offsetHeight + 16;
  dom.petAnchor.style.setProperty('--speech-space', `${space}px`);
}

function hideSay(): void {
  dom.speech.hidden = true;
  syncSpeechSpace();
  if (speechTimer) {
    window.clearTimeout(speechTimer);
    speechTimer = undefined;
  }
}

dom.speech.addEventListener('mouseenter', () => {
  if (speechTimer) {
    window.clearTimeout(speechTimer);
    speechTimer = undefined;
  }
});
dom.speech.addEventListener('mouseleave', () => {
  if (!dom.speech.hidden) {
    speechTimer = window.setTimeout(() => hideSay(), 4000);
  }
});

// ------------------------------------------------------------------ 输入

function setDocsMode(enabled: boolean): void {
  state.docsMode = enabled;
  dom.composer.classList.toggle('docs-mode', enabled);
  dom.input.placeholder = enabled
    ? L('查资料：关键词或文档地址，Enter 发送…')
    : L('和桌宠聊聊…（Enter 发送 / Shift+Enter 换行）');

  dom.quick.querySelectorAll<HTMLElement>('[data-action-index]').forEach((button) => {
    const action = state.config?.quickActions[Number(button.dataset.actionIndex)];
    button.classList.toggle('active', Boolean(enabled) && action?.text === '__docs__');
  });
}

function autoGrow(): void {
  dom.input.style.height = 'auto';
  dom.input.style.height = `${Math.min(110, dom.input.scrollHeight)}px`;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  }
}

function submit(): void {
  const text = dom.input.value.trim();
  if (state.busy) {
    if (state.requestId) {
      post({ type: 'abort', id: state.requestId });
      toast(L('已停止生成'), 'info');
    }
    return;
  }
  if (!text) {
    return;
  }
  const id = newId();
  state.requestId = id;
  clearUnread();
  post({ type: 'send', id, text, mode: state.docsMode ? 'docs' : 'chat' });
  dom.input.value = '';
  autoGrow();
  if (state.docsMode) {
    setDocsMode(false);
  }
}

dom.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});

dom.input.addEventListener('input', autoGrow);
dom.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

dom.quick.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!target) {
    return;
  }

  if (target.dataset.quick === 'clear') {
    post({ type: 'clearHistory' });
    chat.clear();
    return;
  }

  const index = Number(target.dataset.actionIndex);
  const action = state.config?.quickActions[index];
  if (!action) {
    return;
  }

  if (action.command) {
    post({ type: 'command', command: action.command });
  } else if (action.text === '__docs__') {
    setDocsMode(!state.docsMode);
    dom.input.focus();
  } else if (action.text) {
    dom.input.value = action.text;
    submit();
  }
});

// ------------------------------------------------------------------ 未读提醒

function bumpUnread(): void {
  state.unread = Math.min(99, state.unread + 1);
  dom.unreadDot.textContent = String(state.unread);
  dom.unreadDot.hidden = false;
}

function clearUnread(): void {
  if (!state.unread) {
    return;
  }
  state.unread = 0;
  dom.unreadDot.hidden = true;
}

// ------------------------------------------------------------------ 点击桌宠

dom.petMount.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('.speech')) {
    return;
  }
  audio.play('click');
  engine.play('happy');
  post({ type: 'click' });
  clearUnread();
  chat.scrollToBottom(true);
});

// ------------------------------------------------------------------ 工具栏 / 抽屉

let currentDrawer: 'gallery' | 'sound' | 'settings' | 'problems' | 'standards' | 'palette' | undefined;

function openDrawer(kind: 'gallery' | 'sound' | 'settings' | 'problems' | 'standards' | 'palette'): void {
  currentDrawer = kind;
  dom.drawer.hidden = false;
  renderDrawer(kind);
}

function closeDrawer(): void {
  currentDrawer = undefined;
  dom.drawer.hidden = true;
}

function renderDrawer(kind: 'gallery' | 'sound' | 'settings' | 'problems' | 'standards' | 'palette'): void {
  if (kind === 'gallery') {
    renderGallery();
  } else if (kind === 'sound') {
    renderSounds();
  } else if (kind === 'problems') {
    renderProblems();
  } else if (kind === 'standards') {
    renderStandards();
  } else if (kind === 'palette') {
    renderPalette();
  } else {
    renderSettings();
  }
}

function renderGallery(): void {
  dom.drawerTitle.textContent = L('形象库');
  const cards = state.assets
    .map((asset) => {
      const thumb = asset.previewUri
        ? `<img src="${asset.previewUri}" alt="${escapeAttr(asset.name)}" />`
        : `<span class="asset-glyph">${glyphFor(asset.kind)}</span>`;
      return `<button class="asset-card${asset.active ? ' active' : ''}" data-id="${escapeAttr(asset.id)}">
        <span class="asset-thumb">${thumb}</span>
        <span class="asset-name">${escapeText(asset.name)}</span>
        <span class="asset-kind">${kindLabel(asset.kind)}</span>
      </button>`;
    })
    .join('');

  dom.drawerBody.innerHTML = `<div class="asset-grid">${cards}<button class="asset-card import" data-import="1">
      <span class="asset-thumb"><span class="asset-glyph">＋</span></span>
      <span class="asset-name">${L('导入形象')}</span>
      <span class="asset-kind">${L('Live2D / 3D / 图片')}</span>
    </button></div>`;
  dom.drawerFoot.innerHTML = `<span class="hint">${L('支持 .model3.json、.vrm / .glb、png / gif / webp')}</span>`;

  dom.drawerBody.querySelectorAll<HTMLElement>('.asset-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.dataset.import) {
        post({ type: 'command', command: CMD.importModel });
        return;
      }
      const id = card.dataset.id;
      if (id) {
        post({ type: 'switchPet', id });
        audio.play('switch');
        closeDrawer();
      }
    });
  });
}

function renderSounds(): void {
  dom.drawerTitle.textContent = L('音效库');
  const rows = SOUND_SLOTS.map(({ slot, label }) => {
    const bound = state.config?.assets.sounds[slot];
    const options = [
      `<option value="__synth__"${bound ? '' : ' selected'}>${L('内置合成音')}</option>`,
      ...state.sounds.map(
        (sound) => `<option value="${escapeAttr(sound.id)}"${bound === sound.uri ? ' selected' : ''}>${escapeText(sound.name)}</option>`,
      ),
    ].join('');
    return `<div class="sound-row" data-slot="${slot}">
      <div class="sound-label">${L(label)}</div>
      <div class="sound-controls">
        <select data-role="select">${options}</select>
        <button class="ghost-btn" data-role="preview" title="${L('试听')}">♪</button>
      </div>
    </div>`;
  }).join('');

  dom.drawerBody.innerHTML = `<div class="sound-list">${rows}</div>`;
  dom.drawerFoot.innerHTML = `<button class="primary-btn" id="sound-import">${L('导入音效文件…')}</button>`;

  dom.drawerBody.querySelectorAll<HTMLElement>('.sound-row').forEach((row) => {
    const slot = row.dataset.slot as SoundSlot;
    const select = row.querySelector<HTMLSelectElement>('[data-role="select"]');
    select?.addEventListener('change', () => {
      const value = select.value;
      post({ type: 'switchSound', slot, id: value === '__synth__' ? '__none__' : value });
      if (value === '__synth__') {
        audio.play(slot);
      } else {
        const sound = state.sounds.find((item) => item.id === value);
        if (sound) {
          void new Audio(sound.uri).play().catch(() => audio.play(slot));
        }
      }
    });
    row.querySelector<HTMLElement>('[data-role="preview"]')?.addEventListener('click', () => {
      const value = select?.value;
      if (value && value !== '__synth__') {
        const sound = state.sounds.find((item) => item.id === value);
        if (sound) {
          void new Audio(sound.uri).play().catch(() => undefined);
          return;
        }
      }
      audio.play(slot);
    });
  });

  document.getElementById('sound-import')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.importSound });
  });
}

function updateProblemChip(): void {
  const errors = state.problems.filter((item) => item.severity === 'error').length;
  const total = state.problems.length;
  dom.problemChip.hidden = total === 0;
  dom.problemChip.textContent = `⚠ ${total}`;
  dom.problemChip.classList.toggle('has-error', errors > 0);
  dom.problemChip.title = state.problemsFile
    ? L('{0}：{1} 个错误，{2} 条其它提示', state.problemsFile, errors, total - errors)
    : L('当前文件的问题');
}

function renderProblems(): void {
  dom.drawerTitle.textContent = state.problems.length
    ? L('问题清单 · {0}', state.problems.length)
    : L('问题清单');

  if (!state.problems.length) {
    dom.drawerBody.innerHTML = `<div class="empty-state">${L('当前文件没有诊断问题。<br/>可以点下面的「体检整个文件」做一次静态检查。')}</div>`;
  } else {
    const errorCount = state.problems.filter((item) => item.severity === 'error').length;
    dom.drawerBody.innerHTML = `
      ${errorCount > 0 ? `<button class="primary-btn fix-all-btn" id="fix-all">${L('一键修复全部错误（{0}）', errorCount)}</button>` : ''}
      <div class="problem-list">${state.problems
        .map(
          (item) => `<div class="problem-row sev-${item.severity}">
            <div class="problem-head">
              <span class="sev-dot"></span>
              <span class="problem-line">L${item.line}</span>
              <span class="problem-msg">${escapeText(item.message)}</span>
            </div>
            <div class="problem-actions">
              <button data-problem-action="explain" data-line="${item.line}">${L('解释')}</button>
              <button data-problem-action="fix" data-line="${item.line}">${L('修复')}</button>
            </div>
          </div>`,
        )
        .join('')}</div>`;
  }

  dom.drawerFoot.innerHTML = `<div class="drawer-actions">
    <button class="primary-btn" id="review-file">${L('体检整个文件')}</button>
    <button class="ghost-btn" id="analyze-clipboard">${L('分析剪贴板里的报错')}</button>
  </div>`;

  dom.drawerFoot.querySelector('#review-file')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.reviewFile });
    closeDrawer();
  });
  dom.drawerFoot.querySelector('#analyze-clipboard')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.analyzeClipboard });
    closeDrawer();
  });

  dom.drawerBody.querySelectorAll<HTMLElement>('[data-problem-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const line = Number(button.dataset.line);
      const command =
        button.dataset.problemAction === 'explain' ? CMD.explainDiagnostic : CMD.fixDiagnostic;
      post({ type: 'command', command, args: { line } });
      closeDrawer();
    });
  });

  dom.drawerBody.querySelector('#fix-all')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.fixAll });
    closeDrawer();
  });
}

function renderStandards(): void {
  const standards = state.standards;
  const english = getLanguage() === 'en';
  dom.drawerTitle.textContent = L('代码规范');

  const conventions = (standards?.conventions ?? []).length
    ? (standards?.conventions ?? [])
        .map((line) => `<li>${escapeText(line.replace(/^-\s*/, ''))}</li>`)
        .join('')
    : `<li>${L('索引完成后会显示检测到的项目约定')}</li>`;

  const packs = (standards?.packs ?? [])
    .map(
      (pack) => `<label class="pack-row">
        <input type="checkbox" data-pack="${escapeAttr(pack.id)}" ${pack.enabled ? 'checked' : ''}/>
        <span class="pack-text"><b>${escapeText(english ? pack.labelEn ?? pack.label : pack.label)}</b><em>${escapeText(english ? pack.descriptionEn ?? pack.description : pack.description)}</em></span>
      </label>`,
    )
    .join('');

  dom.drawerBody.innerHTML = `
    <div class="standards-section">
      <div class="section-title">${L('检测到的约定')}</div>
      <ul class="convention-list">${conventions}</ul>
    </div>
    <div class="standards-section">
      <div class="section-title">${L('规则包')}</div>
      <div class="pack-list">${packs || `<div class="hint">${L('正在读取配置…')}</div>`}</div>
    </div>
    <div class="standards-meta">
      <span>${L('自定义规则 {0} 条', standards?.customCount ?? 0)}</span>
      <span>${L('白名单 {0} 条', standards?.whitelistCount ?? 0)}</span>
    </div>
    <div class="hint">${L('规则和风格会写进每次生成的提示词；白名单里的规则不会被扫描，也不会被“修复”。')}</div>`;

  dom.drawerFoot.innerHTML = `<div class="drawer-actions">
    <button class="primary-btn" id="review-rules">${L('按规范检查当前文件')}</button>
    <button class="ghost-btn" id="modernize-selection">${L('现代化重构选中代码')}</button>
    <button class="ghost-btn" id="edit-standards">${L('编辑规则与白名单')}</button>
  </div>`;

  dom.drawerBody.querySelectorAll<HTMLInputElement>('[data-pack]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!state.standards) {
        return;
      }
      const enabled = new Set(
        state.standards.packs.filter((pack) => pack.enabled).map((pack) => pack.id),
      );
      const id = input.dataset.pack;
      if (!id) {
        return;
      }
      if (input.checked) {
        enabled.add(id);
      } else {
        enabled.delete(id);
      }
      state.standards.packs = state.standards.packs.map((pack) => ({
        ...pack,
        enabled: enabled.has(pack.id),
      }));
      post({
        type: 'command',
        command: 'deskpet.updateSetting',
        args: { key: 'standards.packs', value: [...enabled] },
      });
      toast(L('规则包已更新，{0} 个启用', enabled.size));
    });
  });

  dom.drawerFoot.querySelector('#review-rules')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.reviewRules });
    closeDrawer();
  });
  dom.drawerFoot.querySelector('#modernize-selection')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.modernize });
    closeDrawer();
  });
  dom.drawerFoot.querySelector('#edit-standards')?.addEventListener('click', () => {
    post({ type: 'command', command: 'workbench.action.openSettings', args: 'deskpet.standards' });
  });
}

const CSS_SNIPPETS: Array<[string, string]> = [
  ['紧凑气泡', '.msg { border-radius: 8px; padding: 6px 9px; }'],
  ['等宽代码', '.code-block code { font-family: var(--vscode-editor-font-family); }'],
  ['隐藏光晕', '.stage-glow { display: none; }'],
  ['大圆角', '.speech, .msg, .advice-card { border-radius: 18px; }'],
];

function settingScope(): 'global' | 'workspace' {
  return state.scope === 'workspace' && state.config?.themeScope?.hasWorkspace ? 'workspace' : 'global';
}

function renderPalette(): void {
  const config = state.config;
  if (!config) {
    dom.drawerTitle.textContent = L('个性化');
    dom.drawerBody.innerHTML = `<div class="hint">${L('正在加载配置…')}</div>`;
    return;
  }

  const theme = config.theme;
  const english = getLanguage() === 'en';
  dom.drawerTitle.textContent = L('个性化');

  const swatches = THEME_PRESETS.map(
    (preset) => `<button class="swatch ${theme.id === preset.id ? 'active' : ''}" data-theme="${preset.id}">
      <span class="swatch-dot" style="${preset.accent ? `background:${preset.accent}` : 'background:linear-gradient(135deg,#4ec9b0,#ffb27a)'}"></span>
      <span class="swatch-label">${escapeText(english ? preset.labelEn : preset.label)}</span>
    </button>`,
  ).join('');

  const actions = config.quickActions.length ? config.quickActions : defaultQuickActions(getLanguage());
  const rows = actions
    .map(
      (action, index) => `<div class="qa-row" data-index="${index}">
        <input class="qa-label" value="${escapeAttr(action.label)}" maxlength="20" placeholder="${L('按钮文字')}" />
        <input class="qa-command" value="${escapeAttr(action.command ?? (action.text === '__docs__' ? '__docs__' : ''))}" placeholder="${L('命令 id 或 __docs__')}" />
        <button class="qa-remove" title="${L('删除')}">×</button>
      </div>`,
    )
    .join('');

  dom.drawerBody.innerHTML = `
    <div class="standards-section">
      <div class="section-title">${L('写入范围')}</div>
      <div class="segmented" id="scope-switch">
        <button data-scope="global" class="${state.scope === 'global' ? 'active' : ''}">${L('全局')}</button>
        <button data-scope="workspace" class="${state.scope === 'workspace' ? 'active' : ''}" ${config.themeScope?.hasWorkspace ? '' : 'disabled'}>${L('当前工作区')}</button>
      </div>
      ${
        config.themeScope?.workspaceOverride
          ? `<div class="scope-note">${L('当前工作区已有独立主题')} <button id="clear-scope">${L('清除')}</button></div>`
          : ''
      }
    </div>

    <div class="standards-section">
      <div class="section-title">${L('主题')}</div>
      <div class="swatch-grid">${swatches}</div>
      <div class="accent-row">
        <span>${L('自定义主色')}</span>
        <input type="color" id="accent-color" value="${theme.accent}" />
        <code id="accent-hex">${theme.accent}</code>
      </div>
    </div>

    <div class="standards-section">
      <div class="section-title">${L('主题包')}</div>
      <div class="qa-actions">
        <button class="ghost-btn" id="theme-import">${L('导入…')}</button>
        <button class="ghost-btn" id="theme-export">${L('导出…')}</button>
      </div>
      <div class="hint">${L('导出为 JSON 分享给同事；导入会逐字段校验，坏值回退默认。')}</div>
    </div>

    <div class="standards-section">
      <div class="section-title">${L('背景')}</div>
      ${segmented('background', [['grid', L('网格')], ['plain', L('纯色')], ['none', L('极简')]], theme.background)}
    </div>
    <div class="standards-section">
      <div class="section-title">${L('动效')}</div>
      ${segmented('motion', [['full', L('完整')], ['lite', L('轻量')], ['off', pick('关闭', 'Off')]], theme.motion)}
    </div>
    <div class="standards-section">
      <div class="section-title">${L('排版')}</div>
      ${segmented('density', [['compact', L('紧凑')], ['cozy', pick('标准', 'Cozy')], ['comfortable', L('宽松')]], theme.density)}
    </div>

    <div class="setting">
      <div class="setting-head"><span>${L('显示名牌')}</span></div>
      <label class="switch"><input type="checkbox" id="nameplate-toggle" ${theme.nameplate ? 'checked' : ''}/><span></span></label>
    </div>

    <div class="standards-section">
      <div class="section-title">${L('快捷按钮')}</div>
      <div class="qa-list" id="qa-list">${rows}</div>
      <div class="qa-actions">
        <button class="ghost-btn" id="qa-add">${L('+ 添加')}</button>
        <button class="primary-btn" id="qa-save">${L('保存')}</button>
      </div>
      <div class="hint">${L('命令 id 填 __docs__ 表示切换到查资料模式；留空的按钮不会保存。')}</div>
    </div>

    <div class="standards-section">
      <div class="section-title">${L('自定义 CSS')}</div>
      <textarea id="custom-css" rows="5" placeholder=".msg { border-radius: 4px; }">${escapeText(theme.customCss)}</textarea>
      <div class="css-chips">
        ${CSS_SNIPPETS.map(
          ([label]) => `<button class="chip" data-css-snippet="${escapeAttr(label)}">${escapeText(L(label))}</button>`,
        ).join('')}
      </div>
      <div class="qa-actions">
        <button class="ghost-btn" id="css-revert">${L('撤销预览')}</button>
        <button class="primary-btn" id="css-apply">${L('保存 CSS')}</button>
      </div>
    </div>`;

  dom.drawerFoot.innerHTML = `<span class="hint">${L('改动即时预览，并写入你的 VS Code 设置')}</span>`;

  dom.drawerBody.querySelectorAll<HTMLElement>('[data-theme]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.theme as ThemeId | undefined;
      if (!id || !state.config) {
        return;
      }
      state.config.theme.id = id;
      applyAppearance(state.config);
      post({ type: 'command', command: 'deskpet.updateSetting', args: { scope: settingScope(), key: 'ui.theme', value: id } });
      renderPalette();
    });
  });

  const colorInput = dom.drawerBody.querySelector<HTMLInputElement>('#accent-color');
  const hexLabel = dom.drawerBody.querySelector<HTMLElement>('#accent-hex');
  const pushAccent = debounce((value: string) => {
    post({ type: 'command', command: 'deskpet.updateSetting', args: { scope: settingScope(), key: 'ui.accent', value } });
  }, 400);

  colorInput?.addEventListener('input', () => {
    const value = colorInput.value;
    if (!state.config) {
      return;
    }
    state.config.theme.accent = value;
    state.config.theme.id = 'custom';
    if (hexLabel) {
      hexLabel.textContent = value;
    }
    applyAppearance(state.config);
    pushAccent(value);
    post({ type: 'command', command: 'deskpet.updateSetting', args: { scope: settingScope(), key: 'ui.theme', value: 'custom' } });
    dom.drawerBody.querySelectorAll<HTMLElement>('[data-theme]').forEach((element) => {
      element.classList.toggle('active', element.dataset.theme === 'custom');
    });
  });

  dom.drawerBody.querySelectorAll<HTMLElement>('.segmented[data-setting]').forEach((group) => {
    const key = group.dataset.setting as 'background' | 'motion' | 'density';
    group.querySelectorAll<HTMLElement>('button').forEach((button) => {
      button.addEventListener('click', () => {
        const value = button.dataset.value;
        if (!state.config || !value) {
          return;
        }
        if (key === 'background') {
          state.config.theme.background = value as BackgroundStyle;
        } else if (key === 'motion') {
          state.config.theme.motion = value as MotionLevel;
        } else {
          state.config.theme.density = value as Density;
        }
        applyAppearance(state.config);
        group.querySelectorAll('button').forEach((element) => element.classList.toggle('active', element === button));
        post({ type: 'command', command: 'deskpet.updateSetting', args: { scope: settingScope(), key: `ui.${key}`, value } });
      });
    });
  });

  const nameplate = dom.drawerBody.querySelector<HTMLInputElement>('#nameplate-toggle');
  nameplate?.addEventListener('change', () => {
    if (!state.config) {
      return;
    }
    state.config.theme.nameplate = nameplate.checked;
    applyAppearance(state.config);
    post({ type: 'command', command: 'deskpet.updateSetting', args: { scope: settingScope(), key: 'ui.nameplate', value: nameplate.checked } });
  });

  const list = dom.drawerBody.querySelector<HTMLElement>('#qa-list');
  const wireRemove = (row: HTMLElement) => {
    row.querySelector('.qa-remove')?.addEventListener('click', () => row.remove());
  };
  list?.querySelectorAll<HTMLElement>('.qa-row').forEach(wireRemove);

  dom.drawerBody.querySelector('#qa-add')?.addEventListener('click', () => {
    if (!list) {
      return;
    }
    const row = document.createElement('div');
    row.className = 'qa-row';
    row.innerHTML = `<input class="qa-label" maxlength="20" placeholder="${L('按钮文字')}"/><input class="qa-command" placeholder="${L('命令 id 或 __docs__')}"/><button class="qa-remove" title="${L('删除')}">×</button>`;
    list.appendChild(row);
    wireRemove(row);
  });

  dom.drawerBody.querySelector('#qa-save')?.addEventListener('click', () => {
    if (!state.config || !list) {
      return;
    }
    const next: QuickAction[] = [];
    list.querySelectorAll<HTMLElement>('.qa-row').forEach((row) => {
      const label = row.querySelector<HTMLInputElement>('.qa-label')?.value.trim();
      const command = row.querySelector<HTMLInputElement>('.qa-command')?.value.trim();
      if (!label) {
        return;
      }
      if (command === '__docs__') {
        next.push({ label, text: '__docs__' });
      } else if (command) {
        next.push({ label, command });
      } else {
        next.push({ label, command: CMD.explain });
      }
    });

    const actions = next.length ? next.slice(0, 10) : defaultQuickActions(getLanguage());
    state.config.quickActions = actions;
    applyAppearance(state.config);
    post({ type: 'command', command: 'deskpet.updateSetting', args: { scope: settingScope(), key: 'ui.quickActions', value: actions } });
    toast(L('快捷按钮已保存'));
    renderPalette();
  });

  const savedCss = theme.customCss;
  const cssBox = dom.drawerBody.querySelector<HTMLTextAreaElement>('#custom-css');
  const previewCss = (value: string) => {
    applyCustomCss(value);
    if (state.config) {
      state.config.theme.customCss = value;
    }
  };

  cssBox?.addEventListener('input', () => previewCss(cssBox.value));

  dom.drawerBody.querySelectorAll<HTMLElement>('[data-css-snippet]').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!cssBox) {
        return;
      }
      const snippet = CSS_SNIPPETS.find(([label]) => label === chip.dataset.cssSnippet)?.[1] ?? '';
      cssBox.value = `${cssBox.value.trim()}\n${snippet}`.trim();
      previewCss(cssBox.value);
    });
  });

  dom.drawerBody.querySelector('#css-apply')?.addEventListener('click', () => {
    if (!state.config || !cssBox) {
      return;
    }
    const css = cssBox.value.slice(0, 12_000);
    state.config.theme.customCss = css;
    applyCustomCss(css);
    post({
      type: 'command',
      command: 'deskpet.updateSetting',
      args: { scope: settingScope(), key: 'ui.customCss', value: css },
    });
    toast(L('自定义 CSS 已保存'));
  });

  dom.drawerBody.querySelector('#css-revert')?.addEventListener('click', () => {
    if (!cssBox) {
      return;
    }
    cssBox.value = savedCss;
    previewCss(savedCss);
    toast(L('已撤销未保存的 CSS 预览'));
  });

  dom.drawerBody.querySelectorAll<HTMLButtonElement>('#scope-switch [data-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.scope as 'global' | 'workspace' | undefined;
      if (!value || button.disabled) {
        return;
      }
      state.scope = value;
      vscode.setState({ ...(vscode.getState() ?? {}), scope: value });
      renderPalette();
      toast(
        value === 'workspace'
          ? L('之后的外观改动只写入当前工作区')
          : L('之后的外观改动写入全局设置'),
      );
    });
  });

  dom.drawerBody.querySelector('#clear-scope')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.clearWorkspaceTheme });
  });
  dom.drawerBody.querySelector('#theme-import')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.importTheme });
  });
  dom.drawerBody.querySelector('#theme-export')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.exportTheme });
  });
}

function renderSettings(): void {
  dom.drawerTitle.textContent = L('设置');
  const config = state.config;
  const snapshot = state.snapshot;
  dom.drawerBody.innerHTML = `
    <div class="setting">
      <div class="setting-head"><span>${L('语音朗读回复')}</span></div>
      <label class="switch"><input type="checkbox" id="set-tts" ${config?.tts ? 'checked' : ''}/><span></span></label>
    </div>
    <div class="setting">
      <div class="setting-head"><span>${L('打扰程度')}</span><em id="interruption-value">${L('平衡')}</em></div>
      <div class="segmented" id="set-interruption">
        <button data-value="quiet">${L('安静')}</button>
        <button data-value="balanced">${L('平衡')}</button>
        <button data-value="chatty">${L('话多')}</button>
      </div>
    </div>
    <div class="setting">
      <div class="setting-head"><span>${L('怎么称呼你')}</span></div>
      <input class="text-input" id="user-name" maxlength="40" placeholder="${L('可留空')}" value="${escapeAttr(config?.persona.userName ?? '')}" />
    </div>
    <div class="setting">
      <div class="setting-head"><span>${L('语气')}</span><em id="tone-value">${L('温和')}</em></div>
      <div class="segmented" id="set-tone">
        <button data-value="warm">${L('温和')}</button>
        <button data-value="sharp">${L('犀利')}</button>
        <button data-value="concise">${L('简洁')}</button>
        <button data-value="chuuni">${L('中二')}</button>
      </div>
    </div>
    <div class="setting">
      <div class="setting-head"><span>${L('回复长度')}</span><em id="length-value">${pick('标准', 'Normal')}</em></div>
      <div class="segmented" id="set-length">
        <button data-value="short">${L('短')}</button>
        <button data-value="normal">${pick('标准', 'Normal')}</button>
        <button data-value="detailed">${L('详细')}</button>
      </div>
    </div>
    <div class="setting">
      <div class="setting-head"><span>${L('开场白')}</span></div>
      <input class="text-input" id="greeting" maxlength="200" placeholder="${L('留空使用默认')}" value="${escapeAttr(config?.greeting ?? '')}" />
    </div>
    <div class="setting">
      <div class="setting-head"><span>${L('音量')}</span><em id="volume-value">${Math.round((config?.volume ?? 0.6) * 100)}%</em></div>
      <input type="range" id="set-volume" min="0" max="100" value="${Math.round((config?.volume ?? 0.6) * 100)}" />
    </div>
    <div class="setting">
      <div class="setting-head"><span>${L('形象大小')}</span><em id="scale-value">${Math.round((config?.scale ?? 1) * 100)}%</em></div>
      <input type="range" id="set-scale" min="50" max="200" value="${Math.round((config?.scale ?? 1) * 100)}" />
    </div>
    <div class="setting-info">
      <div><span>AI</span><strong>${escapeText(config?.aiProviderLabel ?? L('未配置'))}</strong></div>
      <div><span>${L('模型')}</span><strong>${escapeText(config?.aiModel ?? '-')}</strong></div>
      <div><span>${L('好感')}</span><strong>Lv.${snapshot?.level ?? 1} · ${snapshot?.affection ?? 0}</strong></div>
      <div><span>${L('陪伴')}</span><strong>${snapshot?.daysTogether ?? 1} ${L('天')}</strong></div>
    </div>
    <div class="drawer-actions">
      <button class="primary-btn" id="btn-set-key">${L('设置密钥')}</button>
      <button class="ghost-btn" id="btn-goto-settings">${L('打开全部设置')}</button>
      <button class="ghost-btn danger" id="btn-reset-pet">${L('重置桌宠')}</button>
    </div>`;

  const tts = dom.drawerBody.querySelector<HTMLInputElement>('#set-tts');
  tts?.addEventListener('change', () => {
    post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.tts', value: Boolean(tts.checked) } });
    if (tts.checked) {
      audio.speak(L('好呀，以后我会念给你听。'), state.config?.ttsRate ?? 1);
    }
  });

  const interruptionLabels: Record<InterruptionLevel, string> = { quiet: '安静', balanced: '平衡', chatty: '话多' };
  const segmented = dom.drawerBody.querySelector('#set-interruption');
  const interruptionValue = dom.drawerBody.querySelector<HTMLElement>('#interruption-value');
  const markInterruption = () => {
    const current = state.config?.interruption ?? 'balanced';
    segmented?.querySelectorAll<HTMLElement>('button').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === current);
    });
    if (interruptionValue) {
      interruptionValue.textContent = L(interruptionLabels[current]);
    }
  };
  markInterruption();
  segmented?.querySelectorAll<HTMLElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.value as InterruptionLevel;
      if (state.config) {
        state.config.interruption = value;
      }
      post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.interruption', value } });
      markInterruption();
      toast(
        value === 'quiet'
          ? L('安静模式：提醒只写进对话，不弹气泡')
          : value === 'chatty'
            ? L('话多模式：提醒会直接弹气泡')
            : L('平衡模式：重要提醒才弹气泡，打字时不打扰'),
      );
    });
  });

  const toneLabels: Record<PetTone, string> = { warm: L('温和'), sharp: L('犀利'), concise: L('简洁'), chuuni: L('中二') };
  const lengthLabels: Record<ReplyLength, string> = { short: L('短'), normal: pick('标准', 'Normal'), detailed: L('详细') };

  const markSegmented = (selector: string, value: string) => {
    dom.drawerBody.querySelector(selector)?.querySelectorAll<HTMLElement>('button').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === value);
    });
  };

  const persona = state.config?.persona;
  if (persona) {
    markSegmented('#set-tone', persona.tone);
    markSegmented('#set-length', persona.replyLength);
    const toneValue = dom.drawerBody.querySelector<HTMLElement>('#tone-value');
    const lengthValue = dom.drawerBody.querySelector<HTMLElement>('#length-value');
    if (toneValue) {
      toneValue.textContent = toneLabels[persona.tone];
    }
    if (lengthValue) {
      lengthValue.textContent = lengthLabels[persona.replyLength];
    }
  }

  dom.drawerBody.querySelector('#set-tone')?.querySelectorAll<HTMLElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.value as PetTone | undefined;
      if (!value || !state.config) {
        return;
      }
      state.config.persona.tone = value;
      markSegmented('#set-tone', value);
      const label = dom.drawerBody.querySelector<HTMLElement>('#tone-value');
      if (label) {
        label.textContent = toneLabels[value];
      }
      post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.tone', value } });
    });
  });

  dom.drawerBody.querySelector('#set-length')?.querySelectorAll<HTMLElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.value as ReplyLength | undefined;
      if (!value || !state.config) {
        return;
      }
      state.config.persona.replyLength = value;
      markSegmented('#set-length', value);
      const label = dom.drawerBody.querySelector<HTMLElement>('#length-value');
      if (label) {
        label.textContent = lengthLabels[value];
      }
      post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'ai.replyLength', value } });
    });
  });

  const userNameInput = dom.drawerBody.querySelector<HTMLInputElement>('#user-name');
  userNameInput?.addEventListener('change', () => {
    const value = userNameInput.value.trim();
    if (state.config) {
      state.config.persona.userName = value;
    }
    post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.userName', value } });
  });

  const greetingInput = dom.drawerBody.querySelector<HTMLInputElement>('#greeting');
  greetingInput?.addEventListener('change', () => {
    const value = greetingInput.value.trim();
    if (state.config) {
      state.config.greeting = value || undefined;
    }
    post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.greeting', value } });
  });

  const volume = dom.drawerBody.querySelector<HTMLInputElement>('#set-volume');
  const volumeValue = dom.drawerBody.querySelector<HTMLElement>('#volume-value');
  const pushVolume = debounce((value: number) => {
    post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.volume', value } });
  }, 400);
  volume?.addEventListener('input', () => {
    const value = Number(volume.value) / 100;
    if (volumeValue) {
      volumeValue.textContent = `${Math.round(value * 100)}%`;
    }
    audio.setVolume(value);
    pushVolume(value);
  });
  volume?.addEventListener('change', () => audio.play('click'));

  const scale = dom.drawerBody.querySelector<HTMLInputElement>('#set-scale');
  const scaleValue = dom.drawerBody.querySelector<HTMLElement>('#scale-value');
  const pushScale = debounce((value: number) => {
    post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.scale', value } });
  }, 400);
  scale?.addEventListener('input', () => {
    const value = Number(scale.value) / 100;
    if (scaleValue) {
      scaleValue.textContent = `${Math.round(value * 100)}%`;
    }
    engine.setScale(value);
    pushScale(value);
  });

  dom.drawerBody.querySelector('#btn-set-key')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.setApiKey });
  });
  dom.drawerBody.querySelector('#btn-goto-settings')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.openSettings });
  });
  dom.drawerBody.querySelector('#btn-reset-pet')?.addEventListener('click', () => {
    post({ type: 'command', command: CMD.resetPet });
  });

  dom.drawerFoot.innerHTML = `<span class="hint">${L('改完即时生效，设置会写入你的 VS Code 配置')}</span>`;
}

dom.btnGallery.addEventListener('click', () => openDrawer('gallery'));
dom.btnSound.addEventListener('click', () => openDrawer('sound'));
dom.btnStandards.addEventListener('click', () => openDrawer('standards'));
dom.btnPalette.addEventListener('click', () => openDrawer('palette'));
dom.btnSettings.addEventListener('click', () => openDrawer('settings'));
dom.problemChip.addEventListener('click', () => openDrawer('problems'));
dom.btnOpenPanel.addEventListener('click', () => post({ type: 'command', command: CMD.openPanel }));
dom.drawerClose.addEventListener('click', closeDrawer);
dom.btnAi.addEventListener('click', () => openDrawer('settings'));
dom.drawer.addEventListener('click', (event) => {
  if (event.target === dom.drawer) {
    closeDrawer();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!dom.drawer.hidden) {
      closeDrawer();
    } else {
      hideSay();
    }
  }
});

// ------------------------------------------------------------------ 链接 / 复制

dom.chatLog.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;

  const adviceButton = target.closest<HTMLElement>('[data-advice-action]');
  if (adviceButton) {
    const card = adviceButton.closest<HTMLElement>('[data-advice]');
    const id = card?.dataset.advice;
    const action = adviceButton.dataset.adviceAction as AdviceAction | undefined;
    if (id && action) {
      post({ type: 'adviceAction', id, action });
    }
    return;
  }

  const nudgeButton = target.closest<HTMLElement>('.chat-nudge-actions button');
  if (nudgeButton) {
    clearUnread();
    const command = nudgeButton.dataset.command;
    const send = nudgeButton.dataset.send;
    if (command) {
      post({ type: 'command', command });
    } else if (send) {
      dom.input.value = send;
      submit();
    }
    return;
  }

  const anchor = target.closest('a');
  if (anchor) {
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) {
      post({ type: 'command', command: 'deskpet.openExternal', args: href });
    }
    return;
  }
  const copy = target.closest<HTMLElement>('.copy-btn');
  if (copy) {
    const raw = copy.dataset.code;
    if (!raw) {
      return;
    }
    const text = decodeURIComponent(raw);
    post({ type: 'command', command: 'deskpet.copyText', args: text });
    copy.textContent = L('已复制');
    window.setTimeout(() => {
      copy.textContent = L('复制');
    }, 1200);
  }
});

// ------------------------------------------------------------------ 提示条

let toastTimer: number | undefined;

function toast(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  dom.toast.textContent = text;
  dom.toast.className = `toast kind-${kind}`;
  dom.toast.hidden = false;
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, kind === 'error' ? 7000 : 3800);
}

// ------------------------------------------------------------------ 尺寸 / 生命周期

const resizeObserver = new ResizeObserver(() => engine.resize());
resizeObserver.observe(dom.stage);

window.addEventListener('beforeunload', () => {
  audio.stopSpeaking();
  engine.destroy();
});

// ------------------------------------------------------------------ 启动

autoGrow();
post({ type: 'ready' });

// ------------------------------------------------------------------ 小工具

function glyphFor(kind: AssetItem['kind']): string {
  switch (kind) {
    case 'builtin':
      return '✦';
    case 'live2d':
      return '◍';
    case 'vrm':
      return '⬢';
    default:
      return '▣';
  }
}

function kindLabel(kind: AssetItem['kind']): string {
  switch (kind) {
    case 'builtin':
      return L('内置');
    case 'live2d':
      return 'Live2D';
    case 'vrm':
      return '3D';
    default:
      return L('图片');
  }
}

function escapeText(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[char] ?? char;
  });
}

function escapeAttr(input: string): string {
  return escapeText(input).replace(/`/g, '&#96;');
}
