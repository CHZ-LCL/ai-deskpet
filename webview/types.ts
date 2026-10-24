import type { PetAction, PetAssets } from '../shared/protocol';

export interface RendererContext {
  container: HTMLElement;
  assets: PetAssets;
  scale: number;
}

export interface PetRendererHandle {
  play(action: PetAction): void;
  setScale(scale: number): void;
  resize(): void;
  destroy(): void;
}

export type RendererFactory = (context: RendererContext) => Promise<PetRendererHandle>;
