/**
 * webview 侧文案入口。字典放在 shared/i18n.ts，扩展宿主渲染首屏 HTML 时复用同一份，
 * 避免英文界面先闪一下中文。
 */
export { L, setLanguage, getLanguage, englishDictionary } from '../shared/i18n';
export type { Lang } from '../shared/i18n';
