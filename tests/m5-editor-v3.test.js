import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state, loadProject, mutate, mutateDoc, undo, viewDoc, scopeOf, computeView } from '../app/store.js';
import { remapComponentRefs, cleanupDeletedRefs, uniqueVariantId, uniquePresentationId } from '../app/v3edit.js';
import { validateDoc } from '../shared/validate.js';
import { ID_PATTERN } from '../shared/protocol.js';

// ============================================================
// M5 编辑器变体支持测试
// store.js 的解析视图/编辑域语义 + v3edit 引用维护助手。
// store 是纯内存模块（localStorage 有 try/catch 守护），Node 可直接驱动。
// ============================================================

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(TEST_ROOT, 'tests', 'fixtures', 'v3-sample.uidoc.json');
const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// 构造一个最小可校验的 v3 文档（含令牌样式 / 覆盖补丁 / 点击动作 / 初始收起面板）
function makeV3Doc() {
  const comp = (id, type, parent, extra = {}) => ({
    id, type, parent, children: [], flags: {},
    size: { width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 40 } },
    style: {}, ...extra,
  });
  return {
    format: 'uidoc', version: 3, revision: 1, name: 'M5测试', mode: 'generic',
    canvas: { width: 800, height: 600, background: '#ffffff' },
    resources: {},
    features: { bag: { label: '背包', data: { items: ['剑', '盾'] } } },
    styles: {
      dark: { label: '暗色', tokens: { 'color.panel': '#111827' } },
      light: { label: '亮色', tokens: { 'color.panel': '#f8fafc' } },
    },
    presentations: {
      panels: {
        label: '面板呈现',
        components: {
          root: comp('root', 'container', null, {
            name: '页面', layout: { mode: 'vertical' }, children: ['btn1', 'panel1'],
            size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
          }),
          btn1: comp('btn1', 'button', 'root', {
            name: '按钮', text: '菜单', featureId: 'bag',
            actions: { click: { type: 'toggle', target: 'panel1' } },
          }),
          panel1: comp('panel1', 'container', 'root', {
            name: '面板', initiallyOpen: false, layout: { mode: 'vertical' }, style: { background: '$color.panel' },
          }),
        },
      },
    },
    variants: [
      { id: 'v1', label: '暗面板', presentation: 'panels', style: 'dark', overrides: { tokens: {}, components: {} } },
      { id: 'v2', label: '亮面板', presentation: 'panels', style: 'light', overrides: { tokens: {}, components: { panel1: { borderRadius: 12 } } } },
    ],
    activeVariant: 'v1',
  };
}

// ---------- 解析视图 ----------
test('M5: v3 文档载入后 view 是解析出的 v2 形状，原文档保持 v3 原样', () => {
  const doc = makeV3Doc();
  loadProject('m5test', doc);
  const view = viewDoc();
  assert.equal(view.version, 2);
  assert.ok(view.components && view.components.root);
  assert.equal(view.components.panel1.style.background, '#111827'); // 令牌已替换
  assert.equal(view.features, undefined); // v3 顶层段不进解析结果
  assert.equal(state.doc.version, 3);
  assert.equal(state.doc.presentations.panels.components.panel1.style.background, '$color.panel'); // 原文档未动
  assert.equal(state.viewError, null);
});

test('M5: v3 解析失败（activeVariant 悬空）→ viewError 结构化记录，view 为 null', () => {
  const doc = makeV3Doc();
  doc.activeVariant = 'missing';
  loadProject('m5test', doc);
  assert.equal(viewDoc(), null);
  assert.equal(state.viewError.code, 'E_VARIANT_UNKNOWN');
});

test('M5: v2 文档 view 即文档本体', () => {
  const doc = { format: 'uidoc', version: 2, revision: 1, name: 'v2', mode: 'generic', canvas: { width: 800, height: 600, background: '#fff' }, resources: {}, components: {} };
  loadProject('m5test', doc);
  assert.equal(viewDoc(), state.doc);
  assert.equal(state.viewError, null);
});

// ---------- 编辑域（scope）语义 ----------
test('M5: mutate 回调经编辑域落进 activeVariant 指向的 presentation 原树', () => {
  const doc = makeV3Doc();
  loadProject('m5test', doc);
  mutate('编辑按钮文字', (d) => { d.components.btn1.text = '新文案'; });
  assert.equal(state.doc.presentations.panels.components.btn1.text, '新文案');
  assert.equal(viewDoc().components.btn1.text, '新文案');
  assert.equal(state.dirty, true);
  undo();
  assert.equal(state.doc.presentations.panels.components.btn1.text, '菜单');
  assert.equal(viewDoc().components.btn1.text, '菜单');
});

test('M5: mutateDoc 对顶层字段赋值生效（activeVariant 切换），view 跟随重解析', () => {
  const doc = makeV3Doc();
  loadProject('m5test', doc);
  mutateDoc('切换变体', (d) => { d.activeVariant = 'v2'; });
  assert.equal(state.doc.activeVariant, 'v2');
  const view = viewDoc();
  assert.equal(view.components.panel1.style.background, '#f8fafc');
  assert.equal(view.components.panel1.style.borderRadius, 12); // v2 的覆盖补丁生效
  undo();
  assert.equal(state.doc.activeVariant, 'v1');
  assert.equal(viewDoc().components.panel1.style.borderRadius, undefined);
});

test('M5: 普通 mutate（scope）上的顶层字段赋值不持久化——四段编辑必须走 mutateDoc', () => {
  const doc = makeV3Doc();
  loadProject('m5test', doc);
  mutate('错误示范', (d) => { d.activeVariant = 'v2'; });
  assert.equal(state.doc.activeVariant, 'v1'); // scope 浅拷贝上的赋值不落库
});

