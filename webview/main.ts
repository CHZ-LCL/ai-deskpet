import type {
  AssetItem,
  HostMessage,
  PetAction,
  PetConfig,
  PetSnapshot,
  SoundItem,
  SoundSlot,
  WebviewMessage,
} from '../shared/protocol';
import { CMD } from '../shared/protocol';
import { AudioKit } from './audio';
import { PetEngine } from './pet/engine';
import { ChatView } from './ui/chat';
import { debounce } from './util';
import './style.css';

declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
};

const vscode = acquireVsCodeApi<{ greeted?: boolean }>();

const MOOD_LABEL: Record<PetAction, string> = {
  idle: '发呆中',
  happy: '心情不错',
  think: '思考中',
  alert: '警觉',
  sleep: '打盹中',
  shy: '害羞',
  wave: '打招呼',
};

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
  drawer: el('drawer'),
  drawerTitle: el('drawer-title'),
  drawerBody: el('drawer-body'),
  drawerFoot: el('drawer-foot'),
  toast: el('toast'),
  btnAi: el('btn-ai'),
};

const audio = new AudioKit();
const chat = new ChatView(dom.chatLog);
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
} = {
  assets: [],
  sounds: [],
  busy: false,
  docsMode: false,
  rendererKey: '',
  initialized: false,
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
      setBusy(true, state.busyLabel ?? '思考中…');
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
    case 'openChat':
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
        showSay('我在这儿，需要我陪你看段代码吗？', 7000, [
          { label: '讲解选中代码', command: CMD.explain },
          { label: '查资料', send: '__docs__' },
        ]);
      }, 600);
    }
  }
  setBusy(message.busy, message.busyLabel);
}

// ------------------------------------------------------------------ 配置

function applyConfig(config: PetConfig): void {
  state.config = config;
  dom.petName.textContent = config.name;
  dom.namePlate.textContent = `${config.name} · ${MOOD_LABEL[state.snapshot?.mood ?? 'idle']}`;
  dom.modelChip.textContent = config.aiProviderLabel;
  dom.modelChip.title = `模型：${config.aiModel}`;
  audio.configure(config.volume, config.assets);

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

function applySnapshot(snapshot: PetSnapshot): void {
  state.snapshot = snapshot;
  dom.levelChip.textContent = `Lv.${snapshot.level}`;
  dom.levelChip.title = `好感度 ${snapshot.affection} · 陪伴 ${snapshot.daysTogether} 天 · 互动 ${snapshot.totalChats + snapshot.totalClicks} 次`;
  const name = state.config?.name ?? '桌宠';
  dom.namePlate.textContent = `${name} · ${MOOD_LABEL[snapshot.mood] ?? '发呆中'}`;
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
  dom.sendBtn.title = busy ? '停止生成' : '发送';
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

  if (speechTimer) {
    window.clearTimeout(speechTimer);
  }
  if (ttl > 0) {
    speechTimer = window.setTimeout(() => hideSay(), ttl);
  }
}

function hideSay(): void {
  dom.speech.hidden = true;
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
    ? '查资料：关键词或文档地址，Enter 发送…'
    : '和桌宠聊聊…（Enter 发送 / Shift+Enter 换行）';
  const chip = dom.quick.querySelector('[data-quick="docs"]');
  chip?.classList.toggle('active', enabled);
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
      toast('已停止生成', 'info');
    }
    return;
  }
  if (!text) {
    return;
  }
  const id = newId();
  state.requestId = id;
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
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-quick]');
  if (!target) {
    return;
  }
  const kind = target.dataset.quick;
  if (kind === 'docs') {
    setDocsMode(!state.docsMode);
    dom.input.focus();
    return;
  }
  if (kind === 'clear') {
    post({ type: 'clearHistory' });
    chat.clear();
    return;
  }
  const command =
    kind === 'explain' ? CMD.explain : kind === 'fix' ? CMD.fix : kind === 'tests' ? CMD.tests : undefined;
  if (command) {
    post({ type: 'command', command });
  }
});

// ------------------------------------------------------------------ 点击桌宠

dom.petMount.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('.speech')) {
    return;
  }
  audio.play('click');
  engine.play('happy');
  post({ type: 'click' });
});

// ------------------------------------------------------------------ 工具栏 / 抽屉

let currentDrawer: 'gallery' | 'sound' | 'settings' | undefined;

function openDrawer(kind: 'gallery' | 'sound' | 'settings'): void {
  currentDrawer = kind;
  dom.drawer.hidden = false;
  renderDrawer(kind);
}

function closeDrawer(): void {
  currentDrawer = undefined;
  dom.drawer.hidden = true;
}

