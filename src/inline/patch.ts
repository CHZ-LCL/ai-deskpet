/**
 * 补丁应用前的“新鲜度”判断：用户看建议期间可能改过代码，
 * 一旦选区内容变了就拒绝应用，避免覆盖。
 */
export function isPatchStale(currentText: string, originalText: string): boolean {
  return currentText !== originalText;
}
