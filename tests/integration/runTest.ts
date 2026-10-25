import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
  const workspacePath = path.resolve(extensionDevelopmentPath, 'tests/fixtures/workspace');

  await runTests({
    version: 'stable',
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--no-sandbox',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
}

main().catch((error) => {
  console.error('集成测试启动失败：', error);
  process.exit(1);
});
