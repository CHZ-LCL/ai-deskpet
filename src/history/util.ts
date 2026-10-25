/** 历史与“整文件重写”判断的纯函数，便于单测。 */

export interface DatedItem {
  at: number;
}

/** 按时间倒序保留最近 limit 条。 */
export function trimHistory<T extends DatedItem>(items: T[], limit: number): T[] {
  return [...items].sort((left, right) => right.at - left.at).slice(0, Math.max(0, limit));
}

/**
 * 判断模型返回的是不是“完整文件”：
 * - 不能为空，也不能基本没变；
 * - 长度不能缩水到一半以下（防止只返回一个片段）；
 * - 原文件有模块级语法时，输出也必须保留。
 */
export function isFullFileRewrite(original: string, candidate: string): boolean {
  const before = original.trim();
  const after = candidate.trim();
  if (!after || before === after) {
    return false;
  }
  if (after.length < before.length * 0.5) {
    return false;
  }

  const markers = [
    /^\s*(?:import|export)\b/m,
    /\brequire\s*\(/,
    /^\s*(?:def|class)\s/m,
    /^\s*func\s/m,
    /^\s*(?:public|private|protected)\s/m,
    /^\s*#include\b/m,
  ];

  for (const marker of markers) {
    if (marker.test(before) && !marker.test(after)) {
      return false;
    }
  }

  // 顶层声明的名字必须全部保留，防止模型顺手删掉整个类/函数
  const declaration = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|enum|type|def|func|struct|module)\s+([A-Za-z_$][\w$]*)/gm;
  const afterNames = new Set([...after.matchAll(declaration)].map((match) => match[1]));
  for (const match of before.matchAll(declaration)) {
    if (!afterNames.has(match[1])) {
      return false;
    }
  }

  return true;
}
