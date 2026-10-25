import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITY_SAMPLE, validateFullFileReply } from '../../src/ai/capabilitySample';

const goodReply = [
  '```ts',
  '// DESKPET_CAPABILITY_MARKER',
  'export function sum(values: number[]): number {',
  '  let total = 0;',
  '  for (let i = 0; i < values.length; i++) {',
  '    total += values[i] ?? 0;',
  '  }',
  '  return total;',
  '}',
  '```',
].join('\n');

test('完整的修复结果通过验证', () => {
  const verdict = validateFullFileReply(CAPABILITY_SAMPLE, goodReply);
  assert.equal(verdict.ok, true);
  assert.match(verdict.code, /i < values\.length/);
});

test('没有代码块时失败', () => {
  assert.equal(validateFullFileReply(CAPABILITY_SAMPLE, '我修好了，但没给代码').ok, false);
});

test('丢失标记注释说明不是完整文件', () => {
  const reply = goodReply.replace('// DESKPET_CAPABILITY_MARKER\n', '');
  const verdict = validateFullFileReply(CAPABILITY_SAMPLE, reply);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /标记注释/);
});

test('丢失原有函数时失败', () => {
  const reply = goodReply.replace('export function sum', 'function sum');
  const verdict = validateFullFileReply(CAPABILITY_SAMPLE, reply);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /原有函数/);
});

test('没有修掉越界时失败', () => {
  const reply = goodReply.replace('i < values.length', 'i <= values.length');
  const verdict = validateFullFileReply(CAPABILITY_SAMPLE, reply);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /越界/);
});

test('输出明显截断时失败', () => {
  // 用更长的原文触发“长度缩水”规则，避免被前面的检查拦住
  const longOriginal = `${CAPABILITY_SAMPLE}\n// filler\n`.repeat(20);
  const verdict = validateFullFileReply(longOriginal, goodReply);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /截断/);
});
