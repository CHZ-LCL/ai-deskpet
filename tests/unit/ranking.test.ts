import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addToBm25,
  chunkLines,
  createBm25,
  scoreBm25,
  termFrequency,
  tokenize,
} from '../../src/context/ranking';

const CORPUS: Record<string, string> = {
  'src/auth/token.ts':
    'export function refreshToken(client) {\n  return client.post("/oauth/refresh", { refresh_token: state.token });\n}\n',
  'src/ui/button.tsx':
    'export function Button(props) {\n  return <button onClick={props.onClick}>{props.label}</button>;\n}\n',
  'docs/login.md': '登录流程说明：先调用 refreshToken，再把 token 写入本地缓存。',
};

function buildIndex() {
  const index = createBm25();
  const chunks: Array<{ file: string; text: string }> = [];
  let id = 0;
  for (const [file, text] of Object.entries(CORPUS)) {
    for (const chunk of chunkLines(file, text)) {
      addToBm25(index, id, tokenize(`${file} ${chunk.text}`));
      chunks[id] = chunk;
      id += 1;
    }
  }
  return { index, chunks };
}

test('tokenize 拆分 camelCase / snake_case，并保留完整标识符', () => {
  const tokens = tokenize('refreshToken getUser_id HTTPResponse');
  assert.ok(tokens.includes('refresh'));
  assert.ok(tokens.includes('token'));
  assert.ok(tokens.includes('refreshtoken'));
  assert.ok(tokens.includes('getuserid'));
  assert.ok(tokens.includes('http'));
});

test('tokenize 对中文使用 2-gram', () => {
  assert.deepEqual(tokenize('登录缓存'), ['登录', '录缓', '缓存']);
});

test('chunkLines 行号从 1 开始且带重叠', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const chunks = chunkLines('a.ts', text, 10, 2);
  assert.equal(chunks[0].start, 1);
  assert.equal(chunks[0].end, 10);
  assert.ok(chunks.length > 5);
  assert.equal(chunks[1].start, 9);
});

test('BM25 把最相关的文件排到第一', () => {
  const { index } = buildIndex();

  const auth = scoreBm25(index, termFrequency(tokenize('refresh token 过期')), 5);
  assert.equal(auth[0].docId, 0);

  const ui = scoreBm25(index, termFrequency(tokenize('button onClick 样式')), 5);
  assert.equal(ui[0].docId, 1);

  const docs = scoreBm25(index, termFrequency(tokenize('登录流程 缓存')), 5);
  assert.equal(docs[0].docId, 2);
});

test('BM25 对完全不相关的词返回空结果', () => {
  const { index } = buildIndex();
  assert.deepEqual(scoreBm25(index, termFrequency(tokenize('quantum entanglement')), 5), []);
});
