import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addToBm25,
  chunkLines,
  createBm25,
  scoreBm25,
  termFrequency,
  tokenize,
  type Bm25Index,
  type RawChunk,
} from './ranking';
import type { StyleProfile } from '../standards/rules';
/** 参与索引的源码/配置后缀。 */
const SOURCE_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'fs', 'cpp', 'cc', 'c', 'h', 'hpp',
  'rb', 'php', 'swift', 'scala', 'sh', 'ps1', 'sql', 'lua', 'dart', 'ex', 'exs', 'clj', 'hs',
  'zig', 'proto', 'graphql', 'gql', 'css', 'scss', 'less', 'html', 'md', 'json', 'yaml', 'yml',
  'toml', 'ini',
];

const EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/.nuxt/**,**/.output/**,' +
  '**/coverage/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/target/**,**/bin/**,**/obj/**,**/.gradle/**,' +
  '**/vendor/**,**/*.min.js,**/*.min.css,**/*.map,**/*.lock,**/package-lock.json,**/*.snap}';

const MAX_FILE_BYTES = 220 * 1024;
const MAX_CHUNK_CHARS = 1600;

interface IndexedFile {
  uri: vscode.Uri;
  languageId: string;
  imports: string[];
}

export interface BundleOptions {
  query: string;
  activeUri?: vscode.Uri;
  maxChars?: number;
  /** 是否附带 LSP 定义跳转结果 */
  includeDefinitions?: boolean;
}

/**
 * 项目级上下文：全库轻量索引（BM25）+ 模块依赖图 + 代码风格约定 + LSP 符号解析。
 * 目标是给模型一个“看得到整个项目”的视角，而不是只盯着当前选区。
 */
export class ProjectContext implements vscode.Disposable {
  private index: Bm25Index = createBm25();
  private chunks: RawChunk[] = [];
  private chunkTerms: string[][] = [];
  private deleted = new Set<number>();
  private fileChunks = new Map<string, number[]>();
  private files = new Map<string, IndexedFile>();
  private imports = new Map<string, Set<string>>();
  private importedBy = new Map<string, Set<string>>();
  private byBaseName = new Map<string, string[]>();
  private conventions: string[] = [];
  private styleHints: StyleProfile = { indent: '2 空格', quotes: 'either', semicolons: 'either' };
  private status: 'idle' | 'building' | 'ready' = 'idle';
  private task?: Promise<void>;
  private readonly statusBar: vscode.StatusBarItem;
  private stats = { files: 0, chunks: 0, chars: 0 };

