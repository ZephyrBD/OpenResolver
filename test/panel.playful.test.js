import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDataDir, startPanel } from './helpers/panel.mjs';

/** Playful Color 视觉重构（Design-md.md）回归：字体资产 / 设计令牌 / accent 轮换 / 品牌结构。 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'public');
const FONT_REL = path.join('fonts', 'InterVariable.woff2');

function readPublic(...parts) {
  return fs.readFileSync(path.join(PUBLIC_DIR, ...parts), 'utf8');
}

/** 函数体切片：从 `function name` 起到下一个顶层 function/const/区块注释，供 grep 断言圈定作用域。 */
function fnSrc(src, name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start > -1, `app.js 缺函数 ${name}`);
  const rest = src.slice(start + 1);
  const m = rest.match(/\n(?:async function |const |\/\/ ----)/);
  return src.slice(start, m ? start + 1 + m.index : src.length);
}

test('panel.playful: style.css 采用 Playful Color 设计令牌，旧深色主题清零', () => {
  const css = readPublic('style.css');
  // spec 逐字值（Design-md.md §2）
  for (const hex of ['#ffffff', '#fafafa', '#0f0f14', '#6e6e78', '#e5e5ea', '#0acf83', '#f24e1e', '#a259ff', '#ff7262', '#1abcfe']) {
    assert.ok(css.includes(hex), `style.css 缺品牌/中性色 ${hex}`);
  }
  // 深色主题残留清零（Design-md.md §7 Don't: dark-by-default）
  for (const hex of ['#10151b', '#1a212b', '#2a3442', '#8494a7', '#4da3ff', '#e5646c', '#e5a54b']) {
    assert.ok(!css.includes(hex), `style.css 残留深色主题色 ${hex}`);
  }
  // @font-face 指向本地 Inter
  assert.match(css, /@font-face[\s\S]*InterVariable\.woff2/);
  // Five-color 品牌棱镜按页轮换（spec §2）
  for (const page of ['dashboard', 'accounts', 'keys', 'settings']) {
    assert.match(css, new RegExp(`data-page=["']?${page}`), `style.css 缺 [data-page=${page}] accent 轮换`);
  }
  // 全站无明显小圆角（Don't: 0–4px 太冷；999 pill 除外）
  assert.ok(!/(?:^|[^-])border-radius:\s*[0-7](?:\.\d+)?px/m.test(css), 'style.css 出现 <8px 硬圆角');
  // 响应式：768px 断点堆叠（spec §8）
  assert.match(css, /@media[^{]*\(max-width:\s*768px\)/);
});

test('panel.playful: 登录提交按钮是 primary（走查回归：不能画成描边 secondary）', () => {
  const css = readPublic('style.css');
  // 使用非响应式块里的主选择器断言（粗匹配即可：#login-form 下按钮实心 accent）
  const rule = css.match(/#login-form > button[^{]*\{[^}]*\}/);
  assert.ok(rule, 'style.css 缺 #login-form > button 的 primary 样式');
  assert.match(rule[0], /--accent-page/);
  assert.match(rule[0], /#ffffff/, '登录提交按钮白字缺失');
});

test('panel.playful: accent 文本色走 --accent-ink（评审 I-1：白底文本对比度 ≥ AA 的意图）', () => {
  const css = readPublic('style.css');
  // 墨色 token：accent-page 调暗派生，随页轮换自动重算
  assert.match(css, /--accent-ink:\s*color-mix\(\s*in\s+srgb,\s*var\(--accent-page\)\s*\d+%?,\s*#0f0f14\)/, '缺 --accent-ink 派生 token');
  // "色即文本"场景（链接 / secondary 按钮字 / nav 激活字 / tabs 字）不用原色 accent-page
  for (const sel of ['a {', 'button {', 'button:hover {', '#nav a.active {']) {
    const idx = css.indexOf(sel);
    assert.ok(idx > -1, `style.css 缺选择器 ${sel}`);
    // (^|[^-]) 前置哨兵：避免误伤 "border-color: var(--accent-page)"——字色断言只看 color 属性本身
    const block = css.slice(idx, css.indexOf('}', idx));
    assert.ok(!/(^|[^-])color:\s*var\(--accent-page\)/.test(block), `${sel} 文本色直接用 accent-page（对比度不足）`);
  }
  const aIdx = css.indexOf('a {');
  const aBlock = css.slice(aIdx, css.indexOf('}', aIdx));
  assert.match(aBlock, /color:\s*var\(--accent-ink\)/, '链接色应为 --accent-ink');
});

test('panel.playful: font 简写不含混入的 inherit（评审 I-2：CSS-wide keyword 混进多值简写致整条声明作废；font: inherit 全值继承合法）', () => {
  const css = readPublic('style.css');
  // inherit 不是冒号后第一个值 → 非法；"font: inherit" 单独出现 → 合法放行
  assert.ok(!/font:\s+(?!inherit\b)[^;]*\binherit/.test(css), 'font 简写里混了 inherit → 整条被丢弃');
});

test('panel.playful: Inter OFL 许可文件随字体分发（评审 M-7/合规必修）', () => {
  const lic = fs.readFileSync(path.join(PUBLIC_DIR, 'fonts', 'OFL.txt'), 'utf8');
  assert.match(lic, /SIL OPEN FONT LICENSE/i);
  assert.match(lic, /The Inter Project Authors/);
});

test('panel.playful: app.js 挂钩页面 accent + SVG 换品牌色 + 空状态插画', () => {
  const js = readPublic('app.js');
  // [data-page] CSS 钩子：路由 → body.dataset.page（slice 掉 #）
  assert.match(js, /dataset\.page\s*=/, 'app.js 缺 dataset.page 挂钩');
  // 旧深色主题 SVG 硬编码清零
  for (const hex of ['#2a3442', '#8494a7', '#4da3ff', '#e5646c', '#e5a54b']) {
    assert.ok(!js.includes(hex), `app.js 残留深色 SVG 色 ${hex}`);
  }
  // 新品牌色落位（图表蓝 / 趋势线红 / 额度三档 / 网格 / 图文字）
  for (const hex of ['#ff7262', '#f24e1e', '#1abcfe', '#e5e5ea', '#6e6e78']) {
    assert.ok(js.includes(hex), `app.js 缺品牌 SVG 色 ${hex}`);
  }
  // 空状态几何插画助手
  assert.match(js, /function emptyState/, 'app.js 缺 emptyState 助手');
});

test('panel.playful: index.html 品牌几何 logo + 结构红线不破', () => {
  const html = readPublic('index.html');
  // brand 内联几何小 logo（spec §4 扁平向量）
  assert.match(html, /<span class="brand"><svg/i, 'brand 缺内联 SVG logo');
  // script 外链 module + 样式表路径原样（panel.frontend.test.js 依赖）
  assert.match(html, /src="\/panel\/app\.js"/);
  assert.match(html, /href="\/panel\/style\.css"/);
  // 4 项导航
  for (const route of ['#\/dashboard', '#\/accounts', '#\/keys', '#\/settings']) {
    assert.match(html, new RegExp(`href="${route}"`), `nav 缺 ${route}`);
  }
});

test('panel.playful: 侧栏外壳结构', () => {
  const html = readPublic('index.html');
  // 外壳换构（2026-11-05 spec 决策 1）：顶栏 → 左侧固定侧栏
  assert.match(html, /<aside id="sidebar" class="layout-sidebar/, '缺 aside#sidebar.layout-sidebar');
  assert.ok(!html.includes('id="topbar"'), '旧 header#topbar 残留');
  assert.ok(!html.includes('sidebar-pools'), 'Task 4：侧栏池灯容器 #sidebar-pools 应删除');
  assert.match(html, /<main id="view" class="layout-main"><\/main>/, '缺 main#view.layout-main');
  // #nav 仍在侧栏内且 4 个路由链接
  const sidebar = html.match(/<aside id="sidebar"[\s\S]*?<\/aside>/);
  assert.ok(sidebar, '无法提取 aside#sidebar 块');
  assert.match(sidebar[0], /<nav id="nav">/);
  for (const route of ['#/dashboard', '#/accounts', '#/keys', '#/settings']) {
    assert.match(sidebar[0], new RegExp(`href="${route}"`), `侧栏 nav 缺 ${route}`);
  }
  assert.match(sidebar[0], /id="logout-btn"/, '登出按钮应在侧栏内');
  assert.match(sidebar[0], /class="brand"><svg/i, 'brand SVG logo 应保留在侧栏顶部');
  // Task 4：池灯容器删除后登出按钮由 margin-top: auto 钉在侧栏底部
  const css = readPublic('style.css');
  const logoutRule = css.match(/#logout-btn\s*\{[^}]*\}/);
  assert.ok(logoutRule, 'style.css 缺 #logout-btn');
  assert.match(logoutRule[0], /margin-top:\s*auto/, '#logout-btn 应 margin-top: auto 钉在侧栏底部');
  for (const token of ['#sidebar-pools', '.pool-dot']) {
    assert.ok(!css.includes(token), `style.css 残留池灯规则 ${token}`);
  }
});

test('panel.playful: app.js 弹层助手（Task 4 起侧栏池灯已移除）', () => {
  const js = readPublic('app.js');
  // Task 2：openDialog 弹层基石（Task 3~5 依赖，接口逐字）
  assert.match(js, /function openDialog/, 'app.js 缺 openDialog');
  assert.match(js, /addEventListener\('cancel'/, 'openDialog 缺 cancel（Esc）处理');
  assert.match(js, /dialog\.remove\(\)/, 'close 应 dialog.remove()');
  // Task 4：池灯整套（函数/状态映射/DOM 容器/30s 轮询）清零
  for (const token of ['renderPoolDots', 'poolDotState', 'sidebar-pools', 'pool-dot']) {
    assert.ok(!js.includes(token), `app.js 残留池灯实现 ${token}`);
  }
  assert.ok(!/setInterval\(\s*renderPoolDots/.test(js), '池灯 30s 轮询应删除');
  // 侧栏快捷入口记忆键仍被账号页沿用（池灯删除不动账号页下拉）
  assert.match(js, /ugw-accounts-pool/, '账号页池下拉仍应读 ugw-accounts-pool');
});

test('panel.playful: 仪表盘整宽布局 + 14 天趋势纯 SVG（Task 4）', () => {
  const js = readPublic('app.js');
  const css = readPublic('style.css');
  const dash = between(js, 'async function renderDashboard', 'function trendChart');
  // 顺序：h2 仪表盘 → 今日用量（卡带）→ 14 天趋势 → 各池额度 → 模型列表；全部整宽，无分栏
  const order = [
    "text: '仪表盘'",
    "text: '今日用量'",
    "class: 'cards'",
    "text: '14 天趋势'",
    'trendChart(',
    "text: '各池额度'",
    'modelsTable()',
  ];
  let cursor = -1;
  for (const marker of order) {
    const idx = dash.indexOf(marker);
    assert.ok(idx > cursor, `仪表盘顺序漂移：${marker} 未出现在预期位置`);
    cursor = idx;
  }
  assert.ok(!dash.includes('grid-2-1'), '仪表盘不应再有 grid-2-1 分栏');
  assert.ok(!css.includes('.grid-2-1'), 'style.css .grid-2-1 规则应删除');
  assert.ok(!js.includes('function poolCard'), '池卡行（poolCard）应从仪表盘移除');
  // 弹层内容边界（builder check 裁定 5）：弹层 = Base URL + curl；模型表留在页面整宽
  assert.match(js, /function modelsTable/, '模型表应独立为 modelsTable 留在仪表盘整宽');

  // trendChart 重写：几何常量 / 无 preserveAspectRatio / 双轴 / 图例
  const chart = between(js, 'function trendChart', 'function quotaBar');
  assert.ok(!chart.includes('preserveAspectRatio'), '趋势图不应再设置 preserveAspectRatio');
  for (const decl of ['const W = 960;', 'const H = 300;', 'const PAD_L = 56;', 'const PAD_R = 44;', 'const PAD_T = 16;', 'const PAD_B = 34;']) {
    assert.ok(chart.includes(decl), `趋势图缺几何常量「${decl}」`);
  }
  assert.match(chart, /Intl\.NumberFormat\('zh-CN'/, '左轴请求数刻度应整数化（zh-CN 千分位）');
  for (const tick of ["'0%'", "'50%'", "'100%'"]) {
    assert.ok(chart.includes(tick), `右轴错误率缺刻度 ${tick}`);
  }
  assert.match(chart, /'text-anchor': 'end'/, '右轴文字应 text-anchor: end');
  assert.match(chart, /fill: '#1abcfe'/, '请求量柱应为品牌蓝 #1abcfe');
  assert.match(chart, /stroke: '#ff7262'/, '错误率折线应为品牌红 #ff7262');
  assert.match(chart, /'stroke-width': 2/, '错误率折线线宽应为 2');
  assert.match(chart, /i % 2 === 0/, '日期轴应每 2 天标一个（i % 2 === 0）');
  assert.match(chart, /'font-size': 11/, '日期/刻度字号应为 11');
  assert.match(chart, /textContent = '请求量'/, '图例缺「请求量」');
  assert.match(chart, /textContent = '错误率'/, '图例缺「错误率」');
  assert.match(chart, /暂无数据/, '空数据仍应显示「暂无数据」');

  // CSS：整宽自适应高度（删除固定 220px）
  const chartRule = css.match(/svg\.chart\s*\{[^}]*\}/);
  assert.ok(chartRule, 'style.css 缺 svg.chart');
  assert.match(chartRule[0], /width:\s*100%/, 'svg.chart 应整宽');
  assert.match(chartRule[0], /height:\s*auto/, 'svg.chart 高度应自适应');
  assert.ok(!chartRule[0].includes('height: 220px'), 'svg.chart 不应固定 220px 高');
});

test('panel.playful: API 接入卡只出现在密钥页（Task 4）', () => {
  const js = readPublic('app.js');
  // 仪表盘不再挂卡
  const dash = between(js, 'async function renderDashboard', 'function trendChart');
  assert.ok(!dash.includes('apiDialogCard'), 'renderDashboard 不应再引用 apiDialogCard');
  // 密钥页在表格之后挂卡
  const keysSrc = between(js, 'async function renderKeys', '// ---- 页 4');
  assert.match(keysSrc, /apiDialogCard\(\)/, 'renderKeys 应挂 API 接入卡');
  // 文案：密钥就在本页上方列表创建
  const contentSrc = between(js, 'function apiDialogContent', 'function apiDialogCard');
  assert.ok(contentSrc.includes('，密钥在上方列表创建。'), 'API 接入说明应指向密钥页上方列表');
  assert.ok(!contentSrc.includes('密钥在「密钥」页创建'), '旧文案「密钥在「密钥」页创建。」应清零');
});

test('panel.playful: 账号页动作行 + onboard/新增/领取弹层化 + 通用确认弹层（Task 4）', () => {
  const js = readPublic('app.js');
  const css = readPublic('style.css');
  // 通用确认弹层（Task 5 密钥页复用，签名钉死）
  assert.match(js, /function confirmDialog/, 'app.js 缺 confirmDialog');
  assert.match(js, /confirmDialog\(message, \{ danger = false \} = \{\}\)/, 'confirmDialog 签名漂移');
  assert.ok(!/\bconfirm\(/.test(js), 'window.confirm 残留（全站应走 confirmDialog）');
  // 登录接入弹层：有 poll 端点的流授权链接不展示 → window.open
  assert.match(js, /window\.open\(/, '缺 window.open（打开授权页面）');
  assert.match(js, /autoPollOnboardBox/, 'autoPollOnboardBox 应保留（迁移不删除）');
  assert.ok(!js.includes('登录即领取'), '旧说明文案「登录即领取」应清零');
  // 池下拉初始值读 sessionStorage（侧栏池灯快捷入口的记忆键）
  assert.match(js, /sessionStorage\.getItem\('ugw-accounts-pool'\)/, '池下拉未读 sessionStorage 初始值');
  // tabs → 下拉 + 动作行
  assert.ok(!js.includes('renderTabs'), 'renderTabs 应删除（下拉取代 tabs）');
  assert.ok(!css.includes('.tabs'), 'style.css .tabs 规则应随结构废弃删除');
  assert.match(js, /action-row/, 'app.js 缺动作按钮行');
  assert.match(css, /\.action-row\s*\{/, 'style.css 缺 .action-row');
  assert.match(css, /\.dlg-actions\s*\{/, 'style.css 缺 .dlg-actions');
  assert.match(css, /\.page-head\s*\{/, 'style.css 缺 .page-head');
  // 账号表 ID/标签列下挂邮箱行
  assert.match(js, /acc\.email/, '账号表缺邮箱行（acc.email）');

  // Qoder 登录只剩 PAT：device flow 的函数与端点清零，国内/国际取 PAT 链接都在
  assert.ok(!js.includes('qoderDeviceOnboardBox'), 'qoderDeviceOnboardBox 应删除（PAT only）');
  assert.ok(!js.includes('/api/onboard/qoder-device'), 'qoder device flow 端点应清零');
  for (const url of ['https://qoder.cn/account/integrations', 'https://qoder.com/account/integrations']) {
    assert.ok(js.includes(url), `Qoder PAT 缺取用链接 ${url}`);
  }
  assert.ok(js.includes('获取 PAT'), 'Qoder PAT 缺「获取 PAT」链接文案');
  // 设备授权页 URL 不得以任何形式回到前端
  assert.ok(!js.includes('device/selectAccounts'), '前端不应再渲染 device/selectAccounts');
  // 「新增账号」清零 → zcode 独享「手动导入」入口
  assert.ok(!js.includes("text: '新增账号'"), '「新增账号」按钮应改名「手动导入」');
  assert.ok(!js.includes('新增账号 ${current}'), '旧「新增账号」弹层标题应清零');
  const actionRowSrc = between(js, "if (current === 'zcode') {", "text: '领取 / 签到'");
  assert.match(actionRowSrc, /text: '手动导入'/, 'zcode 动作行应提供「手动导入」');
  assert.match(actionRowSrc, /openDialog\(`手动导入 \$\{current\}`/, '弹层标题应为「手动导入 ${current}」');
  assert.ok(!actionRowSrc.includes('qoder'), '手动导入入口不应再给 qoder 池');
});

test('panel.playful: Task 4 返工——弹层内错误可见 / claim 终态 / 动作行位置（fix round 1）', () => {
  const js = readPublic('app.js');
  // I-1：进弹层的盒自建错误节点，不再吃页面级 errBox——dlgErr 节点必须 append 进盒内
  assert.match(js, /function dlgErr\(\)/, '缺 dlgErr 弹层内错误节点工厂');
  const fnOf = (name, next) => js.slice(js.indexOf(`function ${name}`), js.indexOf(`function ${next}`));
  for (const [name, next] of [
    ['addAccountForm', 'traeOnboardBox'],
    ['traeOnboardBox', 'workbuddyOnboardBox'],
    ['workbuddyOnboardBox', 'codeartsOnboardBox'],
    ['codeartsOnboardBox', 'autoPollOnboardBox'],
    ['qoderOnboardBox', 'onboardDialogContent'],
  ]) {
    const fn = fnOf(name, next);
    assert.match(fn, /dlgErr\(\)/, `${name} 缺弹层内错误节点`);
    assert.match(fn, /box\.append\([^)]*errBox\)/, `${name} 未把错误节点挂进盒内`);
  }
  // 弹层构建入口不得再传页面级 errBox
  const renderAccountsSrc = fnOf('renderAccounts', 'secretBox');
  assert.ok(!renderAccountsSrc.includes('onboardDialogContent(current, reload, errBox)'), 'onboardDialogContent 不应收页面级 errBox');
  assert.ok(!renderAccountsSrc.includes('addAccountForm(current, reload, errBox'), 'addAccountForm 不应收页面级 errBox');

  // I-2：claimBox 终态——全成功 close、混失败保持打开 + 按钮恢复
  const claimFn = fnOf('claimBox', 'qoderOnboardBox');
  assert.match(claimFn, /if \(!failed\)\s*\{\s*close\(\)/, '全成功路径缺 close()');
  assert.match(claimFn, /btn\.disabled = false; \/\/ 混有失败/, '混失败路径按钮未恢复');
  assert.match(claimFn, /r\.status === 'failed'\) failed\+\+/, '缺 failed 计数');
  // tried 明细结构不破坏（3007 展示回归锚点）
  assert.match(claimFn, /detail\?\.tried/, '领取结果展示候选摘要（tried）');

  // I-3：动作行插在表前（头部 → 动作行 → 表 → 明细）
  assert.match(renderAccountsSrc, /insertBefore\(actions, tableBox\)/, '动作行应插在 tableBox 前');

  // M-6：refreshQuota 显式引用，不用 querySelector 拿 CSS 类当契约
  assert.match(renderAccountsSrc, /refreshQuota = quotaBox\.refreshQuota/, '额度明细刷新应走显式引用');
  assert.ok(!renderAccountsSrc.includes("detailsWrap.querySelector('.panel-box')"), '不应 querySelector .panel-box（CSS 类当契约）');

  // M-2：空结果直接关，不 append 后同 tick close
  const emptyBranch = claimFn.slice(claimFn.indexOf('if (!data.results?.length)'), claimFn.indexOf('const table', claimFn.indexOf('if (!data.results?.length)')));
  assert.ok(!emptyBranch.includes('没有可领取的账号'), '空结果不应 append 后同 tick close（消息读不到）');

  // M-1：括号句式时效说明清零（信息保留为独立句）
  assert.ok(!/（[^）]*10 分钟内有效）/.test(js), '「（…10 分钟内有效）」括号句式残留');
  assert.ok(js.includes('10 分钟内有效'), '时效信息应保留（独立句式）');
});

test('panel.playful: 密钥页弹层化——创建弹层原位翻明文 locked 态 + 我已保存（Task 5）', () => {
  const js = readPublic('app.js');
  const keysSrc = fnSrc(js, 'renderKeys');
  // 创建走弹层：内联 panel-box 创建表单清零，页面 = 列表 + [创建新密钥] 按钮
  assert.match(js, /创建新密钥/, '缺 [创建新密钥] 按钮');
  assert.ok(!keysSrc.includes('panel-box'), 'renderKeys 内不应再有内联创建表单盒');
  // 成功后弹层原位翻转为明文：secretBox 内容进弹层 + [复制] + [我已保存]
  assert.ok(js.includes('我已保存'), '缺 [我已保存] 按钮（locked 态唯一出口）');
  // 明文态必须 locked：Esc/遮罩不可关，只认"我已保存"
  const secretSrc = fnSrc(js, 'secretBox');
  assert.match(secretSrc, /locked: true/, '密钥明文弹层必须 locked: true');
  assert.match(secretSrc, /我已保存/, 'secretBox 弹层缺 [我已保存]');
  assert.match(secretSrc, /text: '复制'/, 'secretBox 弹层缺 [复制]');
  // 旧页面内 secret-box 直插 DOM 的路径清零（明文只存在于弹层内）
  assert.ok(!keysSrc.includes("view.querySelector('.secret-box')"), 'renderKeys 旧明文插入路径残留');
  assert.ok(!/view\.insertBefore\(secretBox/.test(js), 'secretBox 页面直插残留（明文只应进弹层）');
  // 轮换/删除确认走 confirmDialog danger（签名已有，钉住调用形状）
  const rowSrc = fnSrc(js, 'keyRow');
  assert.match(rowSrc, /confirmDialog\([^)]+, \{ danger: true \}\)/, '轮换/删除缺 confirmDialog danger 确认');
  // 创建成功 → 同帧关表单弹层 + 开 locked 明文弹层（原位翻转，流程在"我已保存"终结）
  const createSrc = fnSrc(js, 'createKeyForm');
  assert.match(createSrc, /close\(\);[^\n]*\n\s*secretBox\(secret, reload\)/, '创建成功应同帧关表单弹层并开 locked 明文弹层');
});

test('panel.playful: 终审 fix 批——onboard 弹窗拦截兜底 / 弹层 max-height（池灯同页跳转随 Task 4 删除）', () => {
  const js = readPublic('app.js');
  const css = readPublic('style.css');

  // I-2：onboard window.open 脱离用户手势被拦截 → 双兜底
  // a) 点击时同步开空白占位页（占住手势），await genLink 后再指 location。
  //    不能带 noopener——带则 window.open 返回 null 拿不到窗口引用，占位失效
  const pollSrc = fnSrc(js, 'autoPollOnboardBox');
  const clickBranch = pollSrc.slice(pollSrc.indexOf("openBtn.addEventListener('click'"));
  assert.ok(clickBranch.includes("window.open('', '_blank')"),
    "点击时须同步 window.open('', '_blank') 占住用户手势（慢于 5s 后 open 会被弹窗拦截；noopener 会让返回值为 null）");
  assert.ok(!clickBranch.includes("window.open('', '_blank', 'noopener')"),
    "占位 open 不能带 noopener（返回 null 拿不到窗口引用）；等效隔离应剪 opener");
  assert.ok(clickBranch.includes('w.opener = null'), '占位页须剪断 opener（等效 noopener 的安全语义）');
  assert.ok(clickBranch.includes('w.location = url'), 'genLink 返回后应给占位窗口指授权 URL');
  // b) 占位也被拦（返回 null）→ 失败态出"弹窗被拦截"+ 链接文本兜底（失败态出字符合"只出失败一行"裁定）
  assert.ok(clickBranch.includes('弹窗被拦截'), 'window.open 返回 null 时须提示"弹窗被拦截"');
  assert.ok(clickBranch.includes("el('a', { href: url, text: url })"), '兜底分支须展示链接文本节点供手动打开');

  // I-3：弹层长内容（claim tried 明细）矮视口下必须可滚
  const dlgRule = css.match(/dialog\.dlg\s*\{[^}]*\}/);
  assert.ok(dlgRule, 'style.css 缺 dialog.dlg 基础样式');
  assert.ok(dlgRule[0].includes('max-height: calc(100vh - 48px)'),
    'dialog.dlg 缺 max-height: calc(100vh - 48px) 视口兜底');
  assert.ok(dlgRule[0].includes('overflow-y: auto'),
    'dialog.dlg 缺 overflow-y: auto（超高内容须可滚）');
});

test('panel.playful: 设置页文案极简——说明性括号注释清零，结构不动（Task 5）', () => {
  const js = readPublic('app.js');
  const settingsSrc = fnSrc(js, 'renderSettings');
  // factor 换算类括号说明文案清零（数据自明）
  for (const phrase of ['每日自动领取开关（1 开 / 0 关）', '每日补领时点（北京时间 0-23 点）', 'ZCode 周末活动包抢领（1 开 / 0 关）', '熔断阈值（连犯次数）']) {
    assert.ok(!js.includes(phrase), `设置说明文案残留「${phrase}」`);
  }
  // 结构不动：分组 panel-box + form-row + data-factor 换算管线原样
  assert.match(settingsSrc, /panel-box/, '设置分组盒结构应保留');
  assert.match(settingsSrc, /dataset\.factor/, 'factor 换算管线应保留');
  assert.match(settingsSrc, /BOOLEAN_SETTING_KEYS/, '布尔键钳制应保留');
  assert.match(settingsSrc, /保存（应用到全部池）/, '保存按钮文案应保留');
});

test('panel.playful: 弹层完整视觉 + 响应式收尾（Task 6）', () => {
  const css = readPublic('style.css');
  const js = readPublic('app.js');
  // 入场动画：@keyframes fade+scale，dialog[open] 挂载（150ms 级，prefers-reduced-motion 单独禁）
  assert.match(css, /@keyframes\s+dlg-in/, 'style.css 缺 dialog 入场 @keyframes dlg-in');
  assert.match(css, /dialog\.dlg\[open\]\s*\{[^}]*animation:\s*dlg-in\s+150ms/, 'dialog.dlg[open] 缺 animation: dlg-in 150ms');
  assert.match(css, /dialog\.dlg\{[^}]*opacity:\s*0(?![\d.])[^}]*transform:\s*scale\(?0\.9|dlg-in[\s\S]*?from\s*\{[^}]*opacity:\s*0/, '入场动画应含 fade（opacity 0 起）+ scale');
  // backdrop 遮罩：0.35 透明度墨色
  assert.match(css, /dialog\.dlg::backdrop\s*\{[^}]*rgba\(15,\s*15,\s*20,\s*0\.35\)/, 'dialog::backdrop 缺 0.35 墨色遮罩');
  // prefers-reduced-motion：全局 * { transition: none } 盖不住 @keyframes（animation 非 transition）——
  // 必须单独禁掉 dialog 入场动画
  const prmIdx = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(prmIdx > -1, 'style.css 缺 prefers-reduced-motion 块');
  const prmBlock = css.slice(prmIdx);
  assert.match(prmBlock, /animation:\s*none\s*(!important)?/, 'prefers-reduced-motion 未禁 dialog @keyframes 动画（transition 兜底盖不住 animation）');
  // 标题行：h3 是 dialog.dlg 直接子元素（openDialog 产物），弹层态样式存在
  assert.match(css, /dialog\.dlg > h3\s*\{/, 'style.css 缺 dialog.dlg > h3 标题行样式');
  // 按钮行：JS 实际类名 .dlg-actions（confirmDialog 产出），右对齐
  const actionsRule = css.match(/\.dlg-actions\s*\{[^}]*\}/);
  assert.ok(actionsRule, 'style.css 缺 .dlg-actions');
  assert.match(actionsRule[0], /justify-content:\s*flex-end/, '.dlg-actions 应右对齐');
  // 768px：弹层近全屏（width 92vw）
  const mqIdx = css.indexOf('@media (max-width: 768px)');
  assert.ok(mqIdx > -1);
  const mqBlock = css.slice(mqIdx);
  assert.match(mqBlock, /dialog\.dlg\s*\{[^}]*width:\s*92vw/, '768px 下弹层应近全屏（width 92vw）');
  assert.match(mqBlock, /dialog\.dlg\s*\{[^}]*max-width:\s*none/, '768px 下弹层 max-width 应放开');
  // 弹层内纵向 flex gap（.dlg-body）
  assert.match(css, /\.dlg-body\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/, '.dlg-body 应纵向 flex');
  // 死规则清理（评审遗留）：.secret-box .warning（app.js 无产出）+ .api-section h4（app.js grep 为零）
  assert.ok(!css.includes('.secret-box .warning'), '死规则 .secret-box .warning 应删除');
  assert.ok(!css.includes('.api-section'), '死规则 .api-section 应删除');
  // app.js 类名契约不破：.dlg / .dlg-body / .dlg-actions 原样
  assert.match(js, /el\('dialog', \{ class: 'dlg' \}\)/, 'openDialog 产物类名 .dlg 契约漂移');
  assert.match(js, /el\('div', \{ class: 'dlg-body' \}\)/, '.dlg-body 类名契约漂移');
  assert.match(js, /el\('div', \{ class: 'dlg-actions' \}\)/, '.dlg-actions 类名契约漂移');
});

test('panel.playful: Inter 可变字体本地打包并可由面板静态服务派发', async (t) => {
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, FONT_REL)), 'panel/public/fonts/InterVariable.woff2 不存在');
  assert.ok(fs.statSync(path.join(PUBLIC_DIR, FONT_REL)).size > 100 * 1024, 'woff2 小于 100KB，疑似下载失败');

  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const font = await fetch(`${base}/panel/fonts/InterVariable.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.ok((await font.arrayBuffer()).byteLength > 100 * 1024);
});

/** 函数体切片（Task 3 断言用）：从起点标记切到终点标记，比 fnSrc 更适合非 async 函数。 */
function between(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a > -1, `app.js 缺 ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  return src.slice(a, b > -1 ? b : src.length);
}

test('panel.playful: 名称主显示 / UUID 次显示（Task 3）', () => {
  const js = readPublic('app.js');
  const api = fs.readFileSync(path.join(PUBLIC_DIR, '..', 'api.mjs'), 'utf8');

  // 后端：导出 displayNameOf（quota/claim 路由的 label 来源）
  assert.match(api, /export function displayNameOf/, 'panel/api.mjs 缺导出 displayNameOf');
  assert.match(api, /label: displayNameOf\(acc\)/, 'quota/claim 路由未回填 label');

  // 前端助手：accountTitle / nameCell（次级 UUID 走 muted mono）
  assert.match(js, /function accountTitle/, 'app.js 缺 accountTitle');
  const nameCellSrc = between(js, 'function nameCell', 'function emptyState');
  assert.match(nameCellSrc, /muted mono/, 'nameCell 次级 UUID 应为 muted mono');
  assert.match(nameCellSrc, /text: primary/, 'nameCell 主显示用 textContent');

  // 表头：'ID / 标签' / 'ID / 名称' → '名称 / ID'（账号表 + 密钥表两处）
  assert.equal(js.split("'名称 / ID'").length - 1, 2, "账号表与密钥表表头都应为 '名称 / ID'");
  assert.ok(!js.includes('ID / 标签'), "旧表头 'ID / 标签' 应清零");
  assert.ok(!js.includes('ID / 名称'), "旧表头 'ID / 名称' 应清零");

  // 账号表首列：名称主显示（label → nickname → email → id）+ nameCell（id 次级）
  const accountRowSrc = between(js, 'function accountRow', 'function dlgErr');
  assert.match(accountRowSrc, /acc\.label \|\| acc\.nickname \|\| acc\.email \|\| acc\.id/, '账号表首列名称优先级漂移');
  assert.match(accountRowSrc, /nameCell\(/, '账号表首列应走 nameCell（名称主 / id 次）');
  // 删除确认文案用名称（名称=id 时不重复括号）
  assert.match(accountRowSrc, /确定删除账号 \$\{displayWithId\(/, '删除确认文案应以名称为主');

  // 密钥表首列：名称主显示 + id/prefix 次级；确认文案用名称
  const keyRowSrc = between(js, 'function keyRow', 'function createKeyForm');
  assert.match(keyRowSrc, /nameCell\(/, '密钥表首列应走 nameCell（名称主 / id 次）');
  assert.match(keyRowSrc, /const title = displayWithId\(key\.name, key\.id\)/, '密钥确认文案应以名称为主');
  assert.match(keyRowSrc, /确定轮换密钥 \$\{title\}/, '轮换确认文案应以名称为主');
  assert.match(keyRowSrc, /确定删除密钥 \$\{title\}/, '删除确认文案应以名称为主');

  // 额度明细：q.label 主显示 + q.account 灰字 mono 次显示；supported=false 显状态原因
  const quotaFn = between(js, 'function quotaDetailsBox', 'function claimBox');
  assert.match(quotaFn, /q\.label \|\| q\.account/, '额度明细账号列应以 label 为主');
  assert.match(quotaFn, /nameCell\(/, '额度明细账号列应走 nameCell');
  assert.match(quotaFn, /q\.supported === false/, '额度明细应按 supported===false 判分支（source==unsupported 是死分支）');
  assert.match(quotaFn, /q\.reason/, '额度明细应展示 q.reason（CodeArts 无余额接口原因）');
  assert.match(quotaFn, /q\.source === 'stale'/, 'stale 时应优先展示本轮 error 而非旧 reason');
  assert.match(quotaFn, /fmtTime\(q\.periodEnd\)\} · \$\{q\.plan\}/, '周期与套餐应并列展示（plan 不再死数据）');
  assert.ok(!quotaFn.includes('上游无余额接口'), '死分支文案「上游无余额接口」应清零');

  // 领取结果：名称主显示 + id 次级
  const claimFn = between(js, 'function claimBox', 'function qoderOnboardBox');
  assert.match(claimFn, /nameCell\(/, '领取结果账号列应走 nameCell');
  assert.match(claimFn, /accountTitle\(/, '领取结果应以 accountTitle(label/account) 为主');

  // 入库成功提示：名称（id）而非 id（名称）
  const onboardSrc = between(js, 'function traeOnboardBox', 'function autoPollOnboardBox');
  assert.match(onboardSrc, /账号已入库：\$\{displayWithId\(/, '入库提示应为 账号已入库：名称（id）');
  const autoPollSrc = between(js, 'function autoPollOnboardBox', 'function zcodeOnboardBox');
  assert.match(autoPollSrc, /账号已入库：\$\{displayWithId\(/, 'zcode/qoder 入库提示应为 名称（id）');
  const qoderSrc = between(js, 'function qoderOnboardBox', 'function onboardDialogContent');
  assert.match(qoderSrc, /账号已入库：\$\{displayWithId\(/, 'qoder PAT 入库提示应为 名称（id）');
});

test('panel.playful: dialog.dlg 基础样式不裸奔（无边框 / 20 圆角 / max-width / box-shadow）', () => {
  const css = readPublic('style.css');
  const dlgRule = css.match(/dialog\.dlg\s*\{[^}]*\}/);
  assert.ok(dlgRule, 'style.css 缺 dialog.dlg 基础样式');
  for (const decl of ['border: none', 'var(--radius-lg)', 'max-width', 'padding', 'box-shadow']) {
    assert.ok(dlgRule[0].includes(decl), `dialog.dlg 缺 ${decl}`);
  }
});

test('panel.playful: 设置页余额折算——codearts 汇率与浮点保存分支（Task 4）', () => {
  const js = readPublic('app.js');
  const fieldsSrc = between(js, 'const SETTING_FIELDS', 'async function renderSettings');
  // 新分组：credits → token 折算三行（元组第 5 位 isFloat = true）
  assert.match(fieldsSrc, /余额折算（credits → token）/, '缺「余额折算」分组');
  for (const tuple of [
    "['wbCreditTokensRate', 'WorkBuddy 积分 → token', '×', 0, true]",
    "['qoderCreditTokensRate', 'Qoder 积分 → token', '×', 0, true]",
    "['codeartsCreditTokensRate', 'CodeArts 积分 → token', '×', 0, true]",
  ]) {
    assert.ok(fieldsSrc.includes(tuple), `设置页缺浮点字段 ${tuple}`);
  }

  const settingsSrc = between(js, 'async function renderSettings', '// ---- 启动');
  // 渲染：浮点原样 String(settings[key])，不取整、不做 factor 换算/布尔 0-1
  assert.match(settingsSrc, /input\.value = isFloat\s*\?\s*String\(settings\[key\]\)/,
    '浮点字段应以 String(settings[key]) 原样展示');
  assert.match(settingsSrc, /input\.dataset\.float = '1'/, '浮点字段应标记 dataset.float');
  // 保存：浮点保留小数（修 1.265 → 1 的既有缺陷）
  assert.match(settingsSrc, /input\.dataset\.float === '1'\s*\?\s*n\b/,
    '浮点保存分支应直接取 n（不做 Math.round）');
  // 既有非浮点管线不动
  assert.match(settingsSrc, /Math\.round\(n \* factor\)/, 'factor 换算管线应保留');
  assert.match(settingsSrc, /BOOLEAN_SETTING_KEYS/, '布尔键钳制应保留');
  assert.match(settingsSrc, /不能为空/, '空输入应报「字段 X 不能为空」，不得被 Number("") === 0 静默清零');
});

test('panel.playful: 改名 Open-Resolver——标题 / 品牌 / 文件头 / package / 日志前缀（Task 4）', () => {
  const html = readPublic('index.html');
  const js = readPublic('app.js');
  const css = readPublic('style.css');
  const pkg = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, '..', '..', 'package.json'), 'utf8'));
  const server = fs.readFileSync(path.join(PUBLIC_DIR, '..', '..', 'server.mjs'), 'utf8');

  assert.match(html, /<title>Open-Resolver 面板<\/title>/, '浏览器标题应为「Open-Resolver 面板」');
  assert.ok(!html.includes('unified-gateway'), 'index.html 旧名应清零');
  assert.match(html, /<\/svg>Open-Resolver<\/span>/, '侧栏品牌文字应为 Open-Resolver');
  assert.ok(js.slice(0, 200).includes('Open-Resolver'), 'app.js 文件头项目名应为 Open-Resolver');
  assert.ok(css.slice(0, 200).includes('Open-Resolver'), 'style.css 文件头项目名应为 Open-Resolver');
  assert.equal(pkg.name, 'open-resolver', 'package.json name 应为 open-resolver');
  assert.match(server, /\[Open-Resolver\]/, 'server.mjs 日志前缀应为 [Open-Resolver]');
  assert.ok(!server.includes('[unified-gateway]'), 'server.mjs 旧日志前缀应清零');

  // 改名范围外：qoder 上游 User-Agent 保持 unified-gateway
  for (const rel of [['pools', 'qoder', 'claim.mjs']]) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, '..', '..', ...rel), 'utf8');
    assert.match(src, /'User-Agent': 'unified-gateway'/, `${rel.join('/')} 上游 UA 不应改名`);
  }
});

test('panel.playful: 账号表去「额度」列（额度明细框继续用 quotaBar）', () => {
  const js = readPublic('app.js');

  // 账号表区块（表头 → 行 → 空行）：6 列，无「额度」表头，空行 colspan 6
  const tableSrc = between(js, "el('th', { text: '名称 / ID' }),", 'tableBox.append(table);');
  assert.ok(!tableSrc.includes("el('th', { text: '额度' })"), '账号表表头不应再有「额度」列');
  assert.match(tableSrc, /colspan: '6'/, '账号空行 colspan 应为 6');
  assert.ok(!tableSrc.includes("colspan: '7'"), '旧 colspan 7 应清零');

  // 行内额度条删除
  const accountRowSrc = between(js, 'function accountRow', 'function dlgErr');
  assert.ok(!accountRowSrc.includes('quotaBar('), '账号行不应再渲染额度条');

  // 额度明细框保留：表头「额度」+ quotaBar(q.ratio)
  const quotaSrc = between(js, 'function quotaDetailsBox', 'function claimBox');
  assert.match(quotaSrc, /el\('th', \{ text: '额度' \}\)/, '额度明细表头「额度」应保留');
  assert.match(quotaSrc, /quotaBar\(q\.ratio\)/, '额度明细应继续用 quotaBar');
});

test('panel.playful: 仪表盘四卡等宽 + 设置页控制台密码盒', () => {
  const js = readPublic('app.js');
  const css = readPublic('style.css');

  // 卡片：4 列等宽 grid，子项可收缩换行；wide 卡通栏
  assert.match(css, /\.cards\s*\{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/, '.cards 应为 4 列等宽 grid');
  const cardRule = css.match(/\.card\s*\{[^}]*\}/);
  assert.ok(cardRule, 'style.css 缺 .card 规则');
  assert.match(cardRule[0], /min-width:\s*0/, '.card 应 min-width: 0（grid 子项可收缩）');
  assert.match(cardRule[0], /overflow-wrap:\s*anywhere/, '.card 应 overflow-wrap: anywhere');
  assert.match(css, /\.card\.wide\s*\{[^}]*grid-column:\s*1 \/ -1/, '.card.wide 应整行独占');
  // 响应式：900px 两列、560px 单列（wide 复位）
  const mq900 = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('@media (max-width: 560px)'));
  assert.match(mq900, /\.cards\s*\{[^}]*repeat\(2,/, '900px 断点卡片应两列');
  const mq560 = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.match(mq560, /\.cards\s*\{[^}]*1fr/, '560px 断点卡片应单列');
  assert.match(mq560, /\.card\.wide\s*\{[^}]*grid-column:\s*auto/, '560px 断点 wide 卡应回 auto');

  // statCard：wide 选项 + 降级卡通栏
  assert.match(js, /function statCard\(label, value, sub, \{ wide = false \} = \{\}\)/, 'statCard 签名应支持 wide');
  assert.match(js, /class: wide \? 'card wide' : 'card'/, 'statCard 应输出 wide 类');
  assert.match(js, /statCard\('用量记录', '降级', 'usage 文件超限，已停写', \{ wide: true \}\)/, '降级卡应整行独占');

  // 设置页：控制台密码盒（三输入 / 本地校验 / 成功与错误提示）
  const settingsPageSrc = between(js, 'function passwordBox', '// ---- 启动');
  assert.ok(settingsPageSrc.includes('控制台密码'), '设置页缺「控制台密码」盒');
  assert.ok(settingsPageSrc.includes('/auth/password'), '密码保存应打 /auth/password');
  const pwdSrc = between(js, 'function passwordBox', 'async function renderSettings');
  for (const token of [
    "autocomplete: 'current-password'",
    "text: '保存密码'",
    '密码已更新，其它会话已退出',
    'newPassword.length < 8',
    'newPassword !== confirmPassword',
  ]) {
    assert.ok(pwdSrc.includes(token), `passwordBox 缺「${token}」`);
  }
  assert.equal((pwdSrc.match(/autocomplete: 'new-password'/g) || []).length, 2, '新密码/确认密码都应是 new-password');
  assert.match(pwdSrc, /catch \(err\) \{\s*showError\(errBox, err\.message\)/, '请求失败应内联展示 err.message');
  // 挂 view（不被 settings reload 的 clear(listBox) 刷走），且在 reload 定义之前挂载
  const settingsSrc = between(js, 'async function renderSettings', '// ---- 启动');
  assert.match(settingsSrc, /view\.append\(passwordBox\(\)\)/, 'renderSettings 应挂载 passwordBox');
  assert.ok(settingsSrc.indexOf('passwordBox()') < settingsSrc.indexOf('async function reload'), 'passwordBox 应在 reload 之前挂载');
});

test('panel.playful: 设置输入宽度栅格 + 创建密钥两列表单（布局打磨）', () => {
  const js = readPublic('app.js');
  const css = readPublic('style.css');

  // CSS：设置行三列栅格（标签 / 输入 / 单位），密钥表单两列栅格（标签 / 控件）
  const settingsRule = css.match(/\.settings-row\s*\{[^}]*\}/);
  assert.ok(settingsRule, 'style.css 缺 .settings-row');
  assert.match(settingsRule[0], /display:\s*grid/, '.settings-row 应为 grid');
  assert.match(settingsRule[0], /grid-template-columns/, '.settings-row 缺 grid-template-columns');
  const keyFormRule = css.match(/\.key-form\s*\{[^}]*\}/);
  assert.ok(keyFormRule, 'style.css 缺 .key-form');
  assert.match(keyFormRule[0], /display:\s*grid/, '.key-form 应为 grid');
  assert.match(keyFormRule[0], /grid-template-columns/, '.key-form 缺 grid-template-columns');
  // 密码行：三输入等宽伸展（可收缩，不把按钮挤下去）
  const pwdRule = css.match(/\.password-row\s+\.password-input\s*\{[^}]*\}/);
  assert.ok(pwdRule, 'style.css 缺 .password-row .password-input');
  assert.match(pwdRule[0], /flex:\s*1\s+1/, '密码输入应等宽伸展');
  assert.match(pwdRule[0], /min-width:\s*0/, '密码输入应可收缩（min-width: 0）');

  // renderSettings：行类 + 输入类（不再用固定 70px 的 w-sm）
  const settingsSrc = fnSrc(js, 'renderSettings');
  assert.match(settingsSrc, /form-row settings-row/, '设置行应带 settings-row 类');
  assert.match(settingsSrc, /class: 'settings-input'/, '设置数字输入应带 settings-input 类');
  assert.ok(!settingsSrc.includes("class: 'w-sm'"), '设置输入不应再固定为 w-sm（70px）');

  // passwordBox：行类 + 三个输入类
  const pwdSrc = fnSrc(js, 'passwordBox');
  assert.match(pwdSrc, /form-row password-row/, '密码行应带 password-row 类');
  assert.equal((pwdSrc.match(/password-input/g) || []).length, 3, '当前/新/确认三个密码输入都应带 password-input');

  // createKeyForm：key-form 两列栅格；启用池 label 是表单直接子元素，不再和整行挤一个 form-row
  const createSrc = fnSrc(js, 'createKeyForm');
  assert.match(createSrc, /class: 'key-form'/, '缺 key-form 容器');
  assert.match(createSrc, /class: 'pool-checks'/, '池复选框容器应带 pool-checks 类');
  assert.match(createSrc, /class: 'key-expiry'/, '过期时间 + 创建按钮应包在 key-expiry 里');
  assert.ok(!createSrc.includes("class: 'form-row'"), '创建表单不应再整体塞进一个 form-row');
  // 直接子元素顺序：名称 → 启用池 → 过期时间（标签与控件成对 append 到 keyForm）
  const appendSrc = createSrc.slice(createSrc.indexOf('keyForm.append('), createSrc.indexOf('box.append('));
  assert.ok(appendSrc, 'createKeyForm 缺 keyForm.append(...)');
  let cursor = -1;
  for (const marker of ["text: '名称'", 'nameInput', "text: '启用池'", 'poolChecks', "text: '过期时间'", 'expiryBox']) {
    const idx = appendSrc.indexOf(marker);
    assert.ok(idx > cursor, `key-form 直接子元素顺序漂移：${marker}`);
    cursor = idx;
  }
  // 复选框 id 与 label for 关联不变
  assert.match(createSrc, /id: `pool-cb-\$\{name\}`/, '池复选框 id 契约漂移（pool-cb-${name}）');
  assert.match(createSrc, /for: `pool-cb-\$\{name\}`/, '池复选框 label for 关联漂移');
});
