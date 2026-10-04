import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initInteractions, extractInteractionSpec } from '../shared/runtime.js';
import { buildPreviewHtml, buildEmbedHtml } from '../shared/export-html.js';
import { resolveVariant, ResolveError } from '../shared/resolve.js';
import { newDoc } from '../shared/protocol.js';

// ============================================================
// M3 交互运行时 + M4 CLI --variant 测试
// 假 DOM 写法参考 canvas-free-move.test.js：只模拟 runtime 用到的能力
// （dataset/style/事件委托/querySelector/focus 记录），不模拟真实布局。
// ============================================================

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_V3 = path.join(TEST_ROOT, 'tests', 'fixtures', 'v3-sample.uidoc.json');

// ---------- 假 DOM ----------
class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.className = '';
    this.attributes = new Map();
    this.listeners = new Map();
    this.focusLog = [];
    this._textContent = '';
    this.style = new Proxy({}, { set: (target, key, value) => { target[key] = String(value); return true; } });
  }
  set textContent(v) { this._textContent = String(v ?? ''); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._textContent;
  }
  get firstElementChild() { return this.children[0] || null; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn)); }
  dispatch(type, event = {}) {
    // 与 DOM 一致的冒泡：从派发元素沿 parentElement 逐级触发监听（stopPropagation 可中断）
    let stopped = false;
    const ev = { target: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...event };
    for (let node = this; node && !stopped; node = node.parentElement) {
      for (const fn of [...(node.listeners.get(type) || [])]) fn(ev);
    }
  }
  focus(opts) { this.focusLog.push(opts ?? null); }
  querySelector(selector) { return queryTree(this, selector)[0] || null; }
  querySelectorAll(selector) { return queryTree(this, selector); }
}

// 只支持 runtime 实际使用的一种选择器：[data-id="x"]
function queryTree(rootEl, selector) {
  const m = selector.match(/^\[data-id="(.+)"\]$/);
  if (!m) throw new Error('假 DOM 只支持 [data-id="x"] 选择器：' + selector);
  const want = m[1];
  const found = [];
  const visit = (node) => { for (const child of node.children) { if (child.dataset?.id === want) found.push(child); visit(child); } };
  visit(rootEl);
  return found;
}

function makeDoc() {
  const doc = new FakeElement('#document', null);
  doc.createElement = (tag) => new FakeElement(tag, doc);
  return doc;
}

// 组件树等价物：root > [menu_btn, panels_root > close_btn]，模拟渲染器输出的 inline display
function makeHarness() {
  const doc = makeDoc();
  const root = doc.createElement('div');
  root.dataset.id = 'root';
  const btn = doc.createElement('button');
  btn.dataset.id = 'menu_btn';
  const panel = doc.createElement('div');
  panel.dataset.id = 'panels_root';
  panel.style.display = 'block';
  const closeBtn = doc.createElement('button');
  closeBtn.dataset.id = 'close_btn';
  panel.appendChild(closeBtn);
  root.appendChild(btn);
  root.appendChild(panel);
  const spec = {
    initiallyClosed: ['panels_root'],
    actions: {
      menu_btn: { click: { type: 'toggle', target: 'panels_root' } },
      opn_btn: { click: { type: 'open', target: 'panels_root' } },
      close_btn: { click: { type: 'close', target: 'panels_root' } },
    },
  };
  const opnBtn = doc.createElement('button');
  opnBtn.dataset.id = 'opn_btn';
  root.appendChild(opnBtn);
  return { doc, root, btn, panel, closeBtn, opnBtn, spec };
}

const overlayIn = (root) => root.children.find((c) => c.className === 'uiw-interact-overlay') || null;

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

// ---------- runtime：初始隐藏 ----------
test('runtime：initiallyClosed 集合初始化即隐藏（记录原 display），其余元素不受影响', () => {
  const h = makeHarness();
  const rt = initInteractions({ rootEl: h.root, spec: h.spec });
  assert.equal(h.panel.style.display, 'none');
  assert.equal(rt.isOpen('panels_root'), false);
  assert.equal(h.btn.style.display, undefined, '未列入 initiallyClosed 的元素不动');
  assert.equal(overlayIn(h.root), null, '没有面板可见时不挂遮罩');
  rt.destroy();
});

