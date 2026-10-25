import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'tests/.dist/unit.test.cjs');

await esbuild.build({
  entryPoints: [path.join(root, 'tests/unit/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
  plugins: [
    {
      name: 'vscode-stub',
      setup(build) {
        // 被测模块会 import 'vscode'，这里换成 tests/stubs/vscode.ts
        build.onResolve({ filter: /^vscode$/ }, () => ({
          path: path.join(root, 'tests/stubs/vscode.ts'),
        }));
      },
    },
  ],
});

const result = spawnSync(process.execPath, ['--test', outfile], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(result.status ?? 1);