  public onDidFinish?: () => void;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = 'deskpet.reindex';
    this.statusBar.tooltip = '点击重建项目索引（AI 桌宠）';
    this.statusBar.text = '$(database) 索引待建立';
    this.statusBar.show();
  }

  get ready(): boolean {
    return this.status === 'ready';
  }

  getConventions(): string[] {
    return [...this.conventions];
  }

  getStyleProfile(): StyleProfile {
    return { ...this.styleHints };
  }

  get label(): string {
    if (this.status === 'building') {
      return '索引构建中';
    }
    if (this.status !== 'ready') {
      return '未索引';
    }
    return `${this.stats.files} 文件 · ${this.stats.chunks} 块`;
  }

  dispose(): void {
    this.statusBar.dispose();
  }

  async ensureBuilt(): Promise<void> {
    if (this.status === 'ready') {
      return;
    }
    if (this.task) {
      return this.task;
    }
    this.task = this.build().finally(() => {
      this.task = undefined;
    });
    return this.task;
  }

  async rebuild(): Promise<void> {
    if (this.status === 'building' && this.task) {
      return this.task;
    }
    this.task = this.build().finally(() => {
      this.task = undefined;
    });
    return this.task;
  }

  /** 保存文件后增量更新，避免每次全量重建。 */
  async updateFile(uri: vscode.Uri): Promise<void> {
    if (this.status !== 'ready' || uri.scheme !== 'file') {
      return;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (!this.files.has(rel)) {
      const ext = path.posix.extname(rel).slice(1).toLowerCase();
      if (!SOURCE_EXTENSIONS.includes(ext)) {
        return;
      }
      // 新文件：直接补进索引；它被别人 import 的关系要等下次重建才完整
      await this.indexFile(uri, rel);
      this.resolveImportsFor(rel);
      this.statusBar.text = `$(database) ${this.label}`;
      return;
    }
    for (const id of this.fileChunks.get(rel) ?? []) {
      this.deleted.add(id);
    }
    this.fileChunks.delete(rel);
    await this.indexFile(uri, rel);
    this.resolveImportsFor(rel);
    this.statusBar.text = `$(database) ${this.label}`;
  }

  // ---------------------------------------------------------------- 建索引

  private async build(): Promise<void> {
    if (this.status === 'building') {
      return;
    }
    this.status = 'building';
    this.statusBar.text = '$(sync~spin) 建立项目索引…';

    try {
      const config = vscode.workspace.getConfiguration('deskpet');
      const maxFiles = Math.max(100, Math.min(20000, config.get<number>('context.maxFiles', 4000)));
      const glob = `**/*.{${SOURCE_EXTENSIONS.join(',')}}`;
      const uris = await vscode.workspace.findFiles(glob, EXCLUDE_GLOB, maxFiles);

      this.reset();
      let done = 0;
      const batchSize = 20;

      for (let start = 0; start < uris.length; start += batchSize) {
        const batch = uris.slice(start, start + batchSize);
        await Promise.all(batch.map((uri) => this.indexFile(uri, vscode.workspace.asRelativePath(uri, false))));
        done += batch.length;
        this.statusBar.text = `$(sync~spin) 索引 ${Math.min(done, uris.length)}/${uris.length}`;
        // 让出事件循环，避免大仓库卡住编辑器
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      for (const rel of this.files.keys()) {
        this.resolveImportsFor(rel);
      }

      this.detectConventions();
      this.status = 'ready';
      this.statusBar.text = `$(database) ${this.label}`;
      this.onDidFinish?.();
    } catch (error) {
      this.status = 'idle';
      this.statusBar.text = '$(warning) 索引失败';
      this.statusBar.tooltip = error instanceof Error ? error.message : String(error);
    }
  }

  private reset(): void {
    this.index = createBm25();
    this.chunks = [];
    this.chunkTerms = [];
    this.deleted = new Set();
    this.fileChunks.clear();
    this.files.clear();
    this.imports.clear();
    this.importedBy.clear();
    this.byBaseName.clear();
    this.stats = { files: 0, chunks: 0, chars: 0 };
  }

  private async indexFile(uri: vscode.Uri, rel: string): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (content.includes('\u0000')) {
        return;
      }
      const lineCount = Math.max(1, content.split('\n').length);
      if (content.length / lineCount > 400) {
        return; // 压缩后的产物，没有检索价值
      }

      const chunks = chunkLines(rel, content);
      if (!chunks.length) {
        return;
      }

      const ids: number[] = [];
      for (const chunk of chunks) {
        const id = this.chunks.length;
        chunk.text = chunk.text.slice(0, MAX_CHUNK_CHARS);
        this.chunks.push(chunk);
        const tokens = tokenize(`${rel} ${chunk.text}`);
        this.chunkTerms[id] = tokens;
        addToBm25(this.index, id, tokens);
        ids.push(id);
        this.stats.chars += chunk.text.length;
      }

      this.fileChunks.set(rel, ids);
      this.files.set(rel, {
        uri,
        languageId: languageIdOf(rel),
        imports: extractImports(content),
      });
      this.stats.files = this.files.size;
      this.stats.chunks = this.chunks.length;

      const base = path.posix.basename(rel, path.posix.extname(rel)).toLowerCase();
      const list = this.byBaseName.get(base) ?? [];
      list.push(rel);
      this.byBaseName.set(base, list);
    } catch {
      // 权限、编码等问题直接跳过该文件
    }
  }

  private resolveImportsFor(rel: string): void {
    const file = this.files.get(rel);
    if (!file) {
      return;
    }
    for (const spec of file.imports) {
      const target = this.resolveSpecifier(rel, spec);
      if (!target || target === rel) {
        continue;
      }
      const out = this.imports.get(rel) ?? new Set<string>();
      out.add(target);
      this.imports.set(rel, out);
      const back = this.importedBy.get(target) ?? new Set<string>();
      back.add(rel);
      this.importedBy.set(target, back);
    }
  }

  private resolveSpecifier(fromRel: string, spec: string): string | undefined {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const dir = path.posix.dirname(fromRel);
      const raw = spec.replace(/^\.\/+/, '');
      const base = path.posix.normalize(path.posix.join(dir, raw));
      const candidates = [
        base,
        `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
        `${base}.vue`, `${base}.svelte`, `${base}.py`, `${base}.go`, `${base}.rs`, `${base}.css`,
        path.posix.join(base, 'index.ts'), path.posix.join(base, 'index.js'),
        path.posix.join(base, 'index.tsx'), path.posix.join(base, '__init__.py'),
      ];
      return candidates.find((candidate) => this.files.has(candidate));
    }

    // 非相对引用：优先按文件名匹配，够用且不会误伤
    const cleaned = spec.replace(/^[^/]*?[:/]/, '');
    const base = path.posix.basename(cleaned).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const matches = this.byBaseName.get(base);
    return matches?.find((candidate) => candidate !== fromRel);
  }

  // ---------------------------------------------------------------- 检索

  async buildBundle(options: BundleOptions): Promise<string> {
    await this.ensureBuilt();
    if (this.status !== 'ready') {
      return '';
    }

    const budget = options.maxChars ?? 8000;
    const activeRel = options.activeUri ? vscode.workspace.asRelativePath(options.activeUri, false) : undefined;
    const blocks: string[] = [];

    if (activeRel && this.files.has(activeRel)) {
      const outline = await this.outline(activeRel);
      const deps = [...(this.imports.get(activeRel) ?? [])].slice(0, 8);
      const usedBy = [...(this.importedBy.get(activeRel) ?? [])].slice(0, 6);
      const lines = [`## 当前文件`, activeRel];
      if (outline.length) {
        lines.push(outline.join('\n'));
      }
      if (deps.length) {
        lines.push(`依赖：${deps.join(', ')}`);
      }
      if (usedBy.length) {
        lines.push(`被引用：${usedBy.join(', ')}`);
      }
      blocks.push(lines.join('\n'));
    }

    if (options.includeDefinitions && options.activeUri) {
      const definitions = await this.definitionSnippets(options.activeUri);
      if (definitions) {
        blocks.push(`## 相关定义\n${definitions}`);
      }
    }

    const retrieved = this.retrieve(options.query, activeRel);
    if (retrieved.length) {
      for (const item of retrieved) {
        blocks.push(
          `### ${item.chunk.file}:${item.chunk.start}-${item.chunk.end}\n\`\`\`${languageIdOf(item.chunk.file)}\n${item.chunk.text}\n\`\`\``,
        );
      }
    }

    // 整块拼装：宁可少给一块，也不要把代码块从中间切断
    let bundle = '';
    for (const block of blocks) {
      const candidate = bundle ? `${bundle}\n\n${block}` : block;
      if (candidate.length <= budget) {
        bundle = candidate;
        continue;
      }
      if (!bundle) {
        bundle = truncateBlock(block, budget);
      }
      break;
    }

    return bundle;
  }

  private retrieve(query: string, activeRel?: string): Array<{ chunk: RawChunk; score: number }> {
    const queryTokens = tokenize(query);
    if (!queryTokens.length) {
      return [];
    }
    const activeDir = activeRel ? path.posix.dirname(activeRel) : '';
    for (const token of tokenize(activeDir)) {
      queryTokens.push(token);
    }

    const terms = termFrequency(queryTokens, 4);
    const scored = scoreBm25(this.index, terms, 400);
    const neighbors = activeRel ? this.neighbors(activeRel) : new Set<string>();

    const ranked = scored
      .filter((item) => !this.deleted.has(item.docId))
      .map((item) => {
        const chunk = this.chunks[item.docId];
        let boost = 1;
        if (activeRel && chunk.file === activeRel) {
          boost *= 0.5;
        }
        if (neighbors.has(chunk.file)) {
          boost *= 1.4;
        }
        if (activeDir && chunk.file.startsWith(activeDir)) {
          boost *= 1.15;
        }
        return { chunk, score: item.score * boost };
      })
      .filter((item) => Boolean(item.chunk));

    if (!ranked.length) {
      return [];
    }

    const best = ranked[0].score;
    const perFile = new Map<string, number>();
    const picked: Array<{ chunk: RawChunk; score: number }> = [];

    for (const item of ranked) {
      if (item.score < best * 0.25) {
        continue;
      }
      const count = perFile.get(item.chunk.file) ?? 0;
      if (count >= 2) {
        continue;
      }
      perFile.set(item.chunk.file, count + 1);
      picked.push(item);
      if (picked.length >= 6) {
        break;
      }
    }

    return picked;
  }

  private neighbors(rel: string): Set<string> {
    const result = new Set<string>();
    for (const item of this.imports.get(rel) ?? []) {
      result.add(item);
    }
    for (const item of this.importedBy.get(rel) ?? []) {
      result.add(item);
    }
    return result;
  }

  private async outline(rel: string): Promise<string[]> {
    const file = this.files.get(rel);
    if (!file) {
      return [];
    }
    try {
      const symbols = (await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        file.uri,
      )) as Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined;
      if (!symbols?.length) {
        return [];
      }
      const lines: string[] = [];
      const walk = (items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, depth: number) => {
        for (const item of items) {
          if (lines.length >= 40) {
            return;
          }
          const isDocumentSymbol = 'range' in item;
          const range = isDocumentSymbol
            ? (item as vscode.DocumentSymbol).range
            : (item as vscode.SymbolInformation).location?.range;
          const line = range ? range.start.line + 1 : 0;
          const kind = vscode.SymbolKind[item.kind] ?? 'Symbol';
          lines.push(`${'  '.repeat(Math.min(depth, 3))}- ${kind} ${item.name}${line ? ` (L${line})` : ''}`);
          const children = (item as vscode.DocumentSymbol).children;
          if (children?.length) {
            walk(children, depth + 1);
          }
        }
      };
      walk(symbols, 0);
      return lines;
    } catch {
      return [];
    }
  }

  /** 把光标处的符号定义（通常是接口/类型/函数签名）取出来。 */
  private async definitionSnippets(activeUri: vscode.Uri): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== activeUri.toString()) {
      return '';
    }
    try {
      const position = editor.selection.active;
      const definitions = (await vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider',
        activeUri,
        position,
      )) as vscode.Location[] | undefined;
      if (!definitions?.length) {
        return '';
      }

      const blocks: string[] = [];
      for (const location of definitions.slice(0, 2)) {
        const rel = vscode.workspace.asRelativePath(location.uri, false);
        if (rel === vscode.workspace.asRelativePath(activeUri, false)) {
          continue;
        }
        const document = await vscode.workspace.openTextDocument(location.uri);
        const start = Math.max(0, location.range.start.line - 12);
        const end = Math.min(document.lineCount, location.range.start.line + 24);
        const text = document.getText(new vscode.Range(start, 0, end, 0)).trim();
        if (text) {
          blocks.push(`定义于 ${rel}:${start + 1}\n\`\`\`${languageIdOf(rel)}\n${text}\n\`\`\``);
        }
      }
      return blocks.join('\n\n');
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------- 约定

  private detectConventions(): void {
    const lines: string[] = [];

    const extCount = new Map<string, number>();
    for (const rel of this.files.keys()) {
      const ext = path.posix.extname(rel).slice(1).toLowerCase() || 'other';
      extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
    }
    const total = this.files.size || 1;
    const langs = [...extCount.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([ext, count]) => `${ext} ${Math.round((count / total) * 100)}%`);
    if (langs.length) {
      lines.push(`- 语言分布：${langs.join('，')}`);
    }

    // 文件命名风格
    const styles = { kebab: 0, snake: 0, camel: 0, pascal: 0 };
    for (const rel of this.files.keys()) {
      const name = path.posix.basename(rel, path.posix.extname(rel));
      if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(name)) {
        styles.kebab += 1;
      } else if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(name)) {
        styles.snake += 1;
      } else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) {
        styles.camel += 1;
      } else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
        styles.pascal += 1;
      }
    }
    const topStyle = Object.entries(styles).sort((left, right) => right[1] - left[1])[0];
    if (topStyle && topStyle[1] > 0) {
      const label: Record<string, string> = { kebab: 'kebab-case', snake: 'snake_case', camel: 'camelCase', pascal: 'PascalCase' };
      lines.push(`- 文件名：${label[topStyle[0]] ?? topStyle[0]} 为主`);
    }

    // 测试文件命名
    const testPatterns = [
      { re: /\.(test|spec)\.[jt]sx?$/, name: '*.test.ts / *.spec.ts' },
      { re: /^test_.*\.py$/, name: 'test_*.py' },
      { re: /_test\.go$/, name: '*_test.go' },
      { re: /Test\.java$/, name: '*Test.java' },
    ];
    for (const pattern of testPatterns) {
      if ([...this.files.keys()].some((rel) => pattern.re.test(path.posix.basename(rel)))) {
        lines.push(`- 测试文件：${pattern.name}`);
        break;
      }
    }

    // 缩进 / 引号 / 分号：抽样统计
    let spaces = 0;
    let tabs = 0;
    let single = 0;
    let double = 0;
    let semicolons = 0;
    let statements = 0;
    let sampled = 0;
    const widthCounts = new Map<number, number>();

    for (const chunk of this.chunks) {
      if (sampled > 220) {
        break;
      }
      if (!/\.(ts|tsx|js|jsx|vue|svelte|py|go|rs|java|kt|cs)$/.test(chunk.file)) {
        continue;
      }
      sampled += 1;
      for (const line of chunk.text.split('\n')) {
        if (/^\t+/.test(line)) {
          tabs += 1;
        } else if (/^ {2,}/.test(line)) {
          spaces += 1;
          const width = /^( +)\S/.exec(line)?.[1].length ?? 0;
          if (width === 2 || width === 4) {
            widthCounts.set(width, (widthCounts.get(width) ?? 0) + 1);
          }
        }
        single += (line.match(/'/g) ?? []).length;
        double += (line.match(/"/g) ?? []).length;
        if (/[;)]$/.test(line.trim())) {
          statements += 1;
          if (line.trim().endsWith(';')) {
            semicolons += 1;
          }
        }
      }
    }

    const topWidth = [...widthCounts.entries()].sort((left, right) => right[1] - left[1])[0];
    const indentText = tabs > spaces ? 'Tab' : topWidth ? `${topWidth[0]} 空格` : '2 空格';
    if (spaces || tabs) {
      lines.push(`- 缩进：${indentText}`);
    }

    const quoteStyle = single || double ? (single >= double * 1.2 ? 'single' : double >= single * 1.2 ? 'double' : 'either') : 'either';
    if (quoteStyle !== 'either') {
      lines.push(`- 引号：以${quoteStyle === 'single' ? '单引号' : '双引号'}为主`);
    }

    let semicolonStyle: 'always' | 'never' | 'either' = 'either';
    if (statements > 20) {
      const ratio = semicolons / statements;
      semicolonStyle = ratio > 0.6 ? 'always' : ratio < 0.2 ? 'never' : 'either';
      lines.push(`- 语句结尾：${semicolonStyle === 'always' ? '带分号' : semicolonStyle === 'never' ? '通常省略分号' : '两种写法都有'}`);
    }

    this.styleHints = { indent: indentText, quotes: quoteStyle, semicolons: semicolonStyle };

    const frameworks = this.detectFrameworks();
    if (frameworks.length) {
      lines.push(`- 依赖线索：${frameworks.join('、')}`);
    }

    this.conventions = lines;
  }

  private detectFrameworks(): string[] {
    const found = new Set<string>();
    const pkg = this.readTextFile('package.json');
    if (pkg) {
      try {
        const json = JSON.parse(pkg) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...json.dependencies, ...json.devDependencies };
        const known = ['react', 'vue', 'svelte', 'next', 'nuxt', 'vite', 'webpack', 'express', 'nestjs',
          'typescript', 'jest', 'vitest', 'mocha', 'playwright', 'tailwindcss', 'electron'];
        for (const name of known) {
          if (deps[name]) {
            found.add(name);
          }
        }
      } catch {
        // package.json 坏了就忽略
      }
    }

    const pyproject = this.readTextFile('pyproject.toml') ?? this.readTextFile('requirements.txt');
    if (pyproject) {
      for (const name of ['django', 'fastapi', 'flask', 'pytest', 'pandas', 'torch']) {
        if (pyproject.toLowerCase().includes(name)) {
          found.add(name);
        }
      }
    }

    const goMod = this.readTextFile('go.mod');
    if (goMod) {
      found.add('go modules');
    }

    return [...found].slice(0, 6);
  }

  private readTextFile(rel: string): string | undefined {
    const ids = this.fileChunks.get(rel);
    if (!ids?.length) {
      return undefined;
    }
    // 只用于 package.json / pyproject.toml 这类小文件，拼起来即可
    return ids.map((id) => this.chunks[id]?.text ?? '').join('\n');
  }
}

