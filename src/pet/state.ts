import * as vscode from 'vscode';
import type { PetAction, PetSnapshot } from '../../shared/protocol';

interface StoredStats {
  affection: number;
  clicks: number;
  chats: number;
  firstSeen: number;
  lastTouched?: number;
}

const KEY = 'deskpet.stats.v1';

/**
 * 桌宠的长期状态（好感度、互动次数）。心情是瞬时状态，不落盘。
 */
export class PetState {
  private stats: StoredStats;
  private mood: PetAction = 'idle';

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = this.context.globalState.get<StoredStats>(KEY);
    this.stats = stored ?? {
      affection: 0,
      clicks: 0,
      chats: 0,
      firstSeen: Date.now(),
    };
  }

  get currentMood(): PetAction {
    return this.mood;
  }

  setMood(mood: PetAction): void {
    this.mood = mood;
  }

  addAffection(delta: number): void {
    const next = Math.max(0, Math.min(9999, this.stats.affection + delta));
    if (next === this.stats.affection) {
      return;
    }
    this.stats.affection = next;
    this.stats.lastTouched = Date.now();
    void this.persist();
  }

  recordClick(): void {
    this.stats.clicks += 1;
    this.stats.lastTouched = Date.now();
    void this.persist();
  }

  recordChat(): void {
    this.stats.chats += 1;
    this.stats.lastTouched = Date.now();
    void this.persist();
  }

  async reset(): Promise<void> {
    this.stats = { affection: 0, clicks: 0, chats: 0, firstSeen: Date.now() };
    await this.persist();
  }

  snapshot(): PetSnapshot {
    const days = Math.max(1, Math.ceil((Date.now() - this.stats.firstSeen) / 86_400_000));
    return {
      affection: this.stats.affection,
      level: levelOf(this.stats.affection),
      mood: this.mood,
      totalClicks: this.stats.clicks,
      totalChats: this.stats.chats,
      daysTogether: days,
    };
  }

  private async persist(): Promise<void> {
    await this.context.globalState.update(KEY, this.stats);
  }
}

/** 每 100 点好感升一级，升一级解锁一句新的台词。 */
export function levelOf(affection: number): number {
  return Math.max(1, Math.min(99, 1 + Math.floor(affection / 100)));
}

interface StoredStatsWithTouch extends StoredStats {
  lastTouched?: number;
}
