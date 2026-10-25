import type { PetAssets, SoundSlot } from '../shared/protocol';
import { L, getLanguage } from './i18n';

const SYNTH_PATTERNS: Record<SoundSlot, { freqs: number[]; type: OscillatorType; duration: number }> = {
  click: { freqs: [880, 1180], type: 'sine', duration: 0.09 },
  happy: { freqs: [660, 880, 1180], type: 'triangle', duration: 0.11 },
  alert: { freqs: [520, 392], type: 'square', duration: 0.13 },
  error: { freqs: [240, 180], type: 'sawtooth', duration: 0.18 },
  switch: { freqs: [520, 780, 1040], type: 'sine', duration: 0.09 },
};

/** 音效 + 语音合成。用户导入的音效优先，没有就用 WebAudio 合成。 */
export class AudioKit {
  private context?: AudioContext;
  private volume = 0.6;
  private sounds: Partial<Record<SoundSlot, string>> = {};
  private cache = new Map<string, HTMLAudioElement>();

  configure(volume: number, assets: PetAssets): void {
    this.volume = clamp(volume, 0, 1);
    this.sounds = assets.sounds ?? {};
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
  }

  play(slot: SoundSlot): void {
    const url = this.sounds[slot];
    if (url) {
      try {
        let audio = this.cache.get(url);
        if (!audio) {
          audio = new Audio(url);
          audio.preload = 'auto';
          this.cache.set(url, audio);
        }
        audio.volume = this.volume;
        audio.currentTime = 0;
        void audio.play().catch(() => this.synth(slot));
        return;
      } catch {
        // 落到合成音
      }
    }
    this.synth(slot);
  }

  speak(text: string, rate: number): void {
    if (!('speechSynthesis' in window)) {
      return;
    }
    const cleaned = cleanForSpeech(text);
    if (!cleaned) {
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleaned);
    utterance.rate = clamp(rate, 0.5, 2);
    utterance.pitch = 1.08;
    const english = getLanguage() === 'en';
    utterance.lang = english ? 'en-US' : 'zh-CN';
    const voice = pickVoice(english);
    if (voice) {
      utterance.voice = voice;
    }
    window.speechSynthesis.speak(utterance);
  }

  stopSpeaking(): void {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  private synth(slot: SoundSlot): void {
    const pattern = SYNTH_PATTERNS[slot];
    const context = this.ensureContext();
    if (!context || !pattern) {
      return;
    }
    const now = context.currentTime;
    pattern.freqs.forEach((freq, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = pattern.type;
      oscillator.frequency.value = freq;
      const start = now + index * pattern.duration * 0.75;
      const peak = this.volume * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + pattern.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + pattern.duration + 0.02);
    });
  }

  private ensureContext(): AudioContext | undefined {
    if (!('AudioContext' in window) && !('webkitAudioContext' in window)) {
      return undefined;
    }
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctor();
    }
    if (this.context.state === 'suspended') {
      void this.context.resume();
    }
    return this.context;
  }
}

function pickVoice(english: boolean): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const prefix = english ? 'en' : 'zh';
  const preferred = english ? /aria|jenny|samantha|natural|female/i : /xiaoxiao|ting|yaoyao|female/i;
  return (
    voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix) && preferred.test(voice.name)) ??
    voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix))
  );
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, L('，代码块，', ', code block, '))
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, L('链接', 'link'))
    .replace(/[#>*_~|-]{1,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 320);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
