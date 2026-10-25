import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { englishDictionary, L, setLanguage } from '../../shared/i18n';
import { resolveLanguage } from '../../src/i18n';
import { configStore, env, resetConfig } from '../stubs/vscode';

const root = path.resolve(__dirname, '../..');

describe('webview i18n', () => {
  it('has a non-empty English string for every dictionary entry', () => {
    for (const [key, value] of Object.entries(englishDictionary())) {
      assert.ok(value.trim().length > 0, `empty translation for ${key}`);
      assert.notEqual(value, key, `untranslated entry: ${key}`);
    }
  });

  it('switches between Chinese and English and interpolates parameters', () => {
    setLanguage('zh');
    assert.equal(L('形象库'), '形象库');
    assert.equal(L('问题清单 · {0}', 3), '问题清单 · 3');

    setLanguage('en');
    assert.equal(L('形象库'), 'Avatars');
    assert.equal(L('问题清单 · {0}', 3), 'Problems · 3');
    assert.equal(L('未收录的文案'), '未收录的文案');
    setLanguage('zh');
  });
});

describe('host language', () => {
  it('follows the VS Code display language when set to auto', () => {
    resetConfig({ 'ui.language': 'auto' });
    env.language = 'en-US';
    assert.equal(resolveLanguage(), 'en');
    env.language = 'zh-cn';
    assert.equal(resolveLanguage(), 'zh');
  });

  it('honours an explicit setting', () => {
    resetConfig({ 'ui.language': 'en' });
    env.language = 'zh-cn';
    assert.equal(resolveLanguage(), 'en');
    configStore['ui.language'] = 'zh';
    assert.equal(resolveLanguage(), 'zh');
  });
});

describe('manifest localization', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    displayName: string;
    description: string;
    contributes: unknown;
  };
  const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const zh = JSON.parse(
    fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'),
  ) as Record<string, string>;

  const placeholders = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = /^%(.+)%$/.exec(value);
      if (match) {
        placeholders.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(collect);
    }
  };
  collect(pkg);

  it('resolves every %placeholder% in package.json', () => {
    assert.ok(placeholders.size > 100, 'expected the manifest to be localized');
    for (const key of placeholders) {
      assert.ok(en[key], `missing English value for ${key}`);
      assert.ok(zh[key], `missing Chinese value for ${key}`);
    }
  });

  it('keeps both language files in sync', () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    assert.equal(en.displayName, 'AI DeskPet');
    assert.match(zh.displayName, /桌宠/);
  });
});
