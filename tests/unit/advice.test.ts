import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdvice } from '../../src/ai/advice';

test('解析【问题】【原因】【方案】【影响】四段', () => {
  const parsed = parseAdvice(
    [
      '【问题】fetch 没有超时控制。',
      '【原因】默认会一直等待网络响应。',
      '【方案】',
      '1. 加 AbortSignal.timeout(5000)',
      '2. catch 转成业务错误',
      '【影响】调用方需要处理新的超时异常。',
      '',
      '```ts',
      'await fetch(url, { signal: AbortSignal.timeout(5000) });',
      '```',
    ].join('\n'),
  );

  assert.match(parsed.problem, /没有超时控制/);
  assert.match(parsed.cause, /一直等待/);
  assert.match(parsed.plan, /timeout/);
  assert.match(parsed.impact, /新的超时异常/);
  assert.doesNotMatch(parsed.impact, /await fetch/);
  assert.match(parsed.code, /AbortSignal\.timeout/);
});

test('兼容 Markdown 标题与行内冒号', () => {
  const parsed = parseAdvice(
    [
      '### 问题',
      '重复计算导致 O(n^2)。',
      '### 原因：',
      '内层循环每次都重新遍历。',
      '### 方案',
      '- 用 Map 缓存结果',
      '### 影响',
      '无行为变化。',
    ].join('\n'),
  );
  assert.match(parsed.problem, /O\(n\^2\)/);
  assert.match(parsed.cause, /重新遍历/);
  assert.match(parsed.plan, /Map 缓存/);
  assert.match(parsed.impact, /无行为变化/);
});

test('不按格式输出时退化为第一段问题描述', () => {
  const parsed = parseAdvice('这段代码能跑，但建议提取函数。\n\n```ts\nfunction a() {}\n```');
  assert.match(parsed.problem, /提取函数/);
  assert.equal(parsed.cause, '');
  assert.match(parsed.code, /function a/);
});

test('代码块不会污染 impact 字段', () => {
  const parsed = parseAdvice(
    ['【问题】x', '【原因】y', '【方案】z', '【影响】无', '', '```ts', 'const a = 1;', '```'].join('\n'),
  );
  assert.equal(parsed.impact, '无');
});
