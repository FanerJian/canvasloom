import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc, newPage, pageIdsOf } from '../shared/protocol.js';
import { validateDoc, applyOps } from '../shared/validate.js';
import { resolveVariant } from '../shared/resolve.js';
import { initInteractions, extractInteractionSpec } from '../shared/runtime.js';
import { upgradeDocToV3 } from '../shared/compat.js';
import { checkSnapshot } from '../shared/measure.js';
import { state, loadProject, select, pagesOfDoc, addPage } from '../app/store.js';

// ============================================================
// v3.1 页面图层（多图层）测试：page 字段 + goto 动作 + v2→v3 升级
// 覆盖：协议工厂 / 校验分流 / 解析剥离 / 运行时切页 / 升级包装 /
//       编辑器状态（activePageId）/ 实测重叠豁免
// ============================================================

// ---------- 测试文档：两个页面 + 一个抽屉面板 + 常驻按钮 ----------
function buildPagesDoc() {
  return {
    format: 'uidoc', version: 3, revision: 1, mode: 'generic',
    name: 'v3.1 页面测试', canvas: { width: 800, height: 600, background: '#ffffff' }, resources: {},
    features: {},
    styles: { plain: { label: '朴素', tokens: {} } },
    presentations: {
      main: {
        label: '主呈现',
        components: {
          root: {
            id: 'root', type: 'container', name: '页面', parent: null,
            children: ['page_home', 'page_settings', 'panel_drawer', 'btn_open_drawer'],
            layout: { mode: 'free' },
            size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
            style: { background: '#f5f5f5' }, flags: {},
          },
          page_home: {
            id: 'page_home', type: 'container', name: '首页', parent: 'root', page: true,
            children: ['btn_goto_settings'], placement: { mode: 'absolute' }, position: { left: 0, top: 0 },
            layout: { mode: 'free' },
            size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
            style: { background: '#ffffff' }, flags: {},
          },
          page_settings: {
            id: 'page_settings', type: 'container', name: '设置页', parent: 'root', page: true,
            children: [], placement: { mode: 'absolute' }, position: { left: 0, top: 0 },
            layout: { mode: 'free' },
            size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
            style: { background: '#fafafa' }, flags: {},
          },
          panel_drawer: {
            id: 'panel_drawer', type: 'container', name: '抽屉', parent: 'root', initiallyOpen: false,
            children: [], placement: { mode: 'absolute' }, position: { left: 40, top: 40 },
            layout: { mode: 'free' },
            size: { width: { mode: 'fixed', value: 200 }, height: { mode: 'fixed', value: 120 } },
            style: { background: '#eeeeee' }, flags: {},
          },
          btn_goto_settings: {
            id: 'btn_goto_settings', type: 'button', name: '去设置', parent: 'page_home', text: '去设置',
            actions: { click: { type: 'goto', target: 'page_settings' } },
            placement: { mode: 'absolute' }, position: { left: 20, top: 20 },
            size: { width: { mode: 'fixed', value: 120 }, height: { mode: 'fixed', value: 40 } },
            style: {}, flags: {},
          },
          btn_open_drawer: {
            id: 'btn_open_drawer', type: 'button', name: '开抽屉', parent: 'root', text: '开抽屉',
            actions: { click: { type: 'open', target: 'panel_drawer' } },
            placement: { mode: 'absolute' }, position: { left: 20, top: 80 },
            size: { width: { mode: 'fixed', value: 120 }, height: { mode: 'fixed', value: 40 } },
            style: {}, flags: {},
          },
        },
      },
    },
    variants: [{ id: 'v1', label: '默认', presentation: 'main', style: 'plain', overrides: { tokens: {}, components: {} } }],
    activeVariant: 'v1',
  };
}

// ---------- 协议工厂 ----------
test('newPage：铺满画布的页面容器挂在 root 下，pageIdsOf 按顺序列出', () => {
  const doc = { components: { root: { id: 'root', type: 'container', name: '页面', parent: null, children: [], layout: { mode: 'vertical' } } } };
  const p1 = newPage(doc, '设置页');
  const p2 = newPage(doc, '关于页');
  assert.equal(p1.page, true);
  assert.deepEqual(p1.placement, { mode: 'absolute' });
  assert.deepEqual(p1.position, { left: 0, top: 0 });
  assert.deepEqual(p1.size, { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } });
  assert.equal(p1.parent, 'root');
  assert.equal(p1.layout.mode, 'free');
  assert.deepEqual(doc.components.root.children, [p1.id, p2.id]);
  assert.deepEqual(pageIdsOf(doc), [p1.id, p2.id]);
  // 无 root 或缺 components 时安全返回空
  assert.deepEqual(pageIdsOf(null), []);
  assert.deepEqual(pageIdsOf({ components: {} }), []);
});

