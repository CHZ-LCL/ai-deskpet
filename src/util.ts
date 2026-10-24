import * as crypto from 'node:crypto';
import * as path from 'node:path';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[body.toLowerCase()] ?? all;
  });
}

/** 把网页 HTML 粗略转成可读纯文本，用于喂给模型。 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6|tr|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, Math.max(0, max - 20))}\n…（内容已截断）`;
}

export function isProbablyUrl(input: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(input.trim());
}

export function normalizeUrl(input: string): string | undefined {
  const value = input.trim();
  if (!value) {
    return undefined;
  }
  if (isProbablyUrl(value)) {
    return value;
  }
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)) {
    return `https://${value}`;
  }
  return undefined;
}

export interface CodeFence {
  code: string;
  lang: string;
}

/** 从模型回复里提取第一个代码块；没有代码块时把整段当作代码。 */
export function extractCode(reply: string): CodeFence {
  const match = /```([\w+#.-]*)\s*\n([\s\S]*?)```/.exec(reply);
  if (match) {
    return { lang: match[1] || '', code: match[2].replace(/\s+$/, '\n') };
  }
  return { lang: '', code: reply.trim() };
}

export function shortenPath(filePath: string, max = 60): string {
  if (filePath.length <= max) {
    return filePath;
  }
  const parts = filePath.split(/[\\/]/);
  if (parts.length <= 2) {
    return `…${filePath.slice(-max)}`;
  }
  return `…${path.sep}${parts.slice(-3).join(path.sep)}`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let timer: NodeJS.Timeout | undefined;
  return ((...args: Parameters<T>) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), wait);
  }) as T;
}
