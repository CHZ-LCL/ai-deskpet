/**
 * 纯函数部分：分块、分词、BM25 打分。
 * 与 VS Code API 解耦，方便单独测试与后续替换成向量检索。
 */

export interface RawChunk {
  file: string;
  start: number;
  end: number;
  text: string;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'import', 'export', 'const', 'let', 'var',
  'function', 'return', 'true', 'false', 'null', 'undefined', 'new', 'class', 'interface', 'type',
  'public', 'private', 'protected', 'static', 'void', 'async', 'await', 'default', 'case', 'break',
  'else', 'if', 'in', 'of', 'is', 'to', 'it', 'as', 'by', 'on', 'at', 'or', 'not', 'be', 'are',
]);

/** 按行切块，带少量重叠，避免跨块的语义被切断。 */
export function chunkLines(file: string, content: string, size = 46, overlap = 6): RawChunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) {
    return [];
  }

  const chunks: RawChunk[] = [];
  const step = Math.max(1, size - overlap);

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + size);
    const text = lines.slice(start, end).join('\n');
    if (text.trim().length > 24) {
      chunks.push({ file, start: start + 1, end, text: text.slice(0, 4000) });
    }
    if (end >= lines.length) {
      break;
    }
  }

  return chunks;
}

/**
 * 标识符感知分词：camelCase / snake_case / SCREAMING_CASE 都会拆出子词，
 * 同时保留完整标识符；中文按 2-gram 切分，保证中文注释也能被检索。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const matches = text.match(/[A-Za-z_$][A-Za-z0-9_$]*|[\u4e00-\u9fa5]+/g) ?? [];

  for (const match of matches) {
    if (/^[\u4e00-\u9fa5]/.test(match)) {
      if (match.length === 1) {
        continue;
      }
      for (let index = 0; index < match.length - 1; index += 1) {
        tokens.push(match.slice(index, index + 2));
      }
      continue;
    }

    const lower = match.toLowerCase();
    if (lower.length > 1 && !STOP_WORDS.has(lower)) {
      tokens.push(lower);
    }

    const parts = match
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_$]+|\s+/)
      .filter((part) => part.length > 1);

    for (const part of parts) {
      const value = part.toLowerCase();
      if (!STOP_WORDS.has(value)) {
        tokens.push(value);
      }
    }
  }

  return tokens;
}

export function termFrequency(tokens: string[], limit = 3): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const next = (counts.get(token) ?? 0) + 1;
    counts.set(token, Math.min(limit, next));
  }
  return counts;
}

export interface Bm25Index {
  postings: Map<string, Map<number, number>>;
  docFreq: Map<string, number>;
  lengths: number[];
  totalLength: number;
}

export function createBm25(): Bm25Index {
  return { postings: new Map(), docFreq: new Map(), lengths: [], totalLength: 0 };
}

/** 把一块文本加入索引；调用方负责给 docId 递增编号。 */
export function addToBm25(index: Bm25Index, docId: number, tokens: string[]): void {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  for (const [term, count] of tf) {
    let posting = index.postings.get(term);
    if (!posting) {
      posting = new Map();
      index.postings.set(term, posting);
    }
    posting.set(docId, count);
    index.docFreq.set(term, (index.docFreq.get(term) ?? 0) + 1);
  }

  index.lengths[docId] = tokens.length;
  index.totalLength += tokens.length;
}

export interface ScoredDoc {
  docId: number;
  score: number;
}

/** 标准 BM25，k1=1.2 / b=0.75。 */
export function scoreBm25(index: Bm25Index, query: Map<string, number>, limit: number): ScoredDoc[] {
  const total = index.lengths.length;
  if (!total) {
    return [];
  }
  const avgLength = Math.max(1, index.totalLength / total);
  const scores = new Map<number, number>();
  const k1 = 1.2;
  const b = 0.75;

  for (const [term, queryWeight] of query) {
    const posting = index.postings.get(term);
    if (!posting) {
      continue;
    }
    const df = index.docFreq.get(term) ?? posting.size;
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));

    for (const [docId, tf] of posting) {
      const length = index.lengths[docId] || 1;
      const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / avgLength)));
      scores.set(docId, (scores.get(docId) ?? 0) + score * queryWeight);
    }
  }

  return [...scores.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
