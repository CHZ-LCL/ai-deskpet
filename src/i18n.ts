import * as vscode from 'vscode';
import type { PetLanguage } from '../shared/protocol';

/**
 * 宿主侧文案。面板里的文字由 webview/i18n.ts 负责，
 * 这里只处理扩展宿主弹出的通知、气泡与提示。
 *
 * 设计成 `L(中文, 英文)` 而不是 key 表：调用处一眼能看出两种语言，
 * 漏翻时也只会退回中文，不会出现空白文案。
 */
export function resolveLanguage(): PetLanguage {
  const setting = vscode.workspace.getConfiguration('deskpet').get<string>('ui.language', 'auto');
  if (setting === 'zh' || setting === 'en') {
    return setting;
  }
  const display = (vscode.env?.language ?? 'en').toLowerCase();
  return display.startsWith('zh') ? 'zh' : 'en';
}

export function isEnglish(): boolean {
  return resolveLanguage() === 'en';
}

/** 按当前语言取文案，支持 {0} {1} 占位符。 */
export function L(zh: string, en: string, ...args: Array<string | number>): string {
  const template = isEnglish() ? en : zh;
  return args.length ? format(template, args) : template;
}

export function format(template: string, args: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}
