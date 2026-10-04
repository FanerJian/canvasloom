// ============================================================
// UIDoc v3 协议层自动检查（冻结决策见 商业级路线图.md §4）
// 覆盖：顶层段、features/styles/presentations/variants、$令牌、
//       featureId/bind/actions/initiallyOpen、v3 ops、版本分流与 v1/v2 回归。
// 只读测试：不修改 projects/ 中的任何文件。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDoc, applyOps, ApplyError } from '../shared/validate.js';
import { newDoc, createFeature, createStyle, createVariant, DOC_VERSION_V3 } from '../shared/protocol.js';
import { inspectDocVersion, upgradeDoc, CompatError } from '../shared/compat.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, 'fixtures', 'v3-sample.uidoc.json');

// 每个用例拿一份独立的深拷贝，互不污染
function loadSample() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function codes(report) {
  return report.errors.map((e) => e.code);
}

function hasCode(report, code) {
  return codes(report).includes(code);
}

// ---------- 合法样例与兼容层 ----------
test('v3 冻结样例零错误（features/styles/presentations/variants 全段合法）', () => {
  const doc = loadSample();
  assert.equal(inspectDocVersion(doc).version, DOC_VERSION_V3, '兼容层应识别 v3');
  const report = validateDoc(doc);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test('compat：v3 原样通过（内存中不升级不改形）', () => {
  const doc = loadSample();
  const next = upgradeDoc(doc);
  assert.equal(next.version, DOC_VERSION_V3, '版本号保持 3');
  assert.equal(JSON.stringify(next), JSON.stringify(doc), 'v3 深拷贝必须与原文档逐字节一致');
});

test('version 4 被拒绝：校验器报 E_VERSION_UNSUPPORTED，兼容层同样拒绝', () => {
  const doc = loadSample();
  doc.version = 4;
  const report = validateDoc(doc);
  assert.equal(report.ok, false);
  assert.ok(hasCode(report, 'E_VERSION_UNSUPPORTED'), JSON.stringify(codes(report)));
  assert.throws(() => inspectDocVersion({ format: 'uidoc', version: 4 }),
    (e) => e instanceof CompatError && e.code === 'E_VERSION_UNSUPPORTED');
});

// ---------- 顶层段（冻结决策 1） ----------
test('顶层出现 components → E_V3_COMPONENTS_FORBIDDEN', () => {
  const doc = loadSample();
  doc.components = { root: {} };
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_V3_COMPONENTS_FORBIDDEN'), JSON.stringify(codes(report)));
});

test('顶层未知字段照旧拒绝（E_FIELD_UNKNOWN）', () => {
  const doc = loadSample();
  doc.自定义段 = 1;
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_FIELD_UNKNOWN'), JSON.stringify(codes(report)));
});

// ---------- featureId / bind（冻结决策 5） ----------
test('featureId 指向不存在的功能 → E_FEATURE_UNKNOWN', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.life_hud.featureId = 'nope';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_FEATURE_UNKNOWN'), JSON.stringify(codes(report)));
});

test('bind 非法键（首版仅 text）→ E_FIELD_UNKNOWN', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.life_level.bind = { href: 'feature:life.data.level' };
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_FIELD_UNKNOWN'), JSON.stringify(codes(report)));
});

test('bind 路径语法非法 → E_FIELD_VALUE', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.life_level.bind = { text: 'feature:life..level' };
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_FIELD_VALUE'), JSON.stringify(codes(report)));
});

test('bind 引用不存在的功能 → E_FEATURE_UNKNOWN', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.life_level.bind = { text: 'feature:ghost.data.hp' };
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_FEATURE_UNKNOWN'), JSON.stringify(codes(report)));
});

// ---------- 令牌（冻结决策 4） ----------
test('style 值引用不存在的令牌 → E_TOKEN_DANGLING', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.life_hud.style.background = '$color.nope';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_TOKEN_DANGLING'), JSON.stringify(codes(report)));
});