test('pageIdsOf：只认 root 直接子元素中 page===true 的容器', () => {
  const comps = buildPagesDoc().presentations.main.components;
  assert.deepEqual(pageIdsOf({ components: comps }), ['page_home', 'page_settings']);
});

// ---------- 校验 ----------
test('validateDoc v3：页面 + goto 合法文档通过', () => {
  const report = validateDoc(buildPagesDoc());
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test('validateDoc v3：goto 目标不是页面容器 → E_ACTION_TARGET_INVALID', () => {
  const doc = buildPagesDoc();
  doc.presentations.main.components.btn_goto_settings.actions.click.target = 'panel_drawer';
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_ACTION_TARGET_INVALID' && /goto/.test(e.message)));
});

test('validateDoc v3：goto 目标不存在 → E_ACTION_TARGET_INVALID', () => {
  const doc = buildPagesDoc();
  doc.presentations.main.components.btn_goto_settings.actions.click.target = 'nope';
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_ACTION_TARGET_INVALID'));
});

test('validateDoc v3：页面容器不可作为 toggle/open/close 的面板目标', () => {
  const doc = buildPagesDoc();
  doc.presentations.main.components.btn_open_drawer.actions.click = { type: 'open', target: 'page_settings' };
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_ACTION_TARGET_INVALID' && /goto/.test(e.message)));
});

test('validateDoc v3：page 只允许 container 布尔值', () => {
  const doc = buildPagesDoc();
  doc.presentations.main.components.btn_goto_settings.page = true;
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_FIELD_INVALID' && e.componentId === 'btn_goto_settings'));
});

test('validateDoc v3：页面容器必须是 root 的直接子元素 → E_PAGE_INVALID', () => {
  const doc = buildPagesDoc();
  const nested = doc.presentations.main.components.page_settings;
  nested.parent = 'page_home';
  doc.presentations.main.components.page_home.children.push('page_settings');
  doc.presentations.main.components.root.children = doc.presentations.main.components.root.children.filter((x) => x !== 'page_settings');
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_PAGE_INVALID'));
});

test('validateDoc v3：页面容器不允许 initiallyOpen 混用 → E_PAGE_INVALID', () => {
  const doc = buildPagesDoc();
  doc.presentations.main.components.page_settings.initiallyOpen = false;
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_PAGE_INVALID' && /initiallyOpen/.test(e.message)));
});

test('validateDoc v2：page 与 goto 都是未知字段，v2 文档拒绝', () => {
  const v3 = buildPagesDoc();
  const v2 = {
    format: 'uidoc', version: 2, revision: 1, mode: 'generic', name: 'v2',
    canvas: { width: 800, height: 600 }, resources: {},
    components: JSON.parse(JSON.stringify(v3.presentations.main.components)),
  };
  const report = validateDoc(v2);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_FIELD_UNKNOWN' && e.field === 'page'));
  assert.ok(report.errors.some((e) => e.code === 'E_FIELD_UNKNOWN' && /actions/.test(e.field || '')));
});

test('applyOps v3：add 可带 page 字段创建页面（白名单放行）', () => {
  const next = applyOps(buildPagesDoc(), [{
    action: 'add', parent: 'root',
    component: {
      type: 'container', name: '关于页', page: true,
      placement: { mode: 'absolute' }, position: { left: 0, top: 0 },
      layout: { mode: 'free' },
      size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
    },
  }]);
  // 中文名取不到 ASCII slug 时按既有规则以类型名为 id 基础
  assert.deepEqual(pageIdsOf({ components: next.presentations.main.components }), ['page_home', 'page_settings', 'container']);
  assert.equal(next.presentations.main.components.container.name, '关于页');
  assert.equal(validateDoc(next).ok, true, JSON.stringify(validateDoc(next).errors));
});

// ---------- 解析 ----------
test('resolveVariant：剥离 page 字段，解析结果通过 v2 校验', () => {
  const doc = buildPagesDoc();
  const resolved = resolveVariant(doc, 'v1');
  assert.equal('page' in resolved.components.page_home, false);
  assert.equal('actions' in resolved.components.btn_goto_settings, false);
  const report = validateDoc(resolved);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

// ---------- 运行时 ----------
// 假 DOM（与 m3-runtime.test.js 同思路，只实现 runtime 用到的能力）
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
    this.style = new Proxy({}, { set: (target, key, value) => { target[key] = String(value); return true; } });
  }
  get firstElementChild() { return this.children[0] || null; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn)); }
  dispatch(type, event = {}) {
    const ev = { target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (let node = this; node; node = node.parentElement) {
      for (const fn of [...(node.listeners.get(type) || [])]) fn(ev);
    }
  }
  focus() { /* 记录不需要 */ }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const m = selector.match(/^\[data-id="(.+)"\]$/);
    if (!m) throw new Error('假 DOM 只支持 [data-id="x"] 选择器：' + selector);
    const found = [];
    const visit = (node) => { for (const child of node.children) { if (child.dataset && child.dataset.id === m[1]) found.push(child); visit(child); } };
    visit(this);
    return found;
  }
}

