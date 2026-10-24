import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
  legalComments: 'none',
  target: ['es2022'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    loader: { '.woff2': 'file', '.png': 'file', '.svg': 'file' },
  },
  {
    // Live2D 渲染器按需加载，避免主包体积膨胀
    ...common,
    entryPoints: ['webview/pet/renderers/live2d.ts'],
    outfile: 'dist/webview/renderer-live2d.js',
    platform: 'browser',
    format: 'iife',
    globalName: 'DeskPetLive2D',
  },
  {
    // 3D 渲染器按需加载
    ...common,
    entryPoints: ['webview/pet/renderers/vrm.ts'],
    outfile: 'dist/webview/renderer-vrm.js',
    platform: 'browser',
    format: 'iife',
    globalName: 'DeskPetVRM',
  },
];

fs.mkdirSync('dist/webview', { recursive: true });

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[deskpet] watching...');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log('[deskpet] build done');
}
