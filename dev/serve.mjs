import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 仅用于开发期预览 webview，不参与打包
const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT ?? 5183);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(root, url === '/' ? '/dev/preview.html' : url);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`[deskpet] preview: http://127.0.0.1:${port}/dev/preview.html`);
  });
