import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc, newComponent } from '../shared/protocol.js';
import { validateDoc } from '../shared/validate.js';

// This deliberately small DOM substitute supplies known design-space rectangles.
// It exercises the real canvas handlers, but does not model browser layout.
class FakeClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = new Proxy({ cssText: '' }, {
      set: (target, key, value) => { target[key] = String(value); return true; },
    });
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this.attributes = new Map();
    this._textContent = '';
  }
  set className(value) { this._className = value; for (const name of String(value).split(/\s+/)) if (name) this.classList.add(name); }
  get className() { return this._className || ''; }
  set textContent(value) { this._textContent = String(value ?? ''); this.children = []; }
  get textContent() { return this._textContent; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  addEventListener(type, fn, options = {}) { const list = this.listeners.get(type) || []; list.push({ fn, once: !!options.once }); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.fn !== fn)); }
  dispatch(type, event = {}) {
    const entries = [...(this.listeners.get(type) || [])];
    for (const entry of entries) { entry.fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); if (entry.once) this.removeEventListener(type, entry.fn); }
  }
  setPointerCapture() {}
  getAttribute(name) {
    if (name !== 'style') return this.attributes.has(name) ? this.attributes.get(name) : null;
    const declarations = Object.entries(this.style)
      .filter(([key, value]) => key !== 'cssText' && value !== '')
      .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: ${value}`);
    return declarations.length ? declarations.join('; ') : null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'style') { clearStyle(this.style); parseCssInto(this.style, value); }
  }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'style') clearStyle(this.style); }
  querySelector(selector) { return queryTree(this, selector, false)[0] || null; }
  querySelectorAll(selector) { return queryTree(this, selector, true); }
  closest(selector) {
    for (let cur = this; cur; cur = cur.parentElement) {
      if (selector === '.ui-handle' && cur.classList.contains('ui-handle')) return cur;
      if (selector === '#artboard [data-id]' && cur.dataset?.id && isWithin(cur, this.ownerDocument.ids.artboard)) return cur;
    }
    return null;
  }
  getBoundingClientRect() { return this.ownerDocument.rectFor(this); }
}

function isWithin(node, ancestor) { for (let cur = node; cur; cur = cur.parentElement) if (cur === ancestor) return true; return false; }
function parseCssInto(style, css) {
  for (const declaration of String(css || '').split(';')) {
    const i = declaration.indexOf(':');
    if (i > 0) style[declaration.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = declaration.slice(i + 1).trim();
  }
}
function clearStyle(style) { for (const key of Object.keys(style)) delete style[key]; style.cssText = ''; }
function styleSnapshot(node) { return Object.fromEntries(Object.entries(node.style).filter(([key]) => key !== 'cssText')); }
function queryTree(root, selector, all) {
  const matches = (node) => {
    const idMatch = selector.match(/^\[data-id="(.+)"\]$/);
    if (idMatch) return node.dataset?.id === idMatch[1];
    if (selector.startsWith('.')) return selector.slice(1).split(',').some((name) => node.classList.contains(name.trim().replace(/^\./, '')));
    return false;
  };
  const found = [];
  const visit = (node) => { for (const child of node.children) { if (matches(child)) found.push(child); visit(child); } };
  visit(root);
  return all ? found : found.slice(0, 1);
}

function makeHarness() {
  const doc = new FakeElement('document', null);
  const win = new FakeElement('window', null);
  const ids = {};
  doc.ids = ids;
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.getElementById = (id) => ids[id] || null;
  doc.head = new FakeElement('head', doc);
  const rects = new Map();
  doc.rectFor = (node) => {
    const zoom = globalThis.__canvasZoom || 1;
    if (node === ids.artboard) return { left: 50, top: 30, width: 800 * zoom, height: 600 * zoom, right: 50 + 800 * zoom, bottom: 30 + 600 * zoom };
    const id = node.dataset?.id;
    if (!id) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const comp = globalThis.__testDoc?.components[id];
    if (id === 'root') return scaledRect(0, 0, 800, 600, zoom);
    if (comp?.parent === 'root') return scaledRect(100, 80, 420, 320, zoom);
    const p = comp && globalThis.__testDoc.components[comp.parent];
    const parentRect = rects.get(comp?.parent) || (p?.parent === 'root' ? { x: 100, y: 80, w: 420, h: 320 } : { x: 0, y: 0, w: 800, h: 600 });
    const cs = globalThis.getComputedStyle(node.parentElement);
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0, borderTop = parseFloat(cs.borderTopWidth) || 0;
    const pos = node.style.position === 'absolute';
    if (pos) {
      const x = parentRect.x + borderLeft + (parseFloat(node.style.left) || 0);
      const y = parentRect.y + borderTop + (parseFloat(node.style.top) || 0);
      return scaledRect(x, y, parseFloat(node.style.width) || 70, parseFloat(node.style.height) || 30, zoom);
    }
    const known = rects.get(id) || { x: parentRect.x + 26, y: parentRect.y + 34, w: 71, h: 33 };
    return scaledRect(known.x, known.y, known.w, known.h, zoom);
  };
  const scaledRect = (x, y, w, h, zoom) => ({ left: 50 + x * zoom, top: 30 + y * zoom, width: w * zoom, height: h * zoom, right: 50 + (x + w) * zoom, bottom: 30 + (y + h) * zoom });
  const wrap = ids['canvas-wrap'] = new FakeElement('div', doc);
  const stage = ids['canvas-stage'] = new FakeElement('div', doc);
  const scaler = ids['canvas-scaler'] = new FakeElement('div', doc);
  const artboard = ids.artboard = new FakeElement('div', doc);
  const overlay = ids.overlay = new FakeElement('div', doc);
  scaler.appendChild(artboard); scaler.appendChild(overlay);
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.CSS = { escape: (value) => value };
  globalThis.getComputedStyle = (node) => ({
    borderLeftWidth: node?.dataset?.id?.startsWith('parent_') ? '3px' : '0px',
    borderRightWidth: node?.dataset?.id?.startsWith('parent_') ? '5px' : '0px',
    borderTopWidth: node?.dataset?.id?.startsWith('parent_') ? '2px' : '0px',
    borderBottomWidth: node?.dataset?.id?.startsWith('parent_') ? '4px' : '0px',
    gridTemplateColumns: '180px 180px', gridTemplateRows: '120px 120px',
  });
  return { doc, win, ids, rects };
}

const layouts = ['vertical', 'horizontal', 'grid'];
const types = ['container', 'text', 'button', 'input', 'image', 'rect', 'divider'];
let canvas, store, harness;

async function setup(layout, type, { zoom = 1, absolute = false, freeMove = true, parentAuto = false } = {}) {
  harness = makeHarness();
  globalThis.__canvasZoom = zoom;
  store = await import('../app/store.js');
  canvas = await import('../app/canvas.js');
  const doc = newDoc('指针拖动回归', 'generic');
  const parent = newComponent(doc, 'container', 'root', { id: `parent_${layout}`, layoutMode: layout });
  parent.layout.padding = [7, 11, 13, 17];
  parent.style.borderWidth = 3;
  parent.size = parentAuto
    ? { width: { mode: 'auto' }, height: { mode: 'auto' } }
    : { width: { mode: 'fixed', value: 420 }, height: { mode: 'fixed', value: 320 } };
  if (layout === 'grid') parent.layout.tracks = { columns: [{ mode: 'fixed', value: 180 }, { mode: 'fixed', value: 180 }], rows: [{ mode: 'fixed', value: 120 }, { mode: 'fixed', value: 120 }] };
  const comp = newComponent(doc, type, parent.id, { id: `child_${layout}_${type}` });
  // Components start with non-fixed modes to verify that first detachment freezes the measured box.
  comp.size = layout === 'free'
    ? { width: { mode: 'auto' }, height: { mode: 'auto' } }
    : { width: { mode: 'fill' }, height: { mode: 'auto' } };
  if (type === 'divider') { comp.orientation = 'horizontal'; comp.thickness = 37; }
  comp.style.borderWidth = 0;
  if (absolute) {
    comp.placement = { mode: 'absolute' };
    comp.position = { left: 20, top: 28 };
    comp.size = { width: { mode: 'percent', value: 40 }, height: { mode: 'auto' } };
    if (layout === 'grid') delete comp.area;
  }
  store.loadProject('pointer-test', doc);
  store.state.zoom = zoom;
  store.state.freeMove = freeMove;
  store.state.snapEnabled = false;
  globalThis.__testDoc = store.state.doc;
  // A known visual box for the child and parent, independent of any browser layout engine.
  harness.rects.set(parent.id, { x: 100, y: 80, w: 420, h: 320 });
  harness.rects.set(comp.id, absolute ? { x: 140, y: 118, w: 83, h: 37 } : { x: 143, y: 123, w: 83, h: 37 });
  canvas.initCanvas();
  canvas.renderCanvas();
  // renderCanvas does not own the application renderer's DOM lifecycle; retain the doc used by rectFor.
  globalThis.__testDoc = store.state.doc;
  return { doc, parent, comp, node: harness.ids.artboard.querySelector(`[data-id="${comp.id}"]`) };
}

function pointerSequence(node, { dx = 31, dy = -19, zoom = 1, action = 'up', esc = false } = {}) {
  const r = node.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  harness.ids['canvas-scaler'].dispatch('pointerdown', { target: node, button: 0, pointerId: 1, clientX: x, clientY: y });
  if (dx !== 0 || dy !== 0) harness.win.dispatch('pointermove', { pointerId: 1, clientX: x + dx * zoom, clientY: y + dy * zoom, altKey: true });
  if (esc) harness.win.dispatch('keydown', { key: 'Escape' });
  else harness.win.dispatch(action === 'cancel' ? 'pointercancel' : 'pointerup', { pointerId: 1, clientX: x + dx * zoom, clientY: y + dy * zoom });
}

test('真实指针 handler：3 种父布局 × 7 种组件第一次拖动写 absolute 与实测尺寸，父布局不变且历史仅一笔', async () => {
  for (const layout of layouts) for (const type of types) {
    const { parent, comp, node } = await setup(layout, type);
    const parentMode = parent.layout.mode;
    pointerSequence(node, { zoom: 1 });
    const moved = store.state.doc.components[comp.id];
    assert.deepEqual(moved.placement, { mode: 'absolute' }, `${layout}/${type}`);
    assert.deepEqual(moved.position, { left: 54, top: 15 }, `${layout}/${type}`);
    assert.deepEqual(moved.size, { width: { mode: 'fixed', value: 83 }, height: { mode: 'fixed', value: 37 } }, `${layout}/${type}`);
    assert.equal(store.state.doc.components[parent.id].layout.mode, parentMode, `${layout}/${type}`);
    assert.equal(store.history.undo.length, 1, `${layout}/${type} should make one history entry`);
  }
});

test('pointerdown/up 点击低于阈值不修改文档或历史', async () => {
  const { comp, node } = await setup('vertical', 'text');
  const before = JSON.stringify(store.state.doc);
  pointerSequence(node, { dx: 1, dy: 1 });
  assert.equal(JSON.stringify(store.state.doc), before);
  assert.equal(store.history.undo.length, 0);
});

test('Escape 与 pointercancel 撤销临时拖动态，保留原文档与节点 style', async () => {
  for (const cancel of ['escape', 'cancel']) {
    const { comp, node } = await setup('horizontal', 'button');
    const before = JSON.stringify(store.state.doc);
    const originalStyle = node.getAttribute('style');
    const originalStyleObject = styleSnapshot(node);
    pointerSequence(node, { action: cancel === 'cancel' ? 'cancel' : 'up', esc: cancel === 'escape' });
    assert.equal(JSON.stringify(store.state.doc), before, cancel);
    assert.equal(store.history.undo.length, 0, cancel);
    assert.equal(node.getAttribute('style'), originalStyle, cancel);
    assert.deepEqual(styleSnapshot(node), originalStyleObject, `${cancel} should restore inline style properties`);
  }
});

test('拖动后 undo/redo 在旧 flow 与 absolute 文档间往返', async () => {
  const { comp, node } = await setup('vertical', 'rect');
  pointerSequence(node);
  assert.equal(store.state.doc.components[comp.id].placement.mode, 'absolute');
  store.undo();
  assert.equal(store.state.doc.components[comp.id].placement, undefined);
  assert.deepEqual(store.state.doc.components[comp.id].size.width, { mode: 'fill' });
  store.redo();
  assert.deepEqual(store.state.doc.components[comp.id].placement, { mode: 'absolute' });
  assert.deepEqual(store.state.doc.components[comp.id].position, { left: 54, top: 15 });
});

test('已有 absolute 的百分比与 auto 尺寸模式拖动后保留', async () => {
  const { comp, node } = await setup('grid', 'image', { absolute: true });
  pointerSequence(node, { dx: 20, dy: 10 });
  const moved = store.state.doc.components[comp.id];
  assert.deepEqual(moved.size, { width: { mode: 'percent', value: 40 }, height: { mode: 'auto' } });
  assert.deepEqual(moved.position, { left: 40, top: 38 });
  assert.equal(store.history.undo.length, 1);
});

test('缩放与父 border/padding 下按设计单位计算，负坐标不截断', async () => {
  for (const zoom of [0.5, 2]) {
    const { comp, node } = await setup('vertical', 'text', { zoom });
    pointerSequence(node, { dx: 31, dy: -70, zoom });
    assert.deepEqual(store.state.doc.components[comp.id].position, { left: 54, top: -36 }, `zoom=${zoom}`);
  }
});

test('freeMove 关闭時保持排列/網格旧操作，free 父容器拖动不改 auto 尺寸', async () => {
  const flow = await setup('vertical', 'text', { freeMove: false });
  pointerSequence(flow.node, { dx: 31, dy: -19 });
  assert.equal(store.state.doc.components[flow.comp.id].placement, undefined);

  const grid = await setup('grid', 'text', { freeMove: false });
  const originalArea = { ...grid.comp.area };
  pointerSequence(grid.node, { dx: 220, dy: 130 });
  assert.equal(store.state.doc.components[grid.comp.id].placement, undefined);
  assert.deepEqual(store.state.doc.components[grid.comp.id].area, { ...originalArea, col: 2, row: 2 });

  const free = await setup('free', 'text', { freeMove: true, parentAuto: true });
  assert.equal(validateDoc(store.state.doc).ok, true, JSON.stringify(validateDoc(store.state.doc).errors));
  pointerSequence(free.node, { dx: 31, dy: -19 });
  assert.equal(store.state.doc.components[free.comp.id].placement, undefined);
  assert.deepEqual(store.state.doc.components[free.comp.id].size, { width: { mode: 'auto' }, height: { mode: 'auto' } });
  assert.equal(validateDoc(store.state.doc).ok, true, JSON.stringify(validateDoc(store.state.doc).errors));
});
