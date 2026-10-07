import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDoc, newComponent } from '../shared/protocol.js';
import { upgradeDoc, upgradeDocToV3, upgradeDocToV4 } from '../shared/compat.js';
import { validateDoc, applyOps } from '../shared/validate.js';
import { checkAiPolicy } from '../shared/intent.js';
import { resolveVariant, editScopeOf } from '../shared/resolve.js';
import { collectCopySnapshot, pasteSnapshotIntoDoc } from '../shared/clipboard.js';
import { backupBeforeUpgrade } from '../shared/backup.js';
import { state, loadProject, toggleSelected, selectedIds } from '../app/store.js';

function sample() {
  const v2 = newDoc('意图验证', 'web', 'free');
  const area = newComponent(v2, 'container', 'root', { id: 'sidebar', name: '菜单', purpose: '左侧菜单' });
  area.position = { left: 16, top: 24 };
  newComponent(v2, 'text', 'sidebar', { id: 'title', text: '菜单标题' });
  newComponent(v2, 'text', 'sidebar', { id: 'second', text: '菜单说明' });
  const doc = upgradeDocToV4(v2);
  doc.intent = { goal: '配置菜单与内容区', style: '简洁清晰' };
  doc.presentations.main.components.sidebar.intent = { precision: 'rough', ai: 'preserve' };
  assert.equal(validateDoc(doc).ok, true, JSON.stringify(validateDoc(doc).errors));
  return doc;
}
const denied = (doc, ops, field) => assert.throws(() => applyOps(doc, ops), (e) =>
  e.payload?.code === 'E_AI_POLICY' && (!field || e.payload.field === field));

test('v1/v2/v3 只在明确启用时升级 v4；树、资源与修订号保持，渲染语义一致', () => {
  const raw = newDoc('兼容意图', 'web', 'free');
  newComponent(raw, 'text', 'root', { id: 'title', text: '保留' });
  for (const old of [{ ...structuredClone(raw), version: 1 }, raw, upgradeDocToV3(raw)]) {
    const unchanged = structuredClone(old);
    const next = upgradeDocToV4(old);
    assert.deepEqual(old, unchanged);
    assert.equal(next.version, 4);
    assert.equal(validateDoc(next).ok, true);
    const view = resolveVariant(next, next.activeVariant);
    assert.deepEqual(view.components, raw.components);
    assert.equal(next.revision, old.revision);
    assert.deepEqual(upgradeDoc(next), next);
  }
});

test('意图字段严格校验；旧格式不接受意图，非法范围不会静默保存', () => {
  for (const transform of [
    (d) => { d.intent.goal = 1; },
    (d) => { d.intent.unknown = true; },
    (d) => { d.presentations.main.components.sidebar.intent.ai = 'anything'; },
    (d) => { d.presentations.main.components.sidebar.intent.precision = 'maybe'; },
    (d) => { d.version = 3; },
  ]) {
    const doc = sample(); transform(doc); assert.equal(validateDoc(doc).ok, false);
  }
  const old = newDoc('旧格式'); old.intent = { goal: '', style: '' };
  assert.equal(validateDoc(old).ok, false);
});

test('保护区域允许合法样式、内部文案与新增内部内容；原始意图不进入渲染视图', () => {
  const doc = sample();
  const next = applyOps(doc, [
    { action: 'update', id: 'sidebar', fields: { style: { background: '#ffffff' } } },
    { action: 'update', id: 'title', fields: { text: '导航菜单' } },
    { action: 'add', parent: 'sidebar', component: { id: 'extra', type: 'text', text: '新增条目', purpose: '补充菜单内容' } },
  ]);
  assert.equal(checkAiPolicy(doc, next).ok, true);
  assert.equal(editScopeOf(next, 'main').components.sidebar.intent.ai, 'preserve');
  assert.equal(resolveVariant(next, 'main').components.sidebar.intent, undefined);
  assert.equal(validateDoc(resolveVariant(next, 'main')).ok, true);
});

test('移动、删除、重排和改变受保护区域尺寸均拒绝；批次拒绝不修改输入', () => {
  for (const ops of [
    [{ action: 'update', id: 'sidebar', fields: { position: { left: 200, top: 0 } } }],
    [{ action: 'update', id: 'sidebar', fields: { size: { width: { mode: 'fixed', value: 300 } } } }],
    [{ action: 'remove', id: 'sidebar' }],
    [{ action: 'remove', id: 'title' }],
    [{ action: 'move', id: 'title', parent: 'root' }],
    [{ action: 'move', id: 'second', parent: 'sidebar', index: 0 }],
    [{ action: 'update', id: 'title', fields: { text: '不应提交' } }, { action: 'remove', id: 'sidebar' }],
  ]) {
    const doc = sample(); const original = structuredClone(doc);
    denied(doc, ops); assert.deepEqual(doc, original);
  }
});

