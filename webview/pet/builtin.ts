import type { PetAction } from '../../shared/protocol';
import type { PetRendererHandle, RendererContext } from '../types';
import { applyScale, playActionClass } from './animate';

/**
 * 内置形象：纯 SVG + CSS 动画，不依赖任何外部素材。
 * 用户提供默认立绘/模型后，这里仍然保留作为兜底。
 */
const SVG = `
<svg class="pet-svg" viewBox="0 0 240 268" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="桌宠">
  <defs>
    <linearGradient id="dpBody" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="#a8f3e2"/>
      <stop offset="52%" stop-color="#6fddc4"/>
      <stop offset="100%" stop-color="#3fb99f"/>
    </linearGradient>
    <linearGradient id="dpBelly" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fffdf6"/>
      <stop offset="100%" stop-color="#e6f7f1"/>
    </linearGradient>
    <linearGradient id="dpEar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8aebd6"/>
      <stop offset="100%" stop-color="#59cdb4"/>
    </linearGradient>
    <radialGradient id="dpAura" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#6ff0d8" stop-opacity="0.45"/>
      <stop offset="70%" stop-color="#6ff0d8" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#6ff0d8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="dpStar" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#fff6c9"/>
      <stop offset="100%" stop-color="#ffd76a"/>
    </radialGradient>
  </defs>

  <ellipse class="pet-aura" cx="120" cy="152" rx="112" ry="108" fill="url(#dpAura)"/>
  <ellipse class="pet-shadow" cx="120" cy="246" rx="58" ry="9" fill="#0c3a33" opacity="0.16"/>

  <g class="pet-antenna">
    <path d="M120 40 C124 20 132 12 142 8" fill="none" stroke="#3fb99f" stroke-width="5" stroke-linecap="round"/>
    <circle class="pet-antenna-light" cx="144" cy="7" r="8" fill="url(#dpStar)"/>
  </g>

  <g class="pet-tail">
    <path d="M196 200 C226 198 232 176 220 162" fill="none" stroke="#4ec4ab" stroke-width="13" stroke-linecap="round"/>
  </g>

  <g class="pet-body">
    <path d="M62 96 C66 54 92 30 120 30 C148 30 174 54 178 96 L180 176 C182 214 154 238 120 238 C86 238 58 214 60 176 Z" fill="url(#dpBody)"/>

    <path d="M60 86 C48 60 50 40 66 38 C80 36 92 54 96 72 Z" fill="url(#dpEar)"/>
    <path d="M180 86 C192 60 190 40 174 38 C160 36 148 54 144 72 Z" fill="url(#dpEar)"/>

    <ellipse cx="120" cy="204" rx="44" ry="30" fill="url(#dpBelly)" opacity="0.94"/>

    <ellipse class="pet-cheek" cx="74" cy="148" rx="13" ry="8" fill="#ff8fae" opacity="0.4"/>
    <ellipse class="pet-cheek" cx="166" cy="148" rx="13" ry="8" fill="#ff8fae" opacity="0.4"/>

    <g class="pet-face">
      <ellipse class="pet-eye" cx="93" cy="124" rx="11" ry="14" fill="#123c38"/>
      <ellipse class="pet-eye" cx="147" cy="124" rx="11" ry="14" fill="#123c38"/>
      <circle cx="97" cy="119" r="4.2" fill="#ffffff" opacity="0.95"/>
      <circle cx="151" cy="119" r="4.2" fill="#ffffff" opacity="0.95"/>
      <circle cx="89" cy="129" r="1.8" fill="#ffffff" opacity="0.55"/>
      <circle cx="143" cy="129" r="1.8" fill="#ffffff" opacity="0.55"/>
      <path class="pet-mouth" d="M110 150 Q120 160 130 150" fill="none" stroke="#123c38" stroke-width="4" stroke-linecap="round"/>
    </g>

    <ellipse class="pet-arm pet-arm-left" cx="48" cy="176" rx="13" ry="20" fill="#5ed3ba" transform="rotate(-18 48 176)"/>
    <ellipse class="pet-arm pet-arm-right" cx="192" cy="176" rx="13" ry="20" fill="#5ed3ba" transform="rotate(18 192 176)"/>
  </g>

  <g class="pet-zzz">
    <text x="186" y="104" font-size="18" fill="#8fd9c9" font-family="system-ui">z</text>
    <text x="200" y="84" font-size="24" fill="#8fd9c9" font-family="system-ui">z</text>
  </g>
</svg>`;

export async function createBuiltinRenderer(context: RendererContext): Promise<PetRendererHandle> {
  const root = document.createElement('div');
  root.className = 'builtin-pet pet-figure';
  root.innerHTML = SVG;
  context.container.appendChild(root);
  applyScale(root, context.scale);

  return {
    play(action: PetAction) {
      playActionClass(root, action);
    },
    setScale(scale: number) {
      applyScale(root, scale);
    },
    resize() {
      // SVG 自适应，无需处理
    },
    destroy() {
      root.remove();
    },
  };
}
