// ============================================================
// S1 自由设计能力自动检查：放宽上限、updateDocument、文档级校验
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDoc, applyOps, ApplyError } from '../shared/validate.js';
import { newDoc, LIMITS, STYLE_FIELDS } from '../shared/protocol.js';

test('S1-3 大字号/大圆角/粗边框/分割线粗细上限放宽（同源 LIMITS）', () => {
  const doc = newDoc('上限测试', 'generic');
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'text', text: '大标题', style: { fontSize: 120 } }, parent: 'root' },
    { action: 'add', component: { type: 'rect', style: { borderRadius: 500, borderWidth: 60, borderColor: '#000000' } }, parent: 'root' },
    { action: 'add', component: { type: 'divider', thickness: 80, size: { width: { mode: 'fixed', value: 300 }, height: { mode: 'auto' } } }, parent: 'root' },
  ]);
  const report = validateDoc(next);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(next.components.root.children.length, 3);
});

test('S1-3 百分比尺寸允许 >100（150% 合法、超容量边界被拒）', () => {
  const doc = newDoc('百分比测试', 'generic');
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'rect', size: { width: { mode: 'percent', value: 150 }, height: { mode: 'fixed', value: 20 } } }, parent: 'root' },
  ]);
  assert.equal(validateDoc(next).ok, true, '150% 应合法');
  assert.throws(() => applyOps(next, [
    { action: 'update', id: next.components.root.children[0], fields: { size: { width: { mode: 'percent', value: LIMITS.percentMax + 1 } } } },
  ]), (e) => e instanceof ApplyError, '超过 percentMax 应被整体拒绝');
});

test('S1-3 非有限数值仍然拒绝', () => {
  const doc = newDoc('有限性测试', 'generic');
  assert.throws(() => applyOps(doc, [
    { action: 'add', component: { type: 'rect', size: { width: { mode: 'fixed', value: Number.NaN }, height: { mode: 'fixed', value: 10 } } }, parent: 'root' },
  ]), ApplyError);
});

test('S1-1 updateDocument：canvas 部分合并 + mode + name', () => {
  const doc = newDoc('文档修改', 'generic');
  const next = applyOps(doc, [
    { action: 'updateDocument', fields: { canvas: { width: 1440, background: '#112233' }, mode: 'game', name: '新名字' } },
  ]);
  assert.equal(next.canvas.width, 1440, 'width 应更新');
  assert.equal(next.canvas.height, doc.canvas.height, 'height 应保持（部分合并）');
  assert.equal(next.canvas.background, '#112233');
  assert.equal(next.mode, 'game');
  assert.equal(next.name, '新名字');
  assert.equal(validateDoc(next).ok, true);
});

test('S1-1 updateDocument：非法输入被整体拒绝', () => {
  const doc = newDoc('文档修改拒绝', 'generic');
  assert.throws(() => applyOps(doc, [
    { action: 'updateDocument', fields: { canvas: { width: 999999 } } },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_CANVAS');
  assert.throws(() => applyOps(doc, [
    { action: 'updateDocument', fields: { canvas: { background: 'red' } } },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_CANVAS');
  assert.throws(() => applyOps(doc, [
    { action: 'updateDocument', fields: { mode: '不存在' } },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FIELD_VALUE');
  assert.throws(() => applyOps(doc, [
    { action: 'updateDocument', fields: { 不支持: 1 } },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FIELD_UNKNOWN');
  // 失败后原文档保持不变
  assert.equal(doc.canvas.width, doc.canvas.width);
  assert.equal(doc.mode, 'generic');
});

test('S1-1 画布 background 非法颜色在静态校验中报错', () => {
  const doc = newDoc('画布颜色', 'generic');
  doc.canvas.background = '不合法';
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_CANVAS' && e.field === 'canvas.background'));
});

test('S1-7 CLI move 到自由布局：fill 轴诚实转 auto（不假造 160×48）', () => {
  const doc = newDoc('move适配', 'generic');
  let next = applyOps(doc, [
    { action: 'add', component: { type: 'container', name: '画板', layout: { mode: 'free' } }, parent: 'root' },
    { action: 'add', component: { type: 'rect', name: '矩形' }, parent: 'root' }, // vertical 根：宽 fill
  ]);
  const rectId = next.components.root.children[1];
  next = applyOps(next, [{ action: 'move', id: rectId, parent: next.components.root.children[0] }]);
  const rect = next.components[rectId];
  assert.equal(rect.parent, next.components.root.children[0]);
  assert.equal(rect.size.width.mode, 'auto', 'fill 移入自由布局应转 auto 而不是假造固定值');
  assert.deepEqual(rect.position, { left: 24, top: 24 });
  assert.equal(validateDoc(next).ok, true);
});

test('S1 协议：STYLE_FIELDS 上限与 LIMITS 同源', () => {
  const fs2 = STYLE_FIELDS.find((f) => f.key === 'fontSize');
  assert.equal(fs2.max, LIMITS.fontSizeMax);
  assert.equal(fs2.min, LIMITS.fontSizeMin);
  const br = STYLE_FIELDS.find((f) => f.key === 'borderRadius');
  assert.equal(br.max, LIMITS.borderRadiusMax);
});
