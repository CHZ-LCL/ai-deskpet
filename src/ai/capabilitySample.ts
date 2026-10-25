/** 模型“整文件改写能力”的测试样本与判定（纯函数，便于单测）。 */

export const CAPABILITY_SAMPLE = [
  '// DESKPET_CAPABILITY_MARKER',
  'export function sum(values: number[]): number {',
  '  let total = 0;',
  '  for (let i = 0; i <= values.length; i++) {',
  '    total += values[i] ?? 0;',
  '  }',
  '  return total;',
  '}',
  '',
].join('\n');

export interface CapabilityVerdict {
  ok: boolean;
  code: string;
  reason: string;
}

/**
 * 判断模型是否“按整文件”完成了修复：
 * 必须有代码块、保留标记注释与原函数、修掉越界、且没有明显截断。
 */
export function validateFullFileReply(original: string, reply: string): CapabilityVerdict {
  const match = /```[\w+#.-]*\s*\n([\s\S]*?)```/.exec(reply);
  const code = (match?.[1] ?? '').trim();

  if (!code) {
    return { ok: false, code: '', reason: '没有返回代码块' };
  }
  if (!code.includes('DESKPET_CAPABILITY_MARKER')) {
    return { ok: false, code, reason: '丢失了标记注释，说明不是完整文件' };
  }
  if (!/export function sum\s*\(/.test(code)) {
    return { ok: false, code, reason: '丢失了原有函数' };
  }
  if (!/i\s*<\s*values\.length/.test(code)) {
    return { ok: false, code, reason: '没有修掉循环越界' };
  }
  if (code.length < original.length * 0.8) {
    return { ok: false, code, reason: '输出明显被截断' };
  }
  return { ok: true, code, reason: '通过' };
}