function buildRuntimeDom() {
  const owner = new FakeElement('#document', null);
  owner.createElement = (tag) => new FakeElement(tag, owner);
  const rootEl = new FakeElement('div', owner);
  const mk = (id, display) => {
    const el = new FakeElement('div', owner);
    el.dataset.id = id;
    el.style.display = display;
    rootEl.appendChild(el);
    return el;
  };
  return {
    rootEl,
    pageHome: mk('page_home', 'block'),
    pageSettings: mk('page_settings', 'block'),
    panel: mk('panel_drawer', 'flex'),
    btnGoto: mk('btn_goto_settings', 'inline-flex'),
    btnOpen: mk('btn_open_drawer', 'inline-flex'),
  };
}

test('extractInteractionSpec：pages 按 root.children 顺序提取，首个为起始页', () => {
  const spec = extractInteractionSpec(buildPagesDoc(), 'v1');
  assert.deepEqual(spec.pages, ['page_home', 'page_settings']);
  assert.deepEqual(spec.initiallyClosed, ['panel_drawer']);
  assert.deepEqual(Object.keys(spec.actions), ['btn_goto_settings', 'btn_open_drawer']);
  assert.deepEqual(spec.actions.btn_goto_settings, { click: { type: 'goto', target: 'page_settings' } });
  // spec 与 doc 无共享引用
  const doc = buildPagesDoc();
  const spec2 = extractInteractionSpec(doc, 'v1');
  spec2.pages.push('x');
  assert.deepEqual(extractInteractionSpec(doc, 'v1').pages, ['page_home', 'page_settings']);
});

test('运行时：初始只显示起始页；goto 切页并收起面板；destroy 全部恢复', () => {
  const dom = buildRuntimeDom();
  const spec = extractInteractionSpec(buildPagesDoc(), 'v1');
  const rt = initInteractions({ rootEl: dom.rootEl, spec });
  // 初始：起始页可见，第二页与面板隐藏
  assert.equal(rt.currentPage(), 'page_home');
  assert.notEqual(dom.pageHome.style.display, 'none');
  assert.equal(dom.pageSettings.style.display, 'none');
  assert.equal(dom.panel.style.display, 'none');

  // goto：切到设置页
  dom.btnGoto.dispatch('click');
  assert.equal(rt.currentPage(), 'page_settings');
  assert.equal(dom.pageHome.style.display, 'none');
  assert.notEqual(dom.pageSettings.style.display, 'none');

  // 切页收起已打开面板：先开抽屉，再 goto，抽屉应被关闭
  dom.btnOpen.dispatch('click');
  assert.notEqual(dom.panel.style.display, 'none');
  dom.btnGoto.dispatch('click');
  assert.equal(dom.panel.style.display, 'none');

  // goto 目标 = 当前页：保持显示
  rt.gotoPage('page_settings');
  assert.equal(rt.currentPage(), 'page_settings');
  assert.notEqual(dom.pageSettings.style.display, 'none');
  // 非法目标被忽略
  assert.equal(rt.gotoPage('nope'), false);

  // destroy：撤销全部 DOM 修改
  rt.destroy();
  assert.equal(dom.pageHome.style.display, 'block');
  assert.equal(dom.pageSettings.style.display, 'block');
  assert.equal(dom.panel.style.display, 'flex');
});

