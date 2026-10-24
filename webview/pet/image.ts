import type { PetAction } from '../../shared/protocol';
import type { PetRendererHandle, RendererContext } from '../types';
import { applyScale, playActionClass } from './animate';

/**
 * 单张图片 / GIF 形象。动作通过外层容器的 CSS 动画实现，不会破坏原图。
 */
export async function createImageRenderer(context: RendererContext): Promise<PetRendererHandle> {
  const root = document.createElement('div');
  root.className = 'image-pet pet-figure';

  const image = document.createElement('img');
  image.className = 'pet-image';
  image.draggable = false;
  image.alt = '桌宠形象';
  image.src = context.assets.imageUri ?? '';
  root.appendChild(image);
  context.container.appendChild(root);
  applyScale(root, context.scale);

  // 横版 / 竖版图片用各自的宽高比撑开外框，否则宽图会被压成一条细带
  const block = context.container.parentElement;

  await new Promise<void>((resolve, reject) => {
    if (image.complete) {
      if (image.naturalWidth > 0) {
        resolve();
      } else {
        reject(new Error('默认形象图片加载失败，已回退到内置形象。'));
      }
      return;
    }
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener(
      'error',
      () => reject(new Error('默认形象图片加载失败，已回退到内置形象。')),
      { once: true },
    );
  });

  if (block && image.naturalWidth > 0 && image.naturalHeight > 0) {
    const ratio = image.naturalWidth / image.naturalHeight;
    block.style.setProperty('--pet-aspect', ratio.toFixed(3));
    block.style.width =
      ratio >= 1.25 ? 'min(96%, 392px)' : ratio <= 0.8 ? 'min(76%, 268px)' : 'min(86%, 292px)';
    document.body.classList.toggle('pet-wide', ratio >= 1.6);
  }

  return {
    play(action: PetAction) {
      playActionClass(root, action);
    },
    setScale(scale: number) {
      applyScale(root, scale);
    },
    resize() {
      // CSS 自适应
    },
    destroy() {
      root.remove();
      if (block) {
        block.style.removeProperty('--pet-aspect');
        block.style.width = '';
      }
    },
  };
}
