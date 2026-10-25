import assert from 'node:assert/strict';
import test from 'node:test';
import { scanDocDrift } from '../../src/docs/docTargets';

const TS_SOURCE = [
  '/**',
  ' * 计算总价。',
  ' * @param items 商品列表',
  ' * @param tax 税率',
  ' */',
  'export function total(items: Item[], discount: number, tax: number) {',
  '  return 0;',
  '}',
  '',
  '/** 只有一句摘要，没有参数说明 */',
  'export function noParams(a: string) {',
  '  return a;',
  '}',
  '',
  '/**',
  ' * 常量加法',
  ' * @param a 左值',
  ' * @param b 右值',
  ' */',
  'const add = (a: number, b: number) => a + b;',
].join('\n');

const PY_SOURCE = [
  'def greet(name, times=1):',
  '    """打招呼。',
  '',
  '    Args:',
  '        name (str): 名字',
  '        times (int): 次数',
  '    """',
  '    return name * times',
  '',
  'def broken(a, b):',
  '    """坏掉的文档。',
  '',
  '    :param a: 参数 a',
  '    """',
  '    return a',
].join('\n');

test('检出缺失的参数，且不会把下一个函数误算进来', () => {
  const drift = scanDocDrift(TS_SOURCE, 'typescript');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].name, 'total');
  assert.deepEqual(drift[0].missing, ['discount']);
  assert.deepEqual(drift[0].extra, []);
});

test('只有摘要、没有参数说明的注释不报漂移', () => {
  const drift = scanDocDrift('/** 只说一句话 */\nfunction f(a, b) {}', 'typescript');
  assert.deepEqual(drift, []);
});

test('参数完全一致时不报漂移', () => {
  const drift = scanDocDrift('/**\n * @param a\n * @param b\n */\nfunction ok(a, b) {}', 'typescript');
  assert.deepEqual(drift, []);
});

test('检出多余参数', () => {
  const drift = scanDocDrift('/**\n * @param a\n * @param gone\n */\nfunction f(a) {}', 'typescript');
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0].extra, ['gone']);
});

test('Python docstring 检出缺少的参数', () => {
  const drift = scanDocDrift(PY_SOURCE, 'python');
  assert.equal(drift.length, 1);
  assert.equal(drift[0].name, 'broken');
  assert.deepEqual(drift[0].missing, ['b']);
});

test('Python Args 段参数一致时不报漂移', () => {
  const drift = scanDocDrift(PY_SOURCE, 'python').filter((item) => item.name === 'greet');
  assert.deepEqual(drift, []);
});
