import type {
  AdviceAction,
  AssetItem,
  HostMessage,
  InterruptionLevel,
  PetAction,
  PetConfig,
  PetSnapshot,
  ProblemItem,
  SoundItem,
  SoundSlot,
  StandardsPack,
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
  unread: number;
  problems: ProblemItem[];
  problemsFile?: string;
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
  dom.indexChip.textContent = config.contextLabel ?? '';
  dom.indexChip.hidden = !config.contextLabel;
  dom.indexChip.title = config.contextLabel ? `已索引项目：${config.contextLabel}` : '项目索引未建立';
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
    kind === 'explain'
      ? CMD.explain
      : kind === 'teach'
        ? CMD.teach
        : kind === 'fix'
          ? CMD.fix
          : kind === 'tests'
            ? CMD.tests
            : undefined;
  if (command) {
    post({ type: 'command', command });
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

let currentDrawer: 'gallery' | 'sound' | 'settings' | 'problems' | 'standards' | undefined;

function openDrawer(kind: 'gallery' | 'sound' | 'settings' | 'problems' | 'standards'): void {
  currentDrawer = kind;
  dom.drawer.hidden = false;
  renderDrawer(kind);
}

function closeDrawer(): void {
  currentDrawer = undefined;
  dom.drawer.hidden = true;
}

function renderDrawer(kind: 'gallery' | 'sound' | 'settings' | 'problems' | 'standards'): void {
  if (kind === 'gallery') {
    renderGallery();
  } else if (kind === 'sound') {
    renderSounds();
  } else if (kind === 'problems') {
    renderProblems();
  } else if (kind === 'standards') {
    renderStandards();
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

function updateProblemChip(): void {
  const errors = state.problems.filter((item) => item.severity === 'error').length;
  const total = state.problems.length;
  dom.problemChip.hidden = total === 0;
  dom.problemChip.textContent = `⚠ ${total}`;
  dom.problemChip.classList.toggle('has-error', errors > 0);
  dom.problemChip.title = state.problemsFile
    ? `${state.problemsFile}：${errors} 个错误，${total - errors} 条其它提示`
    : '当前文件的问题';
}

function renderProblems(): void {
  dom.drawerTitle.textContent = state.problems.length ? `问题清单 · ${state.problems.length}` : '问题清单';

  if (!state.problems.length) {
    dom.drawerBody.innerHTML =
      '<div class="empty-state">当前文件没有诊断问题。<br/>可以点下面的「体检整个文件」做一次静态检查。</div>';
  } else {
    dom.drawerBody.innerHTML = `<div class="problem-list">${state.problems
      .map(
        (item) => `<div class="problem-row sev-${item.severity}">
          <div class="problem-head">
            <span class="sev-dot"></span>
            <span class="problem-line">L${item.line}</span>
            <span class="problem-msg">${escapeText(item.message)}</span>
          </div>
          <div class="problem-actions">
            <button data-problem-action="explain" data-line="${item.line}">解释</button>
            <button data-problem-action="fix" data-line="${item.line}">修复</button>
          </div>
        </div>`,
      )
      .join('')}</div>`;
  }

  dom.drawerFoot.innerHTML = `<div class="drawer-actions">
    <button class="primary-btn" id="review-file">体检整个文件</button>
    <button class="ghost-btn" id="analyze-clipboard">分析剪贴板里的报错</button>
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
}

function renderStandards(): void {
  const standards = state.standards;
  dom.drawerTitle.textContent = '代码规范';

  const conventions = (standards?.conventions ?? []).length
    ? (standards?.conventions ?? [])
        .map((line) => `<li>${escapeText(line.replace(/^-\s*/, ''))}</li>`)
        .join('')
    : '<li>索引完成后会显示检测到的项目约定</li>';

  const packs = (standards?.packs ?? [])
    .map(
      (pack) => `<label class="pack-row">
        <input type="checkbox" data-pack="${escapeAttr(pack.id)}" ${pack.enabled ? 'checked' : ''}/>
        <span class="pack-text"><b>${escapeText(pack.label)}</b><em>${escapeText(pack.description)}</em></span>
      </label>`,
    )
    .join('');

  dom.drawerBody.innerHTML = `
    <div class="standards-section">
      <div class="section-title">检测到的约定</div>
      <ul class="convention-list">${conventions}</ul>
    </div>
    <div class="standards-section">
      <div class="section-title">规则包</div>
      <div class="pack-list">${packs || '<div class="hint">正在读取配置…</div>'}</div>
    </div>
    <div class="standards-meta">
      <span>自定义规则 ${standards?.customCount ?? 0} 条</span>
      <span>白名单 ${standards?.whitelistCount ?? 0} 条</span>
    </div>
    <div class="hint">规则和风格会写进每次生成的提示词；白名单里的规则不会被扫描，也不会被“修复”。</div>`;

  dom.drawerFoot.innerHTML = `<div class="drawer-actions">
    <button class="primary-btn" id="review-rules">按规范检查当前文件</button>
    <button class="ghost-btn" id="modernize-selection">现代化重构选中代码</button>
    <button class="ghost-btn" id="edit-standards">编辑规则与白名单</button>
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
      toast(`规则包已更新，${enabled.size} 个启用`);
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

function renderSettings(): void {  dom.drawerTitle.textContent = '设置';
  const config = state.config;
  const snapshot = state.snapshot;
  dom.drawerBody.innerHTML = `
    <div class="setting">
      <div class="setting-head"><span>语音朗读回复</span></div>
      <label class="switch"><input type="checkbox" id="set-tts" ${config?.tts ? 'checked' : ''}/><span></span></label>
    </div>
    <div class="setting">
      <div class="setting-head"><span>打扰程度</span><em id="interruption-value">平衡</em></div>
      <div class="segmented" id="set-interruption">
        <button data-value="quiet">安静</button>
        <button data-value="balanced">平衡</button>
        <button data-value="chatty">话多</button>
      </div>
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

  const interruptionLabels: Record<InterruptionLevel, string> = { quiet: '安静', balanced: '平衡', chatty: '话多' };
  const segmented = dom.drawerBody.querySelector('#set-interruption');
  const interruptionValue = dom.drawerBody.querySelector<HTMLElement>('#interruption-value');
  const markInterruption = () => {
    const current = state.config?.interruption ?? 'balanced';
    segmented?.querySelectorAll<HTMLElement>('button').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === current);
    });
    if (interruptionValue) {
      interruptionValue.textContent = interruptionLabels[current];
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
          ? '安静模式：提醒只写进对话，不弹气泡'
          : value === 'chatty'
            ? '话多模式：提醒会直接弹气泡'
            : '平衡模式：重要提醒才弹气泡，打字时不打扰',
      );
    });
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
el('btn-standards').addEventListener('click', () => openDrawer('standards'));
el('btn-settings').addEventListener('click', () => openDrawer('settings'));
dom.problemChip.addEventListener('click', () => openDrawer('problems'));
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
