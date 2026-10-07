import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { state, loadProject, mutate, undo, pushUndoEntry } from '../app/store.js';
import { collectCopySnapshot, pasteSnapshotIntoDoc, duplicateSubtree, CLIPBOARD_KIND } from '../shared/clipboard.js';
import { checkSnapshot } from '../shared/measure.js';
import { editScopeOf } from '../shared/resolve.js';
import { validateDoc } from '../shared/validate.js';
import { newDoc } from '../shared/protocol.js';
import { publishExportDir } from '../shared/exportdir.js';

// ============================================================
// S1 可靠性测试（优化计划 §7 阶段一）
// B02 项目切换/加载最新的撤销语义；B03 v3 实测校验读取；
// B04 复制粘贴原始语义与依赖合并；B05 副本引用重映射；
// B06 隐藏组件跳过实测结论；B08 导出目录唯一发布。
// ============================================================

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(TEST_ROOT); // 仅供对齐既有测试文件的结构约定

// 构造最小可校验的 v3 文档：按钮（功能绑定 + 令牌样式 + 指向面板的动作）+ 收起面板
function makeV3Doc({ revision = 1, btnText = '打开面板' } = {}) {
  const comp = (id, type, parent, extra = {}) => ({
    id, type, parent, children: [], flags: {},
    size: { width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 40 } },
    style: {}, ...extra,
  });
  return {
    format: 'uidoc', version: 3, revision, name: 'S1测试', mode: 'generic',
    canvas: { width: 800, height: 600, background: '#ffffff' },
    resources: {},
    features: { bag: { label: '背包', data: { items: ['剑', '盾'] } } },
    styles: {
      dark: { label: '暗色', tokens: { 'color.primary': '#2563eb' } },
    },
    presentations: {
      panels: {
        label: '面板呈现',
        components: {
          root: comp('root', 'container', null, {
            name: '页面', layout: { mode: 'vertical' },
            size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
            children: ['open_button', 'popup'],
          }),
          open_button: comp('open_button', 'button', 'root', {
            name: '打开面板', text: btnText, featureId: 'bag',
            bind: { text: 'feature:bag.items[0]' },
            style: { background: '$color.primary', padding: [10, 20, 10, 20] },
            actions: { click: { type: 'toggle', target: 'popup' } },
          }),
          popup: comp('popup', 'container', 'root', {
            name: '弹出面板', initiallyOpen: false, layout: { mode: 'vertical' },
            style: { background: '#f8fafc' },
          }),
        },
      },
    },
    variants: [
      { id: 'v1', label: '暗面板', presentation: 'panels', style: 'dark', overrides: { tokens: {}, components: {} } },
    ],
    activeVariant: 'v1',
  };
}

// ---------- B04：复制保留原始语义 ----------
test('B04 复制快照保留 actions/bind/featureId/$令牌（不丢语义）', () => {
  const doc = makeV3Doc();
  const clip = collectCopySnapshot(editScopeOf(doc, 'v1'), 'open_button', { sourceProject: '来源项目' });
  assert.equal(clip.kind, CLIPBOARD_KIND);
  assert.equal(clip.tree.open_button.actions.click.target, 'popup');
  assert.equal(clip.tree.open_button.featureId, 'bag');
  assert.equal(clip.tree.open_button.bind.text, 'feature:bag.items[0]');
  assert.equal(clip.tree.open_button.style.background, '$color.primary');
  assert.deepEqual(clip.features.bag.data.items, ['剑', '盾']);
  assert.equal(clip.styles.dark.tokens['color.primary'], '#2563eb');
  assert.equal(clip.sourceProject, '来源项目');
});