/** 首块就超出预算时的兜底：按行截断，并补齐未闭合的代码围栏。 */
function truncateBlock(block: string, budget: number): string {
  let slice = block.slice(0, Math.max(0, budget - 8));
  const lastNewline = slice.lastIndexOf('\n');
  if (lastNewline > budget * 0.5) {
    slice = slice.slice(0, lastNewline);
  }
  const fences = (slice.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${slice}\n\`\`\`` : slice;
}

function languageIdOf(file: string): string {  const ext = path.posix.extname(file).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', cc: 'cpp',
    c: 'c', h: 'c', hpp: 'cpp', rb: 'ruby', php: 'php', swift: 'swift', sh: 'shell', ps1: 'powershell',
    sql: 'sql', css: 'css', scss: 'scss', less: 'less', html: 'html', md: 'markdown', json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', vue: 'vue', svelte: 'svelte', lua: 'lua', dart: 'dart',
  };
  return map[ext] ?? 'text';
}

/** 从源码里粗提 import 说明符；宁可多提几个，也不要漏掉关键依赖。 */
function extractImports(content: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /^\s*(?:import|export)\s[^;'"`]*?from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([\w.]+)\s+import/gm,
    /^\s*import\s+([\w.]+)\s*$/gm,
    /^\s*use\s+([\w:]+)/gm,
    /^\s*#include\s+[<"]([^>"]+)[>"]/gm,
    /^\s*import\s+([\w.]+)\s*;/gm,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const spec = match[1]?.trim();
      if (spec && spec.length < 160) {
        found.add(spec);
      }
    }
    if (found.size > 120) {
      break;
    }
  }

  return [...found];
}