// ---------- runtime：toggle / open / close ----------
test('runtime：toggle 翻转显示并恢复原 display，遮罩随可见性挂载/移除，焦点回到触发按钮', () => {
  const h = makeHarness();
  const rt = initInteractions({ rootEl: h.root, spec: h.spec });
  h.btn.dispatch('click', { target: h.btn });
  assert.equal(rt.isOpen('panels_root'), true);
  assert.equal(h.panel.style.display, 'block', '显示时恢复渲染器输出的原 display');
  const overlay = overlayIn(h.root);
  assert.ok(overlay, '面板可见时挂遮罩');
  assert.equal(overlay.style.background, 'transparent', '纯透明不加深色');
  assert.equal(overlay.style.zIndex, '1');
  assert.equal(h.panel.style.zIndex, '2', '面板 z 高于遮罩、遮罩高于其余内容');
  assert.equal(h.btn.focusLog.length, 1, '动作完成后焦点回到触发按钮');
  assert.deepEqual(h.btn.focusLog[0], { preventScroll: true });
  assert.equal(h.btn.getAttribute('tabindex'), '-1');
  h.btn.dispatch('click', { target: h.btn });
  assert.equal(rt.isOpen('panels_root'), false);
  assert.equal(h.panel.style.display, 'none');
  assert.equal(overlayIn(h.root), null, '全部关闭后遮罩移除');
  assert.ok(!h.panel.style.zIndex, 'z-index 恢复');
  assert.equal(h.btn.focusLog.length, 2);
  rt.destroy();
});

test('runtime：open/close 动作与幂等性', () => {
  const h = makeHarness();
  const rt = initInteractions({ rootEl: h.root, spec: h.spec });
  h.opnBtn.dispatch('click', { target: h.opnBtn });
  assert.equal(rt.isOpen('panels_root'), true, 'open 打开已关闭面板');
  h.opnBtn.dispatch('click', { target: h.opnBtn });
  assert.equal(rt.isOpen('panels_root'), true, 'open 对已打开面板幂等');
  h.closeBtn.dispatch('click', { target: h.closeBtn });
  assert.equal(rt.isOpen('panels_root'), false, 'close 隐藏面板');
  h.closeBtn.dispatch('click', { target: h.closeBtn });
  assert.equal(rt.isOpen('panels_root'), false, 'close 对已关闭面板幂等');
  assert.equal(h.closeBtn.focusLog.length, 2);
  rt.destroy();
});

// ---------- runtime：Esc ----------
test('runtime：Esc 关闭全部可见面板且焦点回到最近触发按钮；无面板打开时不抢焦点', () => {
  const h = makeHarness();
  const rt = initInteractions({ rootEl: h.root, spec: h.spec });
  h.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.btn.focusLog.length, 0, '没有面板打开时 Esc 不动焦点');
  h.btn.dispatch('click', { target: h.btn });
  assert.equal(h.btn.focusLog.length, 1);
  h.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(rt.isOpen('panels_root'), false, 'Esc 关闭全部可见面板');
  assert.equal(h.panel.style.display, 'none');
  assert.equal(h.btn.focusLog.length, 2, '焦点回到最近一次触发按钮');
  rt.destroy();
});

// ---------- runtime：遮罩点击 ----------
test('runtime：点击遮罩 = 关闭全部打开的可展开面板（等价点外部）', () => {
  const h = makeHarness();
  const rt = initInteractions({ rootEl: h.root, spec: h.spec });
  h.opnBtn.dispatch('click', { target: h.opnBtn });
  const overlay = overlayIn(h.root);
  assert.ok(overlay);
  overlay.dispatch('click', { target: overlay });
  assert.equal(rt.isOpen('panels_root'), false);
  assert.equal(h.panel.style.display, 'none');
  assert.equal(overlayIn(h.root), null);
  rt.destroy();
});

// ---------- runtime：运行态绝不写回 doc/spec ----------
test('runtime：连点动作后 doc/spec 对象 deepEqual 未变（deepFreeze + structuredClone 留底）', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_V3, 'utf8'));
  const docBefore = structuredClone(fixture);
  deepFreeze(fixture); // 严格模式下任何写入都会抛 TypeError
  const spec = deepFreeze(extractInteractionSpec(fixture, 'B1'));
  const specBefore = structuredClone(spec);
  const h = makeHarness();
  const rt = initInteractions({ rootEl: h.root, spec });
  for (let i = 0; i < 3; i++) h.btn.dispatch('click', { target: h.btn }); // toggle 连点
  h.opnBtn.dispatch('click', { target: h.opnBtn });
  h.doc.dispatch('keydown', { key: 'Escape' });
  h.opnBtn.dispatch('click', { target: h.opnBtn });
  const overlay = overlayIn(h.root);
  if (overlay) overlay.dispatch('click', { target: overlay });
  rt.destroy();
  assert.deepEqual(structuredClone(spec), specBefore, 'spec 未被修改');
  assert.deepEqual(structuredClone(fixture), docBefore, 'doc 未被修改');
});

