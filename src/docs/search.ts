import * as vscode from 'vscode';
import { htmlToText, normalizeUrl, truncate } from '../util';

export interface DocSource {
  title: string;
  url: string;
  text: string;
}

export const DOCS_KEY_SECRET = 'deskpet.docsKey';

interface TavilyResult {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

interface SerperResult {
  organic?: Array<{ title?: string; link?: string; snippet?: string }>;
}

/**
 * 资料查询：联网搜索（可选）→ 抓取正文 → 交给模型总结。
 * 没有配置搜索服务时，直接把用户输入的网址抓下来；用户只输入关键词时返回 undefined，由宿主降级为“凭知识回答”。
 */
export async function gatherSources(
  context: vscode.ExtensionContext,
  query: string,
  token: vscode.CancellationToken,
): Promise<{ sources: DocSource[]; searched: boolean }> {
  const directUrl = normalizeUrl(query);
  if (directUrl) {
    const page = await fetchPage(directUrl, token);
    return { sources: page ? [page] : [], searched: false };
  }

  const config = vscode.workspace.getConfiguration('deskpet');
  const provider = config.get<string>('docs.searchProvider', 'none');
  const key = await context.secrets.get(DOCS_KEY_SECRET);
  if (provider === 'none' || !key) {
    return { sources: [], searched: false };
  }

  let hits: Array<{ title: string; url: string; snippet: string }> = [];
  try {
    hits = provider === 'tavily' ? await tavilySearch(query, key) : await serperSearch(query, key);
  } catch (error) {
    void vscode.window.showWarningMessage(
      `资料搜索失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return { sources: [], searched: true };
  }

  const sources: DocSource[] = [];
  for (const hit of hits.slice(0, 3)) {
    if (token.isCancellationRequested) {
      break;
    }
    const page = await fetchPage(hit.url, token);
    if (page) {
      sources.push({ ...page, title: hit.title || page.title });
    } else {
      sources.push({ title: hit.title, url: hit.url, text: hit.snippet });
    }
  }
  return { sources, searched: true };
}

async function tavilySearch(query: string, key: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: 5, search_depth: 'basic' }),
  });
  if (!response.ok) {
    throw new Error(`Tavily ${response.status}`);
  }
  const json = (await response.json()) as TavilyResult;
  return (json.results ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.url ?? '',
    snippet: item.content ?? '',
  }));
}

async function serperSearch(query: string, key: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: 5 }),
  });
  if (!response.ok) {
    throw new Error(`Serper ${response.status}`);
  }
  const json = (await response.json()) as SerperResult;
  return (json.organic ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.link ?? '',
    snippet: item.snippet ?? '',
  }));
}

async function fetchPage(url: string, token: vscode.CancellationToken): Promise<DocSource | undefined> {
  if (!/^https?:\/\//i.test(url)) {
    return undefined;
  }
  const controller = new AbortController();
  const sub = token.onCancellationRequested(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DeskPet-VSCode/0.1; +https://github.com/)',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!response.ok) {
      return undefined;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/json|text\/markdown/i.test(contentType)) {
      return { title: url, url, text: `（该资源类型 ${contentType} 无法解析为文本）` };
    }
    const raw = await response.text();
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    return {
      title: titleMatch ? htmlToText(titleMatch[1]).trim() : url,
      url,
      text: truncate(htmlToText(raw), 7000),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    sub.dispose();
  }
}
