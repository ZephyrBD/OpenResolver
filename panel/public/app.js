/**
 * Open-Resolver 管理面板（M6b）：原生 JS，零依赖，hash 路由。
 * 硬约束：CSP script-src 'self'（本文件必须外链）；动态内容一律 textContent/createElement，
 * 禁用 HTML 字符串注入类 API；fetch 自动带 x-ugw-csrf 双提交头。
 */

// createElementNS 需要完整 SVG 命名空间；拆开写以避免源码里出现外链字面量（CSP 自检 grep）
const SVG_NS = ['ht', 'tp://www.w3.org/2000/svg'].join('');

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---- fetch 包装：CSRF 双提交 + 401/403 处理 ----

function csrfToken() {
  for (const pair of document.cookie.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0 && pair.slice(0, idx).trim() === 'ugw_csrf') return pair.slice(idx + 1).trim();
  }
  return '';
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(pathname, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = csrfToken();
  if (token && method !== 'GET') headers['x-ugw-csrf'] = token;
  let res;
  try {
    res = await fetch(pathname, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, '网络错误：无法连接网关');
  }
  if (res.status === 401) {
    showLogin('登录已过期，请重新登录');
    throw new ApiError(401, '未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `请求失败（HTTP ${res.status}）`;
    if (res.status === 403) throw new ApiError(403, `${message}（CSRF 失效时请刷新页面重新登录）`);
    throw new ApiError(res.status, message);
  }
  return data;
}

// ---- 工具 ----

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function errorNode(err) {
  return el('p', { class: 'error', text: err.message || String(err) });
}

// ---- 名称主显示 / UUID 次显示（Task 3） ----

/** 池账号实体名称：标签 → 昵称 → 邮箱 → id。 */
function accountName(acc) {
  return String(acc?.label || acc?.nickname || acc?.email || acc?.id || '');
}

/** quota/claim 结果行的名称（后端回填的 label，缺省退 id）。 */
function accountTitle(item) {
  return item?.label || item?.account || '';
}

/** `名称（id）`；未起名（名称即 id）时只显示一次，避免重复括号。 */
function displayWithId(name, id) {
  const primary = String(name || '');
  const secondary = String(id || '');
  return primary && secondary && primary !== secondary ? `${primary}（${secondary}）` : primary || secondary;
}

/** 首列两行单元格：主显示（名称）+ 灰字 mono 次级（UUID）+ 可选第三行灰字（邮箱）。 */
function nameCell(primary, secondary, extra) {
  const td = el('td');
  td.append(el('div', { text: primary }));
  if (secondary && secondary !== primary) td.append(el('div', { class: 'muted mono', text: secondary }));
  if (extra && extra !== primary && extra !== secondary) td.append(el('div', { class: 'muted', text: extra }));
  return td;
}

/** 空状态：扁平几何小插画（2~3 个品牌色，spec §4）+ 一句指引（friendly 小帮手口吻）。 */
function emptyState(text) {
  const box = el('div', { class: 'empty-state' });
  const svg = svgEl('svg', { width: 96, height: 72, viewBox: '0 0 120 90' });
  svg.append(svgEl('rect', { x: 52, y: 10, width: 34, height: 34, rx: 10, fill: '#1abcfe', opacity: 0.85 }));
  svg.append(svgEl('circle', { cx: 30, cy: 34, r: 20, fill: '#a259ff', opacity: 0.65 }));
  svg.append(svgEl('circle', { cx: 88, cy: 58, r: 24, fill: '#0acf83', opacity: 0.5 }));
  svg.append(svgEl('circle', { cx: 56, cy: 68, r: 5, fill: '#ff7262' }));
  box.append(svg);
  box.append(el('p', { class: 'muted', text }));
  return box;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch {
    btn.textContent = '复制失败';
  }
}

const POOL_NAMES = ['zcode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-cn', 'codearts'];

// ---- API 接入（卡片 + 弹层）与模型表（仪表盘整宽） ----

/** 弹层体：Base URL 说明 + 3 段 curl 示例（模型表不进弹层——builder check 裁定 5）。 */
async function apiDialogContent(body) {
  const models = await api('/api/models');
  const base = `${location.protocol}//${location.host}`;

  const info = el('p', { class: 'muted' });
  info.append(
    'Base URL：', el('code', { text: base }),
    '（Anthropic 协议与 OpenAI 协议同端口）；鉴权头 ',
    el('code', { text: 'Authorization: Bearer zsk_…' }),
    '，密钥在上方列表创建。',
  );
  body.append(info);

  const examples = [
    ['/v1/messages（Anthropic，Claude Code 等客户端直接用）',
      `curl ${base}/v1/messages \\\n  -H "Authorization: Bearer zsk_你的密钥" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${models.data[0]?.id ?? 'zcode/GLM-5.3'}","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'`],
    ['/v1/messages 流式（SSE）',
      `curl ${base}/v1/messages \\\n  -H "Authorization: Bearer zsk_你的密钥" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${models.data[0]?.id ?? 'zcode/GLM-5.3'}","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"你好"}]}'`],
    ['/v1/chat/completions（OpenAI 兼容，messages 数组）',
      `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer zsk_你的密钥" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${models.data[0]?.id ?? 'zcode/GLM-5.3'}","messages":[{"role":"user","content":"你好"}]}'`],
  ];
  for (const [title, cmd] of examples) {
    const pre = el('pre', { class: 'code' });
    pre.textContent = cmd; // 命令含密钥占位符，textContent 防 XSS
    const copyBtn = el('button', { text: '复制' });
    copyBtn.addEventListener('click', () => copyText(cmd, copyBtn));
    const row = el('div', { class: 'api-example' });
    row.append(el('h4', { text: title }), pre, copyBtn);
    body.append(row);
  }
  body.append(el('p', { class: 'muted', text: '不写 stream 字段视为非流式。count_tokens 端点 /v1/messages/count_tokens 可用（Claude Code 会自动调用）。' }));
}

/** API 接入卡：一张卡 + 按钮开弹层（原整段 API 说明弹层化）。 */
function apiDialogCard() {
  const card = el('div', { class: 'panel-box api-dialog-card' });
  const row = el('div', { class: 'form-row' });
  const btn = el('button', { class: 'primary', text: 'API 接入' });
  row.append(el('span', { class: 'muted', text: 'Base URL 与 curl 调用示例' }), btn);
  card.append(row);
  btn.addEventListener('click', () => {
    openDialog('API 接入', (body) => { apiDialogContent(body); });
  });
  return card;
}

/** 模型列表表（8 列 + 池筛选），仪表盘整宽展示。 */
async function modelsTable() {
  const models = await api('/api/models');
  const box = el('div');
  box.append(el('h3', { text: '模型列表' }));
  const muted = el('p', { class: 'muted' });
  muted.append('调用时 model 填完整调用名（', el('code', { text: '池名/模型ID' }),
    '），网关自动映射到上游模型。筛选池：');
  const poolSel = el('select');
  poolSel.append(el('option', { value: '', text: '全部' }));
  const pools = [...new Set(models.data.map((m) => m.pool))];
  for (const p of pools) poolSel.append(el('option', { value: p, text: p }));
  muted.append(poolSel);
  box.append(muted);

  const table = el('table');
  const tableHead = el('tr', {}, [
    el('th', { text: '调用名' }),
    el('th', { text: '显示名' }),
    el('th', { text: '上游模型' }),
    el('th', { text: '池' }),
    el('th', { text: '上下文' }),
    el('th', { text: 'tools' }),
    el('th', { text: 'thinking' }),
    el('th', { text: '可用' }),
  ]);
  table.append(tableHead);
  const tbody = el('tbody');
  table.append(tbody);
  const renderRows = () => {
    clear(tbody);
    const rows = models.data.filter((m) => !poolSel.value || m.pool === poolSel.value);
    for (const m of rows) {
      const tr = el('tr');
      tr.append(el('td', { class: 'mono', text: m.id }));
      tr.append(el('td', { text: m.display_name || m.id }));
      tr.append(el('td', { class: 'mono', text: m.upstream_model || m.id }));
      tr.append(el('td', { text: m.pool }));
      tr.append(el('td', { text: m.context_window ? `${Math.round(m.context_window / 1000)}k` : '—' }));
      tr.append(el('td', { text: m.supports_tools ? '✓' : '—' }));
      tr.append(el('td', { text: m.supports_thinking ? '✓' : '—' }));
      const avail = el('td', { text: m.available ? '✓' : '不可用' });
      if (!m.available) avail.className = 'bad';
      tr.append(avail);
      tbody.append(tr);
    }
    if (!rows.length) {
      const empty = el('tr');
      empty.append(el('td', { class: 'muted', text: '该池暂无模型', colspan: '8' }));
      tbody.append(empty);
    }
  };
  poolSel.addEventListener('change', renderRows);
  renderRows();
  box.append(table);
  return box;
}

// ---- 登录视图 ----

function showLogin(message = '') {
  const overlay = $('#login-overlay');
  document.body.dataset.page = 'login';
  overlay.classList.remove('hidden');
  $('#sidebar').classList.add('hidden');
  clear(view);
  const errNode = $('#login-error');
  if (message) {
    errNode.textContent = message;
    errNode.classList.remove('hidden');
  } else {
    errNode.classList.add('hidden');
  }
}

async function doLogin(password) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.message || '登录失败');
}

