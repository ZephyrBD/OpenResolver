import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../http/respond.mjs';

/**
 * 面板静态服务挂载点（M6b 前端用）：`/` 与 `/panel/*` 服务 `panel/public/` 下的文件。
 * 路径归一化后校验前缀防穿越；index.html 不存在时 503 提示未部署。
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function createStaticHandler({ publicDir, maxFileBytes = 4 * 1024 * 1024 } = {}) {
  const root = path.normalize(publicDir + path.sep);
  const indexFile = path.join(publicDir, 'index.html');

  function serve(res, file, status = 200) {
    let buf;
    try {
      if (fs.statSync(file).size > maxFileBytes) throw new Error('too large');
      buf = fs.readFileSync(file);
    } catch {
      return sendJson(res, 404, { error: { type: 'not_found_error', message: '面板资源不存在' } });
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(status, {
      'content-type': type,
      'content-length': buf.length,
      // HTML 入口必须每次拉新，避免前端发版后浏览器拿着旧页面调旧 API
      'cache-control': 'no-store',
    });
    res.end(buf);
  }

  return function handleStatic(req, res, url) {
    if (url.pathname === '/' || url.pathname === '/panel') {
      if (!fs.existsSync(indexFile)) {
        return sendJson(res, 503, {
          error: { type: 'api_error', message: '面板文件未部署，请把前端产物放到 panel/public/' },
        });
      }
      return serve(res, indexFile);
    }

    let rest = url.pathname.replace(/^\/panel\//, '');
    try {
      rest = decodeURIComponent(rest);
    } catch {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'URL 编码非法' } });
    }
    const file = path.normalize(path.join(publicDir, rest));
    if (!file.startsWith(root)) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: '非法路径' } });
    }
    return serve(res, file);
  };
}