test('B04 同项目粘贴：组内动作目标重映射到副本面板，语义全保留', () => {
  const doc = makeV3Doc();
  // 把按钮和收起面板装进同一容器组并复制整组：组内 toggle 目标应映射到副本面板
  doc.presentations.panels.components.group = {
    id: 'group', type: 'container', parent: 'root', children: ['open_button', 'popup'], flags: {},
    layout: { mode: 'vertical' },
    size: { width: { mode: 'fixed', value: 200 }, height: { mode: 'fixed', value: 120 } },
    style: {},
  };
  doc.presentations.panels.components.root.children = ['group'];
  doc.presentations.panels.components.open_button.parent = 'group';
  doc.presentations.panels.components.popup.parent = 'group';
  const clip = collectCopySnapshot(editScopeOf(doc, 'v1'), 'group', { sourceProject: '同一项目' });
  const next = JSON.parse(JSON.stringify(doc));
  const scope = editScopeOf(next, 'v1'); // v3 组件树在 presentation 内：断言走编辑域
  const result = pasteSnapshotIntoDoc(scope, clip, 'root', { currentProject: '同一项目' });
  assert.ok(!result.aborted, JSON.stringify(result.notices));
  const pasted = scope.components[result.newId];
  assert.equal(pasted.id, 'group_copy');
  const pastedBtn = scope.components[pasted.children[0]];
  assert.equal(pastedBtn.id, 'open_button_copy');
  assert.equal(pastedBtn.actions.click.target, 'popup_copy', '组内目标重映射到粘贴树内的副本面板');
  assert.equal(scope.components.popup_copy.initiallyOpen, false);
  assert.equal(pastedBtn.featureId, 'bag');
  assert.equal(pastedBtn.bind.text, 'feature:bag.items[0]');
  assert.equal(pastedBtn.style.background, '$color.primary', '同项目令牌保留引用');
  assert.equal(validateDoc(next).ok, true, JSON.stringify(validateDoc(next).errors));
});

test('B04 跨项目粘贴：功能缺失补入、冲突改名重映射、未知令牌冻结', () => {
  const source = makeV3Doc();
  const clip = collectCopySnapshot(editScopeOf(source, 'v1'), 'open_button', { sourceProject: '来源项目' });
  // 目标：同名功能但内容不同（触发改名 + bind 重映射）；令牌虽同名但走目标变体判断
  const target = makeV3Doc();
  target.features.bag = { label: '背包（目标版）', data: { items: ['药水'] } };
  target.name = '目标项目';
  const next = JSON.parse(JSON.stringify(target));
  const scope = editScopeOf(next, 'v1');
  const result = pasteSnapshotIntoDoc(scope, clip, 'root', { currentProject: '目标项目' });
  assert.ok(!result.aborted, JSON.stringify(result.notices));
  const pasted = scope.components[result.newId];
  assert.notEqual(pasted.featureId, 'bag', '冲突功能不能静默覆盖目标');
  assert.equal(next.features[pasted.featureId].label, '背包');
  assert.equal(pasted.bind.text, `feature:${pasted.featureId}.items[0]`, 'bind 前缀跟随新功能 id');
  const notices = result.notices.map((n) => n.message).join('\n');
  assert.match(notices, /bag_copy/);
  assert.equal(validateDoc(next).ok, true, JSON.stringify(validateDoc(next).errors));
});

test('B04 令牌不在目标变体范围且来源缺值时：整次粘贴被拒绝', () => {
  const source = makeV3Doc();
  const clip = collectCopySnapshot(editScopeOf(source, 'v1'), 'open_button', { sourceProject: '来源项目' });
  delete clip.styles.dark; // 模拟来源也没有该令牌的取值
  const target = newDoc('v2目标', 'generic', 'free');
  const before = JSON.stringify(target);
  const result = pasteSnapshotIntoDoc(target, clip, 'root');
  assert.ok(result.aborted);
  assert.equal(JSON.stringify(target), before, '拒绝时目标文档不被改动');
  assert.match(result.notices.map((n) => n.message).join('\n'), /粘贴被拒绝/);
});

