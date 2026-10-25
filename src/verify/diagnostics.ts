/** 修改后验证的纯逻辑：诊断快照对比与分类。 */
import { L } from '../i18n';

export type DiagSeverity = 'error' | 'warning' | 'info';

export interface DiagItem {
  /** 相对路径，用于跨文件对比与展示 */
  file?: string;
  line: number;
  severity: DiagSeverity;
  code: string;
  message: string;
  source?: string;
}

export function keyOf(item: DiagItem): string {
  return `${item.file ?? ''}|${item.line}|${item.code}|${item.message}`;
}

export interface DiagDiff {
  introduced: DiagItem[];
  fixed: DiagItem[];
  remaining: DiagItem[];
}

/** 以“文件+行+错误码+消息”为键，找出修改后**新出现**的错误。 */
export function diffDiagnostics(before: DiagItem[], after: DiagItem[]): DiagDiff {
  const beforeKeys = new Set(before.map(keyOf));
  const afterKeys = new Set(after.map(keyOf));
  return {
    introduced: after.filter((item) => !beforeKeys.has(keyOf(item))),
    fixed: before.filter((item) => !afterKeys.has(keyOf(item))),
    remaining: after,
  };
}

export type DiagCategory = 'module' | 'type' | 'variable' | 'other';

const CATEGORY_LABELS: Record<DiagCategory, string> = {
  module: '模块/名称解析',
  type: '类型不匹配',
  variable: '变量/未使用',
  other: '其它',
};

const CATEGORY_LABELS_EN: Record<DiagCategory, string> = {
  module: 'module/name resolution',
  type: 'type mismatch',
  variable: 'variable/unused',
  other: 'other',
};

export function categorize(item: DiagItem): DiagCategory {
  const text = `${item.message} ${item.code}`;

  if (
    /cannot find module|is not defined|undefined name|unresolved|has no exported member|cannot find name|module not found|no module named|import .* not found|NameError/i.test(
      text,
    )
  ) {
    return 'module';
  }
  if (
    /not assignable|incompatible type|type '.*' is not|argument of type|property .* does not exist|expected \d+ arguments|missing .* in type|TypeError/i.test(
      text,
    )
  ) {
    return 'type';
  }
  if (/never read|unused|implicitly has an 'any' type|possibly undefined|declared but|is not used/i.test(text)) {
    return 'variable';
  }
  return 'other';
}

export function summarize(items: DiagItem[]): Array<{ category: DiagCategory; label: string; count: number }> {
  const counts: Record<DiagCategory, number> = { module: 0, type: 0, variable: 0, other: 0 };
  for (const item of items) {
    counts[categorize(item)] += 1;
  }
  return (Object.keys(counts) as DiagCategory[])
    .filter((category) => counts[category] > 0)
    .map((category) => ({
      category,
      label: L(CATEGORY_LABELS[category], CATEGORY_LABELS_EN[category]),
      count: counts[category],
    }));
}

/** 用于通知和对话里的简短列表。 */
export function describeItems(items: DiagItem[], limit = 4): string {
  return items
    .slice(0, limit)
    .map((item) => `${item.file ? `${item.file}:` : ''}L${item.line} ${item.message}`)
    .join('\n');
}
