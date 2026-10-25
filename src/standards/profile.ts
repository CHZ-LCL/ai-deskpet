import * as vscode from 'vscode';
import type { StyleProfile } from './rules';

const DEFAULT_PROFILE: StyleProfile = {
  indent: '2 空格',
  quotes: 'either',
  semicolons: 'either',
};

/**
 * 从目标文件本身推断风格，而不是全局拍脑袋。
 * 生成代码之后再用同一个 profile 校验，偏差会写进变更卡片。
 */
export function inferStyleProfile(code: string, fallback?: Partial<StyleProfile>): StyleProfile {
  const config = vscode.workspace.getConfiguration('deskpet');
  const forcedIndent = config.get<string>('style.indent', 'auto');
  const forcedQuotes = config.get<string>('style.quotes', 'auto');
  const forcedSemicolons = config.get<string>('style.semicolons', 'auto');

  const lines = code.split(/\r?\n/);
  const widths = new Map<number, number>();
  let tabs = 0;

  for (const line of lines) {
    if (/^\t+/.test(line)) {
      tabs += 1;
      continue;
    }
    const match = /^( +)\S/.exec(line);
    if (match) {
      const width = match[1].length;
      if (width === 2 || width === 4 || width === 8) {
        widths.set(width, (widths.get(width) ?? 0) + 1);
      }
    }
  }

  let indent = '2 空格';
  const topWidth = [...widths.entries()].sort((left, right) => right[1] - left[1])[0];
  if (tabs > (topWidth?.[1] ?? 0)) {
    indent = 'Tab';
  } else if (topWidth) {
    indent = `${topWidth[0]} 空格`;
  }

  const single = (code.match(/'/g) ?? []).length;
  const double = (code.match(/"/g) ?? []).length;
  let quotes: StyleProfile['quotes'] = 'either';
  if (single + double >= 6) {
    quotes = single >= double * 1.5 ? 'single' : double >= single * 1.5 ? 'double' : 'either';
  }

  const statementLines = lines.filter((line) => /[)\]\w'"`]\s*;?\s*$/.test(line.trim()) && line.trim().length > 3);
  const withSemicolon = statementLines.filter((line) => line.trim().endsWith(';')).length;
  let semicolons: StyleProfile['semicolons'] = 'either';
  if (statementLines.length >= 12) {
    const ratio = withSemicolon / statementLines.length;
    semicolons = ratio > 0.6 ? 'always' : ratio < 0.2 ? 'never' : 'either';
  }

  return {
    indent:
      forcedIndent === '2' ? '2 空格' : forcedIndent === '4' ? '4 空格' : forcedIndent === 'tab' ? 'Tab' : (fallback?.indent ?? indent),
    quotes:
      forcedQuotes === 'single' || forcedQuotes === 'double' ? forcedQuotes : (fallback?.quotes ?? quotes),
    semicolons:
      forcedSemicolons === 'always' || forcedSemicolons === 'never'
        ? forcedSemicolons
        : (fallback?.semicolons ?? semicolons),
  };
}

/** 生成代码与目标文件风格的偏差，最多返回 2 条，避免刷屏。 */
export function checkStyle(code: string, profile: StyleProfile): string[] {
  const notes: string[] = [];
  const lines = code.split(/\r?\n/);
  if (!code.trim()) {
    return notes;
  }

  if (profile.quotes === 'single') {
    const single = (code.match(/'/g) ?? []).length;
    const double = (code.match(/"/g) ?? []).length;
    if (double > single * 2 && double > 4) {
      notes.push('引号：生成代码以双引号为主，项目现有代码以单引号为主');
    }
  } else if (profile.quotes === 'double') {
    const single = (code.match(/'/g) ?? []).length;
    const double = (code.match(/"/g) ?? []).length;
    if (single > double * 2 && single > 4) {
      notes.push('引号：生成代码以单引号为主，项目现有代码以双引号为主');
    }
  }

  if (profile.semicolons === 'always' || profile.semicolons === 'never') {
    const statements = lines.filter((line) => /[)\]\w'"`]\s*;?\s*$/.test(line.trim()) && line.trim().length > 3);
    const withSemicolon = statements.filter((line) => line.trim().endsWith(';')).length;
    if (statements.length >= 6) {
      const ratio = withSemicolon / statements.length;
      if (profile.semicolons === 'always' && ratio < 0.5) {
        notes.push('分号：项目习惯语句结尾加分号，生成代码多数没有');
      } else if (profile.semicolons === 'never' && ratio > 0.7) {
        notes.push('分号：项目习惯省略分号，生成代码带了分号');
      }
    }
  }

  if (profile.indent !== 'Tab') {
    const expected = Number.parseInt(profile.indent, 10);
    const indents = lines
      .map((line) => /^( +)\S/.exec(line)?.[1].length ?? 0)
      .filter((width) => width > 0);
    if (expected > 0 && indents.length >= 4) {
      const wrong = indents.filter((width) => width % expected !== 0).length;
      if (wrong / indents.length > 0.4) {
        notes.push(`缩进：项目使用 ${profile.indent}，生成代码的缩进宽度不一致`);
      }
    }
  }

  return notes.slice(0, 2);
}

export function profileFromConventions(conventions: string[]): Partial<StyleProfile> {
  const result: Partial<StyleProfile> = { ...DEFAULT_PROFILE };
  for (const line of conventions) {
    if (line.includes('缩进')) {
      result.indent = line.includes('Tab') ? 'Tab' : line.includes('4') ? '4 空格' : '2 空格';
    }
    if (line.includes('引号')) {
      result.quotes = line.includes('单引号') ? 'single' : line.includes('双引号') ? 'double' : 'either';
    }
    if (line.includes('分号')) {
      result.semicolons = line.includes('带分号') ? 'always' : line.includes('省略') ? 'never' : 'either';
    }
  }
  return result;
}