test('B04 粘贴到 v2 文档：剥除 v3 专属字段并冻结令牌，文档仍可保存', () => {
  const source = makeV3Doc();
  const clip = collectCopySnapshot(editScopeOf(source, 'v1'), 'open_button', { sourceProject: '来源项目' });
  const target = newDoc('v2目标', 'generic', 'free');
  const result = pasteSnapshotIntoDoc(target, clip, 'root', { currentProject: '来源项目' });
  assert.ok(!result.aborted, JSON.stringify(result.notices));
  const pasted = target.components[result.newId];
  assert.equal(pasted.actions, undefined);
  assert.equal(pasted.featureId, undefined);
  assert.equal(pasted.bind, undefined);
  assert.equal(pasted.style.background, '#2563eb', 'v2 无令牌体系 → 冻结为来源取值');
  const notices = result.notices.map((n) => n.message).join('\n');
  assert.match(notices, /v2 文档/);
  assert.equal(validateDoc(target).ok, true, JSON.stringify(validateDoc(target).errors));
});

test('B04 跨项目粘贴时子树外部的动作目标被移除并提示', () => {
  const source = makeV3Doc();
  source.presentations.panels.components.inner = {
    id: 'inner', type: 'container', parent: 'root', children: ['btn2'], flags: {},
    layout: { mode: 'vertical' },
    size: { width: { mode: 'fixed', value: 200 }, height: { mode: 'fixed', value: 100 } },
    style: {},
  };
  source.presentations.panels.components.root.children.push('inner');
  source.presentations.panels.components.btn2 = {
    id: 'btn2', type: 'button', parent: 'inner', children: [], flags: {},
    size: { width: { mode: 'fixed', value: 80 }, height: { mode: 'fixed', value: 32 } },
    style: {}, text: '外部开关',
    actions: { click: { type: 'toggle', target: 'popup' } }, // popup 不在复制子树内
  };
  const clip = collectCopySnapshot(editScopeOf(source, 'v1'), 'inner', { sourceProject: '来源项目' });
  const target = makeV3Doc();
  target.name = '目标项目';
  const next = JSON.parse(JSON.stringify(target));
  const scope = editScopeOf(next, 'v1');
  const result = pasteSnapshotIntoDoc(scope, clip, 'root', { currentProject: '目标项目' });
  assert.ok(!result.aborted, JSON.stringify(result.notices));
  const pastedBtn = scope.components['btn2_copy'];
  assert.ok(pastedBtn, '粘贴的按钮存在');
  assert.equal(pastedBtn.actions, undefined, '跨项目时外部目标的动作被移除');
  assert.match(result.notices.map((n) => n.message).join('\n'), /动作已移除/);
  assert.equal(validateDoc(next).ok, true, JSON.stringify(validateDoc(next).errors));
});

// ---------- B05：副本引用重映射 ----------
test('B05 副本：按钮先于目标面板复制，副本按钮指向副本面板', () => {
  const doc = makeV3Doc();
  // 按钮与面板同组、按钮在前（前向引用）；复制整组后组内 toggle 应指向副本面板
  doc.presentations.panels.components.group = {
    id: 'group', type: 'container', parent: 'root', children: ['open_button', 'popup'], flags: {},
    layout: { mode: 'vertical' },
    size: { width: { mode: 'fixed', value: 200 }, height: { mode: 'fixed', value: 120 } },
    style: {},
  };
  doc.presentations.panels.components.root.children = ['group'];
  doc.presentations.panels.components.open_button.parent = 'group';
  doc.presentations.panels.components.popup.parent = 'group';
  const next = JSON.parse(JSON.stringify(doc));
  const scope = editScopeOf(next, 'v1');
  const r = duplicateSubtree(scope, 'group');
  assert.ok(r);
  // 与编辑器 duplicateComponent 一致：副本插入父容器 children（紧跟原件）
  const rootKids = scope.components.root.children;
  rootKids.splice(rootKids.indexOf('group') + 1, 0, r.newId);
  const copyBtn = scope.components[r.newId].children.map((cid) => scope.components[cid])
    .find((c) => c.type === 'button');
  assert.equal(copyBtn.id, 'open_button_copy');
  assert.equal(copyBtn.actions.click.target, 'popup_copy', '前向引用也能映射到副本面板');
  assert.equal(scope.components.popup_copy.initiallyOpen, false);
  assert.equal(validateDoc(next).ok, true, JSON.stringify(validateDoc(next).errors));
});

