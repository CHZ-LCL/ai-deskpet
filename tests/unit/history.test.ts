import assert from 'node:assert/strict';
import test from 'node:test';
import { isFullFileRewrite, trimHistory } from '../../src/history/util';

test('trimHistory 按时间倒序保留最近 N 条', () => {
  const items = [
    { id: 'a', at: 1 },
    { id: 'b', at: 3 },
    { id: 'c', at: 2 },
  ];
  assert.deepEqual(
    trimHistory(items, 2).map((item) => item.id),
    ['b', 'c'],
  );
});

test('接受完整的整文件重写', () => {
  const before = "import { x } from './x';\n\nexport function add(a, b) {\n  return a - b;\n}\n";
  const after = "import { x } from './x';\n\nexport function add(a, b) {\n  return a + b;\n}\n";
  assert.equal(isFullFileRewrite(before, after), true);
});

test('拒绝缩水到一半以下的片段', () => {
  const before = 'const a = 1;\n'.repeat(40);
  const after = 'const a = 1;\n';
  assert.equal(isFullFileRewrite(before, after), false);
});

test('拒绝丢失模块级语法的输出', () => {
  const before = "import fs from 'node:fs';\n\nexport function read(p) {\n  return fs.readFileSync(p, 'utf8');\n}\n";
  const after = 'function read(p) {\n  return p;\n}\n';
  assert.equal(isFullFileRewrite(before, after), false);
});

test('内容完全相同时不算重写', () => {
  const code = 'export const a = 1;\n';
  assert.equal(isFullFileRewrite(code, code), false);
});

test('空输出被拒绝', () => {
  assert.equal(isFullFileRewrite('export const a = 1;', '   '), false);
});

test('Python 的 def/class 标记需要保留', () => {
  const before = 'class A:\n    def run(self):\n        return 1\n';
  const after = 'def run():\n    return 1\n';
  assert.equal(isFullFileRewrite(before, after), false);
});
