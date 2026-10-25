import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AssetItem, PetAssets, RendererKind, SoundItem, SoundSlot } from '../../shared/protocol';
import { L } from '../i18n';

const SLOT_LABELS: Record<SoundSlot, string> = {
  click: '点击桌宠',
  happy: '开心 / 保存成功',
  alert: '提醒 / 报错',
  error: '出错',
  switch: '切换形象',
};

const SLOT_LABELS_EN: Record<SoundSlot, string> = {
  click: 'Pet click',
  happy: 'Happy / saved',
  alert: 'Alert / error',
  error: 'Error',
  switch: 'Switch avatar',
};

const soundFilter = (): Record<string, string[]> => ({
  [L('音频文件', 'Audio files')]: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
});

const modelFilter = (): Record<string, string[]> => ({
  [L('Live2D 模型 (model3.json)', 'Live2D model (.model3.json)')]: ['json'],
  [L('3D 模型 (VRM / GLB / GLTF)', '3D model (VRM / GLB / GLTF)')]: ['vrm', 'glb', 'gltf'],
  [L('静态图片 / GIF', 'Image / GIF')]: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'],
});

interface SoundBindings {
  [slot: string]: string;
}

const SOUND_KEY = 'deskpet.soundBindings.v1';

/**
 * 管理用户导入的素材：形象、音效。
 * 素材统一复制到 globalStorage，避免用户移动源文件后失效。
 */
