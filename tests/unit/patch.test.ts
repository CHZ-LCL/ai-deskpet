import assert from 'node:assert/strict';
import test from 'node:test';
import { isPatchStale } from '../../src/inline/patch';

test('原文未变化时可以应用', () => {
  assert.equal(isPatchStale('const a = 1;', 'const a = 1;'), false);
});

test('原文被改过时拒绝应用', () => {
  assert.equal(isPatchStale('const a = 2;', 'const a = 1;'), true);
  assert.equal(isPatchStale('', 'const a = 1;'), true);
});