test('布局字段出现 $ 串 → E_TOKEN_INVALID_CONTEXT（size 与 position 都查）', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.life_hud.size.width.value = '$color.bg';
  doc.presentations.persistent.components.life_hud.position.left = '$space.x';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_TOKEN_INVALID_CONTEXT'), JSON.stringify(codes(report)));
});

// ---------- actions / initiallyOpen（冻结决策 5） ----------
test('actions type 非法 → E_ACTION_TARGET_INVALID', () => {
  const doc = loadSample();
  doc.presentations.popup.components.menu_btn.actions.click.type = 'show';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_ACTION_TARGET_INVALID'), JSON.stringify(codes(report)));
});

test('actions target 不存在 → E_ACTION_TARGET_INVALID', () => {
  const doc = loadSample();
  doc.presentations.popup.components.menu_btn.actions.click.target = 'ghost';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_ACTION_TARGET_INVALID'), JSON.stringify(codes(report)));
});

test('actions target 非 container → E_ACTION_TARGET_INVALID', () => {
  const doc = loadSample();
  doc.presentations.popup.components.menu_btn.actions.click.target = 'skill_q';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_ACTION_TARGET_INVALID'), JSON.stringify(codes(report)));
});

test('actions target 未显式 initiallyOpen:false → E_ACTION_TARGET_INVALID', () => {
  const doc = loadSample();
  doc.presentations.popup.components.menu_btn.actions.click.target = 'inv_panel';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_ACTION_TARGET_INVALID'), JSON.stringify(codes(report)));
});

test('actions 用在非 button → E_FIELD_INVALID；initiallyOpen 用在非 container → E_FIELD_INVALID', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.inv_panel.actions = { click: { type: 'toggle', target: 'inv_panel' } };
  doc.presentations.persistent.components.life_avatar.initiallyOpen = true;
  const report = validateDoc(doc);
  const hits = report.errors.filter((e) => e.code === 'E_FIELD_INVALID' && (e.field === 'actions' || e.field === 'initiallyOpen'));
  assert.equal(hits.length, 2, JSON.stringify(report.errors));
});

test('initiallyOpen 非布尔值 → E_FIELD_TYPE', () => {
  const doc = loadSample();
  doc.presentations.popup.components.panels_root.initiallyOpen = 'false';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_FIELD_TYPE'), JSON.stringify(codes(report)));
});

// ---------- variants / activeVariant（冻结决策 6/7） ----------
test('variant 引用不存在的 presentation / style → E_VARIANT_UNKNOWN', () => {
  const doc = loadSample();
  doc.variants[0].presentation = 'ghost';
  doc.variants[1].style = 'ghost';
  const report = validateDoc(doc);
  const hits = report.errors.filter((e) => e.code === 'E_VARIANT_UNKNOWN');
  assert.equal(hits.length, 2, JSON.stringify(codes(report)));
});

test('variant id 重复 → E_ID_DUP', () => {
  const doc = loadSample();
  doc.variants[1].id = 'A1';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_ID_DUP'), JSON.stringify(codes(report)));
});

test('overrides.tokens 新增令牌键 → E_TOKEN_UNKNOWN_OVERRIDE', () => {
  const doc = loadSample();
  doc.variants[0].overrides.tokens['color.nope'] = '#123456';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_TOKEN_UNKNOWN_OVERRIDE'), JSON.stringify(codes(report)));
});

test('overrides.components 引用树外组件 → E_COMPONENT_MISSING；补丁未知样式字段 → E_FIELD_UNKNOWN', () => {
  const doc = loadSample();
  doc.variants[0].overrides.components['ghost'] = {};
  doc.variants[0].overrides.components['life_hud'] = { boxShadow: '0 0 4px #000' };
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_COMPONENT_MISSING'), JSON.stringify(codes(report)));
  assert.ok(hasCode(report, 'E_FIELD_UNKNOWN'), JSON.stringify(codes(report)));
});