function renderDrawer(kind: 'gallery' | 'sound' | 'settings'): void {
  if (kind === 'gallery') {
    renderGallery();
  } else if (kind === 'sound') {
    renderSounds();
  } else {
    renderSettings();
  }
}

function renderGallery(): void {
  dom.drawerTitle.textContent = '形象库';
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
      <span class="asset-name">导入形象</span>
      <span class="asset-kind">Live2D / 3D / 图片</span>
    </button></div>`;
  dom.drawerFoot.innerHTML = '<span class="hint">支持 .model3.json、.vrm / .glb、png / gif / webp</span>';

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
  dom.drawerTitle.textContent = '音效库';
  const rows = SOUND_SLOTS.map(({ slot, label }) => {
    const bound = state.config?.assets.sounds[slot];
    const options = [
      `<option value="__synth__"${bound ? '' : ' selected'}>内置合成音</option>`,
      ...state.sounds.map(
        (sound) => `<option value="${escapeAttr(sound.id)}"${bound === sound.uri ? ' selected' : ''}>${escapeText(sound.name)}</option>`,
      ),
    ].join('');
    return `<div class="sound-row" data-slot="${slot}">
      <div class="sound-label">${label}</div>
      <div class="sound-controls">
        <select data-role="select">${options}</select>
        <button class="ghost-btn" data-role="preview" title="试听">♪</button>
      </div>
    </div>`;
  }).join('');

  dom.drawerBody.innerHTML = `<div class="sound-list">${rows}</div>`;
  dom.drawerFoot.innerHTML = '<button class="primary-btn" id="sound-import">导入音效文件…</button>';

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

function renderSettings(): void {
  dom.drawerTitle.textContent = '设置';
  const config = state.config;
  const snapshot = state.snapshot;
  dom.drawerBody.innerHTML = `
    <div class="setting">
      <div class="setting-head"><span>语音朗读回复</span></div>
      <label class="switch"><input type="checkbox" id="set-tts" ${config?.tts ? 'checked' : ''}/><span></span></label>
    </div>
    <div class="setting">
      <div class="setting-head"><span>音量</span><em id="volume-value">${Math.round((config?.volume ?? 0.6) * 100)}%</em></div>
      <input type="range" id="set-volume" min="0" max="100" value="${Math.round((config?.volume ?? 0.6) * 100)}" />
    </div>
    <div class="setting">
      <div class="setting-head"><span>形象大小</span><em id="scale-value">${Math.round((config?.scale ?? 1) * 100)}%</em></div>
      <input type="range" id="set-scale" min="50" max="200" value="${Math.round((config?.scale ?? 1) * 100)}" />
    </div>
    <div class="setting-info">
      <div><span>AI</span><strong>${escapeText(config?.aiProviderLabel ?? '未配置')}</strong></div>
      <div><span>模型</span><strong>${escapeText(config?.aiModel ?? '-')}</strong></div>
      <div><span>好感</span><strong>Lv.${snapshot?.level ?? 1} · ${snapshot?.affection ?? 0}</strong></div>
      <div><span>陪伴</span><strong>${snapshot?.daysTogether ?? 1} 天</strong></div>
    </div>
    <div class="drawer-actions">
      <button class="primary-btn" id="btn-set-key">设置密钥</button>
      <button class="ghost-btn" id="btn-goto-settings">打开全部设置</button>
      <button class="ghost-btn danger" id="btn-reset-pet">重置桌宠</button>
    </div>`;

  const tts = dom.drawerBody.querySelector<HTMLInputElement>('#set-tts');
  tts?.addEventListener('change', () => {
    post({ type: 'command', command: 'deskpet.updateSetting', args: { key: 'pet.tts', value: Boolean(tts.checked) } });
    if (tts.checked) {
      audio.speak('好呀，以后我会念给你听。', state.config?.ttsRate ?? 1);
    }
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

  dom.drawerFoot.innerHTML = '<span class="hint">改完即时生效，设置会写入你的 VS Code 配置</span>';
}

el('btn-gallery').addEventListener('click', () => openDrawer('gallery'));
el('btn-sound').addEventListener('click', () => openDrawer('sound'));
el('btn-settings').addEventListener('click', () => openDrawer('settings'));
el('btn-open-panel').addEventListener('click', () => post({ type: 'command', command: CMD.openPanel }));
el('drawer-close').addEventListener('click', closeDrawer);
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
    copy.textContent = '已复制';
    window.setTimeout(() => {
      copy.textContent = '复制';
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
      return '内置';
    case 'live2d':
      return 'Live2D';
    case 'vrm':
      return '3D';
    default:
      return '图片';
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
