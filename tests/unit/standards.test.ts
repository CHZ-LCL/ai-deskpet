import assert from 'node:assert/strict';
import test from 'node:test';
import { resetConfig } from '../stubs/vscode';
import { scanCode } from '../../src/standards/patterns';
import { globToRegExp, isWhitelisted } from '../../src/standards/rules';

const TS_SAMPLE = [
  'var total = 0;',
  'if (a == b) { console.log("x"); }',
  'const el = document.getElementById("x");',
  'el.innerHTML = userInput;',
  'const key = "sk_live_1234567890";',
  'eval(code);',
  'const clone = JSON.parse(JSON.stringify(obj));',
  'const n = parseInt(input);',
].join('\n');

const PY_SAMPLE = [
  'for i in range(len(items)):',
  '    print("%s" % items[i])',
  'f = open("x.txt")',
  'try:',
  '    pass',
  'except:',
  '    pass',
].join('\n');

test.beforeEach(() => {
  resetConfig({
    'standards.packs': ['js-modern', 'security', 'python-modern'],
    'standards.whitelist': [],
  });
});

test('扫描 JS/TS 现代语法与安全问题', () => {
  const ids = scanCode(TS_SAMPLE, 'typescript', 'src/app.ts').map((item) => item.ruleId);
  for (const expected of [
    'js-modern.var',
    'js-modern.loose-eq',
    'js-modern.console',
    'js-modern.json-clone',
    'js-modern.parseint',
    'security.innerhtml',
    'security.eval',
    'security.secret-token',
  ]) {
    assert.ok(ids.includes(expected), `缺少 ${expected}`);
  }
});

test('扫描 Python 反模式', () => {
  const ids = scanCode(PY_SAMPLE, 'python', 'app/main.py').map((item) => item.ruleId);
  for (const expected of ['python.range-len', 'python.percent-format', 'python.open-without-with', 'python.bare-except']) {
    assert.ok(ids.includes(expected), `缺少 ${expected}`);
  }
});

test('规则包未启用时不产出对应结果', () => {
  resetConfig({ 'standards.packs': ['security'], 'standards.whitelist': [] });
  const ids = scanCode(TS_SAMPLE, 'typescript', 'src/app.ts').map((item) => item.ruleId);
  assert.ok(ids.includes('security.eval'));
  assert.ok(!ids.includes('js-modern.var'));
});

test('白名单按 glob 豁免，且不影响其它文件', () => {
  resetConfig({
    'standards.packs': ['security'],
    'standards.whitelist': [{ rule: 'security.eval', glob: '**/test/**' }],
  });
  assert.ok(!scanCode(TS_SAMPLE, 'typescript', 'test/app.test.ts').some((item) => item.ruleId === 'security.eval'));
  assert.ok(scanCode(TS_SAMPLE, 'typescript', 'src/app.ts').some((item) => item.ruleId === 'security.eval'));
});

test('白名单支持 security.* 前缀', () => {
  resetConfig({
    'standards.packs': ['security'],
    'standards.whitelist': [{ rule: 'security.*' }],
  });
  assert.equal(scanCode(TS_SAMPLE, 'typescript', 'src/app.ts').length, 0);
});

test('行号偏移用于选中片段', () => {
  resetConfig({ 'standards.packs': ['js-modern'], 'standards.whitelist': [] });
  const findings = scanCode('var x = 1;', 'typescript', 'src/a.ts', { lineOffset: 40 });
  assert.equal(findings[0].line, 41);
});

test('glob 能匹配根目录与嵌套路径', () => {
  const glob = globToRegExp('**/test/**');
  assert.ok(glob.test('test/a.ts'));
  assert.ok(glob.test('src/test/a.ts'));
  assert.ok(!glob.test('src/app.ts'));
});

test('白名单规则匹配支持前缀与精确 id', () => {
  assert.ok(isWhitelisted('security.eval', 'src/a.ts', [{ rule: 'security.*' }]));
  assert.ok(isWhitelisted('security.eval', 'src/a.ts', [{ rule: 'security.eval' }]));
  assert.ok(!isWhitelisted('security.eval', 'src/a.ts', [{ rule: 'security.md5' }]));
});
