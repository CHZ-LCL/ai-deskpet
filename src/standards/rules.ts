import * as vscode from 'vscode';
import { isEnglish, L } from '../i18n';

export type Severity = 'high' | 'medium' | 'low';

export type PackId = 'js-modern' | 'ts-strict' | 'react' | 'python-modern' | 'security' | 'consistency';

export interface PackDefinition {
  id: PackId;
  label: string;
  description: string;
  labelEn: string;
  descriptionEn: string;
}

export const PACKS: PackDefinition[] = [
  {
    id: 'js-modern',
    label: 'JS/TS 现代语法',
    description: 'var→const/let、===、includes、模板字符串、展开语法、async/await',
    labelEn: 'Modern JS/TS syntax',
    descriptionEn: 'var→const/let, ===, includes, template literals, spread, async/await',
  },
  {
    id: 'ts-strict',
    label: 'TypeScript 严格模式',
    description: '少用 any、@ts-expect-error 必须写原因、优先联合类型而不是 enum',
    labelEn: 'Strict TypeScript',
    descriptionEn: 'Avoid any; explain @ts-expect-error; prefer unions over enums',
  },
  {
    id: 'react',
    label: 'React 最佳实践',
    description: 'key、依赖数组、内联函数、dangerouslySetInnerHTML',
    labelEn: 'React best practices',
    descriptionEn: 'keys, dependency arrays, inline functions, dangerouslySetInnerHTML',
  },
  {
    id: 'python-modern',
    label: 'Python 现代写法',
    description: 'f-string、enumerate、with open、避免裸 except 与可变默认参数',
    labelEn: 'Modern Python',
    descriptionEn: 'f-strings, enumerate, with open, no bare except or mutable defaults',
  },
  {
    id: 'security',
    label: '安全基线',
    description: 'eval、innerHTML、命令注入、硬编码密钥、明文 HTTP、SQL 拼接',
    labelEn: 'Security baseline',
    descriptionEn: 'eval, innerHTML, command injection, hardcoded secrets, plain HTTP, SQL concatenation',
  },
  {
    id: 'consistency',
    label: '风格一致性',
    description: '按项目现有缩进、引号、分号与命名习惯生成代码',
    labelEn: 'Style consistency',
    descriptionEn: 'Follow the project’s existing indentation, quotes, semicolons, and naming',
  },
];

export const DEFAULT_PACKS: PackId[] = ['js-modern', 'security', 'consistency'];

export interface CustomRule {
  id: string;
  title: string;
  severity?: Severity;
  guidance: string;
  languages?: string[];
}

export interface WhitelistEntry {
  rule: string;
  glob?: string;
  reason?: string;
}

export interface StandardsConfig {
  packs: PackId[];
  custom: CustomRule[];
  whitelist: WhitelistEntry[];
}

export interface StyleProfile {
  indent: string;
  quotes: 'single' | 'double' | 'either';
  semicolons: 'always' | 'never' | 'either';
}

export function readStandardsConfig(): StandardsConfig {
  const config = vscode.workspace.getConfiguration('deskpet');
  const rawPacks = config.get<string[]>('standards.packs', DEFAULT_PACKS);
  const valid = new Set(PACKS.map((pack) => pack.id));
  const packs = rawPacks.filter((item): item is PackId => valid.has(item as PackId));

  return {
    packs: packs.length ? packs : DEFAULT_PACKS,
    custom: sanitizeCustom(config.get<CustomRule[]>('standards.custom', [])),
    whitelist: sanitizeWhitelist(config.get<WhitelistEntry[]>('standards.whitelist', [])),
  };
}

/** 设置面板可能被手改成奇怪的形状，这里做一次兜底。 */
function sanitizeCustom(input: unknown): CustomRule[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item): item is CustomRule => Boolean(item) && typeof (item as CustomRule).id === 'string')
    .slice(0, 40)
    .map((item) => ({
      id: item.id.trim(),
      title: String(item.title ?? item.id).slice(0, 120),
      severity: item.severity === 'high' || item.severity === 'low' ? item.severity : 'medium',
      guidance: String(item.guidance ?? '').slice(0, 400),
      languages: Array.isArray(item.languages) ? item.languages.map(String).slice(0, 10) : undefined,
    }));
}

