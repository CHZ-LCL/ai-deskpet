import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categorize,
  describeItems,
  diffDiagnostics,
  summarize,
  type DiagItem,
} from '../../src/verify/diagnostics';

const item = (overrides: Partial<DiagItem> = {}): DiagItem => ({
  file: 'src/a.ts',
  line: 1,
  severity: 'error',
  code: 'TS1000',
  message: 'boom',
  ...overrides,
});

test('diffDiagnostics 只把新增项算作 introduced', () => {
  const before = [
    item({ line: 1, message: '旧错误' }),
    item({ line: 2, message: '会被修掉' }),
  ];
  const after = [
    item({ line: 1, message: '旧错误' }),
    item({ line: 9, message: '新错误', code: 'TS2304' }),
  ];
  const diff = diffDiagnostics(before, after);
  assert.deepEqual(diff.introduced.map((entry) => entry.message), ['新错误']);
  assert.deepEqual(diff.fixed.map((entry) => entry.message), ['会被修掉']);
  assert.equal(diff.remaining.length, 2);
});

test('同一行但错误码不同，算新错误', () => {
  const diff = diffDiagnostics([item({ line: 3, code: 'TS1' })], [item({ line: 3, code: 'TS2' })]);
  assert.equal(diff.introduced.length, 1);
});

test('跨文件的同类错误不会被误判为同一个', () => {
  const diff = diffDiagnostics(
    [item({ file: 'src/a.ts' })],
    [item({ file: 'src/b.ts' })],
  );
  assert.equal(diff.introduced.length, 1);
  assert.equal(diff.fixed.length, 1);
});

test('分类：模块解析、类型、变量、其它', () => {
  assert.equal(categorize(item({ message: "Cannot find module 'x'" })), 'module');
  assert.equal(categorize(item({ message: "Cannot find name 'foo'." })), 'module');
  assert.equal(categorize(item({ message: "Type 'string' is not assignable to type 'number'." })), 'type');
  assert.equal(categorize(item({ message: "'x' is declared but its value is never read." })), 'variable');
  assert.equal(categorize(item({ message: 'something odd' })), 'other');
});

test('summarize 只返回有计数的分类', () => {
  const groups = summarize([
    item({ message: "Cannot find module 'a'" }),
    item({ message: "Cannot find module 'b'" }),
    item({ message: "'x' is declared but its value is never read." }),
  ]);
  assert.deepEqual(
    groups.map((group) => `${group.category}:${group.count}`),
    ['module:2', 'variable:1'],
  );
});

test('describeItems 最多列 4 条并带文件名', () => {
  const text = describeItems(
    Array.from({ length: 6 }, (_, index) => item({ line: index + 1 })),
    4,
  );
  assert.equal(text.split('\n').length, 4);
  assert.match(text, /src\/a\.ts:L1/);
});