test('activeVariant 悬空 → E_VARIANT_UNKNOWN', () => {
  const doc = loadSample();
  doc.activeVariant = 'ZZ';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_VARIANT_UNKNOWN'), JSON.stringify(codes(report)));
});

// ---------- 功能可达（冻结决策 8） ----------
test('presentation 内无任何组件引用某功能 → E_FEATURE_UNREACHABLE', () => {
  const doc = loadSample();
  delete doc.presentations.persistent.components.settings_btn.featureId;
  const report = validateDoc(doc);
  const hit = report.errors.find((e) => e.code === 'E_FEATURE_UNREACHABLE');
  assert.ok(hit, JSON.stringify(codes(report)));
  assert.equal(hit.presentation, 'persistent', 'issue 应能定位到呈现方案');
});

// ---------- 样式白名单扩展（冻结决策 9） ----------
test('v3 新样式字段：fontFamily 与 deco(container) 合法', () => {
  const doc = loadSample();
  const life = doc.presentations.persistent.components.life_hud;
  life.style.fontFamily = 'system-ui, sans-serif';
  life.style.deco = 'corner-cut';
  assert.equal(validateDoc(doc).ok, true, JSON.stringify(validateDoc(doc).errors));
});

test('deco 用在非 container → E_FIELD_INVALID；deco 非法枚举 → E_STYLE_VALUE', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.life_avatar.style.deco = 'corner-cut';
  doc.presentations.persistent.components.life_hud.style.deco = 'shadow';
  const report = validateDoc(doc);
  assert.ok(hasCode(report, 'E_FIELD_INVALID'), JSON.stringify(codes(report)));
  assert.ok(hasCode(report, 'E_STYLE_VALUE'), JSON.stringify(codes(report)));
});

test('v2 共享样式白名单：fontFamily 可用（冻结决策 9）；deco 用在非 container 仍拒绝', () => {
  const doc = newDoc('共享白名单', 'generic');
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'text', id: 't1', text: 'x', style: { fontFamily: 'serif' } }, parent: 'root' },
  ]);
  assert.equal(next.components.t1.style.fontFamily, 'serif');
  assert.throws(() => applyOps(next, [
    { action: 'add', component: { type: 'text', text: 'y', style: { deco: 'none' } }, parent: 'root' },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FIELD_INVALID');
});

// ---------- v3 ops（冻结决策 11） ----------
test('v3 ops：add/update/move/remove 命中 activeVariant 指向的 presentation 树', () => {
  const doc = loadSample(); // activeVariant A1 → persistent
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'text', id: 'note', name: '备注', text: '注记', featureId: 'life', position: { left: 700, top: 500 } }, parent: 'root' },
  ]);
  // 新组件落在 persistent 树内，而不是文档顶层
  assert.ok(next.presentations.persistent.components.note, 'add 应命中 persistent 树');
  assert.equal(next.components, undefined, 'v3 顶层没有 components');
  assert.ok(next.presentations.persistent.components.root.children.includes('note'));
  // 其他 presentation 不受影响
  assert.equal(next.presentations.popup.components.note, undefined);
  assert.equal(next.presentations.popup.components.root.children.length, 4);

  const next2 = applyOps(next, [{ action: 'update', id: 'note', fields: { name: '备注2' } }]);
  assert.equal(next2.presentations.persistent.components.note.name, '备注2');

  const next3 = applyOps(next2, [{ action: 'move', id: 'note', parent: 'life_hud' }]);
  assert.equal(next3.presentations.persistent.components.note.parent, 'life_hud');
  assert.ok(next3.presentations.persistent.components.life_hud.children.includes('note'));

  const next4 = applyOps(next3, [{ action: 'remove', id: 'note' }]);
  assert.equal(next4.presentations.persistent.components.note, undefined);
});