// ---------- runtime：destroy ----------
test('runtime：destroy 移除监听与遮罩并恢复初始可见性，销毁后动作失效', () => {
  const h = makeHarness();
  const rt = initInteractions({ rootEl: h.root, spec: h.spec });
  h.opnBtn.dispatch('click', { target: h.opnBtn });
  assert.ok(overlayIn(h.root));
  rt.destroy();
  assert.equal(h.panel.style.display, 'block', '恢复初始可见性（渲染输出原样）');
  assert.equal(overlayIn(h.root), null, '遮罩移除');
  assert.ok(!h.panel.style.zIndex, 'z-index 恢复');
  const focusCount = h.btn.focusLog.length;
  h.btn.dispatch('click', { target: h.btn });
  h.doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.panel.style.display, 'block', '销毁后点击不再触发动作');
  assert.equal(h.btn.focusLog.length, focusCount, '销毁后焦点不再变化');
});

// ---------- extractInteractionSpec ----------
test('extractInteractionSpec：popup 变体提取 initiallyClosed 与 actions；persistent 为空；doc 只读', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_V3, 'utf8'));
  const before = structuredClone(fixture);
  deepFreeze(fixture);
  const specB1 = extractInteractionSpec(fixture, 'B1');
  assert.deepEqual(specB1.initiallyClosed, ['panels_root']);
  assert.deepEqual(Object.keys(specB1.actions), ['menu_btn', 'settings_close']);
  assert.deepEqual(specB1.actions.menu_btn, { click: { type: 'toggle', target: 'panels_root' } });
  assert.deepEqual(specB1.actions.settings_close, { click: { type: 'close', target: 'panels_root' } });
  assert.deepEqual(extractInteractionSpec(fixture, 'A1'), { initiallyClosed: [], actions: {} }, 'persistent 无可展开面板');
  assert.deepEqual(extractInteractionSpec(fixture, 'NOPE'), { initiallyClosed: [], actions: {} }, '未知变体返回空 spec');
  assert.deepEqual(extractInteractionSpec(null, 'B1'), { initiallyClosed: [], actions: {} });
  assert.deepEqual(structuredClone(fixture), before, 'doc 未被修改');
});

// ---------- export-html：内联链与引导代码 ----------
const SRC = (name) => fs.readFileSync(path.join(TEST_ROOT, 'shared', name), 'utf8');
const sources = {
  modesSource: SRC('modes.js'),
  protocolSource: SRC('protocol.js'),
  resolveSource: SRC('resolve.js'),
  runtimeSource: SRC('runtime.js'),
  rendererSource: SRC('renderer.js'),
};
const v3doc = JSON.parse(fs.readFileSync(FIXTURE_V3, 'utf8'));