test('M5: scopeOf 把 components 映射到活动 presentation 树，__presentationId 记录来源', () => {
  const doc = makeV3Doc();
  loadProject('m5test', doc);
  const scope = scopeOf(state.doc);
  assert.equal(scope.__presentationId, 'panels');
  assert.equal(scope.components.btn1.text, '菜单');
  assert.equal(scope.version, 3); // 其余字段照抄原文档
});

// ---------- v3edit：引用维护 ----------
test('M5: remapComponentRefs 重命名后联动 actions.target 与指向该呈现的变体补丁键', () => {
  const doc = makeV3Doc();
  remapComponentRefs(doc, 'panels', { panel1: 'panelX' });
  assert.equal(doc.presentations.panels.components.btn1.actions.click.target, 'panelX');
  const v2 = doc.variants.find((v) => v.id === 'v2');
  assert.equal(v2.overrides.components.panel1, undefined);
  assert.deepEqual(v2.overrides.components.panelX, { borderRadius: 12 });
});

test('M5: remapComponentRefs 不触碰其他呈现方案的变体补丁', () => {
  const doc = makeV3Doc();
  doc.presentations.other = { label: '另一呈现', components: { root: { id: 'root', type: 'container', parent: null, children: [], size: {}, style: {}, flags: {} } } };
  doc.variants.push({ id: 'v3', label: '另一变体', presentation: 'other', style: 'dark', overrides: { tokens: {}, components: { panel1: { opacity: 0.5 } } } });
  remapComponentRefs(doc, 'panels', { panel1: 'panelX' });
  const v3 = doc.variants.find((v) => v.id === 'v3');
  assert.deepEqual(v3.overrides.components.panel1, { opacity: 0.5 }); // other 呈现的补丁键保持不动
});

test('M5: cleanupDeletedRefs 清理指向被删组件的点击动作与补丁键', () => {
  const doc = makeV3Doc();
  cleanupDeletedRefs(doc, 'panels', ['panel1']);
  assert.equal(doc.presentations.panels.components.btn1.actions, undefined); // click 动作整条移除
  const v2 = doc.variants.find((v) => v.id === 'v2');
  assert.equal(v2.overrides.components.panel1, undefined);
});

// ---------- 唯一 id 助手 ----------
test('M5: uniqueVariantId 去重与中文兜底', () => {
  const doc = makeV3Doc();
  assert.equal(uniqueVariantId(doc, 'V1'), 'v1_2'); // slugify 转小写后与既有 v1 撞名 → 去重
  assert.ok(ID_PATTERN.test(uniqueVariantId(doc, '纯中文名'))); // slug 取不到 → variant 兜底
  doc.variants.push({ id: 'variant', label: 'x', presentation: 'panels', style: 'dark', overrides: { tokens: {}, components: {} } });
  assert.equal(uniqueVariantId(doc, '纯中文名'), 'variant_2');
});

test('M5: uniquePresentationId 生成未占用键', () => {
  const doc = makeV3Doc();
  assert.equal(uniquePresentationId(doc, 'panels_copy'), 'panels_copy');
  doc.presentations.panels_copy = { label: 'x', components: {} };
  assert.equal(uniquePresentationId(doc, 'panels_copy'), 'panels_copy_2');
});

// ---------- 完整性：夹具本身可校验；编辑后的文档仍可校验 ----------
test('M5: 六套方案样例夹具通过 v3 校验；切换变体+新建变体后仍通过', () => {
  const doc = loadFixture();
  assert.equal(validateDoc(doc).ok, true);
  loadProject('m5test', doc);
  mutateDoc('切换', (d) => { d.activeVariant = 'B3'; });
  assert.equal(validateDoc(state.doc).ok, true);
  mutateDoc('新建', (d) => {
    d.variants.push({ id: 'A1_v2', label: '新变体', presentation: 'persistent', style: 'scifi', overrides: { tokens: {}, components: {} } });
    d.activeVariant = 'A1_v2';
  });
  const report = validateDoc(state.doc);
  assert.equal(report.ok, true, JSON.stringify(report.errors || []));
  // 新变体解析结果与原变体同树同风格
  computeView();
  assert.ok(viewDoc().components.root);
});

test('M5: 面板改名/删除流程语义（remap+cleanup 后文档仍通过校验）', () => {
  const doc = makeV3Doc();
  assert.equal(validateDoc(doc).ok, true); // 夹具本身合法
  // 模拟 renameComponent 的完整改名：移动组件表键 + 修父 children + 引用重映射
  const comps = doc.presentations.panels.components;
  const moved = comps.panel1;
  comps.panel1_renamed = moved;
  delete comps.panel1;
  moved.id = 'panel1_renamed';
  comps.root.children = comps.root.children.map((x) => (x === 'panel1' ? 'panel1_renamed' : x));
  remapComponentRefs(doc, 'panels', { panel1: 'panel1_renamed' });
  const report1 = validateDoc(doc);
  assert.equal(report1.ok, true, JSON.stringify(report1.errors || []));
  // 模拟删除：移除组件 + 清理引用
  delete comps.panel1_renamed;
  comps.root.children = comps.root.children.filter((x) => x !== 'panel1_renamed');
  cleanupDeletedRefs(doc, 'panels', ['panel1_renamed']);
  const report2 = validateDoc(doc);
  assert.equal(report2.ok, true, JSON.stringify(report2.errors || []));
});