test('运行时：无页面的 v3 文档行为不变', () => {
  const dom = buildRuntimeDom();
  const spec = extractInteractionSpec(buildPagesDoc(), 'v1');
  spec.pages = []; // 模拟无页面文档
  const rt = initInteractions({ rootEl: dom.rootEl, spec });
  assert.equal(rt.currentPage(), null);
  dom.btnOpen.dispatch('click');
  assert.notEqual(dom.panel.style.display, 'none');
  rt.destroy();
  assert.equal(dom.panel.style.display, 'flex');
});

// ---------- v2→v3 升级 ----------
test('upgradeDocToV3：组件树原样入 presentations.main，校验通过', () => {
  const v2 = newDoc('升级测试', 'generic', 'free');
  const before = JSON.stringify(v2.components);
  const up = upgradeDocToV3(v2);
  assert.equal(up.version, 3);
  assert.equal(up.activeVariant, 'main');
  assert.deepEqual(up.presentations.main.components.root.id, 'root');
  assert.equal(JSON.stringify(up.presentations.main.components), before, '组件树逐字节一致');
  const report = validateDoc(up);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  // 幂等边界：已是 v3 / v1 输入明确拒绝
  assert.throws(() => upgradeDocToV3(up), /已经是 v3/);
  assert.throws(() => upgradeDocToV3({ ...v2, version: 1 }), /仅支持将 v2/);
});

// ---------- 编辑器状态（store） ----------
test('store：loadProject 默认激活起始页；select 自动切换所属页面；addPage 新建并切换', () => {
  loadProject('v31-pages', buildPagesDoc());
  assert.deepEqual(pagesOfDoc(), ['page_home', 'page_settings']);
  assert.equal(state.activePageId, 'page_home');

  // 选中非页面组件：页面不变
  select('btn_open_drawer');
  assert.equal(state.activePageId, 'page_home');
  // 选中第二页内组件：自动切页
  select('btn_goto_settings');
  assert.equal(state.activePageId, 'page_home');
  select('page_settings');
  assert.equal(state.activePageId, 'page_settings');

  // 新建页面：创建 + 立即激活，文档可保存
  const id = addPage('页面 3');
  assert.ok(id);
  assert.equal(state.activePageId, id);
  assert.deepEqual(pagesOfDoc(), ['page_home', 'page_settings', id]);
  assert.equal(validateDoc(state.doc).ok, true, JSON.stringify(validateDoc(state.doc).errors));
});

test('store：v2 文档无页面，activePageId 恒为 null', () => {
  loadProject('v31-plain', newDoc('普通 v2', 'generic', 'free'));
  assert.deepEqual(pagesOfDoc(), []);
  assert.equal(state.activePageId, null);
});

// ---------- 实测重叠豁免 ----------
test('checkSnapshot：不同页面间的重叠不报告；不传 pageIds 时维持原判', () => {
  const doc = {
    revision: 1,
    components: {
      root: { id: 'root', type: 'container', parent: null, children: ['pageA', 'pageB', 'chrome'], layout: { mode: 'free' } },
      pageA: { id: 'pageA', type: 'container', parent: 'root', page: true, placement: { mode: 'absolute' }, position: { left: 0, top: 0 }, children: [] },
      pageB: { id: 'pageB', type: 'container', parent: 'root', page: true, placement: { mode: 'absolute' }, position: { left: 0, top: 0 }, children: [] },
      chrome: { id: 'chrome', type: 'container', parent: 'root', placement: { mode: 'absolute' }, position: { left: 0, top: 0 }, children: [] },
    },
  };
  const full = { x: 0, y: 0, width: 800, height: 600, visible: true, bl: 0, bt: 0 };
  const snapshot = {
    revision: 1, viewport: { width: 800, height: 600 },
    measured: { root: { ...full }, pageA: { ...full }, pageB: { ...full }, chrome: { ...full } },
  };
  // 不传 pageIds：三对独立摆放重叠全部报告（历史行为）
  const plain = checkSnapshot(doc, snapshot);
  assert.equal(plain.issues.filter((i) => i.code === 'W_OVERLAP_FREE').length, 3);
  // 传 pageIds：页面互斥显示，跨页重叠豁免
  const exempt = checkSnapshot(doc, snapshot, { pageIds: ['pageA', 'pageB'] });
  assert.equal(exempt.issues.filter((i) => i.code === 'W_OVERLAP_FREE').length, 0);
});