test('export-html：v3 预览页包含 resolve/runtime 内联、桥接与按变体解析引导，内联顺序即依赖', () => {
  const html = buildPreviewHtml({ doc: v3doc, ...sources });
  assert.match(html, /function resolveVariant\(/, 'resolve.js 已内联');
  assert.match(html, /function initInteractions\(/, 'runtime.js 已内联');
  assert.match(html, /window\.UIForgeResolve = /, 'resolve 桥接');
  assert.match(html, /window\.UIForgeRuntime = /, 'runtime 桥接');
  assert.match(html, /window\.UIFORGE_VARIANT = /, '变体注入点');
  assert.match(html, /DOC\.version === 3/, 'v3 分支门禁');
  assert.match(html, /resolveVariant\(DOC, vid\)/, '按变体解析成 v2 形状再渲染');
  const iResolve = html.indexOf('function resolveVariant(');
  const iRuntime = html.indexOf('function initInteractions(');
  const iRenderer = html.indexOf('function renderDoc(');
  assert.ok(iResolve >= 0 && iRuntime > iResolve && iRenderer > iRuntime, '内联顺序 modes→protocol→resolve→runtime→renderer');
});

test('export-html：传 variantId 与不传生成的页面不同（B2 注入 vs 缺省 activeVariant）', () => {
  const withV = buildPreviewHtml({ doc: v3doc, ...sources, variantId: 'B2' });
  const withoutV = buildPreviewHtml({ doc: v3doc, ...sources });
  assert.notEqual(withV, withoutV);
  assert.match(withV, /window\.UIFORGE_VARIANT = "B2"/);
  assert.match(withoutV, /window\.UIFORGE_VARIANT = null/);
});

// ---------- export-html：BOOTSTRAP 行为级验证（embed 模式，假 window/document） ----------
// 抽出页面最后一个 <script>（BOOTSTRAP）在假环境里执行，验证 v3 分支的真实行为。
function runBootstrap(html, { docJson, resolve, runtime, variant }) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const boot = scripts[scripts.length - 1];
  const calls = { render: [], resolve: [], init: [] };
  const doc = makeDoc();
  const docData = doc.createElement('script');
  docData.setAttribute('id', 'doc-data');
  docData.textContent = JSON.stringify(docJson);
  const app = doc.createElement('div');
  app.setAttribute('id', 'app');
  doc.getElementById = (id) => (id === 'doc-data' ? docData : id === 'app' ? app : null);
  const win = {
    parent: {}, // parent !== window → embed 模式
    innerWidth: 1024,
    innerHeight: 768,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
  win.UIForgeRenderer = { renderDoc: (container, d, opts) => {
    calls.render.push({ doc: d, opts });
    const rootEl = doc.createElement('div');
    rootEl.dataset.id = 'root';
    const panel = doc.createElement('div');
    panel.dataset.id = 'panels_root';
    panel.style.display = 'block';
    const menuBtn = doc.createElement('button');
    menuBtn.dataset.id = 'menu_btn';
    rootEl.appendChild(panel);
    rootEl.appendChild(menuBtn);
    container.appendChild(rootEl);
    return rootEl;
  } };
  win.UIForgeResolve = { resolveVariant: (d, vid) => { calls.resolve.push(vid); return resolve.resolveVariant(d, vid); } };
  win.UIForgeRuntime = {
    extractInteractionSpec: runtime.extractInteractionSpec,
    initInteractions: (opts) => { calls.init.push(opts); return runtime.initInteractions(opts); },
  };
  win.UIFORGE_VARIANT = variant === undefined ? null : variant;
  new Function('window', 'document', 'location', 'requestAnimationFrame', boot)(win, doc, { search: '' }, () => {});
  return { calls, doc, app };
}

test('BOOTSTRAP：v3 按指定变体解析渲染并接入交互（初始隐藏 + 点击展开端到端）', () => {
  const html = buildEmbedHtml({ doc: v3doc, ...sources });
  const r = runBootstrap(html, { docJson: v3doc, resolve: { resolveVariant }, runtime: { initInteractions, extractInteractionSpec }, variant: 'B1' });
  assert.deepEqual(r.calls.resolve, ['B1'], '按页面注入的变体解析');
  assert.equal(r.calls.render.length, 1);
  assert.equal(r.calls.render[0].doc.version, 2, '渲染的是解析后的 v2 形状');
  assert.equal('variants' in r.calls.render[0].doc, false, 'v3 顶层段不进入渲染文档');
  assert.equal(r.calls.init.length, 1, '渲染成功后 initInteractions');
  assert.deepEqual(r.calls.init[0].spec.initiallyClosed, ['panels_root']);
  const panel = r.app.querySelector('[data-id="panels_root"]');
  assert.equal(panel.style.display, 'none', 'initiallyOpen:false 容器初始隐藏');
  const menu = r.app.querySelector('[data-id="menu_btn"]');
  menu.dispatch('click', { target: menu });
  assert.equal(panel.style.display, 'block', '点击按钮展开（真运行时端到端）');
  menu.dispatch('click', { target: menu });
  assert.equal(panel.style.display, 'none', '再点收起');
});

test('BOOTSTRAP：v3 缺省按 activeVariant 解析；persistent 变体无可隐藏面板', () => {
  const html = buildEmbedHtml({ doc: v3doc, ...sources });
  const r = runBootstrap(html, { docJson: v3doc, resolve: { resolveVariant }, runtime: { initInteractions, extractInteractionSpec } });
  assert.deepEqual(r.calls.resolve, ['A1'], '未注入变体时用 activeVariant');
  const panel = r.app.querySelector('[data-id="panels_root"]');
  assert.equal(panel.style.display, 'block', 'persistent 变体无 initiallyOpen:false 容器，不隐藏');
});

test('BOOTSTRAP：v3 变体解析失败显示错误卡（错误码+信息），不白屏、不渲染、不初始化交互', () => {
  const html = buildEmbedHtml({ doc: v3doc, ...sources });
  const r = runBootstrap(html, {
    docJson: v3doc,
    resolve: { resolveVariant: () => { throw new ResolveError({ code: 'E_VARIANT_UNKNOWN', message: '变体 "NOPE" 不存在于 variants' }); } },
    runtime: { initInteractions, extractInteractionSpec },
    variant: 'NOPE',
  });
  assert.equal(r.calls.render.length, 0);
  assert.equal(r.calls.init.length, 0);
  const card = r.app.firstElementChild;
  assert.ok(card, '页面上有错误卡');
  assert.match(card.textContent, /E_VARIANT_UNKNOWN/);
  assert.match(card.textContent, /变体 "NOPE" 不存在于 variants/);
});

test('BOOTSTRAP：v2 文档行为与今天完全一致（不解析变体、不 init runtime）', () => {
  const v2doc = newDoc('v2 回归', 'generic');
  const html = buildEmbedHtml({ doc: v2doc, ...sources });
  const r = runBootstrap(html, { docJson: v2doc, resolve: { resolveVariant }, runtime: { initInteractions, extractInteractionSpec } });
  assert.deepEqual(r.calls.resolve, [], 'v2 不调用变体解析');
  assert.equal(r.calls.render[0].doc.version, 2, '照常渲染原文档');
  assert.deepEqual(r.calls.render[0].doc, v2doc, 'v2 原样渲染（BOOTSTRAP 从 doc-data 重新解析，内容一致）');
  assert.deepEqual(r.calls.init, [], 'v2 不 init runtime');
});

// ---------- CLI export --variant ----------
function runCli(args) {
  return spawnSync(process.execPath, [path.join(TEST_ROOT, 'cli', 'cli.js'), ...args], { encoding: 'utf8', env: process.env });
}

test('CLI --variant：v2 文档带 flag 报错 E_VARIANT_FLAG_ON_V2，不产生导出包', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiforge-m3-'));
  try {
    const input = path.join(tmp, 'v2.uidoc.json');
    fs.writeFileSync(input, JSON.stringify(newDoc('v2 项目', 'generic')), 'utf8');
    const outDir = path.join(tmp, 'o1');
    const r = runCli(['export', input, '--out', outDir, '--variant', 'B1']);
    assert.equal(r.status, 2, r.stdout || r.stderr);
    assert.match(r.stdout, /E_VARIANT_FLAG_ON_V2/);
    assert.equal(fs.existsSync(outDir), false, '校验失败不留半成品导出包');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI --variant：v3 未知变体报错 E_VARIANT_UNKNOWN 并列出可用 id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiforge-m3-'));
  try {
    const input = path.join(tmp, 'v3.uidoc.json');
    fs.writeFileSync(input, JSON.stringify(v3doc), 'utf8');
    const r = runCli(['export', input, '--out', path.join(tmp, 'o2'), '--variant', 'NOPE']);
    assert.equal(r.status, 2, r.stdout || r.stderr);
    assert.match(r.stdout, /E_VARIANT_UNKNOWN/);
    assert.match(r.stdout, /A1、A2、A3、B1、B2、B3/, '可用变体 id 全部列出');
    assert.equal(fs.existsSync(path.join(tmp, 'o2')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI --variant：合法变体导出成功，report.json 记 variant，页面按指定变体解析，design.uidoc.json 仍为原文档', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiforge-m3-'));
  try {
    const input = path.join(tmp, 'v3.uidoc.json');
    fs.writeFileSync(input, JSON.stringify(v3doc), 'utf8');
    const outDir = path.join(tmp, 'o3');
    const r = runCli(['export', input, '--out', outDir, '--variant', 'B1', '--json']);
    assert.equal(r.status, 0, r.stdout || r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.variant, 'B1');
    const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.variant, 'B1', 'report.json 记录渲染变体');
    const html = fs.readFileSync(path.join(outDir, 'preview.html'), 'utf8');
    assert.match(html, /window\.UIFORGE_VARIANT = "B1"/, '页面按指定变体解析');
    assert.match(html, /function resolveVariant\(/, '解析器已内联');
    assert.match(html, /function initInteractions\(/, '交互运行时已内联');
    const designOut = JSON.parse(fs.readFileSync(path.join(outDir, 'design.uidoc.json'), 'utf8'));
    assert.equal(designOut.version, 3);
    assert.equal(designOut.activeVariant, 'A1', 'design.uidoc.json 写原文档，运行态/指定变体不入文件');
    assert.deepEqual(structuredClone(designOut), structuredClone(v3doc));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI export：v3 缺省按 activeVariant 导出且 report.json 记 variant=A1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uiforge-m3-'));
  try {
    const input = path.join(tmp, 'v3.uidoc.json');
    fs.writeFileSync(input, JSON.stringify(v3doc), 'utf8');
    const r = runCli(['export', input, '--out', path.join(tmp, 'o4'), '--json']);
    assert.equal(r.status, 0, r.stdout || r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.variant, 'A1');
    const report = JSON.parse(fs.readFileSync(path.join(tmp, 'o4', 'report.json'), 'utf8'));
    assert.equal(report.variant, 'A1');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
