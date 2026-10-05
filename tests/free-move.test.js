import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { newDoc, newComponent, isAbsolutePlacement } from '../shared/protocol.js';
import { validateDoc, applyOps, ApplyError } from '../shared/validate.js';
import { checkSnapshot } from '../shared/measure.js';

const types = ['container', 'text', 'button', 'input', 'image', 'rect', 'divider'];
const layouts = ['vertical', 'horizontal', 'grid'];

function testDoc(layout) {
  const doc = newDoc('自由移动合同', 'generic');
  const parent = newComponent(doc, 'container', 'root', { id: 'test_parent', layoutMode: layout });
  parent.size = { width: { mode: 'fixed', value: 500 }, height: { mode: 'fixed', value: 400 } };
  parent.style.borderWidth = 3;
  parent.layout.padding = [7, 9, 11, 13];
  if (layout === 'grid') parent.layout.tracks = { columns: [{ mode: 'fill', value: 1 }, { mode: 'fill', value: 1 }], rows: [{ mode: 'fixed', value: 80 }] };
  return { doc, parent };
}

test('UIDoc v2: 三种自动布局中的七类组件均可显式独立摆放并允许负坐标', () => {
  for (const layout of layouts) {
    const { doc, parent } = testDoc(layout);
    for (const type of types) {
      const comp = newComponent(doc, type, parent.id, { id: `test_${type}` });
      comp.placement = { mode: 'absolute' };
      comp.position = { left: -17, top: 23 };
      comp.size = { width: { mode: 'fixed', value: 101 }, height: { mode: 'fixed', value: 42 } };
      if (layout === 'grid') comp.area = { col: 999, row: 999, colSpan: 1, rowSpan: 1 };
      assert.equal(isAbsolutePlacement(comp, parent), true);
    }
    const report = validateDoc(doc);
    assert.equal(report.ok, true, `${layout}: ${JSON.stringify(report.errors)}`);
  }
});

test('省略 placement 保留旧 v1/v2 父布局语义', () => {
  const { doc, parent } = testDoc('vertical');
  const child = newComponent(doc, 'text', parent.id);
  assert.equal(isAbsolutePlacement(child, parent), false);
  assert.equal(validateDoc(doc).ok, true);
  doc.version = 1;
  assert.equal(validateDoc(doc).ok, true);
});

test('v1 拒绝 placement；未知 mode 和 placement 子字段拒绝', () => {
  const { doc, parent } = testDoc('vertical');
  const child = newComponent(doc, 'rect', parent.id);
  child.placement = { mode: 'absolute' };
  child.position = { left: 0, top: 0 };
  child.size = { width: { mode: 'fixed', value: 20 }, height: { mode: 'fixed', value: 20 } };
  doc.version = 1;
  assert.ok(validateDoc(doc).errors.some((e) => e.code === 'E_VERSION_FIELD'));
  doc.version = 2;
  child.placement = { mode: 'teleport' };
  assert.ok(validateDoc(doc).errors.some((e) => e.code === 'E_PLACEMENT'));
  child.placement = { mode: 'absolute', unexpected: true };
  assert.ok(validateDoc(doc).errors.some((e) => e.code === 'E_PLACEMENT'));
  child.placement = { mode: 'flow' };
  child.position = { left: 1, top: 2 };
  assert.ok(validateDoc(doc).errors.some((e) => e.code === 'E_PLACEMENT'));
  doc.components.root.placement = { mode: 'absolute' };
  assert.ok(validateDoc(doc).errors.some((e) => e.componentId === 'root' && e.code === 'E_PLACEMENT'));
  delete doc.components.root.placement;
  parent.layout.mode = 'free';
  child.position = undefined;
  assert.ok(validateDoc(doc).errors.some((e) => e.componentId === child.id && e.code === 'E_PLACEMENT'));
});

test('applyOps 接受 absolute、检查非法 fill，失败保持文档原子性', () => {
  const { doc, parent } = testDoc('grid');
  const next = applyOps(doc, [{ action: 'add', parent: parent.id, component: {
    id: 'floating', type: 'button', text: '按钮', placement: { mode: 'absolute' },
    position: { left: -20, top: 8 }, size: { width: { mode: 'fixed', value: 90 }, height: { mode: 'fixed', value: 36 } },
  } }]);
  assert.deepEqual(next.components.floating.placement, { mode: 'absolute' });
  assert.deepEqual(next.components.floating.position, { left: -20, top: 8 });
  const before = JSON.stringify(next);
  assert.throws(() => applyOps(next, [
    { action: 'update', id: 'floating', fields: { position: { left: 4, top: 8 } } },
    { action: 'update', id: 'missing', fields: { name: 'bad' } },
  ]), ApplyError);
  assert.equal(JSON.stringify(next), before);
  assert.throws(() => applyOps(doc, [{ action: 'add', parent: parent.id, component: {
    type: 'rect', placement: { mode: 'absolute' }, position: { left: 0, top: 0 },
    size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 30 } },
  } }]), (e) => e instanceof ApplyError && e.payload.code === 'E_FREE_FILL');
});