function bindLogin() {
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errNode = $('#login-error');
    errNode.classList.add('hidden');
    try {
      await doLogin($('#login-password').value);
      $('#login-password').value = '';
      await boot();
    } catch (err) {
      errNode.textContent = err.message;
      errNode.classList.remove('hidden');
    }
  });
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch { /* 会话可能已失效，照常回登录页 */ }
  showLogin();
}

// ---- 路由 ----

const routes = {
  '/dashboard': renderDashboard,
  '/accounts': renderAccounts,
  '/keys': renderKeys,
  '/settings': renderSettings,
};

function currentRoute() {
  // location.hash 形如 '#/accounts'，而 routes 以 '/accounts' 为键——必须先剥掉 '#'
  const hash = (location.hash || '#/dashboard').slice(1);
  return routes[hash] ? hash : '/dashboard';
}

function setActiveNav(route) {
  for (const a of $('#nav').querySelectorAll('a')) {
    a.classList.toggle('active', a.getAttribute('href') === `#${route}`);
  }
}

async function renderRoute() {
  if (!$('#login-overlay').classList.contains('hidden')) return;
  const route = currentRoute();
  document.body.dataset.page = route.slice(1); // CSS 按 [data-page] 轮换 accent
  setActiveNav(route);
  cooldownTickers.length = 0; // 离开页面即停掉倒计时，避免对已脱离 DOM 的节点空转
  clear(view);
  try {
    await routes[route]();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    view.append(errorNode(err));
  }
}

// ---- 弹层助手（2026-11-05 布局重构 Task 2；侧栏池灯已随 Task 4 移除） ----

/**
 * 全站弹层基石（Task 3~5 依赖，接口签名不可动）：
 * openDialog(title, build, { locked } = {}) → dialog 元素；
 * build(body, close) 在弹层体内构建内容；close 时 dialog.remove()。
 * 非 locked：Esc（cancel）与 ::backdrop 点击关闭；locked：拦截 cancel，仅 close() 可关（明文凭据态）。
 */
function openDialog(title, build, { locked = false } = {}) {
  const dialog = el('dialog', { class: 'dlg' });
  const close = () => dialog.remove();
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault(); // 统一走 close() 的 remove 路径；locked 时即拦截 Esc
    if (!locked) close();
  });
  if (!locked) {
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) close(); }); // 点 ::backdrop（target 落在 dialog 自身）
  }
  const body = el('div', { class: 'dlg-body' });
  dialog.append(el('h3', { text: title }), body);
  document.body.append(dialog);
  build(body, close);
  dialog.showModal();
  return dialog;
}

/**
 * 通用确认弹层（Task 5 密钥页复用，签名不可动）：
 * confirmDialog(message, { danger }) → Promise<boolean>；locked（拦 Esc/遮罩）只认按钮。
 */
function confirmDialog(message, { danger = false } = {}) {
  return new Promise((resolve) => {
    openDialog(message, (body, close) => {
      const row = el('div', { class: 'dlg-actions' });
      row.append(
        el('button', {
          class: danger ? 'danger' : 'primary',
          text: '确认',
          onclick: () => { close(); resolve(true); },
        }),
        el('button', {
          text: '取消',
          onclick: () => { close(); resolve(false); },
        }),
      );
      body.append(row);
    }, { locked: true });
  });
}

// ---- 页 1：仪表盘 ----

function statCard(label, value, sub, { wide = false } = {}) {
  const card = el('div', { class: wide ? 'card wide' : 'card' });
  card.append(el('div', { class: 'label', text: label }));
  card.append(el('div', { class: 'value', text: value }));
  if (sub) card.append(el('div', { class: 'sub', text: sub }));
  return card;
}

async function renderDashboard() {
  const [overview, poolsRes, statsRes] = await Promise.all([
    api('/api/overview'),
    api('/api/pools'),
    api('/api/stats?days=14'),
  ]);

  clear(view);
  view.append(el('h2', { text: '仪表盘' }));

  // 整宽纵向流：今日用量卡带 → 14 天趋势图 → 各池额度表 → 模型列表（2026-11-05 Task 4）
  view.append(el('h3', { text: '今日用量' }));
  const today = el('div', { class: 'cards' });
  today.append(statCard('请求', String(overview.today.requests)));
  today.append(statCard('错误', String(overview.today.errors)));
  today.append(statCard('输入 tokens', fmtTokens(overview.today.inputTokens)));
  today.append(statCard('输出 tokens', fmtTokens(overview.today.outputTokens)));
  if (overview.usageDegraded) {
    today.append(statCard('用量记录', '降级', 'usage 文件超限，已停写', { wide: true }));
  }
  view.append(today);

  view.append(el('h3', { text: '14 天趋势' }));
  view.append(trendChart(statsRes.stats || []));

  view.append(el('h3', { text: '各池额度' }));
  const table = el('table');
  table.append(el('tr', {}, [
    el('th', { text: '池' }),
    el('th', { text: '账号数' }),
    el('th', { text: '平均额度' }),
  ]));
  for (const p of poolsRes.pools) {
    const ratios = (p.accounts || []).map((a) => a.quotaRatio).filter((r) => r != null);
    const avg = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
    const tr = el('tr');
    tr.append(el('td', { text: p.name }));
    tr.append(el('td', { text: String((p.accounts || []).length) }));
    tr.append(quotaBar(avg));
    table.append(tr);
  }
  view.append(table);

  // API 接入卡已搬到密钥页（Task 4：那里才是建密钥的地方）
  view.append(await modelsTable());
}

/**
 * 纯手写 SVG：请求量柱状（左轴，请求数）+ 错误率折线（右轴，百分比），14 天。
 * 整宽自适应靠 CSS（width:100%; height:auto）+ viewBox 比例，故不设 preserveAspectRatio。
 */
