// 移植自 qodbuddy2pi/assets/vendor/pi-provider-qoder/dist/index.js :1270-1300（MIT）
// Qoder 私有编码：标准 base64 后按「尾部 a / 中段 / 头部 a」三段重排（a = floor(n/3)），
// 再把 64 个标准字符逐字节映射到自定义字母表，'=' 映射为 '$'。

export const qoderStdAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const qoderCustomAlphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';

export const encodeTable = new Uint8Array(256);
for (let i = 0; i < encodeTable.length; i++) encodeTable[i] = i;
for (let i = 0; i < qoderStdAlphabet.length; i++) {
  encodeTable[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet.charCodeAt(i);
}
encodeTable['='.charCodeAt(0)] = '$'.charCodeAt(0);

/** JSON 明文（字符串或 Buffer）→ Qoder 编码后字节。 */
export function qoderEncodeBody(plaintext) {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64');
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - a; i < n; i++) out[dst++] = encodeTable[std.charCodeAt(i)];
  for (let i = a; i < n - a; i++) out[dst++] = encodeTable[std.charCodeAt(i)];
  for (let i = 0; i < a; i++) out[dst++] = encodeTable[std.charCodeAt(i)];
  return out;
}
