import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. 先构建扩展本身（runTest 会加载 dist/extension.js）
const extensionBuild = spawnSync(process.execPath, ['esbuild.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
if (extensionBuild.status !== 0) {
  process.exit(extensionBuild.status ?? 1);
}

// 2. 编译测试启动器与测试套件
await esbuild.build({
  entryPoints: [path.join(root, 'tests/integration/runTest.ts')],
  outfile: path.join(root, 'tests/.dist/integration/runTest.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['@vscode/test-electron'],
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: [path.join(root, 'tests/integration/suite/index.ts')],
  outfile: path.join(root, 'tests/.dist/integration/suite/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: [path.join(root, 'tests/integration/suite/extension.test.ts')],
  outfile: path.join(root, 'tests/.dist/integration/suite/extension.test.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  logLevel: 'warning',
});

// 3. 下载/启动真实 VS Code 跑测试
const result = spawnSync(process.execPath, [path.join(root, 'tests/.dist/integration/runTest.cjs')], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