test('CLI move 保留显式 absolute 与坐标，清除旧网格占格', () => {
  const { doc, parent } = testDoc('grid');
  const flow = newComponent(doc, 'container', 'root', { id: 'target_parent', layoutMode: 'horizontal' });
  const child = newComponent(doc, 'rect', parent.id, { id: 'move_absolute' });
  child.placement = { mode: 'absolute' };
  child.position = { left: -9, top: 18 };
  child.area = { col: 1, row: 1, colSpan: 1, rowSpan: 1 };
  child.size = { width: { mode: 'fixed', value: 20 }, height: { mode: 'fixed', value: 30 } };
  const next = applyOps(doc, [{ action: 'move', id: child.id, parent: flow.id }]);
  assert.deepEqual(next.components[child.id].placement, { mode: 'absolute' });
  assert.deepEqual(next.components[child.id].position, { left: -9, top: 18 });
  assert.equal(next.components[child.id].area, undefined);
});

test('CLI move 显式 flow 组件移入 legacy free 父容器时恢复旧自由布局语义', () => {
  const doc = newDoc('移入自由容器', 'generic');
  const horizontal = newComponent(doc, 'container', 'root', { id: 'flow_parent', layoutMode: 'horizontal' });
  const free = newComponent(doc, 'container', 'root', { id: 'free_parent', layoutMode: 'free' });
  const child = newComponent(doc, 'text', horizontal.id, { id: 'flow_child' });
  child.placement = { mode: 'flow' };
  const next = applyOps(doc, [{ action: 'move', id: child.id, parent: free.id }]);
  assert.equal(next.components[child.id].placement, undefined);
  assert.ok(next.components[child.id].position);
});

test('测量合同按父 border + padding + 负 position 核对 absolute 子项', () => {
  const { doc, parent } = testDoc('horizontal');
  parent.position = { left: 0, top: 0 };
  const child = newComponent(doc, 'rect', parent.id);
  child.placement = { mode: 'absolute' };
  child.position = { left: -12, top: 31 };
  child.size = { width: { mode: 'fixed', value: 40 }, height: { mode: 'fixed', value: 20 } };
  const snapshot = { revision: doc.revision, viewport: { width: 800, height: 600 }, measured: {
    root: { x: 0, y: 0, width: 800, height: 600, visible: true },
    [parent.id]: { x: 0, y: 0, width: 500, height: 400, visible: true, bl: 3, bt: 3 },
    [child.id]: { x: 4, y: 41, width: 40, height: 20, visible: true, bl: 0, bt: 0 },
  } };
  const report = checkSnapshot(doc, snapshot);
  assert.equal(report.issues.some((i) => i.code === 'E_POSITION_MISMATCH'), false, JSON.stringify(report.issues));
});

test('独立摆放与排列兄弟相交时尊重 noOverlap', () => {
  const { doc, parent } = testDoc('vertical');
  const flow = newComponent(doc, 'rect', parent.id, { id: 'flow_rect' });
  flow.size = { width: { mode: 'fixed', value: 50 }, height: { mode: 'fixed', value: 30 } };
  const absolute = newComponent(doc, 'rect', parent.id, { id: 'absolute_rect' });
  absolute.placement = { mode: 'absolute' };
  absolute.position = { left: 0, top: 0 };
  absolute.size = { width: { mode: 'fixed', value: 50 }, height: { mode: 'fixed', value: 30 } };
  absolute.flags.noOverlap = true;
  const report = checkSnapshot(doc, { revision: doc.revision, viewport: { width: 800, height: 600 }, measured: {
    root: { x: 0, y: 0, width: 800, height: 600, visible: true },
    [parent.id]: { x: 0, y: 0, width: 500, height: 400, visible: true, bl: 3, bt: 3 },
    [flow.id]: { x: 16, y: 10, width: 50, height: 30, visible: true },
    [absolute.id]: { x: 16, y: 10, width: 50, height: 30, visible: true },
  } });
  assert.ok(report.errors.some((i) => i.code === 'E_OVERLAP'));
});

test('CLI catalog / inspect / offline export 保留并渲染 placement', () => {
  const { doc, parent } = testDoc('vertical');
  const comp = newComponent(doc, 'button', parent.id, { id: 'float_button' });
  comp.placement = { mode: 'absolute' };
  comp.position = { left: -8, top: 15 };
  comp.size = { width: { mode: 'fixed', value: 90 }, height: { mode: 'fixed', value: 36 } };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvasloom-free-move-'));
  const input = path.join(tempDir, 'placement.uidoc.json');
  const output = path.join(tempDir, 'export');
  fs.writeFileSync(input, JSON.stringify(doc), 'utf8');
  const cli = path.resolve('cli/cli.js');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, `${args[0]} failed: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const catalog = run('catalog', '--json');
  assert.equal(catalog.catalog.layoutExtraFields.placement.mode.includes('absolute'), true);
  const inspect = run('inspect', input, '--json');
  assert.deepEqual(inspect.tree.children[0].children[0].placement, { mode: 'absolute' });
  const exported = run('export', input, '--out', output, '--json');
  const html = fs.readFileSync(path.join(output, 'preview.html'), 'utf8');
  assert.match(html, /isAbsolutePlacement/);
  assert.match(html, /placement\.mode === 'absolute'/);
  assert.equal(exported.ok, true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
