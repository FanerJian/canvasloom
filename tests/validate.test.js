// ============================================================
// 静态校验器自动检查：v1/v2 均通过、坏版本拒绝、ops 原子性
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDoc, applyOps, ApplyError } from '../shared/validate.js';
import { newDoc, newComponent, findComponent } from '../shared/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(HERE, '..', 'projects');

test('现有项目原始文件静态校验全部通过', () => {
  const files = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith('.uidoc.json'));
  assert.ok(files.length >= 8, `至少应有 8 个项目文件，实际 ${files.length}`);
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
    const report = validateDoc(doc);
    assert.equal(report.ok, true, `${f} 校验失败：${JSON.stringify(report.errors)}`);
  }
});

test('不支持的版本号产生 E_VERSION 错误', () => {
  const doc = newDoc('版本测试', 'generic');
  doc.version = 9;
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'E_VERSION'));
});

test('v2 新建文档通过校验', () => {
  const doc = newDoc('版本测试', 'generic');
  assert.equal(doc.version, 2);
  const report = validateDoc(doc);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

// ---------- ops ----------
test('applyOps：add/update/move/remove 基本链路', () => {
  const doc = newDoc('ops测试', 'generic');
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'container', name: '卡片', layout: { mode: 'free' } }, parent: 'root' },
  ]);
  const card = Object.values(next.components).find((c) => c.name === '卡片');
  assert.ok(card, '卡片应已添加');
  const next2 = applyOps(next, [
    { action: 'add', component: { type: 'text', text: '你好', position: { left: 10, top: 20 } }, parent: card.id },
    { action: 'update', id: card.id, fields: { purpose: '测试卡片' } },
  ]);
  const txt = next2.components[card.id].children.map((cid) => next2.components[cid])[0];
  assert.equal(txt.text, '你好');
  assert.deepEqual(txt.position, { left: 10, top: 20 });
  const next3 = applyOps(next2, [{ action: 'move', id: txt.id, parent: 'root' }]);
  assert.equal(next3.components[txt.id].parent, 'root');
  // 移入纵向根容器后 position 应被清理
  assert.equal(next3.components[txt.id].position, undefined);
  const next4 = applyOps(next3, [{ action: 'remove', id: txt.id }]);
  assert.equal(next4.components[txt.id], undefined);
});

test('applyOps：原子性——后续操作失败时整体拒绝且原文档不变', () => {
  const doc = newDoc('原子测试', 'generic');
  const before = JSON.stringify(doc);
  assert.throws(() => applyOps(doc, [
    { action: 'add', component: { type: 'text', text: 'x' }, parent: 'root' },
    { action: 'update', id: '不存在', fields: { name: 'y' } },
  ]), ApplyError);
  assert.equal(JSON.stringify(doc), before, '原文档对象不得被修改');
});

test('applyOps：非自由布局父容器中设置 position 被拒绝', () => {
  const doc = newDoc('位置测试', 'generic'); // 根为 vertical
  assert.throws(() => applyOps(doc, [
    { action: 'add', component: { type: 'text', text: 'x', position: { left: 5, top: 5 } }, parent: 'root' },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FIELD_INVALID');
});

test('applyOps：自由布局中 fill 尺寸被拒绝（v1/v2 同规则，负坐标合法）', () => {
  const doc = newDoc('自由测试', 'generic');
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'container', name: '画板', layout: { mode: 'free' } }, parent: 'root' },
  ]);
  const board = Object.values(next.components).find((c) => c.name === '画板');
  assert.throws(() => applyOps(next, [
    { action: 'add', component: { type: 'rect', size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 20 } } }, parent: board.id, position: { left: -30, top: -10 } },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FREE_FILL');

  const next2 = applyOps(next, [
    { action: 'add', component: { type: 'rect', position: { left: -30, top: -10 } }, parent: board.id },
  ]);
  const rect = next2.components[board.id].children.map((cid) => next2.components[cid])[0];
  assert.deepEqual(rect.position, { left: -30, top: -10 }, '自由布局负坐标应合法');
});

test('applyOps：add 的未知字段被整体拒绝（不允许静默丢弃）', () => {
  const doc = newDoc('未知字段', 'generic');
  assert.throws(() => applyOps(doc, [
    { action: 'add', component: { type: 'text', text: 'x', 自定义: 1 }, parent: 'root' },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FIELD_UNKNOWN');
});
