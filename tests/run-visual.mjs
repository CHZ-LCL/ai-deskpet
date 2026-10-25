import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5199;
const baseUrl = `http://127.0.0.1:${port}/dev/preview.html`;
const actualDir = path.join(root, 'tests/visual/actual');
const baselineDir = path.join(root, 'tests/visual/baseline');
const platform = process.platform;
const threshold = 0.005; // 允许 0.5% 的像素差异（抗锯齿）

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

async function waitForServer(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function shoot(chrome, url, outfile) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-visual-'));
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      '--window-size=380,800',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=3000',
      `--screenshot=${outfile}`,
      url,
    ],
    { stdio: 'ignore', timeout: 60_000 },
  );
  fs.rmSync(profile, { recursive: true, force: true });
  if (result.status !== 0 || !fs.existsSync(outfile)) {
    throw new Error(`截图失败（${path.basename(outfile)}），Chrome 退出码 ${result.status}`);
  }
}

function compare(baselineFile, actualFile) {
  const baseline = PNG.sync.read(fs.readFileSync(baselineFile));
  const actual = PNG.sync.read(fs.readFileSync(actualFile));

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return { ok: false, reason: `尺寸不同：${baseline.width}x${baseline.height} vs ${actual.width}x${actual.height}` };
  }

  const total = baseline.width * baseline.height;
  let changed = 0;
  for (let index = 0; index < baseline.data.length; index += 4) {
    if (
      Math.abs(baseline.data[index] - actual.data[index]) > 12 ||
      Math.abs(baseline.data[index + 1] - actual.data[index + 1]) > 12 ||
      Math.abs(baseline.data[index + 2] - actual.data[index + 2]) > 12
    ) {
      changed += 1;
    }
  }

  const ratio = changed / total;
  return {
    ok: ratio <= threshold,
    reason: `${(ratio * 100).toFixed(2)}% 像素不同（阈值 ${(threshold * 100).toFixed(1)}%）`,
  };
}

async function main() {
  console.log('[visual] 构建 webview…');
  const build = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.log('[visual] 没找到 Chrome/Edge，跳过视觉测试（可用 CHROME_PATH 指定）。');
    return;
  }

  console.log('[visual] 启动预览服务器…');
  const server = spawn(process.execPath, ['dev/serve.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });

  let failed = false;
  try {
    if (!(await waitForServer())) {
      throw new Error('预览服务器启动超时');
    }

    const stamp = Date.now();
    for (const theme of ['dark', 'light']) {
      const query = `embed=1&v=${stamp}${theme === 'light' ? '&light=1' : ''}`;
      const actualFile = path.join(actualDir, `${platform}-${theme}.png`);
      const baselineFile = path.join(baselineDir, `${platform}-${theme}.png`);

      shoot(chrome, `${baseUrl}?${query}`, actualFile);

      if (!fs.existsSync(baselineFile)) {
        fs.mkdirSync(baselineDir, { recursive: true });
        fs.copyFileSync(actualFile, baselineFile);
        console.log(`[visual] ${theme}: 已创建基线 ${path.relative(root, baselineFile)}`);
        continue;
      }

      const result = compare(baselineFile, actualFile);
      if (result.ok) {
        console.log(`[visual] ${theme}: 通过（${result.reason}）`);
      } else {
        failed = true;
        console.error(`[visual] ${theme}: 失败 — ${result.reason}`);
        console.error(`         实际截图：${path.relative(root, actualFile)}`);
      }
    }
  } finally {
    server.kill();
  }

  if (failed) {
    console.error('[visual] 视觉回归未通过。确认是有意改动后，用实际截图覆盖基线再提交。');
    process.exit(1);
  }
  console.log('[visual] 全部通过');
}

main().catch((error) => {
  console.error('[visual]', error);
  process.exit(1);
});
