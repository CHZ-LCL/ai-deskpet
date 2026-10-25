import * as path from 'node:path';
import Mocha from 'mocha';

/** VS Code 测试宿主会调用这个入口。 */
export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 60_000,
  });

  // 测试文件必须在 Mocha 装好 TDD 全局（suite/test）之后再加载
  mocha.addFile(path.join(__dirname, 'extension.test.js'));

  return new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} 个集成测试失败`));
        return;
      }
      resolve();
    });
  });
}