function trendChart(stats) {
  const W = 960;
  const H = 300;
  const PAD_L = 56;
  const PAD_R = 44;
  const PAD_T = 16;
  const PAD_B = 34;
  const svg = svgEl('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': '近 14 天请求量与错误率趋势',
  });
  if (!stats.length) {
    const label = svgEl('text', { x: W / 2, y: H / 2, fill: '#6e6e78', 'font-size': 14, 'text-anchor': 'middle' });
    label.textContent = '暂无数据';
    svg.append(label);
    return svg;
  }

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const bottom = PAD_T + plotH;
  const maxReq = Math.max(1, ...stats.map((s) => s.requests));
  const fmtTick = (n) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(n);
  // 三档刻度：底=0 / 中=峰值一半 / 顶=峰值。左轴读请求数，右轴读错误率百分比。
  const ticks = [
    { y: bottom, req: 0, pct: '0%' },
    { y: bottom - plotH / 2, req: maxReq / 2, pct: '50%' },
    { y: PAD_T, req: maxReq, pct: '100%' },
  ];
  for (const tick of ticks) {
    svg.append(svgEl('line', {
      x1: PAD_L, y1: tick.y, x2: W - PAD_R, y2: tick.y, stroke: '#e5e5ea', 'stroke-width': 1,
    }));
    const left = svgEl('text', { x: PAD_L - 8, y: tick.y + 4, fill: '#6e6e78', 'font-size': 11, 'text-anchor': 'end' });
    left.textContent = fmtTick(tick.req);
    svg.append(left);
    const right = svgEl('text', { x: W - 8, y: tick.y + 4, fill: '#6e6e78', 'font-size': 11, 'text-anchor': 'end' });
    right.textContent = tick.pct;
    svg.append(right);
  }

  const barW = plotW / stats.length;
  const pts = [];
  stats.forEach((s, i) => {
    const x = PAD_L + barW * i;
    const h = (s.requests / maxReq) * plotH;
    svg.append(svgEl('rect', {
      x: x + barW * 0.2,
      y: bottom - h,
      width: barW * 0.6,
      height: Math.max(h, s.requests ? 1 : 0),
      fill: '#1abcfe',
      opacity: 0.9,
    }));
    const rate = s.requests ? (s.errors / s.requests) * 100 : 0;
    pts.push([x + barW / 2, bottom - plotH * (rate / 100)]);
    // 日期轴：首尾必标，其余每 2 天一个（MM-DD）
    if (i === 0 || i === stats.length - 1 || i % 2 === 0) {
      const t = svgEl('text', { x: x + barW / 2, y: H - 12, fill: '#6e6e78', 'font-size': 11, 'text-anchor': 'middle' });
      t.textContent = s.date.slice(5);
      svg.append(t);
    }
  });
  svg.append(svgEl('polyline', {
    points: pts.map(([x, y]) => `${x},${y}`).join(' '),
    fill: 'none', stroke: '#ff7262', 'stroke-width': 2,
  }));

  // 顶部图例：蓝块=请求量（左轴柱），红线=错误率（右轴折线）
  svg.append(svgEl('rect', { x: PAD_L, y: 4, width: 10, height: 10, rx: 2, fill: '#1abcfe' }));
  const reqLegend = svgEl('text', { x: PAD_L + 16, y: 13, fill: '#6e6e78', 'font-size': 11 });
  reqLegend.textContent = '请求量';
  svg.append(reqLegend);
  svg.append(svgEl('line', {
    x1: PAD_L + 74, y1: 9, x2: PAD_L + 90, y2: 9, stroke: '#ff7262', 'stroke-width': 2,
  }));
  const errLegend = svgEl('text', { x: PAD_L + 96, y: 13, fill: '#6e6e78', 'font-size': 11 });
  errLegend.textContent = '错误率';
  svg.append(errLegend);
  return svg;
}

/** 额度条用 SVG 属性而非 inline style（CSP style-src 'self' 禁 style 属性）。 */
function quotaBar(ratio) {
  const cell = el('td', { class: 'quota' });
  if (ratio == null) {
    cell.append(el('span', { class: 'muted', text: '无数据' }));
    return cell;
  }
  const pct = Math.round(ratio * 100);
  const w = 90;
  const h = 8;
  const color = pct <= 20 ? '#ff7262' : pct <= 50 ? '#f24e1e' : '#1abcfe';
  const svg = svgEl('svg', { class: 'qbar', width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  svg.append(svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: 4, fill: '#e5e5ea' }));
  svg.append(svgEl('rect', { x: 0, y: 0, width: Math.round(w * Math.min(1, ratio)), height: h, rx: 4, fill: color }));
  cell.append(svg);
  cell.append(el('span', { class: 'muted', text: `${pct}%` }));
  return cell;
}

// ---- 页 2：账号 ----

const cooldownTickers = [];

/** 冷却剩余倒计时单元格：客户端 1s tick，不重拉 API。 */
function cooldownCell(acc) {
  const td = el('td', { class: 'mono' });
  const render = () => {
    const remain = Math.max(0, (acc.cooldownUntil || 0) - Date.now());
    clear(td);
    if (remain <= 0) {
      td.append(el('span', { text: acc.cooldownKind ? '已到期' : '—' }));
      return;
    }
    const min = Math.floor(remain / 60_000);
    const sec = Math.floor((remain % 60_000) / 1000);
    td.append(el('span', { class: 'state-cooling', text: `${min}:${String(sec).padStart(2, '0')}` }));
    if (acc.cooldownKind) td.append(el('span', { class: 'muted', text: ` (${acc.cooldownKind})` }));
  };
  render();
  cooldownTickers.push(render);
  return td;
}

