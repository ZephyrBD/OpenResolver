// 移植自 qodbuddy2pi/assets/vendor/pi-provider-qoder/dist/index.js :1301-1341（MIT）
// thinking 标签剥离（跨 chunk 安全由 stream.mjs 的前缀扣留保证）与 DSML 残渣剥离。

export const THINKING_TAG_VARIANTS = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<think>', close: '</think>' },
  { open: '<reasoning>', close: '</reasoning>' },
  { open: '<thought>', close: '</thought>' },
];

export function stripThinkingTags(text) {
  let out = text;
  for (const { open, close } of THINKING_TAG_VARIANTS) {
    if (open.length > 0 && out.includes(open)) out = out.split(open).join('');
    if (close.length > 0 && out.includes(close)) out = out.split(close).join('');
  }
  return out;
}

const DSML_TAG = /<\/?[\uFF5C|]{0,2}\s*DSML\s*[\uFF5C|]{0,2}[^>]*>|<\/?(?:invoke|invocation|parameter|function_call|function_calls)\b[^>]*>/g;

export function stripDsmlResidue(text) {
  return text.replace(DSML_TAG, '').replace(/\n{3,}/g, '\n\n');
}