test('B05 副本：子树外部的动作目标保持不变', () => {
  const doc = makeV3Doc();
  doc.presentations.panels.components.btn2 = {
    id: 'btn2', type: 'button', parent: 'root', children: [], flags: {},
    size: { width: { mode: 'fixed', value: 80 }, height: { mode: 'fixed', value: 32 } },
    style: {}, text: '外部开关',
    actions: { click: { type: 'toggle', target: 'popup' } },
  };
  doc.presentations.panels.components.root.children.push('btn2');
  const next = JSON.parse(JSON.stringify(doc));
  const scope = editScopeOf(next, 'v1');
  const r = duplicateSubtree(scope, 'btn2');
  assert.equal(scope.components[r.newId].actions.click.target, 'popup', '外部目标按规则保留');
});

// ---------- B02：加载最新可撤销 ----------
test('B02 加载最新：旧未保存文档成为撤销记录，undo 恢复文档与修订号', () => {
  const docA = makeV3Doc({ revision: 1, btnText: '外部版本' });
  loadProject('S1B02', docA);
  mutate('改按钮文字', (d) => {
    d.presentations.panels.components.open_button.text = '改过的文字';
  });
  assert.equal(state.dirty, true);
  // 外部把文件更新到修订号 2（不含用户的未保存修改）→ 用户选择"加载最新"
  const docB = makeV3Doc({ revision: 2, btnText: '外部版本2' });
  pushUndoEntry({ doc: state.doc, label: '加载最新前（未保存修改）', revision: state.revision });
  loadProject('S1B02', docB, { keepHistory: true });
  assert.equal(state.dirty, false);
  assert.equal(state.doc.presentations.panels.components.open_button.text, '外部版本2');
  undo();
  assert.equal(state.doc.presentations.panels.components.open_button.text, '改过的文字', '未保存修改可通过撤销找回');
  assert.equal(state.revision, 1, '撤销一并恢复该文档对应的磁盘修订号');
  assert.equal(state.dirty, true);
});

// ---------- B03：v3 实测校验读取 ----------
function fullSnapshot(comps, revision, overrides = {}) {
  const measured = { root: { x: 0, y: 0, width: 800, height: 600, visible: true, bl: 0, bt: 0 } };
  for (const id of Object.keys(comps)) {
    if (id === 'root') continue;
    const o = overrides[id] || { x: 0, y: 0, width: 100, height: 40, visible: true };
    measured[id] = { ...o, bl: 0, bt: 0 };
  }
  return { revision, viewport: { width: 800, height: 600 }, measuredAt: new Date().toISOString(), measured };
}

test('B03 checkSnapshot 接受 v3 编辑域（editScopeOf），拒绝 v3 文档本体且不崩溃', () => {
  const doc = makeV3Doc();
  // 文档本体没有顶层 components：结构化错误而不是 TypeError（历史缺陷 E_CLI_CRASH）
  const raw = checkSnapshot(doc, fullSnapshot({}, doc.revision));
  assert.equal(raw.ok, false);
  assert.ok(raw.errors.some((e) => e.code === 'E_SNAPSHOT' && /components/.test(e.message)));
  // 编辑域视图：正常对照
  const scope = editScopeOf(doc, 'v1');
  assert.equal(scope.components.open_button.actions.click.target, 'popup', '编辑域保留原始语义');
  const rep = checkSnapshot(scope, fullSnapshot(scope.components, doc.revision));
  assert.equal(rep.ok, true, JSON.stringify(rep.errors));
});

test('B03 editScopeOf：未知变体抛结构化错误，作用域携带呈现方案定位', () => {
  const doc = makeV3Doc();
  assert.throws(() => editScopeOf(doc, '不存在'), (e) => e.code === 'E_VARIANT_UNKNOWN');
  const scope = editScopeOf(doc, 'v1');
  assert.equal(scope.__presentationId, 'panels');
  assert.equal(scope.__variantId, 'v1');
  assert.equal(scope.revision, doc.revision);
});