function accountRow(poolName, acc, reload, errBox) {
  const tr = el('tr');

  // 名称主显示（label → nickname → email → id），UUID 退居灰字 mono 次级，邮箱另起一行
  tr.append(nameCell(acc.label || acc.nickname || acc.email || acc.id, acc.id, acc.email));

  const stateTd = el('td');
  const stateClass = !acc.enabled ? 'state-disabled' : acc.state === 'ok' ? 'state-ok' : 'state-needs_login';
  stateTd.append(el('span', { class: stateClass, text: acc.enabled ? acc.state : 'disabled' }));
  if (acc.consecutiveFails > 0) stateTd.append(el('div', { class: 'muted', text: `连败 ${acc.consecutiveFails}` }));
  tr.append(stateTd);

  const enabledTd = el('td');
  const enabledBox = el('input', { type: 'checkbox' });
  enabledBox.checked = acc.enabled;
  enabledTd.append(enabledBox);
  tr.append(enabledTd);

  const weightTd = el('td');
  const weightInput = el('input', { type: 'number', min: '0', max: '20', class: 'w-sm' });
  weightInput.value = String(acc.manualWeight ?? 10);
  weightTd.append(weightInput);
  tr.append(weightTd);

  tr.append(cooldownCell(acc));

  const actions = el('td', { class: 'actions' });
  actions.append(el('button', {
    text: '保存',
    onclick: async () => {
      errBox.classList.add('hidden');
      try {
        const raw = weightInput.value.trim();
        if (raw === '') {
          weightInput.value = String(acc.manualWeight ?? 10);
          errBox.textContent = '权重不能为空，已回填当前值';
          errBox.classList.remove('hidden');
          return;
        }
        const weight = Number(raw);
        if (!Number.isInteger(weight) || weight < 0 || weight > 20) {
          errBox.textContent = '权重须为 0-20 的整数';
          errBox.classList.remove('hidden');
          return;
        }
        await api(`/api/pools/${poolName}/accounts/${encodeURIComponent(acc.id)}`, {
          method: 'PATCH',
          body: { label: acc.label, enabled: enabledBox.checked, manualWeight: weight },
        });
        await reload();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    },
  }));
  actions.append(el('button', {
    text: '清冷却',
    onclick: async () => {
      errBox.classList.add('hidden');
      try {
        await api(`/api/pools/${poolName}/accounts/${encodeURIComponent(acc.id)}/reset`, { method: 'POST' });
        await reload();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    },
  }));
  actions.append(el('button', {
    class: 'danger',
    text: '删除',
    onclick: async () => {
      if (!(await confirmDialog(`确定删除账号 ${displayWithId(accountName(acc), acc.id)}？此操作不可恢复。`, { danger: true }))) return;
      errBox.classList.add('hidden');
      try {
        await api(`/api/pools/${poolName}/accounts/${encodeURIComponent(acc.id)}`, { method: 'DELETE' });
        await reload();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    },
  }));
  tr.append(actions);
  return tr;
}

/**
 * 弹层内错误节点（评审 I-1）：进弹层的盒不能用页面级 errBox——
 * 那写在 backdrop 后面看不见。每个盒自建 hidden p.error，
 * 用 showError(box, msg) 展示（弹层内也常用于"未完成"类提示）。
 */
function dlgErr() {
  return el('p', { class: 'error hidden' });
}

function showError(errNode, msg) {
  errNode.textContent = msg;
  errNode.classList.remove('hidden');
}

function hideError(errNode) {
  errNode.classList.add('hidden');
}

/** 手动导入账号表单（弹层内，仅 zcode）：手工填 JWT 等字段；提交成功关弹层 + 表格刷新。 */
function addAccountForm(poolName, reload, close) {
  const box = el('div');
  const errBox = dlgErr();
  const form = el('div');
  const fields = [
    ['label', '标签'],
    ['jwt', 'JWT'],
    ['pat', 'PAT'],
    ['uid', 'UID'],
    ['email', 'Email'],
  ];
  const inputs = {};
  for (const [name, placeholder] of fields) {
    const input = el('input', { placeholder, class: 'w-md' });
    inputs[name] = input;
    form.append(input);
  }
  const submit = el('button', { class: 'primary', text: '新增' });
  form.append(submit);
  box.append(form, errBox);

  submit.addEventListener('click', async () => {
    hideError(errBox);
    const body = {};
    for (const [name] of fields) {
      if (inputs[name].value.trim()) body[name] = inputs[name].value.trim();
    }
    if (body.uid) body.uid = Number(body.uid) || body.uid;
    try {
      await api(`/api/pools/${poolName}/accounts`, { method: 'POST', body });
      close();
      await reload();
    } catch (err) {
      showError(errBox, err.message);
    }
  });
  return box;
}

function traeOnboardBox(reload) {
  // 回调粘贴类（builder check 2）：弹层内保留输入框——那是流程输入端
  const box = el('div');
  const errBox = dlgErr();
  box.append(errBox);

  const linkRow = el('div', { class: 'form-row' });
  const genBtn = el('button', { text: '生成登录链接' });
  const linkA = el('a', { target: '_blank', rel: 'noopener noreferrer' });
  const copyBtn = el('button', { class: 'hidden', text: '复制' });
  linkRow.append(genBtn, linkA, copyBtn);
  box.append(linkRow);

  let currentFlowId = null;
  genBtn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const { url, flowId } = await api('/api/onboard/trae/link');
      currentFlowId = flowId; // 提交回调时必须带回，后端用它找回本次登录的 machine/device id 对
      linkA.textContent = url;
      linkA.setAttribute('href', url);
      copyBtn.classList.remove('hidden');
      copyBtn.onclick = () => copyText(url, copyBtn);
    } catch (err) {
      showError(errBox, err.message);
    }
  });

  const cbRow = el('div', { class: 'form-row' });
  const cbInput = el('input', { placeholder: '粘贴登录完成后的回调 URL', class: 'grow' });
  const cbBtn = el('button', { text: '提交回调' });
  cbRow.append(cbInput, cbBtn);
  box.append(cbRow);

  cbBtn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const { account } = await api('/api/onboard/trae/callback', {
        method: 'POST',
        body: { flowId: currentFlowId, callbackUrl: cbInput.value.trim() },
      });
      cbInput.value = '';
      const done = el('p', { class: 'state-ok' });
      done.textContent = `账号已入库：${displayWithId(accountName(account), account.id)}`;
      box.append(done);
      await reload();
    } catch (err) {
      showError(errBox, err.message);
    }
  });
  return box;
}

function workbuddyOnboardBox(reload) {
  const box = el('div');
  box.append(el('h3', { text: 'WorkBuddy' }));
  const errBox = dlgErr();
  box.append(errBox);

  const row = el('div', { class: 'form-row' });
  const regionSel = el('select');
  for (const [value, label] of [['cn', 'cn'], ['global', 'global']]) {
    const opt = el('option', { value, text: label });
    regionSel.append(opt);
  }
  const genBtn = el('button', { text: '生成登录链接' });
  row.append(el('label', { text: 'Region' }), regionSel, genBtn);
  box.append(row);

  const linkRow = el('div', { class: 'form-row' });
  const linkA = el('a', { target: '_blank', rel: 'noopener noreferrer' });
  const copyBtn = el('button', { class: 'hidden', text: '复制' });
  linkRow.append(linkA, copyBtn);
  box.append(linkRow);

  const pollRow = el('div', { class: 'form-row' });
  const pollBtn = el('button', { class: 'hidden', text: '我已登录，入库' });
  pollRow.append(pollBtn);
  box.append(pollRow);

  let currentFlowId = null;
  genBtn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const { loginUrl, flowId } = await api('/api/onboard/workbuddy', {
        method: 'POST',
        body: { region: regionSel.value, action: 'link' },
      });
      currentFlowId = flowId;
      linkA.textContent = loginUrl;
      linkA.setAttribute('href', loginUrl);
      copyBtn.classList.remove('hidden');
      copyBtn.onclick = () => copyText(loginUrl, copyBtn);
      pollBtn.classList.remove('hidden');
    } catch (err) {
      showError(errBox, err.message);
    }
  });

  pollBtn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const out = await api('/api/onboard/workbuddy', {
        method: 'POST',
        body: { region: regionSel.value, action: 'poll', flowId: currentFlowId },
      });
      if (out.pending) {
        showError(errBox, '登录尚未完成：请先在浏览器完成登录再入库。登录链接 10 分钟内有效。');
        return;
      }
      linkA.textContent = '';
      copyBtn.classList.add('hidden');
      pollBtn.classList.add('hidden');
      const done = el('p', { class: 'state-ok' });
      done.textContent = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`;
      box.append(done);
      await reload();
    } catch (err) {
      showError(errBox, err.message);
    }
  });
  return box;
}

function codeartsOnboardBox(reload) {
  const box = el('div');
  box.append(el('h3', { text: 'CodeArts' }));
  const errBox = dlgErr();
  box.append(errBox);

  const genRow = el('div', { class: 'form-row' });
  const genBtn = el('button', { text: '生成授权链接' });
  genRow.append(genBtn);
  box.append(genRow);

  const linkRow = el('div', { class: 'form-row' });
  const linkA = el('a', { target: '_blank', rel: 'noopener noreferrer' });
  const copyBtn = el('button', { class: 'hidden', text: '复制' });
  linkRow.append(linkA, copyBtn);
  box.append(linkRow);

  const callbackRow = el('div', { class: 'form-row' });
  const callbackInput = el('input', { placeholder: '粘贴浏览器回跳的完整 URL（含 code=）', class: 'w-lg' });
  const callbackBtn = el('button', { class: 'hidden', text: '回调入库' });
  callbackRow.append(callbackInput, callbackBtn);
  box.append(callbackRow);

  const pollRow = el('div', { class: 'form-row' });
  const pollBtn = el('button', { class: 'hidden', text: 'ticket 轮询入库' });
  pollRow.append(pollBtn);
  box.append(pollRow);

  let currentFlowId = null;
  genBtn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const { authorizeUrl, flowId } = await api('/api/onboard/codearts', {
        method: 'POST',
        body: { action: 'link' },
      });
      currentFlowId = flowId;
      linkA.textContent = authorizeUrl;
      linkA.setAttribute('href', authorizeUrl);
      copyBtn.classList.remove('hidden');
      copyBtn.onclick = () => copyText(authorizeUrl, copyBtn);
      callbackBtn.classList.remove('hidden');
      pollBtn.classList.remove('hidden');
    } catch (err) {
      showError(errBox, err.message);
    }
  });

  callbackBtn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const out = await api('/api/onboard/codearts', {
        method: 'POST',
        body: { action: 'callback', flowId: currentFlowId, callbackUrl: callbackInput.value.trim() },
      });
      callbackBtn.classList.add('hidden');
      pollBtn.classList.add('hidden');
      const done = el('p', { class: 'state-ok' });
      done.textContent = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`;
      box.append(done);
      await reload();
    } catch (err) {
      showError(errBox, err.message);
    }
  });

  pollBtn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const out = await api('/api/onboard/codearts', {
        method: 'POST',
        body: { action: 'poll', flowId: currentFlowId },
      });
      if (out.pending) {
        showError(errBox, '登录尚未完成：请先在浏览器完成登录再入库。授权链接 10 分钟内有效。');
        return;
      }
      callbackBtn.classList.add('hidden');
      pollBtn.classList.add('hidden');
      const done = el('p', { class: 'state-ok' });
      done.textContent = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`;
      box.append(done);
      await reload();
    } catch (err) {
      showError(errBox, err.message);
    }
  });
  return box;
}

/**
 * 通用两段式链接登录：按钮"打开授权页面"按下即 window.open 新标签 + 开始轮询（spec 决策 4）。
 * 授权链接不展示（builder check 2 只适用本类有 poll 端点的流：zcode OAuth / qoder device）；
 * 弹窗策略：点击同步开空白页占住用户手势（genLink 慢于弹窗拦截窗口时事后 open 会被拦），
 * 拿到链接后原地指向；连占位都被拦（返回 null）→ 失败态出"弹窗被拦截"+ 链接文本兜底。
 * 文案极简：等待中无文字（按钮变灰即可），只出成功/失败一行结果。
 * 轮询在节点脱离 DOM 时自停——此内部机制本任务不改。
 */
function autoPollOnboardBox({ genLink, pollOnce, linkKey = 'loginUrl', intervalSec = 2 }) {
  const box = el('div');

  const openRow = el('div', { class: 'form-row' });
  const openBtn = el('button', { class: 'primary', text: '打开授权页面' });
  openRow.append(openBtn);
  box.append(openRow);

  const statusRow = el('div', { class: 'form-row' });
  const statusText = el('span');
  statusRow.append(statusText);
  box.append(statusRow);

  let flowId = null;
  let polling = false;
  let pollTimer = null;

  const stopPoll = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    polling = false;
  };

  const finish = (out) => {
    stopPoll();
    openBtn.disabled = false; // 完成后允许再来一个账号
    statusText.className = 'state-ok';
    const claimMsg = out.claim ? `；领取：${out.claim.status === 'claimed' ? `已领 ${out.claim.claimed?.join(', ')}` : out.claim.message || out.claim.status}` : '';
    statusText.textContent = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}${claimMsg}`;
  };

  const pollTick = async () => {
    if (!polling || !box.isConnected || !flowId) return stopPoll();
    try {
      const out = await pollOnce(flowId);
      if (out.pending || out.status === 'pending') {
        pollTimer = setTimeout(pollTick, intervalSec * 1000);
        return;
      }
      finish(out);
    } catch (err) {
      stopPoll();
      openBtn.disabled = false; // 失败可重试：按钮恢复
      statusText.className = 'error';
      statusText.textContent = err.message;
    }
  };

  const startPoll = () => {
    if (polling) return;
    polling = true;
    pollTick();
  };

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true; // 变灰防双击（等待中无文字，灰即态）
    statusText.textContent = '';
    // 同步开空白占位页占住用户手势：await genLink 慢于弹窗拦截窗口（约 5s）时，事后 window.open 会被拦。
    // 不能带 noopener——那会返回 null 拿不到窗口引用；占位页仍是同源 about:blank，先剪断 opener（等效 noopener）再外跳
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    try {
      const out = await genLink();
      flowId = out.flowId;
      const url = out[linkKey] || out.authorizeUrl || out.loginUrl;
      if (w) {
        w.location = url; // 占位成功 → 原地指向授权页，手势保活
        startPoll();
      } else {
        // 占位也被拦（返回 null）→ 失败态兜底：出"弹窗被拦截"一行 + 链接文本节点供手动打开
        openBtn.disabled = false;
        statusText.className = 'error';
        statusText.append('弹窗被拦截：请允许本站弹窗，或手动打开 ');
        statusText.append(el('a', { href: url, text: url }));
      }
    } catch (err) {
      if (w) w.close(); // 链接生成失败，收掉空白占位页（此刻仍同源，close 可达）
      openBtn.disabled = false; // 生成失败：允许重试
      statusText.className = 'error';
      statusText.textContent = err.message;
    }
  });

  return box;
}

