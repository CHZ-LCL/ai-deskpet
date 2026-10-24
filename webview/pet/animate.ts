import type { PetAction } from '../../shared/protocol';
import type { PetRendererHandle, RendererContext } from '../types';

/**
 * 动作类名 + 自动回落，供内置形象和图片形象共用。
 * 加类前先强制一次重排，保证连续点击也能重新播放动画。
 */
export function playActionClass(root: HTMLElement, action: PetAction, duration = 2400): void {
  const classes = ['is-happy', 'is-think', 'is-alert', 'is-sleep', 'is-shy', 'is-wave'];
  root.classList.remove(...classes);
  if (action === 'idle') {
    return;
  }
  void root.offsetWidth;
  root.classList.add(`is-${action}`);
  if (action === 'sleep') {
    return;
  }
  window.setTimeout(() => {
    root.classList.remove(`is-${action}`);
  }, duration);
}

export function applyScale(element: HTMLElement, scale: number): void {
  element.style.setProperty('--pet-scale', String(clamp(scale, 0.3, 3)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type { PetRendererHandle, RendererContext };
