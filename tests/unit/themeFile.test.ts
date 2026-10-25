import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThemeFile, normalizeTheme, parseThemeFile } from '../../src/theme/themeFile';

const THEME = {
  id: 'custom' as const,
  accent: '#ff8800',
  background: 'plain' as const,
  motion: 'lite' as const,
  density: 'compact' as const,
  nameplate: false,
  customCss: '.msg { color: red; }',
};

test('导出后再导入保持一致', () => {
  const file = buildThemeFile(THEME, [{ label: '讲解', command: 'deskpet.explainSelection' }], '我的主题');
  const parsed = parseThemeFile(JSON.stringify(file));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.file.theme, THEME);
  assert.equal(parsed.file.quickActions?.[0].label, '讲解');
});

test('坏 JSON 返回错误而不是抛异常', () => {
  const parsed = parseThemeFile('{ not json');
  assert.equal(parsed.ok, false);
});

test('未知枚举回退到默认值', () => {
  const theme = normalizeTheme({
    id: 'hacker',
    accent: 'red',
    background: 'stars',
    motion: 'turbo',
    density: 'huge',
    nameplate: 'yes',
    customCss: 42,
  });
  assert.equal(theme.id, 'mint');
  assert.equal(theme.accent, '#4ec9b0');
  assert.equal(theme.background, 'grid');
  assert.equal(theme.motion, 'full');
  assert.equal(theme.density, 'cozy');
  assert.equal(theme.nameplate, true);
  assert.equal(theme.customCss, '');
});

test('CSS 超长会被截断', () => {
  const parsed = parseThemeFile(JSON.stringify({ version: 1, theme: { customCss: 'a'.repeat(20_000) } }));
  assert.ok(parsed.ok);
  assert.equal(parsed.file.theme.customCss.length, 12_000);
});

test('快捷按钮最多 10 个，空 label 会被丢弃', () => {
  const quickActions = Array.from({ length: 15 }, (_, index) => ({
    label: index === 0 ? '  ' : `按钮 ${index}`,
    command: 'deskpet.chat',
  }));
  const parsed = parseThemeFile(JSON.stringify({ version: 1, theme: THEME, quickActions }));
  assert.ok(parsed.ok);
  assert.equal(parsed.file.quickActions?.length, 9);
});

test('拒绝不支持的版本', () => {
  const parsed = parseThemeFile(JSON.stringify({ version: 2, theme: THEME }));
  assert.equal(parsed.ok, false);
});

test('允许省略 version，兼容手写文件', () => {
  const parsed = parseThemeFile(JSON.stringify({ id: 'sakura', accent: '#ff9db3' }));
  assert.ok(parsed.ok);
  assert.equal(parsed.file.theme.id, 'sakura');
});