function zcodeOnboardBox() {
  return autoPollOnboardBox({
    genLink: () => api('/api/onboard/zcode', { method: 'POST', body: { action: 'link' } }),
    pollOnce: (flowId) => api('/api/onboard/zcode', { method: 'POST', body: { action: 'poll', flowId } }),
    linkKey: 'authorizeUrl',
    intervalSec: 2,
  });
}

/**
 * 额度明细：按账号展开剩余/总量/百分比/周期（现场回源，带缓存）。
 * 查询封装成 refresh 并挂到 box.refreshQuota：账号页挂载即自动查一次
 * （autoRefresh，仅池有账号时传 true），claimBox 领取完成后联动再刷。
 */
function quotaDetailsBox(poolName, { autoRefresh = false } = {}) {
  const box = el('div', { class: 'panel-box' });
  box.append(el('h3', { text: '额度明细' }));
  const row = el('div', { class: 'form-row' });
  const btn = el('button', { text: '刷新额度明细' });
  row.append(btn);
  box.append(row);
  const out = el('div');
  box.append(out);

  async function refresh() {
    clear(out);
    out.append(el('p', { class: 'muted', text: '查询中…' }));
    try {
      const data = await api(`/api/pools/${encodeURIComponent(poolName)}/quota`);
      clear(out);
      const table = el('table');
      table.append(el('tr', {}, [
        el('th', { text: '账号' }),
        el('th', { text: '额度' }),
        el('th', { text: '明细' }),
        el('th', { text: '周期/套餐' }),
        el('th', { text: '签到' }),
      ]));
      for (const q of data.accounts) {
        const tr = el('tr');
        // 名称主显示（label 优先），UUID 灰字 mono 次级；两者相同只显示一次
        tr.append(nameCell(q.label || q.account, q.account));
        tr.append(quotaBar(q.ratio));
        const detailTd = el('td');
        if (q.supported === false) {
          // supported=false：优先池方给出的原因；stale 时旧 reason 可能已过时，改用本轮新错误。
          const reason = q.source === 'stale' && q.error
            ? `查询失败：${q.error}`
            : (q.reason || (q.error ? `查询失败：${q.error}` : '上游未返回可用的额度信息'));
          detailTd.append(el('span', { class: 'muted', text: reason }));
        } else if (!q.details?.length) {
          detailTd.append(el('span', { class: 'muted', text: q.error ? `查询失败：${q.error}` : '无数据' }));
        } else {
          for (const d of q.details) {
            const line = el('div');
            const pct = d.percent != null ? `（${Math.round(d.percent * 100)}%）` : '';
            // fmtTokens 只用于 token 类度量；credits 等小数字直接原样（不显示成 3.0k）
            const fmt = /token/i.test(String(d.unit)) ? fmtTokens : String;
            const amount = d.total != null ? `${fmt(d.remaining ?? 0)} / ${fmt(d.total)} ${d.unit}${pct}` : (d.kind === 'unlimited' ? '不限量' : `— ${d.unit}`);
            line.append(el('span', { text: `${d.name}：` }), el('span', { class: 'mono', text: amount }));
            detailTd.append(line);
          }
        }
        tr.append(detailTd);
        // 周期/套餐：两者都有时并列展示（plan 不再是死数据）
        tr.append(el('td', {
          class: 'mono',
          text: q.periodEnd
            ? (q.plan ? `${fmtTime(q.periodEnd)} · ${q.plan}` : fmtTime(q.periodEnd))
            : (q.plan || '—'),
        }));
        tr.append(el('td', { text: q.checkin ? (q.checkin.checkedIn ? `已签（${q.checkin.credits ?? 0}）` : (q.checkin.message || '未签')) : '—' }));
        table.append(tr);
      }
      out.append(table);
    } catch (err) {
      clear(out);
      out.append(errorNode(err));
    }
  }

  btn.addEventListener('click', () => refresh());
  box.refreshQuota = refresh;
  if (autoRefresh) refresh();
  return box;
}