test('v3 ops：作用于非活动 presentation 的组件被拒（E_COMPONENT_MISSING）且原文档不变', () => {
  const doc = loadSample();
  const before = JSON.stringify(doc);
  assert.throws(() => applyOps(doc, [
    { action: 'update', id: 'menu_btn', fields: { name: 'x' } }, // menu_btn 只在 popup 树
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_COMPONENT_MISSING');
  assert.equal(JSON.stringify(doc), before, '失败的 ops 不得修改原文档');
});

test('v3 ops：导致功能不可达的 remove 被整体拒绝（E_FEATURE_UNREACHABLE）', () => {
  const doc = loadSample();
  assert.throws(() => applyOps(doc, [
    { action: 'remove', id: 'settings_btn' }, // persistent 中 settings 功能的最后引用
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FEATURE_UNREACHABLE');
});

test('v3 ops：add 支持新字段（featureId/bind），非法值由整体校验拒绝', () => {
  const doc = loadSample();
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'text', id: 'bind_note', name: '绑定示例', featureId: 'life', bind: { text: 'feature:life.data.level' }, position: { left: 600, top: 600 } }, parent: 'root' },
  ]);
  assert.deepEqual(next.presentations.persistent.components.bind_note.bind, { text: 'feature:life.data.level' });
  // 非法 featureId 在最终校验被整体拒绝
  assert.throws(() => applyOps(doc, [
    { action: 'add', component: { type: 'text', text: 'x', featureId: 'ghost', position: { left: 1, top: 1 } }, parent: 'root' },
  ]), (e) => e instanceof ApplyError && e.payload.code === 'E_FEATURE_UNKNOWN');
});

test('v3 updateDocument：canvas/mode/name 可改；改 v3 段 → E_V3_SECTION_READONLY', () => {
  const doc = loadSample();
  const next = applyOps(doc, [
    { action: 'updateDocument', fields: { name: '改个名', canvas: { width: 1600 } } },
  ]);
  assert.equal(next.name, '改个名');
  assert.equal(next.canvas.width, 1600);
  for (const section of ['features', 'styles', 'presentations', 'variants', 'activeVariant', 'components']) {
    assert.throws(() => applyOps(doc, [{ action: 'updateDocument', fields: { [section]: {} } }]),
      (e) => e instanceof ApplyError && e.payload.code === 'E_V3_SECTION_READONLY',
      `修改 ${section} 应被拒绝`);
  }
});

// ---------- 工厂函数 ----------
test('v3 最小工厂：字段显式、id 规则同组件 ID', () => {
  assert.deepEqual(createFeature('life', '生命', {}), { label: '生命', data: {} });
  assert.deepEqual(createStyle('modern', '现代简洁', { 'color.bg': '#ffffff' }), { label: '现代简洁', tokens: { 'color.bg': '#ffffff' } });
  assert.deepEqual(
    createVariant('A1', '常驻', 'persistent', 'modern', { tokens: {}, components: {} }),
    { id: 'A1', label: '常驻', presentation: 'persistent', style: 'modern', overrides: { tokens: {}, components: {} } },
  );
  assert.throws(() => createFeature('bad-id', 'x', {}), /不合法/);
  assert.throws(() => createVariant('A1', '', 'p', 's', {}), /非空/);
});

// ---------- v1/v2 回归（现有行为的抽查复用） ----------
test('v1/v2 回归：newDoc(v2) 校验通过、ops 链路行为不变、版本号不被提升', () => {
  const doc = newDoc('回归', 'generic');
  assert.equal(doc.version, 2, 'newDoc 仍产 v2（v3 只由明确路径创建）');
  const next = applyOps(doc, [
    { action: 'add', component: { type: 'text', text: '旧路径' }, parent: 'root' },
  ]);
  assert.equal(validateDoc(next).ok, true);
  assert.equal(next.components.root.children.length, 1);
});