function sanitizeWhitelist(input: unknown): WhitelistEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter((item): item is WhitelistEntry => Boolean(item) && typeof (item as WhitelistEntry).rule === 'string')
    .slice(0, 100)
    .map((item) => ({
      rule: item.rule.trim(),
      glob: item.glob ? String(item.glob).slice(0, 200) : undefined,
      reason: item.reason ? String(item.reason).slice(0, 160) : undefined,
    }));
}

/** 规范块会被拼进每次代码生成请求，控制篇幅，只保留能指导生成的内容。 */
export function standardsBlock(
  conventions: string[],
  style: StyleProfile,
  options: { compact?: boolean } = {},
): string {
  const config = readStandardsConfig();
  const enabled = PACKS.filter((pack) => config.packs.includes(pack.id));
  const english = isEnglish();
  const lines: string[] = [
    L('## 团队规范（生成代码必须遵守）', '## Team standards (must follow when generating code)'),
  ];

  const quotes =
    style.quotes === 'either'
      ? L('引号跟随现有代码', 'quotes follow existing code')
      : style.quotes === 'single'
        ? L('单引号', 'single quotes')
        : L('双引号', 'double quotes');
  const semicolons =
    style.semicolons === 'either'
      ? L('分号跟随现有代码', 'semicolons follow existing code')
      : style.semicolons === 'always'
        ? L('语句结尾加分号', 'terminate statements with semicolons')
        : L('不加分号', 'no semicolons');
  lines.push(
    L(
      `编码风格：${style.indent} 缩进；${quotes}；${semicolons}。`,
      `Code style: ${style.indent} indentation; ${quotes}; ${semicolons}.`,
    ),
  );

  const useful = conventions
    .filter((line) => /文件名|测试文件|语言分布|依赖线索|File names|Test files|Languages|Dependency/.test(line))
    .slice(0, 4);
  if (useful.length) {
    lines.push(
      L(
        `项目约定：${useful.map((line) => line.replace(/^-\s*/, '')).join('；')}。`,
        `Project conventions: ${useful.map((line) => line.replace(/^-\s*/, '')).join('; ')}.`,
      ),
    );
  }

  if (enabled.length) {
    const list = enabled
      .map((pack) => {
        const label = english ? pack.labelEn : pack.label;
        const description = english ? pack.descriptionEn : pack.description;
        return english ? `${label} (${description})` : `${label}（${description}）`;
      })
      .join(english ? '; ' : '；');
    lines.push(L(`启用规则包：${list}。`, `Enabled rule packs: ${list}.`));
  }

  if (config.custom.length && !options.compact) {
    lines.push(L('团队自定义规则：', 'Custom team rules:'));
    for (const rule of config.custom.slice(0, 8)) {
      lines.push(`- ${rule.id}（${rule.severity}）：${rule.guidance || rule.title}`);
    }
  }

  if (config.whitelist.length && !options.compact) {
    const entries = config.whitelist.slice(0, 5).map((item) => `${item.rule}${item.glob ? ` @ ${item.glob}` : ''}`);
    lines.push(
      L(
        `白名单（这些规则在这些位置允许出现，不要报错也不要“修复”）：${entries.join('；')}。`,
        `Whitelist (allowed in these locations; do not report or “fix”): ${entries.join('; ')}.`,
      ),
    );
  }

  lines.push(
    L(
      '生成代码必须直接符合以上规范；若某条规则与当前上下文冲突，在【影响】里说明原因并选择更安全的一侧。',
      'Generated code must follow the standards above. If a rule conflicts with the current context, explain why in 【影响】 and choose the safer option.',
    ),
  );
  return lines.join('\n');
}

/** 极简 glob：支持双星号、星号、问号；开头的双星号也能匹配根目录。 */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let pattern = '';
  let index = 0;

  while (index < normalized.length) {
    const char = normalized[index];

    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 3;
          continue;
        }
        pattern += '.*';
        index += 2;
        continue;
      }
      pattern += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      pattern += '.';
      index += 1;
      continue;
    }

    if ('\\^$+.()|{}[]'.includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
    index += 1;
  }

  return new RegExp(`^${pattern}$`);
}

export function isWhitelisted(ruleId: string, filePath: string, whitelist: WhitelistEntry[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return whitelist.some((entry) => {
    const ruleMatches = entry.rule === ruleId || (entry.rule.endsWith('.*') && ruleId.startsWith(entry.rule.slice(0, -1)));
    if (!ruleMatches) {
      return false;
    }
    if (!entry.glob) {
      return true;
    }
    try {
      return globToRegExp(entry.glob).test(normalized);
    } catch {
      return false;
    }
  });
}