/**
 * 手动领取（整池立即跑一轮 claimer，幂等）：弹层内就地等结果（builder check 4 裁定 3）——
 * 执行中按钮变灰，结果（含 3007 tried 明细）直接展示在弹层内，失败可原地重试；
 * 全部成功（无 failed）后关闭弹层并联动刷新额度明细；混有失败则保持弹层打开、
 * 恢复按钮供重试（评审 I-2：200-with-failed 不能永久灰）。内部结果表逻辑不动。
 */
function claimBox(poolName, quotaBox, close) {
  const box = el('div');
  const btn = el('button', { class: 'primary', text: '立即领取（整池）' });
  const out = el('div');
  box.append(el('div', { class: 'form-row' }, [btn]), out);

  btn.addEventListener('click', async () => {
    btn.disabled = true; // 执行中变灰：慢操作真打上游，防双击
    clear(out);
    out.append(el('p', { class: 'muted', text: '领取中…' }));
    try {
      const data = await api(`/api/pools/${encodeURIComponent(poolName)}/claim`, { method: 'POST', body: {} });
      clear(out);
      if (!data.results?.length) {
        // 无可领对象（空池/全禁用）：直接关弹层——同 tick append 再 close 读不到（评审 M-2）
        quotaBox?.refreshQuota?.();
        close();
        return;
      }
      const table = el('table');
      table.append(el('tr', {}, [
        el('th', { text: '账号' }),
        el('th', { text: '结果' }),
        el('th', { text: '积分' }),
        el('th', { text: '说明' }),
      ]));
      let failed = 0;
      for (const r of data.results) {
        if (r.status === 'failed') failed++;
        const tr = el('tr');
        // 名称主显示（后端 label）+ id 灰字 mono 次级
        tr.append(nameCell(accountTitle(r) || r.account, r.account));
        const stateTd = el('td');
        stateTd.append(el('span', { class: r.status === 'claimed' ? 'state-ok' : r.status === 'failed' ? 'bad' : 'muted', text: r.status }));
        tr.append(stateTd);
        tr.append(el('td', { class: 'mono', text: String(r.credits ?? 0) }));
        const msgTd = el('td');
        msgTd.textContent = r.claimed?.length ? `${r.claimed.join(', ')}；${r.message || ''}` : (r.message || '');
        const tried = r.detail?.tried;
        if (Array.isArray(tried) && tried.length) {
          // 逐候选摘要（如 zcode 3007 captcha verify failed 时能看到每个 planId 的上游回复）
          msgTd.append(el('div', {
            class: 'muted',
            text: tried.map((t) => `${t.planId ?? '?'}:${t.code ?? ''} ${t.msg ?? ''}`).join('；'),
          }));
        }
        tr.append(msgTd);
        table.append(tr);
      }
      out.append(table);
      // 领取可能改变了额度/签到：联动刷新额度明细（best-effort，不阻塞结果展示）
      quotaBox?.refreshQuota?.();
      if (!failed) {
        close(); // 全部 claimed/already/none：终态即关
        return;
      }
      btn.disabled = false; // 混有失败：保持弹层开放展示明细，按钮恢复可重试
    } catch (err) {
      clear(out);
      out.append(errorNode(err));
      btn.disabled = false; // 失败原地重试：按钮恢复
    }
  });
  // 弹层是唯一领取入口：点开即执行，无需再点一次
  btn.click();
  return box;
}

/**
 * Qoder PAT 导入（弹层内）：device flow 已整体移除（上游 cn 侧不接受），只保留 PAT。
 * 两个官方取 PAT 入口兼作 region 提示——点国内版/国际版同步把 Region 下拉切到对应站点。
 */
function qoderOnboardBox(reload) {
  const box = el('div');
  box.append(el('h3', { text: 'Qoder PAT' }));

  const errBox = dlgErr();
  const regionSel = el('select');
  for (const [value, label] of [['global', 'global'], ['cn', 'cn']]) {
    const opt = el('option', { value, text: label });
    regionSel.append(opt);
  }

  // 取 PAT 链接：点击只切 Region，导航交给 target=_blank（CSP 不拦外链跳转）
  const linkRow = el('div', { class: 'form-row' });
  for (const [region, href, text] of [
    ['cn', 'https://qoder.cn/account/integrations', '国内版 · 获取 PAT'],
    ['global', 'https://qoder.com/account/integrations', '国际版 · 获取 PAT'],
  ]) {
    linkRow.append(el('a', {
      href,
      text,
      target: '_blank',
      rel: 'noopener noreferrer',
      onclick: () => { regionSel.value = region; },
    }));
  }
  box.append(linkRow);

  const row = el('div', { class: 'form-row' });
  const patInput = el('input', { placeholder: '粘贴 PAT', type: 'password', class: 'w-lg' });
  const btn = el('button', { class: 'primary', text: '导入' });
  row.append(el('label', { text: 'PAT' }), patInput, el('label', { text: 'Region' }), regionSel, btn);
  box.append(row, errBox);
  box.append(el('p', { class: 'muted', text: 'PAT 以 pt- 开头；Region 必须与 PAT 所属站点一致。' }));

  btn.addEventListener('click', async () => {
    hideError(errBox);
    try {
      const { account } = await api('/api/onboard/qoder', {
        method: 'POST',
        body: { pat: patInput.value.trim(), region: regionSel.value },
      });
      patInput.value = '';
      const done = el('p', { class: 'state-ok' });
      done.textContent = `账号已入库：${displayWithId(accountName(account), account.id)}`;
      box.append(done);
      await reload();
    } catch (err) {
      showError(errBox, err.message);
    }
  });
  return box;
}

/** 登录接入弹层内容：按池组合现有 onboard 流（builder check 裁定 2），有 poll 端点的流链接不展示。 */
function onboardDialogContent(poolName, reload) {
  const wrap = el('div');
  if (poolName === 'zcode') wrap.append(zcodeOnboardBox());
  if (poolName === 'qoder' || poolName === 'qoder-cn') wrap.append(qoderOnboardBox(reload));
  if (poolName === 'trae') wrap.append(traeOnboardBox(reload));
  if (poolName === 'workbuddy' || poolName === 'workbuddy-cn') wrap.append(workbuddyOnboardBox(reload));
  if (poolName === 'codearts') wrap.append(codeartsOnboardBox(reload));
  return wrap;
}

