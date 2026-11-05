import http from 'node:http';

/** 真 HTTP 桩上游：记录每条请求，交给 handler 决定响应。 */
export async function startStub(ctx, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rec = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      aborted: false,
    };
    req.on('aborted', () => {
      rec.aborted = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) rec.aborted = true;
    });
    requests.push(rec);
    await handler(req, res, rec, requests.length - 1);
  });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  ctx.after(() => new Promise((r) => server.close(r)));

  return { origin: `http://127.0.0.1:${port}`, requests, server };
}