export class AssetStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get petsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'pets');
  }

  get soundsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'sounds');
  }

  get builtinSoundsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'sounds');
  }

  get defaultsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'default');
  }

  async ensureDirs(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.petsDir.fsPath, { recursive: true }),
      fs.mkdir(this.soundsDir.fsPath, { recursive: true }),
    ]);
  }

  /** 当前配置指向的模型文件（可能是工作区相对路径）。 */
  resolveModelUri(webview: vscode.Webview): vscode.Uri | undefined {
    const raw = vscode.workspace.getConfiguration('deskpet').get<string>('pet.modelPath', '').trim();
    if (!raw) {
      return undefined;
    }
    const absolute = this.toAbsolute(raw);
    return absolute ? webview.asWebviewUri(vscode.Uri.file(absolute)) : undefined;
  }

  resolveCubismCoreUri(webview: vscode.Webview): vscode.Uri | undefined {
    const raw = vscode.workspace.getConfiguration('deskpet').get<string>('pet.cubismCorePath', '').trim();
    if (!raw) {
      return undefined;
    }
    const absolute = this.toAbsolute(raw);
    if (!absolute || !absolute.toLowerCase().endsWith('.js')) {
      return undefined;
    }
    return webview.asWebviewUri(vscode.Uri.file(absolute));
  }

  toAbsolute(raw: string): string | undefined {
    const cleaned = raw.replace(/^file:\/\//i, '');
    if (path.isAbsolute(cleaned)) {
      return cleaned;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return path.join(folder.uri.fsPath, cleaned);
  }

  async buildAssets(webview: vscode.Webview): Promise<PetAssets> {
    const renderer = vscode.workspace.getConfiguration('deskpet').get<RendererKind>('pet.renderer', 'builtin');
    const modelUri = this.resolveModelUri(webview);
    const assets: PetAssets = { sounds: await this.buildSounds(webview) };

    const defaultImage = await this.findDefaultImage();
    if (defaultImage) {
      assets.builtinImageUri = webview.asWebviewUri(vscode.Uri.file(defaultImage)).toString();
    }

    if (modelUri) {
      if (renderer === 'image') {
        assets.imageUri = modelUri.toString();
      } else if (renderer === 'live2d') {
        assets.live2dModelUri = modelUri.toString();
        assets.cubismCoreUri = this.resolveCubismCoreUri(webview)?.toString();
      } else if (renderer === 'vrm') {
        assets.vrmModelUri = modelUri.toString();
      }
    }

    return assets;
  }

  /** assets/default/ 里第一张图片会被当作默认立绘（用户后续提供的默认样式放这里）。 */
  async findDefaultImage(): Promise<string | undefined> {
    const entries = await safeReadDir(this.defaultsDir.fsPath);
    const file = entries.find(
      (entry) => entry.isFile() && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(entry.name),
    );
    return file ? path.join(this.defaultsDir.fsPath, file.name) : undefined;
  }

  private async buildSounds(webview: vscode.Webview): Promise<Partial<Record<SoundSlot, string>>> {
    const bindings = this.context.globalState.get<SoundBindings>(SOUND_KEY) ?? {};
    const result: Partial<Record<SoundSlot, string>> = {};

    for (const slot of SOUND_SLOTS) {
      const explicit = bindings[slot];
      if (explicit && path.isAbsolute(explicit) && (await exists(explicit))) {
        result[slot] = webview.asWebviewUri(vscode.Uri.file(explicit)).toString();
        continue;
      }
      // 没绑定时找随插件分发的默认音效：assets/sounds/click.mp3
      const bundled = await findBundledSound(this.builtinSoundsDir.fsPath, slot);
      if (bundled) {
        result[slot] = webview.asWebviewUri(vscode.Uri.file(bundled)).toString();
      }
    }

    return result;
  }

  async listAssets(webview: vscode.Webview): Promise<AssetItem[]> {
    await this.ensureDirs();
    const config = vscode.workspace.getConfiguration('deskpet');
    const renderer = config.get<RendererKind>('pet.renderer', 'builtin');
    const configuredPath = config.get<string>('pet.modelPath', '').trim();
    const currentAbs = configuredPath ? this.toAbsolute(configuredPath) : undefined;
    const defaultImage = await this.findDefaultImage();

    const items: AssetItem[] = [
      {
        id: 'builtin',
        name: defaultImage
          ? L('默认形象', 'Default avatar')
          : L('内置形象 · 小豆', 'Built-in avatar · Xiaodou'),
        kind: 'builtin',
        source: 'builtin',
        previewUri: defaultImage ? webview.asWebviewUri(vscode.Uri.file(defaultImage)).toString() : undefined,
        active: renderer === 'builtin' || !currentAbs,
      },
    ];

    const entries = await safeReadDir(this.petsDir.fsPath);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(this.petsDir.fsPath, entry.name);
      const primary = await findPrimaryModel(dir);
      if (!primary) {
        continue;
      }
      const kind = kindOf(primary);
      if (!kind) {
        continue;
      }
      items.push({
        id: `user:${entry.name}`,
        name: prettyName(entry.name),
        kind,
        source: 'user',
        previewUri: kind === 'image' ? webview.asWebviewUri(vscode.Uri.file(primary)).toString() : undefined,
        active: currentAbs === primary,
      });
    }

    // 配置里手写的模型路径也算一个可切换项
    if (currentAbs && !items.some((item) => item.source === 'user' && item.active)) {
      items.push({
        id: 'configured',
        name: L('当前配置的形象', 'Configured avatar'),
        kind: renderer,
        source: 'workspace',
        active: true,
      });
    }

    return items;
  }

  async listSounds(webview: vscode.Webview): Promise<SoundItem[]> {
    await this.ensureDirs();
    const items: SoundItem[] = [];
    for (const [dir, source] of [
      [this.soundsDir.fsPath, 'user'],
      [this.builtinSoundsDir.fsPath, 'builtin'],
    ] as const) {
      const entries = await safeReadDir(dir);
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        items.push({
          id: `${source}:${entry.name}`,
          name: path.basename(entry.name, ext),
          uri: webview.asWebviewUri(vscode.Uri.file(full)).toString(),
          source,
        });
      }
    }
    return items;
  }

  async importFromDialog(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      title: L('选择桌宠形象（Live2D / 3D / 图片）', 'Choose an avatar (Live2D / 3D / image)'),
      filters: modelFilter(),
    });
    const file = picked?.[0];
    if (!file) {
      return;
    }
    const sourcePath = file.fsPath;
    const kind = kindOf(sourcePath);
    if (!kind) {
      void vscode.window.showErrorMessage(L('无法识别的文件类型。', 'Unsupported file type.'));
      return;
    }

    await this.ensureDirs();
    const folder = path.join(this.petsDir.fsPath, `${slug(path.basename(sourcePath, path.extname(sourcePath)))}-${Date.now().toString(36)}`);
    await fs.mkdir(folder, { recursive: true });

    try {
      const lower = sourcePath.toLowerCase();
      // 图片、VRM、GLB 都是单文件（贴图内嵌）；只有 Live2D 和 glTF 需要同目录的附属文件
      const singleFile = kind === 'image' || /\.(vrm|glb)$/.test(lower);
      if (singleFile) {
        await fs.copyFile(sourcePath, path.join(folder, path.basename(sourcePath)));
      } else {
        const stats = await dirStats(path.dirname(sourcePath));
        if (stats.files > 800 || stats.bytes > 200 * 1024 * 1024) {
          await fs.rm(folder, { recursive: true, force: true });
          void vscode.window.showErrorMessage(
            L(
              `这个目录太大了（${stats.files} 个文件，约 ${(stats.bytes / 1024 / 1024).toFixed(0)} MB）。请把模型单独放在一个文件夹里再导入。`,
              `That folder is too large (${stats.files} files, about ${(stats.bytes / 1024 / 1024).toFixed(0)} MB). Put the model in its own folder and try again.`,
            ),
          );
          return;
        }
        await fs.cp(path.dirname(sourcePath), folder, {
          recursive: true,
          force: true,
          filter: (src) => {
            const base = path.basename(src);
            return !base.startsWith('.') && base !== 'node_modules';
          },
        });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        L(
          `复制素材失败：${error instanceof Error ? error.message : String(error)}`,
          `Could not copy the assets: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    const copiedPrimary = path.join(folder, path.basename(sourcePath));
    const config = vscode.workspace.getConfiguration('deskpet');
    await config.update('pet.renderer', kind, vscode.ConfigurationTarget.Global);
    await config.update('pet.modelPath', copiedPrimary, vscode.ConfigurationTarget.Global);

    if (kind === 'live2d' && !config.get<string>('pet.cubismCorePath', '').trim()) {
      const openSettings = L('打开设置', 'Open settings');
      void vscode.window
        .showWarningMessage(
          L(
            'Live2D 需要 Live2D 官方的 Cubism Core 文件（live2dcubismcore.min.js）。请从 Live2D 官网下载后，在设置 deskpet.pet.cubismCorePath 中指定路径。',
            'Live2D needs the official Cubism Core file (live2dcubismcore.min.js). Download it from Live2D and set deskpet.pet.cubismCorePath.',
          ),
          openSettings,
        )
        .then((choice) => {
          if (choice === openSettings) {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'deskpet.pet.cubismCorePath');
          }
        });
    }

    void vscode.window.showInformationMessage(
      L(`已导入形象：${path.basename(sourcePath)}`, `Avatar imported: ${path.basename(sourcePath)}`),
    );
  }

  async importSound(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      title: L('选择音效文件', 'Choose a sound file'),
      filters: soundFilter(),
    });
    const file = picked?.[0];
    if (!file) {
      return;
    }
    await this.ensureDirs();
    const target = path.join(this.soundsDir.fsPath, `${slug(path.basename(file.fsPath, path.extname(file.fsPath)))}${path.extname(file.fsPath).toLowerCase()}`);
    await fs.copyFile(file.fsPath, target);

    const slots = Object.entries(SLOT_LABELS).map(([value, label]) => ({
      label: L(label, SLOT_LABELS_EN[value as SoundSlot]),
      description: value,
      value: value as SoundSlot,
    }));
    const slot = await vscode.window.showQuickPick(slots, {
      title: L('把这个音效绑定到哪个场景？', 'Which scene should use this sound?'),
      placeHolder: L('选择场景', 'Choose a scene'),
    });
    if (slot) {
      await this.bindSound(slot.value, target);
      void vscode.window.showInformationMessage(
        L(`已设置「${slot.label}」音效`, `Sound set for “${slot.label}”`),
      );
    }
  }

  async bindSound(slot: SoundSlot, filePath: string): Promise<void> {
    const bindings = this.context.globalState.get<SoundBindings>(SOUND_KEY) ?? {};
    bindings[slot] = filePath;
    await this.context.globalState.update(SOUND_KEY, bindings);
  }

  /** 通过 webview 传来的 id 找回本地文件，避免解析 asWebviewUri 之后的 https 地址。 */
  async resolveSoundPath(id: string): Promise<string | undefined> {
    const separator = id.indexOf(':');
    if (separator < 0) {
      return undefined;
    }
    const source = id.slice(0, separator);
    const name = path.basename(id.slice(separator + 1));
    const dir = source === 'user' ? this.soundsDir.fsPath : this.builtinSoundsDir.fsPath;
    const full = path.join(dir, name);
    return (await exists(full)) ? full : undefined;
  }

  async unbindSound(slot: SoundSlot): Promise<void> {
    const bindings = this.context.globalState.get<SoundBindings>(SOUND_KEY) ?? {};
    delete bindings[slot];
    await this.context.globalState.update(SOUND_KEY, bindings);
  }

  async switchAsset(id: string): Promise<void> {
    if (id === 'builtin') {
      await vscode.workspace.getConfiguration('deskpet').update('pet.renderer', 'builtin', vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('deskpet').update('pet.modelPath', '', vscode.ConfigurationTarget.Global);
      return;
    }
    if (id === 'configured') {
      return;
    }
    if (!id.startsWith('user:')) {
      return;
    }
    const dir = path.join(this.petsDir.fsPath, id.slice('user:'.length));
    const primary = await findPrimaryModel(dir);
    if (!primary) {
      void vscode.window.showErrorMessage(
        L('这个素材目录里找不到可用模型文件。', 'No usable model file was found in that folder.'),
      );
      return;
    }
    const kind = kindOf(primary);
    if (!kind) {
      return;
    }
    const config = vscode.workspace.getConfiguration('deskpet');
    await config.update('pet.renderer', kind, vscode.ConfigurationTarget.Global);
    await config.update('pet.modelPath', primary, vscode.ConfigurationTarget.Global);
  }
}

async function safeReadDir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const SOUND_SLOTS: SoundSlot[] = ['click', 'happy', 'alert', 'error', 'switch'];
const SOUND_EXTS = ['.mp3', '.wav', '.ogg', '.m4a'];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findBundledSound(dir: string, slot: SoundSlot): Promise<string | undefined> {
  for (const ext of SOUND_EXTS) {
    const candidate = path.join(dir, `${slot}${ext}`);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** 导入前先估算目录体积，避免把整个「下载」目录复制进来。 */
async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 4) {
      return;
    }
    const entries = await safeReadDir(current);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fs.stat(full)).size;
        } catch {
          // 忽略读不到的文件
        }
      }
    }
  };

  await walk(dir, 0);
  return { files, bytes };
}

async function findPrimaryModel(dir: string): Promise<string | undefined> {
  const entries = await safeReadDir(dir);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const pick = (names: string[], predicate: (name: string) => boolean) =>
    names.find(predicate);

  const image = pick(files, (name) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name));
  const live2d = pick(files, (name) => /\.model3?\.json$/i.test(name));
  const vrm = pick(files, (name) => /\.(vrm|glb|gltf)$/i.test(name));

  const chosen = live2d ?? vrm ?? image;
  return chosen ? path.join(dir, chosen) : undefined;
}

function kindOf(filePath: string): RendererKind | undefined {
  const lower = filePath.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(lower)) {
    return 'image';
  }
  if (/\.model3?\.json$/.test(lower)) {
    return 'live2d';
  }
  if (/\.(vrm|glb|gltf)$/.test(lower)) {
    return 'vrm';
  }
  return undefined;
}

function slug(input: string): string {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'asset';
}

function prettyName(folder: string): string {
  return folder.replace(/-[a-z0-9]{4,}$/i, '').replace(/-/g, ' ');
}