// ---------- B06：隐藏组件跳过实测结论 ----------
test('B06 hiddenIds：隐藏面板不产生不可见/重叠结论，可见组件仍受检', () => {
  const doc = newDoc('B06', 'generic', 'free');
  doc.components.btn = {
    id: 'btn', type: 'button', parent: 'root', children: [], flags: {},
    size: { width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 40 } },
    style: {}, text: '按钮',
    placement: { mode: 'absolute' }, position: { left: 10, top: 10 },
  };
  doc.components.panel = {
    id: 'panel', type: 'container', parent: 'root', children: [], flags: {},
    layout: { mode: 'vertical' },
    size: { width: { mode: 'fixed', value: 100 }, height: { mode: 'fixed', value: 40 } },
    style: {},
    placement: { mode: 'absolute' }, position: { left: 10, top: 10 }, // 与按钮重叠
    initiallyOpen: false, // 预览中隐藏
  };
  doc.components.root.children = ['btn', 'panel'];
  const measured = {
    root: { x: 0, y: 0, width: 1280, height: 800, visible: true, bl: 0, bt: 0 },
    btn: { x: 10, y: 10, width: 100, height: 40, visible: true, bl: 0, bt: 0 },
    panel: { x: 0, y: 0, width: 0, height: 0, visible: false, bl: 0, bt: 0 }, // display:none
  };
  const snap = { revision: doc.revision, viewport: { width: 1280, height: 800 }, measured };
  const withoutHidden = checkSnapshot(doc, snap, { pageIds: [] });
  assert.ok(withoutHidden.issues.some((i) => i.code === 'W_INVISIBLE' && i.componentId === 'panel'), '不隐藏时会误报不可见');
  const withHidden = checkSnapshot(doc, snap, { hiddenIds: ['panel'] });
  assert.ok(!withHidden.issues.some((i) => i.componentId === 'panel'), '隐藏组件不产生任何结论');
  assert.equal(withHidden.issues.filter((i) => i.severity === 'error').length, 0, JSON.stringify(withHidden.issues));
  // 可见组件仍受检：把按钮实测宽度改错 → E_SIZE_MISMATCH
  const snap2 = JSON.parse(JSON.stringify(snap));
  snap2.measured.btn.width = 55;
  const rep2 = checkSnapshot(doc, snap2, { hiddenIds: ['panel'] });
  assert.ok(rep2.errors.some((e) => e.code === 'E_SIZE_MISMATCH' && e.componentId === 'btn'));
});

// ---------- B08：导出目录唯一发布 ----------
test('B08 publishExportDir：同基名两次发布不覆盖，失败清理临时目录', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvasloom-export-test-'));
  try {
    const base = '项目_rev1_20260101-000000_ab12cd';
    const dir1 = await publishExportDir(root, base, async (tmp) => {
      await fsp.writeFile(path.join(tmp, 'design.uidoc.json'), 'first', 'utf8');
    });
    const dir2 = await publishExportDir(root, base, async (tmp) => {
      await fsp.writeFile(path.join(tmp, 'design.uidoc.json'), 'second', 'utf8');
    });
    assert.notEqual(dir1, dir2, '同秒两次导出必须得到不同目录');
    assert.equal(await fsp.readFile(path.join(dir1, 'design.uidoc.json'), 'utf8'), 'first', '先发布的目录不被覆盖');
    assert.equal(await fsp.readFile(path.join(dir2, 'design.uidoc.json'), 'utf8'), 'second');
    await assert.rejects(() => publishExportDir(root, '失败任务_rev1_x', async () => {
      throw new Error('boom');
    }), /boom/);
    const leftovers = (await fsp.readdir(root)).filter((n) => n.includes('.tmp-'));
    assert.equal(leftovers.length, 0, '临时目录应被清理：' + leftovers.join('、'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
