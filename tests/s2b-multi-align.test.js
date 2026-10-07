import test from 'node:test';
import assert from 'node:assert/strict';
import { planAlign, planDistribute, sharedParent, ALIGN_MODES } from '../app/align.js';
import { state, loadProject, select, toggleSelected, selectedIds, pruneSelection, mutate } from '../app/store.js';
import { newDoc, newComponent } from '../shared/protocol.js';

// ============================================================
// S2b 多选对齐与等距分布（优化计划 §3.3 / §7 S2）
// 纯几何计算与作用范围判定；画布交互（Shift 加选、整组拖动）另行浏览器验收。
// ============================================================

const R = (id, x, y, w, h) => ({ id, x, y, w, h });

test('S2b 对齐：左/右/顶/底以集合外接矩形为基准', () => {
  const rects = [R('a', 10, 10, 50, 30), R('b', 100, 60, 80, 40), R('c', 40, 120, 20, 20)];
  const left = planAlign(rects, 'left');
  assert.deepEqual(left.map((r) => r.x), [10, 10, 10]);
  const right = planAlign(rects, 'right');
  // 最右边界 = max(x+w) = 180 → c 的 x = 160
  assert.deepEqual(right.map((r) => r.x), [130, 100, 160]);
  const top = planAlign(rects, 'top');
  assert.deepEqual(top.map((r) => r.y), [10, 10, 10]);
  const bottom = planAlign(rects, 'bottom');
  // 最下边界 = max(y+h) = 140 → a 的 y = 110
  assert.deepEqual(bottom.map((r) => r.y), [110, 100, 120]);
});

test('S2b 对齐：水平/垂直居中按外接矩形中线', () => {
  const rects = [R('a', 0, 0, 40, 20), R('b', 100, 100, 60, 40)];
  const hc = planAlign(rects, 'hcenter');
  // 外接矩形 x: 0..160，中线 80 → a.x = 60，b.x = 50
  assert.deepEqual(hc.map((r) => r.x), [60, 50]);
  const vc = planAlign(rects, 'vcenter');
  // 外接矩形 y: 0..140，中线 70 → a.y = 60，b.y = 50
  assert.deepEqual(vc.map((r) => r.y), [60, 50]);
});

test('S2b 对齐：仅调整对应轴，另一轴不动；不足两项或未知模式返回空', () => {
  const rects = [R('a', 10, 20, 30, 40), R('b', 90, 200, 30, 40)];
  const res = planAlign(rects, 'left');
  assert.deepEqual(res.map((r) => r.y), [20, 200]);
  assert.equal(planAlign([R('a', 0, 0, 10, 10)], 'left').length, 0);
  assert.equal(planAlign(rects, 'middle').length, 0);
  assert.equal(ALIGN_MODES.length, 6);
});

test('S2b 等距分布：首末不动，相邻边缘间距相等（水平）', () => {
  const rects = [R('a', 0, 0, 20, 10), R('b', 30, 5, 20, 10), R('c', 200, 9, 20, 10)];
  const res = planDistribute(rects, 'h');
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.equal(byId.a.x, 0);
  assert.equal(byId.c.x, 200);
  // 总跨度 220，三件总宽 60，两段间隔各 80 → b.x = 0 + 20 + 80 = 100
  assert.equal(byId.b.x, 100);
  // 另一轴保持原值
  assert.equal(byId.b.y, 5);
});

test('S2b 等距分布：垂直方向同理；不足三项返回空', () => {
  const rects = [R('a', 3, 0, 10, 20), R('b', 4, 30, 10, 20), R('c', 5, 90, 10, 20)];
  const res = planDistribute(rects, 'v');
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  // 总跨度 110，总高 60，间隔各 25 → b.y = 20 + 25 = 45
  assert.equal(byId.b.y, 45);
  assert.equal(byId.b.x, 4);
  assert.equal(planDistribute(rects.slice(0, 2), 'v').length, 0);
});

test('S2b 等距分布：输入乱序时按坐标排序后再分配', () => {
  const rects = [R('c', 200, 0, 20, 10), R('a', 0, 0, 20, 10), R('b', 30, 0, 20, 10)];
  const res = planDistribute(rects, 'h');
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.equal(byId.a.x, 0);
  assert.equal(byId.b.x, 100);
  assert.equal(byId.c.x, 200);
});

test('S2b 作用范围：同一父容器判定', () => {
  const parentMap = { a: 'p1', b: 'p1', c: 'p2' };
  assert.equal(sharedParent(['a', 'b'], (id) => parentMap[id]), 'p1');
  assert.equal(sharedParent(['a', 'c'], (id) => parentMap[id]), null);
  assert.equal(sharedParent(['a'], (id) => parentMap[id]), null);
});

// ---------- 选中模型（store 级） ----------
function makeDocWithThree() {
  const doc = newDoc('S2B选中', 'web', 'free');
  newComponent(doc, 'text', 'root', { id: 't1', name: '一' });
  newComponent(doc, 'text', 'root', { id: 't2', name: '二' });
  newComponent(doc, 'text', 'root', { id: 't3', name: '三' });
  return doc;
}

test('S2b 选中模型：单选 / Shift 加选 / 再点减选 / 主选中补位', () => {
  loadProject('S2B选中', makeDocWithThree());
  select('t1');
  assert.deepEqual(selectedIds(), ['t1']);
  toggleSelected('t2');
  assert.deepEqual(selectedIds(), ['t1', 't2']);
  assert.equal(state.selection, 't1', '主选中保持首项');
  toggleSelected('t3');
  assert.deepEqual(selectedIds(), ['t1', 't2', 't3']);
  toggleSelected('t2'); // 减选
  assert.deepEqual(selectedIds(), ['t1', 't3']);
  toggleSelected('t1'); // 减掉主选中 → 主选中补位
  assert.deepEqual(selectedIds(), ['t3']);
  assert.equal(state.selection, 't3');
  toggleSelected('t3'); // 减到空
  assert.deepEqual(selectedIds(), []);
  assert.equal(state.selection, null);
});

test('S2b 选中模型：文档变化后多选自动清理失效项', () => {
  loadProject('S2B选中', makeDocWithThree());
  select('t1');
  toggleSelected('t2');
  toggleSelected('t3');
  mutate('删 t2', (d) => {
    delete d.components.t2;
    d.components.root.children = d.components.root.children.filter((x) => x !== 't2');
  });
  // applyMutation 内的 pruneSelection 已清理
  assert.deepEqual(selectedIds(), ['t1', 't3']);
  mutate('删 t1', (d) => {
    delete d.components.t1;
    d.components.root.children = d.components.root.children.filter((x) => x !== 't1');
  });
  assert.deepEqual(selectedIds(), ['t3'], '主选中失效后由剩余项补位');
  assert.equal(state.selection, 't3');
});

test('S2b 选中模型：再次单选同一 id 收敛为单选', () => {
  loadProject('S2B选中', makeDocWithThree());
  select('t1');
  toggleSelected('t2');
  select('t1'); // 再点主选中 → 收敛单选
  assert.deepEqual(selectedIds(), ['t1']);
  assert.equal(state.multiSelection, null);
});
