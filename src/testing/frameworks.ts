import * as path from 'node:path';
import * as vscode from 'vscode';
import { L } from '../i18n';

export type FrameworkId =
  | 'vitest'
  | 'jest'
  | 'mocha'
  | 'playwright'
  | 'node-test'
  | 'pytest'
  | 'go'
  | 'junit'
  | 'xunit'
  | 'rust'
  | 'unknown';

export interface TestFramework {
  id: FrameworkId;
  label: string;
  /** 测试文件建议路径（相对工作区） */
  fileFor: (sourceRel: string) => string;
  /** 生成测试时使用的语言 id */
  languageId: (sourceLanguage: string) => string;
  /** 给模型的写法提示 */
  idiom: string;
}

/**
 * 先看工程里实际用了什么测试框架，再决定文件命名和写法。
 * 读不到配置时按语言给一个合理默认，保证“零配置也能生成”。
 */
export async function detectTestFramework(
  languageId: string,
  sourceRel: string,
): Promise<TestFramework> {
  const deps = await readPackageDeps();
  const testSamples = await sampleTestFiles();

  if (deps['vitest']) {
    return makeJs('vitest', 'Vitest', sourceRel, testSamples, '`import { describe, it, expect, vi } from "vitest"`');
  }
  if (deps['@playwright/test']) {
    return makeJs('playwright', 'Playwright', sourceRel, testSamples, '`import { test, expect } from "@playwright/test"`');
  }
  if (deps['jest']) {
    return makeJs('jest', 'Jest', sourceRel, testSamples, '`describe / it / expect / jest.fn()`');
  }
  if (deps['mocha']) {
    return makeJs('mocha', 'Mocha + Chai', sourceRel, testSamples, '`describe / it` + `expect`');
  }

  if (languageId === 'typescript' || languageId === 'javascript' ||
      languageId === 'typescriptreact' || languageId === 'javascriptreact') {
    return makeJs('node-test', 'Node Test Runner', sourceRel, testSamples, '`import test from "node:test"` + `node:assert/strict`');
  }

  if (languageId === 'python') {
    const style = testSamples.some((file) => file.includes('/tests/')) ? 'tests/' : '';
    return {
      id: 'pytest',
      label: 'pytest',
      fileFor: (rel) => pythonTestPath(rel, style),
      languageId: () => 'python',
      idiom: 'pytest 函数式测试，`assert` 断言，可用 `pytest.raises`',
    };
  }

  if (languageId === 'go') {
    return {
      id: 'go',
      label: 'go test',
      fileFor: (rel) => rel.replace(/\.go$/, '_test.go'),
      languageId: () => 'go',
      idiom: '表驱动测试（tests := []struct{...}），`t.Run` 子测试',
    };
  }

  if (languageId === 'rust') {
    return {
      id: 'rust',
      label: 'cargo test',
      fileFor: (rel) => rel.replace(/\.rs$/, '_test.rs'),
      languageId: () => 'rust',
      idiom: '`#[cfg(test)] mod tests` + `#[test]`，`assert_eq!`',
    };
  }

  if (languageId === 'java' || languageId === 'kotlin') {
    return {
      id: 'junit',
      label: 'JUnit 5',
      fileFor: (rel) => {
        const base = path.posix.basename(rel, path.posix.extname(rel));
        return `src/test/java/${base}Test.${languageId === 'kotlin' ? 'kt' : 'java'}`;
      },
      languageId: (source) => source,
      idiom: '`@Test` + `assertEquals` / `assertThrows`',
    };
  }

  if (languageId === 'csharp') {
    return {
      id: 'xunit',
      label: 'xUnit',
      fileFor: (rel) => rel.replace(/\.cs$/, 'Tests.cs'),
      languageId: () => 'csharp',
      idiom: '`[Fact]` / `[Theory]` + `Assert.Equal` / `Assert.Throws`',
    };
  }

  return {
    id: 'unknown',
    label: L('通用单元测试', 'generic unit tests'),
    fileFor: (rel) => {
      const ext = path.posix.extname(rel);
      return `${rel.slice(0, -ext.length)}.test${ext}`;
    },
    languageId: (source) => source,
    idiom: '使用该语言最主流的测试框架写法',
  };
}

function makeJs(
  id: FrameworkId,
  label: string,
  sourceRel: string,
  samples: string[],
  idiom: string,
): TestFramework {
  const spec = samples.some((file) => file.includes('.spec.'));
  const inTestsDir = samples.some((file) => /(^|\/)__tests__\//.test(file));
  const suffix = spec ? 'spec' : 'test';
  return {
    id,
    label,
    fileFor: (rel) => {
      const ext = path.posix.extname(rel);
      const base = path.posix.basename(rel, ext);
      const dir = path.posix.dirname(rel);
      return inTestsDir
        ? path.posix.join(dir, '__tests__', `${base}.${suffix}${ext}`)
        : path.posix.join(dir, `${base}.${suffix}${ext}`);
    },
    languageId: (source) =>
      source === 'typescript' || source === 'typescriptreact' ? 'typescript' : 'javascript',
    idiom,
  };
}

function pythonTestPath(rel: string, prefix: string): string {
  const base = path.posix.basename(rel, '.py');
  const dir = path.posix.dirname(rel);
  return path.posix.join(dir, prefix, `test_${base}.py`);
}

async function readPackageDeps(): Promise<Record<string, string>> {
  try {
    const found = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 5);
    for (const uri of found) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const json = JSON.parse(new TextDecoder().decode(bytes)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...json.dependencies, ...json.devDependencies };
      if (Object.keys(deps).length) {
        return deps;
      }
    }
  } catch {
    // 读不到就按默认处理
  }
  return {};
}

async function sampleTestFiles(): Promise<string[]> {
  try {
    const found = await vscode.workspace.findFiles(
      '**/*.{test,spec}.{ts,tsx,js,jsx}',
      '**/node_modules/**',
      30,
    );
    const py = await vscode.workspace.findFiles('**/test_*.py', '**/{node_modules,.venv,venv}/**', 15);
    return [...found, ...py].map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

export function testLanguageFor(sourceLanguage: string): string {
  const map: Record<string, string> = {
    typescriptreact: 'typescript',
    javascriptreact: 'javascript',
    vue: 'javascript',
    svelte: 'javascript',
  };
  return map[sourceLanguage] ?? sourceLanguage;
}
