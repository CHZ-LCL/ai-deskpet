import { extractCode } from '../util';

export interface ParsedAdvice {
  problem: string;
  cause: string;
  plan: string;
  impact: string;
  code: string;
}

const KEYS = ['问题', '原因', '方案', '影响'] as const;

/**
 * 解析模型按【问题】【原因】【方案】【影响】输出的小结。
 * 容错：Markdown 标题、加粗、全角/半角冒号、行内写法都能识别；
 * 完全没按格式输出时，退化成“第一段当问题描述”，不影响应用代码。
 */
export function parseAdvice(reply: string): ParsedAdvice {
  const result: Record<(typeof KEYS)[number], string> = { 问题: '', 原因: '', 方案: '', 影响: '' };
  let current: (typeof KEYS)[number] | undefined;
  let inFence = false;

  for (const raw of reply.split('\n')) {
    const line = raw.trim();

    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const header = /^[#*\s【\[]*(问题|原因|方案|影响)[】\]*：:]?\s*$/.exec(line);
    if (header) {
      current = header[1] as (typeof KEYS)[number];
      continue;
    }

    const inline = /^[#*\s【\[]*(问题|原因|方案|影响)[】\]*：[：]\s*(.+)$/.exec(line);
    if (inline) {
      current = inline[1] as (typeof KEYS)[number];
      result[current] += `${inline[2]}\n`;
      continue;
    }

    if (!current) {
      continue;
    }
    result[current] += `${raw}\n`;
  }

  const clean = (value: string): string =>
    value
      .replace(/```[\s\S]*?```/g, '')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const { code } = extractCode(reply);
  const parsed: ParsedAdvice = {
    problem: clean(result.问题),
    cause: clean(result.原因),
    plan: clean(result.方案),
    impact: clean(result.影响),
    code,
  };

  if (!parsed.problem) {
    const prose = reply.replace(/```[\s\S]*?```/g, '').trim();
    parsed.problem = prose.split(/\n{2,}/)[0]?.slice(0, 400) ?? '';
  }

  return parsed;
}
