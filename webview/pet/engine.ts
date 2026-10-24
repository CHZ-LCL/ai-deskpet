import type { PetAction, PetConfig } from '../../shared/protocol';
import type { PetRendererHandle, RendererContext } from '../types';
import { createBuiltinRenderer } from './builtin';
import { createImageRenderer } from './image';

type RendererModule = { create: (context: RendererContext) => Promise<PetRendererHandle> };

declare global {
  interface Window {
    DeskPetLive2D?: RendererModule;
    DeskPetVRM?: RendererModule;
  }
}

const loadedScripts = new Map<string, Promise<void>>();

function loadScript(uri: string): Promise<void> {
  const cached = loadedScripts.get(uri);
  if (cached) {
    return cached;
  }
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = uri;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`渲染器脚本加载失败：${uri.split('/').pop()}`));
    document.head.appendChild(script);
  });
  loadedScripts.set(uri, promise);
  return promise;
}

export type Notify = (text: string, kind?: 'info' | 'warn' | 'error') => void;

/**
 * 形象渲染的统一入口：按配置选择 builtin / image / live2d / vrm，
 * 任何一步失败都回退到内置形象，绝不让面板变成白屏。
 */
export class PetEngine {
  private handle?: PetRendererHandle;
  private generation = 0;
  private config?: PetConfig;
  private fallbackNoticeShown = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly notify: Notify,
  ) {}

  async apply(config: PetConfig): Promise<void> {
    const generation = ++this.generation;
    this.destroyHandle();
    this.container.innerHTML = '';
    // 图片形象会改写外框宽高比，切回其他渲染器前先还原
    const block = this.container.parentElement;
    if (block) {
      block.style.removeProperty('--pet-aspect');
      block.style.width = '';
    }
    document.body.classList.remove('pet-wide');
    this.config = config;

    let handle: PetRendererHandle | undefined;
    let failure: string | undefined;

    try {
      handle = await this.createRenderer(config);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    if (generation !== this.generation) {
      handle?.destroy();
      return;
    }

    if (!handle) {
      handle = await this.createBuiltin(config);
      if (failure) {
        this.notify(failure, 'error');
      } else if (config.renderer !== 'builtin' && !this.fallbackNoticeShown) {
        this.fallbackNoticeShown = true;
        this.notify('这个形象还没配好，先用内置形象陪你。', 'warn');
      }
    } else {
      this.fallbackNoticeShown = false;
    }

    this.handle = handle;
  }

  play(action: PetAction): void {
    this.handle?.play(action);
  }

  setScale(scale: number): void {
    this.handle?.setScale(scale);
    if (this.config) {
      this.config.scale = scale;
    }
  }

  resize(): void {
    this.handle?.resize();
  }

  destroy(): void {
    this.generation++;
    this.destroyHandle();
  }

  private destroyHandle(): void {
    try {
      this.handle?.destroy();
    } catch {
      // 忽略第三方渲染器销毁时的异常
    }
    this.handle = undefined;
  }

  private async createRenderer(config: PetConfig): Promise<PetRendererHandle | undefined> {
    const context: RendererContext = {
      container: this.container,
      assets: config.assets,
      scale: config.scale,
    };

    if (config.renderer === 'builtin') {
      return this.createBuiltin(config);
    }

    if (config.renderer === 'image') {
      if (!config.assets.imageUri) {
        return undefined;
      }
      return createImageRenderer(context);
    }

    if (config.renderer === 'live2d') {
      if (!config.assets.live2dModelUri) {
        throw new Error('还没有选择 Live2D 模型：运行命令「导入桌宠形象」选择 .model3.json。');
      }
      if (!config.assets.cubismCoreUri) {
        throw new Error(
          'Live2D 缺少 Cubism Core：请从 Live2D 官网下载 live2dcubismcore.min.js，并在设置 deskpet.pet.cubismCorePath 填写路径。',
        );
      }
      await loadScript(config.assets.cubismCoreUri);
      if (!config.rendererScripts.live2d) {
        throw new Error('Live2D 渲染器未打包，请重新安装插件。');
      }
      await loadScript(config.rendererScripts.live2d);
      const module = window.DeskPetLive2D;
      if (!module) {
        throw new Error('Live2D 渲染器加载后不可用。');
      }
      return module.create(context);
    }

    if (config.renderer === 'vrm') {
      if (!config.assets.vrmModelUri) {
        throw new Error('还没有选择 3D 模型：运行命令「导入桌宠形象」选择 .vrm / .glb 文件。');
      }
      if (!config.rendererScripts.vrm) {
        throw new Error('3D 渲染器未打包，请重新安装插件。');
      }
      await loadScript(config.rendererScripts.vrm);
      const module = window.DeskPetVRM;
      if (!module) {
        throw new Error('3D 渲染器加载后不可用。');
      }
      return module.create(context);
    }

    return undefined;
  }

  /** 内置形象：如果 assets/default/ 放了默认立绘就优先用它。 */
  private async createBuiltin(config: PetConfig): Promise<PetRendererHandle> {
    if (config.assets.builtinImageUri) {
      return createImageRenderer({
        container: this.container,
        assets: { ...config.assets, imageUri: config.assets.builtinImageUri },
        scale: config.scale,
      });
    }
    return createBuiltinRenderer({
      container: this.container,
      assets: config.assets,
      scale: config.scale,
    });
  }
}