test('不能通过修改祖先布局、画布或用途绕过区域保护', () => {
  const doc = sample();
  denied(doc, [{ action: 'update', id: 'root', fields: { layout: { mode: 'free', padding: 80 } } }], 'layout');
  denied(doc, [{ action: 'updateDocument', fields: { canvas: { width: 1500 } } }], 'canvas');
  denied(doc, [{ action: 'update', id: 'sidebar', fields: { purpose: '解除菜单用途' } }], 'purpose');
  denied(doc, [{ action: 'update', id: 'sidebar', fields: { intent: { precision: 'ai', ai: 'open' } } }], 'intent');
});

test('整文档提交拒绝解除策略、删呈现、切换方案、降级及改写目标', () => {
  const before = sample();
  for (const transform of [
    (d) => { d.presentations.main.components.sidebar.intent.ai = 'open'; },
    (d) => { delete d.presentations.main; },
    (d) => { d.activeVariant = 'other'; },
    (d) => { d.variants[0].presentation = 'other'; },
    (d) => { d.version = 3; delete d.intent; },
    (d) => { d.intent.goal = '覆盖目标'; },
  ]) { const after = structuredClone(before); transform(after); assert.equal(checkAiPolicy(before, after).ok, false); }
});

test('保护覆盖非活动呈现；AI 不能通过在其他呈现中修改绕过检查', () => {
  const before = sample(); before.presentations.other = structuredClone(before.presentations.main);
  const after = structuredClone(before); after.presentations.other.components.sidebar.position.left += 100;
  const errors = checkAiPolicy(before, after).errors;
  assert.ok(errors.some((e) => e.presentation === 'other' && e.componentId === 'sidebar' && e.field === 'position'));
});

test('异常候选的方案/子级字段返回保护错误，不因输入形状崩溃', () => {
  const before = sample();
  for (const change of [
    (d) => { d.variants = {}; },
    (d) => { d.variants = [null]; },
    (d) => { d.presentations.main.components.sidebar.children = {}; },
    (d) => { d.presentations.main.components.root.children = 'sidebar'; },
  ]) {
    const after = structuredClone(before); change(after);
    const result = checkAiPolicy(before, after);
    assert.equal(result.ok, false);
    assert.ok(result.errors.every((e) => e.code === 'E_AI_POLICY'));
  }
});

test('跨项目复制保留 v4 意图；粘贴至旧项目明确剥除而不留下非法字段', () => {
  const source = sample();
  const clip = collectCopySnapshot(editScopeOf(source, 'main'), 'sidebar', '来源');
  const target = upgradeDocToV4(newDoc('目标', 'web', 'free'));
  const v4 = pasteSnapshotIntoDoc(editScopeOf(target, 'main'), clip, 'root', '目标');
  assert.equal(target.presentations.main.components[v4.newId].intent.ai, 'preserve');
  assert.equal(validateDoc(target).ok, true);
  const old = newDoc('旧目标', 'web', 'free');
  const v2 = pasteSnapshotIntoDoc(old, clip, 'root', '旧目标');
  assert.equal(old.components[v2.newId].intent, undefined);
  assert.equal(validateDoc(old).ok, true);
  assert.ok(v2.notices.some((x) => x.message.includes('intent')));
});

test('首次升级备份逐字节保留原文件，重复升级检查不覆盖已有备份', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'canvasloom-intent-'));
  try {
    const file = path.join(base, '原设计.uidoc.json');
    const raw = Buffer.from(JSON.stringify(newDoc('原设计'), null, 4) + '\r\n');
    fs.writeFileSync(file, raw);
    const backup = backupBeforeUpgrade(file, 4);
    assert.equal(backup.needed, true);
    assert.deepEqual(fs.readFileSync(backup.backupPath), raw);
    fs.writeFileSync(file, JSON.stringify(upgradeDocToV4(JSON.parse(raw.toString()))));
    assert.equal(backupBeforeUpgrade(file, 4).needed, false);
    assert.deepEqual(fs.readFileSync(backup.backupPath), raw);
  } finally {
    if (path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(base, { recursive: true, force: true });
  }
});

test('打开另一个项目不会残留上个项目的多选列表', () => {
  const first = newDoc('第一'); newComponent(first, 'text', 'root', { id: 'text' });
  loadProject('第一', first); toggleSelected('root'); toggleSelected('text');
  assert.equal(selectedIds().length, 2);
  loadProject('第二', structuredClone(first));
  assert.equal(state.multiSelection, null); assert.deepEqual(selectedIds(), []);
});
