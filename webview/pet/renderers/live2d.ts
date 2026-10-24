import * as PIXI from 'pixi.js';
import type { PetAction } from '../../../shared/protocol';
import type { PetRendererHandle, RendererContext } from '../../types';

// pixi-live2d-display 需要从全局拿到 PIXI 的 Ticker，必须在动态 import 之前设置
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;

const MOTION_MAP: Record<PetAction, string[]> = {
  idle: ['Idle', 'idle', 'Idle_01'],
  happy: ['Happy', 'happy', 'TapBody', 'tap_body', 'FlickUp', 'Idle'],
  think: ['Think', 'think', 'TapHead', 'Idle'],
  alert: ['Surprised', 'surprised', 'Shake', 'TapHead', 'Idle'],
  sleep: ['Sleep', 'sleep', 'Idle'],
  shy: ['Shy', 'shy', 'TapBody', 'Idle'],
  wave: ['Wave', 'wave', 'TapBody', 'Idle'],
};

const EXPRESSION_MAP: Record<PetAction, string[]> = {
  idle: ['neutral', 'Normal'],
  happy: ['smile', 'Smile', 'happy', 'F01'],
  think: ['think', 'serious', 'F02'],
  alert: ['surprised', 'shock', 'F03'],
  sleep: ['sleep', 'F04'],
  shy: ['blush', 'shy', 'F05'],
  wave: ['smile', 'happy'],
};

/**
 * Live2D（Cubism 4）渲染器，由主包按需加载。
 * Cubism Core 版权归 Live2D 所有，因此由用户自行提供、运行时注入。
 */
export async function create(context: RendererContext): Promise<PetRendererHandle> {
  const { Live2DModel } = await import('pixi-live2d-display/cubism4');
  Live2DModel.registerTicker(PIXI.Ticker);

  const app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    resizeTo: context.container,
  });

  const view = app.view as unknown as HTMLCanvasElement;
  view.className = 'pet-canvas';
  context.container.appendChild(view);

  const model = await Live2DModel.from(context.assets.live2dModelUri!, {
    autoInteract: false,
    autoUpdate: true,
  });
  app.stage.addChild(model);

  let scale = context.scale;
  let baseX = 0;
  let baseY = 0;
  let pulse: { kind: PetAction; elapsed: number } | undefined;

  const fit = () => {
    const width = app.screen.width;
    const height = app.screen.height;
    const base = Math.min(width / model.internalModel.width, height / model.internalModel.height) * 0.94;
    const finalScale = base * scale;
    baseX = (width - model.internalModel.width * finalScale) / 2;
    baseY = height - model.internalModel.height * finalScale;
    model.scale.set(finalScale);
    model.x = baseX;
    model.y = baseY;
  };
  fit();

  // 动作组 / 表情名：不同模型命名差异很大，这里全部收集后按候选列表匹配
  const motionGroups = new Set(Object.keys(model.internalModel.motionManager?.definitions ?? {}));
  const expressionNames = new Set<string>();
  const expressionManager = (model.internalModel as unknown as {
    expressionManager?: { definitions?: Array<{ Name?: string; name?: string }> };
  }).expressionManager;
  for (const definition of expressionManager?.definitions ?? []) {
    const name = definition?.Name ?? definition?.name;
    if (typeof name === 'string') {
      expressionNames.add(name);
    }
  }

  let expressionTimer: number | undefined;
  const applyExpression = (action: PetAction) => {
    for (const name of EXPRESSION_MAP[action] ?? []) {
      if (!expressionNames.has(name)) {
        continue;
      }
      try {
        model.expression(name);
        break;
      } catch {
        // 模型没有该表情，忽略
      }
    }
    if (expressionTimer) {
      window.clearTimeout(expressionTimer);
    }
    if (action !== 'idle' && action !== 'sleep') {
      expressionTimer = window.setTimeout(() => {
        try {
          model.expression();
        } catch {
          // ignore
        }
      }, 2600);
    }
  };

  // 呼吸 + 动作兜底：即使模型没有对应 motion，也能看出反应
  const ticker = () => {
    const now = performance.now() / 1000;
    let offsetX = 0;
    let offsetY = 0;
    let rotation = Math.sin(now * 0.9) * 0.012;

    if (pulse) {
      pulse.elapsed += app.ticker.deltaMS / 1000;
      const progress = pulse.elapsed;
      const damp = Math.exp(-progress * 4);
      switch (pulse.kind) {
        case 'happy':
        case 'wave':
          offsetY = Math.sin(progress * 18) * 6 * damp;
          rotation += Math.sin(progress * 14) * 0.06 * damp;
          break;
        case 'alert':
          offsetX = Math.sin(progress * 40) * 7 * damp;
          break;
        case 'think':
          rotation = 0.06 * Math.min(1, progress * 4);
          break;
        case 'shy':
          rotation = -0.05 * Math.min(1, progress * 3);
          break;
        default:
          break;
      }
      if (progress > 1.8) {
        pulse = undefined;
      }
    }

    model.x = baseX + offsetX;
    model.y = baseY + offsetY;
    model.rotation = rotation;
  };
  app.ticker.add(ticker);

  return {
    play(action: PetAction) {
      if (action !== 'idle') {
        pulse = { kind: action, elapsed: 0 };
      } else {
        pulse = undefined;
      }
      applyExpression(action);

      for (const group of MOTION_MAP[action] ?? []) {
        if (!motionGroups.has(group)) {
          continue;
        }
        try {
          model.motion(group, 0);
          return;
        } catch {
          // 换下一个动作组
        }
      }
    },
    setScale(next: number) {
      scale = next;
      fit();
    },
    resize() {
      app.renderer.resize(context.container.clientWidth, context.container.clientHeight);
      fit();
    },
    destroy() {
      if (expressionTimer) {
        window.clearTimeout(expressionTimer);
      }
      app.ticker.remove(ticker);
      app.destroy(true, { children: true, texture: true, baseTexture: true });
      view.remove();
    },
  };
}
