import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { trimHistory } from './util';

const INDEX_KEY = 'deskpet.fixHistory.v1';
const LIMIT = 30;
/** 单条记录最多保存约 40 万字符（before+after），防止把 globalStorage 撑爆 */
const MAX_ENTRY_CHARS = 400_000;

export interface FixMeta {
  id: string;
  uri: string;
  title: string;
  at: number;
}

export interface FixEntry extends FixMeta {
  before: string;
  after: string;
}

let instance: FixHistory | undefined;

export function initFixHistory(context: vscode.ExtensionContext): FixHistory {
  instance = new FixHistory(context);
  return instance;
}

export function getFixHistory(): FixHistory | undefined {
  return instance;
}

/**
 * AI 修改历史：每次应用补丁都留一份前后快照，支持逐条回退。
 * 快照写在 globalStorage/fix-history/<id>.json，索引放在 globalState。
 */
export class FixHistory {
  private readonly dir: vscode.Uri;
  private index: FixMeta[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.dir = vscode.Uri.joinPath(context.globalStorageUri, 'fix-history');
    this.index = context.globalState.get<FixMeta[]>(INDEX_KEY) ?? [];
  }

  list(): FixMeta[] {
    return trimHistory(this.index, LIMIT);
  }

  async add(uri: vscode.Uri, before: string, after: string, title: string): Promise<FixMeta | undefined> {
    if (before === after || before.length + after.length > MAX_ENTRY_CHARS) {
      return undefined;
    }

    const id = crypto.randomUUID();
    const meta: FixMeta = { id, uri: uri.toString(), title, at: Date.now() };

    try {
      await vscode.workspace.fs.createDirectory(this.dir);
      const file = vscode.Uri.joinPath(this.dir, `${id}.json`);
      await vscode.workspace.fs.writeFile(
        file,
        new TextEncoder().encode(JSON.stringify({ before, after })),
      );
    } catch {
      return undefined;
    }

    this.index = trimHistory([meta, ...this.index], LIMIT);
    await this.context.globalState.update(INDEX_KEY, this.index);
    await this.pruneFiles();
    return meta;
  }

  async get(id: string): Promise<FixEntry | undefined> {
    const meta = this.index.find((item) => item.id === id);
    if (!meta) {
      return undefined;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, `${id}.json`));
      const data = JSON.parse(new TextDecoder().decode(bytes)) as { before: string; after: string };
      return { ...meta, before: data.before, after: data.after };
    } catch {
      return undefined;
    }
  }

  async clear(): Promise<void> {
    for (const meta of this.index) {
      await this.deleteFile(meta.id);
    }
    this.index = [];
    await this.context.globalState.update(INDEX_KEY, []);
  }

  /** 索引只保留 LIMIT 条，磁盘上的旧文件顺手删掉。 */
  private async pruneFiles(): Promise<void> {
    const keep = new Set(this.index.map((item) => item.id));
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.dir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) {
          continue;
        }
        const id = name.slice(0, -'.json'.length);
        if (!keep.has(id)) {
          await this.deleteFile(id);
        }
      }
    } catch {
      // 目录不存在时忽略
    }
  }

  private async deleteFile(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, `${id}.json`));
    } catch {
      // 文件已经没了
    }
  }
}
