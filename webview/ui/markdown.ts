import { escapeHtml } from '../util';

/**
 * 极简 Markdown 渲染：只支持对话里真正会出现的语法。
 * 先转义再拼标签，链接只允许 http(s)，避免模型输出变成 XSS。
 */
export function renderMarkdown(source: string): string {
  const segments = source.split(/^```/m);
  let html = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index % 2 === 1) {
      const newline = segment.indexOf('\n');
      const lang = newline >= 0 ? segment.slice(0, newline).trim() : '';
      const code = (newline >= 0 ? segment.slice(newline + 1) : segment).replace(/\n$/, '');
      html += codeBlock(code, lang);
    } else {
      html += renderBlocks(segment);
    }
  }
  return html;
}

function codeBlock(code: string, lang: string): string {
  const encoded = encodeURIComponent(code);
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(lang || 'text')}</span><button class="copy-btn" data-code="${encoded}" title="复制代码">复制</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function renderBlocks(text: string): string {
  const lines = text.split('\n');
  let html = '';
  let paragraph: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | undefined;

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    html += `<p>${inline(paragraph.join(' '))}</p>`;
    paragraph = [];
  };
  const flushList = () => {
    if (!list) {
      return;
    }
    const tag = list.type;
    html += `<${tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`;
    list = undefined;
  };
  const breakBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      breakBlocks();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      breakBlocks();
      const level = Math.min(4, heading[1].length + 2);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      breakBlocks();
      html += '<hr />';
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (list?.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (list?.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      breakBlocks();
      html += `<blockquote>${inline(quote[1])}</blockquote>`;
      continue;
    }

    paragraph.push(line);
  }

  breakBlocks();
  return html;
}

function inline(text: string): string {
  const codes: string[] = [];
  let html = escapeHtml(text);

  html = html.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');

  html = html.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)]}</code>`);
  return html;
}