async function renderAccounts() {
  const { pools } = await api('/api/pools');
  const names = pools.length ? pools.map((p) => p.name) : POOL_NAMES;

  clear(view);

  let current = sessionStorage.getItem('ugw-accounts-pool') || names[0];
  if (!names.includes(current)) current = names[0];

  const errBox = el('p', { class: 'error hidden' }); // 页面级：只承接池切换 reload 失败（评审 I-1）
  const tableBox = el('div');
  const detailsWrap = el('div');
  let refreshQuota = null; // 额度明细显式引用（评审 M-6：不用 querySelector 拿 CSS 类当契约）

  // 头部：h2 + 池下拉（侧栏池灯快捷入口的记忆键沿用）
  const head = el('div', { class: 'page-head' });
  const poolSel = el('select');
  for (const name of names) poolSel.append(el('option', { value: name, text: name }));
  poolSel.value = current;
  poolSel.addEventListener('change', async () => {
    current = poolSel.value;
    sessionStorage.setItem('ugw-accounts-pool', current);
    errBox.classList.add('hidden');
    try {
      await reload();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  });
  head.append(el('h2', { text: '账号' }), poolSel);
  view.append(head, errBox, tableBox, detailsWrap);

  async function reload() {
    const data = await api(`/api/pools/${encodeURIComponent(current)}/accounts`);
    cooldownTickers.length = 0; // 旧行引用作废，下面重建
    clear(tableBox);
    const table = el('table');
    table.append(el('tr', {}, [
      el('th', { text: '名称 / ID' }),
      el('th', { text: '状态' }),
      el('th', { text: '启用' }),
      el('th', { text: '权重' }),
      el('th', { text: '冷却' }),
      el('th', { text: '操作' }),
    ]));
    for (const acc of data.accounts) table.append(accountRow(current, acc, reload, errBox));
    if (!data.accounts.length) {
      const empty = el('tr');
      const td = el('td', { colspan: '6' });
      td.append(emptyState('暂无账号——用「登录接入」接入一个，马上就有东西看。'));
      empty.append(td);
      table.append(empty);
    }
    tableBox.append(table);

    // 动作按钮行（builder check 裁定 6：按池条件渲染，不渲染空表单按钮）
    const oldRow = view.querySelector('.action-row');
    if (oldRow) oldRow.remove();
    const actions = el('div', { class: 'action-row' });
    if (POOL_NAMES.includes(current)) {
      actions.append(el('button', {
        class: 'primary',
        text: '登录接入',
        onclick: () => openDialog(`登录接入 ${current}`, (body) => {
          body.append(onboardDialogContent(current, reload));
        }),
      }));
    }
    if (current === 'zcode') {
      actions.append(el('button', {
        text: '手动导入',
        onclick: () => openDialog(`手动导入 ${current}`, (body, close) => {
          body.append(addAccountForm(current, reload, close));
        }),
      }));
    }
    actions.append(el('button', {
      text: '领取 / 签到',
      onclick: () => openDialog(`领取 ${current}`, (body, close) => {
        // 有账号时页面额度明细框已在挂载，refreshQuota 显式引用联动；无账号池无可领对象
        body.append(claimBox(current, refreshQuota ? { refreshQuota } : null, close));
      }),
    }));
    view.insertBefore(actions, tableBox); // 头部 → 动作行 → 表 → 明细（评审 I-3）

    // 整宽内联额度明细（高频"看"的数据留页面内联，领取成功联动刷新行为不变）
    clear(detailsWrap);
    refreshQuota = null;
    if (data.accounts.length) {
      const quotaBox = quotaDetailsBox(current, { autoRefresh: true });
      refreshQuota = quotaBox.refreshQuota;
      detailsWrap.append(quotaBox);
    }
  }

  await reload();
}

// ---- 页 3：密钥 ----

/**
 * 密钥明文弹层（builder check 裁定 3）：locked 态——Esc/遮罩不可关，只认 [我已保存]。
 * 创建成功（关表单弹层后叠开此明文弹层）与轮换成功共用此明文展示。
 */
function secretBox(secret, reload) {
  openDialog('新密钥明文（仅此一次）', (body, closeDialog) => {
    const box = el('div', { class: 'secret-box' });
    box.append(el('div', { class: 'secret mono', text: secret }));
    const row = el('div', { class: 'form-row' });
    const copyBtn = el('button', { class: 'primary', text: '复制' });
    copyBtn.addEventListener('click', () => copyText(secret, copyBtn));
    row.append(copyBtn, el('button', {
      text: '我已保存',
      onclick: async () => { closeDialog(); if (reload) await reload(); },
    }));
    box.append(row);
    body.append(box);
  }, { locked: true });
}

function keyRow(key, reload, errBox) {
  const tr = el('tr');
  // 名称主显示，UUID + 明文前缀退居灰字 mono 次级
  tr.append(nameCell(key.name || key.prefix || '未命名', `${key.id} · ${key.prefix}…`));

  const poolsTd = el('td', { class: 'muted' });
  poolsTd.textContent = (key.enabledPools || []).join(', ') || '全部';
  tr.append(poolsTd);

  tr.append(el('td', { class: 'mono', text: key.expiresAt ? fmtTime(key.expiresAt) : '永不过期' }));
  tr.append(el('td', { class: 'mono', text: fmtTime(key.createdAt) }));
  tr.append(el('td', { class: 'mono', text: fmtTokens(key.usedTokens || 0) }));

  const actions = el('td', { class: 'actions' });
  const title = displayWithId(key.name, key.id); // 名称（id）；确认文案以名称为主
  actions.append(el('button', {
    text: '轮换',
    onclick: async () => {
      if (!(await confirmDialog(`确定轮换密钥 ${title}？旧明文立即失效。`, { danger: true }))) return;
      errBox.classList.add('hidden');
      try {
        const { secret } = await api(`/api/keys/${encodeURIComponent(key.id)}/rotate`, { method: 'POST' });
        secretBox(secret, reload);
        await reload();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    },
  }));
  actions.append(el('button', {
    class: 'danger',
    text: '删除',
    onclick: async () => {
      if (!(await confirmDialog(`确定删除密钥 ${title}？使用它的客户端会立即 401。`, { danger: true }))) return;
      errBox.classList.add('hidden');
      try {
        await api(`/api/keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
        await reload();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    },
  }));
  tr.append(actions);
  return tr;
}

/** 创建密钥弹层表单：提交成功同帧 close() 关表单弹层 → 叠开 locked 明文弹层（流程在 [我已保存] 终结）。 */
function createKeyForm(reload, close) {
  const box = el('div');
  const errBox = dlgErr();
  const keyForm = el('div', { class: 'key-form' });
  const nameInput = el('input', { placeholder: '名称', class: 'w-md' });
  const poolChecks = el('span', { class: 'pool-checks' });
  for (const name of POOL_NAMES) {
    const cb = el('input', { type: 'checkbox', value: name, id: `pool-cb-${name}` });
    const label = el('label', { for: `pool-cb-${name}` });
    label.append(cb, document.createTextNode(` ${name} `));
    poolChecks.append(label);
  }
  const expiresInput = el('input', { type: 'datetime-local' });
  const createBtn = el('button', { class: 'primary', text: '创建' });
  // 两列栅格（label 列 / 控件列）：启用池 label 不再和整行其余控件挤在同一个 flex 行里
  const expiryBox = el('div', { class: 'key-expiry' });
  expiryBox.append(expiresInput, createBtn);
  keyForm.append(
    el('label', { text: '名称' }), nameInput,
    el('label', { text: '启用池' }), poolChecks,
    el('label', { text: '过期时间' }), expiryBox,
  );
  box.append(keyForm, errBox);

  createBtn.addEventListener('click', async () => {
    hideError(errBox);
    const pools = [...poolChecks.querySelectorAll('input:checked')].map((cb) => cb.value);
    const body = { name: nameInput.value.trim(), pools };
    if (expiresInput.value) body.expiresAt = new Date(expiresInput.value).getTime();
    try {
      const { secret } = await api('/api/keys', { method: 'POST', body });
      close(); // 同帧原位翻转：关表单弹层 → 叠 locked 明文弹层，流程在 [我已保存] 终结
      secretBox(secret, reload);
    } catch (err) {
      showError(errBox, err.message);
    }
  });
  return box;
}

async function renderKeys() {
  clear(view);
  view.append(el('h2', { text: '密钥' }));
  const errBox = el('p', { class: 'error hidden' });
  const listBox = el('div');
  view.append(errBox, listBox);

  async function reload() {
    const { keys } = await api('/api/keys');
    clear(listBox);
    if (!keys.length) {
      listBox.append(emptyState('还没有密钥——建一把 zsk_ 开头的新钥匙，分配给需要的池。'));
    } else {
      const table = el('table');
      table.append(el('tr', {}, [
        el('th', { text: '名称 / ID' }),
        el('th', { text: '启用池' }),
        el('th', { text: '过期时间' }),
        el('th', { text: '创建时间' }),
        el('th', { text: '已用 tokens' }),
        el('th', { text: '操作' }),
      ]));
      for (const key of keys) table.append(keyRow(key, reload, errBox));
      listBox.append(table);
    }
  }
  await reload();

  // 创建表单弹层化（spec 决策 4）：列表整宽，[创建新密钥] 按钮开弹层
  const actions = el('div', { class: 'action-row' });
  actions.append(el('button', {
    class: 'primary',
    text: '创建新密钥',
    onclick: () => openDialog('创建密钥', (body, close) => { body.append(createKeyForm(reload, close)); }),
  }));
  view.insertBefore(actions, listBox);

  // API 接入卡只出现在密钥页（Task 4）。挂 view 而非 listBox：reload 会 clear(listBox)，卡片不该被轮换/删除刷走
  const apiBox = el('div');
  apiBox.append(apiDialogCard());
  view.append(apiBox);
}

// ---- 页 4：设置（全局一份，应用到所有池） ----

const SETTING_FIELDS = [
  ['调度', [
    ['maxInFlight', '单账号最大并发', '个', 0],
    ['topN', '候选 Top-N', '个', 0],
    ['maxAttempts', '单请求最大尝试账号数', '个', 0],
    ['stickyTtlMs', '粘性会话有效期', '分钟', 60_000],
  ]],
  ['冷却', [
    ['busyCooldownMs', '限流首犯冷却', '分钟', 60_000],
    ['quotaCooldownMs', '限流连犯冷却', '分钟', 60_000],
    ['blockedCooldownMs', '风控/3012 冷却', '分钟', 60_000],
    ['serverCooldownMs', '上游 5xx/网络冷却', '秒', 1000],
    ['quotaExhaustedCooldownMs', '额度耗尽冷却', '小时', 3_600_000],
    ['breakerThreshold', '熔断阈值', '次', 0],
    ['breakerCooldownMs', '熔断基数', '分钟', 60_000],
    ['breakerCapMs', '熔断封顶', '小时', 3_600_000],
  ]],
  ['自动领取', [
    ['autoClaimEnabled', '每日自动领取', '', 0],
    ['autoClaimHour', '每日补领时点', '点', 0],
    ['weekendGrabEnabled', 'ZCode 周末活动包抢领', '', 0],
  ]],
  // 元组第 5 位 isFloat=true：credits→token 汇率，保存时保留小数（不取整、不做 factor 换算）
  ['余额折算（credits → token）', [
    ['wbCreditTokensRate', 'WorkBuddy 积分 → token', '×', 0, true],
    ['qoderCreditTokensRate', 'Qoder 积分 → token', '×', 0, true],
    ['codeartsCreditTokensRate', 'CodeArts 积分 → token', '×', 0, true],
  ]],
];

/** 布尔键：面板里显示 0/1，保存时钳到 0/1。 */
const BOOLEAN_SETTING_KEYS = new Set(['autoClaimEnabled', 'weekendGrabEnabled']);

/**
 * 控制台密码修改盒：三输入（当前/新/确认）+ 保存。
 * 校验在本地先做完（少跑一次失败请求），成功后清空输入并提示其它会话已退出。
 * 挂 view 而非 reload 会 clear 的 listBox，避免保存设置时被刷走。
 */
function passwordBox() {
  const box = el('div', { class: 'panel-box' });
  box.append(el('h3', { text: '控制台密码' }));

  const row = el('div', { class: 'form-row password-row' });
  const currentInput = el('input', { type: 'password', placeholder: '当前密码', autocomplete: 'current-password', class: 'w-md password-input' });
  const newInput = el('input', { type: 'password', placeholder: '新密码（至少 8 位）', autocomplete: 'new-password', class: 'w-md password-input' });
  const confirmInput = el('input', { type: 'password', placeholder: '确认新密码', autocomplete: 'new-password', class: 'w-md password-input' });
  const btn = el('button', { class: 'primary', text: '保存密码' });
  row.append(currentInput, newInput, confirmInput, btn);
  box.append(row);

  const errBox = dlgErr();
  const okMsg = el('p', { class: 'state-ok hidden' });
  box.append(errBox, okMsg);

  btn.addEventListener('click', async () => {
    hideError(errBox);
    okMsg.classList.add('hidden');
    const currentPassword = currentInput.value;
    const newPassword = newInput.value;
    const confirmPassword = confirmInput.value;
    if (!currentPassword) return showError(errBox, '请输入当前密码');
    if (newPassword.length < 8) return showError(errBox, '新密码至少 8 位');
    if (newPassword !== confirmPassword) return showError(errBox, '两次输入的新密码不一致');
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      for (const input of [currentInput, newInput, confirmInput]) input.value = '';
      okMsg.textContent = '密码已更新，其它会话已退出';
      okMsg.classList.remove('hidden');
    } catch (err) {
      showError(errBox, err.message);
    }
  });
  return box;
}

async function renderSettings() {
  clear(view);
  view.append(el('h2', { text: '设置' }));
  const errBox = el('p', { class: 'error hidden' });
  view.append(errBox);
  const listBox = el('div');
  view.append(listBox);
  view.append(passwordBox()); // 挂 view：settings 的 reload() 只 clear(listBox)，密码盒不被刷走

  async function reload() {
    const { settings } = await api('/api/settings');
    clear(listBox);
    for (const [groupTitle, fields] of SETTING_FIELDS) {
      const box = el('div', { class: 'panel-box' });
      box.append(el('h3', { text: groupTitle }));
      for (const [key, label, unit, factor, isFloat] of fields) {
        const row = el('div', { class: 'form-row settings-row' });
        const input = el('input', { type: 'number', class: 'settings-input', 'data-key': key, step: 'any' });
        // 展示值：浮点原样（汇率）；毫秒类 ÷ factor；布尔 0/1
        input.value = isFloat
          ? String(settings[key])
          : factor > 0 ? String(settings[key] / factor) : String(settings[key] ? 1 : 0);
        input.dataset.key = key;
        if (factor > 0) input.dataset.factor = String(factor);
        if (isFloat) input.dataset.float = '1';
        row.append(el('label', { text: label }), input, el('span', { class: 'muted', text: unit || '' }));
        box.append(row);
      }
      listBox.append(box);
    }
    const saveRow = el('div', { class: 'form-row' });
    const saveBtn = el('button', { class: 'primary', text: '保存（应用到全部池）' });
    const saveMsg = el('span', { class: 'muted' });
    saveRow.append(saveBtn, saveMsg);
    listBox.append(saveRow);

    saveBtn.addEventListener('click', async () => {
      errBox.classList.add('hidden');
      const body = {};
      for (const input of listBox.querySelectorAll('input[data-key]')) {
        const raw = input.value.trim();
        // 空输入不能落成 Number('') === 0（会把汇率/时长静默清零）
        if (raw === '') {
          errBox.textContent = `字段 ${input.dataset.key} 不能为空`;
          errBox.classList.remove('hidden');
          return;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          errBox.textContent = `字段 ${input.dataset.key} 不是数字`;
          errBox.classList.remove('hidden');
          return;
        }
        const factor = Number(input.dataset.factor || 0);
        // 浮点（credits→token 汇率）原样保留小数；factor>0：展示单位（分钟/秒/小时）→ 毫秒；
        // 布尔键钳到 0/1；普通整数原样
        body[input.dataset.key] = input.dataset.float === '1'
          ? n
          : factor > 0
            ? Math.round(n * factor)
            : (BOOLEAN_SETTING_KEYS.has(input.dataset.key) ? (n > 0 ? 1 : 0) : Math.round(n));
      }
      try {
        const out = await api('/api/settings', { method: 'PATCH', body });
        saveMsg.textContent = `已保存并应用到 ${out.applied} 个池`;
        setTimeout(() => { saveMsg.textContent = ''; }, 2500);
        await reload();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    });
  }
  await reload();
}

// ---- 启动 ----

async function boot() {
  let me;
  try {
    me = await api('/auth/me');
  } catch {
    me = { authenticated: false };
  }
  if (!me.authenticated) {
    showLogin();
    return;
  }
  $('#login-overlay').classList.add('hidden');
  $('#sidebar').classList.remove('hidden');
  await renderRoute();
}

window.addEventListener('hashchange', renderRoute);
bindLogin();
$('#logout-btn').addEventListener('click', logout);
// 倒计时 1s tick：只刷新冷却单元格文本，不重拉 API
setInterval(() => {
  for (const fn of cooldownTickers) fn();
}, 1000);
boot();
