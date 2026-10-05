// ============================================================
// CanvasLoom M2 变体解析器自动检查（resolveVariant → v2 形状文档）
// 覆盖：冻结样例全 variant 解析 → v2 校验 0 错误；快照等价（手写 v2 文档
// 与解析结果逐字段 deepEqual：persistent×modern 与 popup×scifi）；其余
// variant 结构断言；令牌替换/微调/字面量保留/补丁优先；v3 专属字段剥离与
// v3 顶层段隔离；失败路径（结构化错误，绝不回退默认值）；renderer 对
// fontFamily/deco 的渲染支持与 v2 旧文档渲染不回归。
// 只读测试：不修改 projects/ 中的任何文件。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVariant, ResolveError } from '../shared/resolve.js';
import { validateDoc, applyOps } from '../shared/validate.js';
import { newDoc } from '../shared/protocol.js';
import { renderDoc } from '../shared/renderer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, 'fixtures', 'v3-sample.uidoc.json');
const V3_COMPONENT_FIELDS = ['featureId', 'bind', 'actions', 'initiallyOpen'];

// 每个用例拿一份独立的深拷贝，互不污染
function loadSample() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

// ---------- 快照等价：手写期望文档（persistent × modern，variant A1） ----------
// 令牌表 = modern 基础 tokens ∪ A1 微调 { color.accent: "#0ea5e9" }，逐字段手工替换
function expectedA1() {
  const accent = '#0ea5e9'; // A1 微调后的 color.accent（modern 基础值为 #2563eb）
  const skill = (id, label) => ({ id, type: 'button', name: label, parent: 'skill_bar',
    size: { width: { mode: 'fixed', value: 48 }, height: { mode: 'fixed', value: 48 } },
    style: { background: '#ffffff', color: accent, fontSize: 18, fontWeight: 'bold', borderRadius: 6, padding: 0 }, flags: {} });
  const slot = (n) => ({ id: 'inv_slot_' + n, type: 'rect', name: '物品格' + n, parent: 'inv_grid',
    size: { width: { mode: 'fill' }, height: { mode: 'fill' } },
    style: { background: '#f1f5f9', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 4 }, flags: {} });
  return {
    format: 'uidoc', version: 2, revision: 1, mode: 'game', name: 'P0 样例 · v3 冻结样例',
    canvas: { width: 1920, height: 1080, background: '#0b0f19' },
    resources: {},
    components: {
      root: { id: 'root', type: 'container', name: '页面', parent: null,
        children: ['life_hud', 'skill_bar', 'inv_panel', 'quest_list', 'map_box', 'settings_btn'],
        layout: { mode: 'free' },
        size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
        style: { background: '#f1f5f9' }, flags: {} },
      life_hud: { id: 'life_hud', type: 'container', name: '生命 HUD', parent: 'root',
        children: ['life_avatar', 'life_info'], purpose: '[feature:life] 常驻血条与等级',
        layout: { mode: 'horizontal', gap: 10, padding: 0 },
        size: { width: { mode: 'fixed', value: 420 }, height: { mode: 'fixed', value: 60 } },
        position: { left: 24, top: 24 },
        style: { background: '#ffffff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 }, flags: {} },
      life_avatar: { id: 'life_avatar', type: 'rect', name: '头像', parent: 'life_hud',
        size: { width: { mode: 'fixed', value: 60 }, height: { mode: 'fixed', value: 60 } },
        style: { background: accent, borderRadius: 6 }, flags: {} },
      life_info: { id: 'life_info', type: 'container', name: '血条区', parent: 'life_hud',
        children: ['life_bar', 'life_level'],
        layout: { mode: 'vertical', gap: 4, padding: 0 },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: {}, flags: {} },
      life_bar: { id: 'life_bar', type: 'container', name: '血条', parent: 'life_info', children: ['life_fill'],
        layout: { mode: 'vertical', padding: 0 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 16 } },
        style: { background: '#f1f5f9', borderRadius: 8, overflow: 'hidden' }, flags: {} },
      life_fill: { id: 'life_fill', type: 'rect', name: '血量', parent: 'life_bar',
        size: { width: { mode: 'percent', value: 75 }, height: { mode: 'fill' } },
        style: { background: '#dc2626', borderRadius: 2 }, flags: {} },
      life_level: { id: 'life_level', type: 'text', name: '等级', parent: 'life_info',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 12, color: '#64748b' }, flags: {} },
      skill_bar: { id: 'skill_bar', type: 'container', name: '技能栏', parent: 'root',
        children: ['skill_q', 'skill_e', 'skill_r', 'skill_f'],
        layout: { mode: 'horizontal', gap: 8, padding: 10 },
        size: { width: { mode: 'fixed', value: 230 }, height: { mode: 'fixed', value: 68 } },
        position: { left: 845, top: 992 },
        style: { background: '#ffffff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 }, flags: {} },
      skill_q: skill('skill_q', '技能 Q'),
      skill_e: skill('skill_e', '技能 E'),
      skill_r: skill('skill_r', '技能 R'),
      skill_f: skill('skill_f', '技能 F'),
      inv_panel: { id: 'inv_panel', type: 'container', name: '背包面板', parent: 'root',
        children: ['inv_title', 'inv_grid', 'inv_count'],
        layout: { mode: 'vertical', gap: 8, padding: 12 },
        size: { width: { mode: 'fixed', value: 320 }, height: { mode: 'fixed', value: 230 } },
        position: { left: 24, top: 780 },
        style: { background: '#ffffff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 }, flags: {} },
      inv_title: { id: 'inv_title', type: 'text', name: '背包标题', parent: 'inv_panel',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 14, fontWeight: 'bold', color: accent }, flags: {} },
      inv_grid: { id: 'inv_grid', type: 'container', name: '物品格', parent: 'inv_panel',
        children: ['inv_slot_1', 'inv_slot_2', 'inv_slot_3', 'inv_slot_4'],
        layout: { mode: 'grid', columnGap: 8, rowGap: 8, padding: 0,
          tracks: { columns: [{ mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 }], rows: [{ mode: 'fixed', value: 64 }] } },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: {}, flags: {} },
      inv_slot_1: slot(1), inv_slot_2: slot(2), inv_slot_3: slot(3), inv_slot_4: slot(4),
      inv_count: { id: 'inv_count', type: 'text', name: '容量文字', parent: 'inv_panel',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 12, color: '#64748b' }, flags: {} },
      quest_list: { id: 'quest_list', type: 'container', name: '任务列表', parent: 'root',
        children: ['quest_title', 'quest_1', 'quest_2', 'quest_3'],
        layout: { mode: 'vertical', gap: 6, padding: 12 },
        size: { width: { mode: 'fixed', value: 260 }, height: { mode: 'fixed', value: 150 } },
        position: { left: 1636, top: 224 },
        style: { background: '#ffffff', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 }, flags: {} },
      quest_title: { id: 'quest_title', type: 'text', name: '任务标题', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 14, fontWeight: 'bold', color: accent }, flags: {} },
      quest_1: { id: 'quest_1', type: 'text', name: '任务一', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 13, color: '#1f2937' }, flags: {} },
      quest_2: { id: 'quest_2', type: 'text', name: '任务二', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 13, color: '#1f2937' }, flags: {} },
      quest_3: { id: 'quest_3', type: 'text', name: '任务三', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 13, color: '#64748b' }, flags: {} },
      map_box: { id: 'map_box', type: 'container', name: '小地图', parent: 'root',
        children: ['map_view', 'map_label'],
        layout: { mode: 'vertical', gap: 6, padding: 8 },
        size: { width: { mode: 'fixed', value: 180 }, height: { mode: 'fixed', value: 180 } },
        position: { left: 1716, top: 24 },
        style: { background: '#f1f5f9', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 }, flags: {} },
      map_view: { id: 'map_view', type: 'rect', name: '地图画面', parent: 'map_box',
        size: { width: { mode: 'fill' }, height: { mode: 'fill' } },
        style: { background: '#ffffff' }, flags: {} },
      map_label: { id: 'map_label', type: 'text', name: '地图标注', parent: 'map_box',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 12, color: '#64748b' }, flags: {} },
      settings_btn: { id: 'settings_btn', type: 'button', name: '设置按钮', parent: 'root',
        size: { width: { mode: 'fixed', value: 56 }, height: { mode: 'fixed', value: 36 } },
        position: { left: 1648, top: 24 },
        style: { background: '#ffffff', color: accent, fontSize: 14, fontWeight: 'bold', borderRadius: 4, borderWidth: 1, borderColor: '#e2e8f0', padding: 0 }, flags: {} },
    },
  };
}

// ---------- 快照等价：手写期望文档（popup × scifi，variant B2） ----------
function expectedB2() {
  const skill = (id, label) => ({ id, type: 'button', name: label, parent: 'skill_bar',
    size: { width: { mode: 'fixed', value: 48 }, height: { mode: 'fixed', value: 48 } },
    style: { background: '#0f172a', color: '#38bdf8', fontSize: 18, fontWeight: 'bold', borderRadius: 6, padding: 0 }, flags: {} });
  const slot = (n) => ({ id: 'inv_slot_' + n, type: 'rect', name: '物品格' + n, parent: 'inv_grid',
    size: { width: { mode: 'fill' }, height: { mode: 'fill' } },
    style: { background: '#020617', borderWidth: 1, borderColor: '#164e63', borderRadius: 4 }, flags: {} });
  return {
    format: 'uidoc', version: 2, revision: 1, mode: 'game', name: 'P0 样例 · v3 冻结样例',
    canvas: { width: 1920, height: 1080, background: '#0b0f19' },
    resources: {},
    components: {
      root: { id: 'root', type: 'container', name: '页面', parent: null,
        children: ['life_hud', 'skill_bar', 'menu_btn', 'panels_root'],
        layout: { mode: 'free' },
        size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
        style: { background: '#020617' }, flags: {} },
      life_hud: { id: 'life_hud', type: 'container', name: '生命 HUD', parent: 'root',
        children: ['life_avatar', 'life_info'],
        layout: { mode: 'horizontal', gap: 10, padding: 0 },
        size: { width: { mode: 'fixed', value: 420 }, height: { mode: 'fixed', value: 60 } },
        position: { left: 24, top: 24 },
        style: { background: '#0f172a', borderWidth: 1, borderColor: '#164e63', borderRadius: 0 }, flags: {} },
      life_avatar: { id: 'life_avatar', type: 'rect', name: '头像', parent: 'life_hud',
        size: { width: { mode: 'fixed', value: 60 }, height: { mode: 'fixed', value: 60 } },
        style: { background: '#38bdf8', borderRadius: 6 }, flags: {} },
      life_info: { id: 'life_info', type: 'container', name: '血条区', parent: 'life_hud',
        children: ['life_bar', 'life_level'],
        layout: { mode: 'vertical', gap: 4, padding: 0 },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: {}, flags: {} },
      life_bar: { id: 'life_bar', type: 'container', name: '血条', parent: 'life_info', children: ['life_fill'],
        layout: { mode: 'vertical', padding: 0 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 16 } },
        style: { background: '#020617', borderRadius: 0, overflow: 'hidden' }, flags: {} },
      life_fill: { id: 'life_fill', type: 'rect', name: '血量', parent: 'life_bar',
        size: { width: { mode: 'percent', value: 75 }, height: { mode: 'fill' } },
        style: { background: '#f43f5e', borderRadius: 2 }, flags: {} },
      life_level: { id: 'life_level', type: 'text', name: '等级', parent: 'life_info',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 12, color: '#38bdf8' }, flags: {} },
      skill_bar: { id: 'skill_bar', type: 'container', name: '技能栏', parent: 'root',
        children: ['skill_q', 'skill_e', 'skill_r', 'skill_f'],
        layout: { mode: 'horizontal', gap: 8, padding: 10 },
        size: { width: { mode: 'fixed', value: 230 }, height: { mode: 'fixed', value: 68 } },
        position: { left: 845, top: 992 },
        style: { background: '#0f172a', borderWidth: 1, borderColor: '#164e63', borderRadius: 0 }, flags: {} },
      skill_q: skill('skill_q', '技能 Q'),
      skill_e: skill('skill_e', '技能 E'),
      skill_r: skill('skill_r', '技能 R'),
      skill_f: skill('skill_f', '技能 F'),
      menu_btn: { id: 'menu_btn', type: 'button', name: '主菜单按钮', parent: 'root',
        size: { width: { mode: 'fixed', value: 140 }, height: { mode: 'fixed', value: 48 } },
        position: { left: 890, top: 1000 },
        style: { background: '#0f172a', color: '#38bdf8', fontSize: 16, fontWeight: 'bold', borderRadius: 6, borderWidth: 1, borderColor: '#164e63', padding: 0 }, flags: {} },
      panels_root: { id: 'panels_root', type: 'container', name: '功能面板层', parent: 'root',
        children: ['inv_panel', 'quest_list', 'settings_panel', 'map_box'],
        layout: { mode: 'free' },
        size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
        position: { left: 0, top: 0 }, style: {}, flags: {} },
      inv_panel: { id: 'inv_panel', type: 'container', name: '背包面板', parent: 'panels_root',
        children: ['inv_title', 'inv_grid', 'inv_count'],
        layout: { mode: 'vertical', gap: 8, padding: 12 },
        size: { width: { mode: 'fixed', value: 320 }, height: { mode: 'fixed', value: 230 } },
        position: { left: 24, top: 780 },
        style: { background: '#0f172a', borderWidth: 1, borderColor: '#164e63', borderRadius: 0 }, flags: {} },
      inv_title: { id: 'inv_title', type: 'text', name: '背包标题', parent: 'inv_panel',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 14, fontWeight: 'bold', color: '#38bdf8' }, flags: {} },
      inv_grid: { id: 'inv_grid', type: 'container', name: '物品格', parent: 'inv_panel',
        children: ['inv_slot_1', 'inv_slot_2', 'inv_slot_3', 'inv_slot_4'],
        layout: { mode: 'grid', columnGap: 8, rowGap: 8, padding: 0,
          tracks: { columns: [{ mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 }], rows: [{ mode: 'fixed', value: 64 }] } },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: {}, flags: {} },
      inv_slot_1: slot(1), inv_slot_2: slot(2), inv_slot_3: slot(3), inv_slot_4: slot(4),
      inv_count: { id: 'inv_count', type: 'text', name: '容量文字', parent: 'inv_panel',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 12, color: '#38bdf8' }, flags: {} },
      quest_list: { id: 'quest_list', type: 'container', name: '任务列表', parent: 'panels_root',
        children: ['quest_title', 'quest_1', 'quest_2', 'quest_3'],
        layout: { mode: 'vertical', gap: 6, padding: 12 },
        size: { width: { mode: 'fixed', value: 260 }, height: { mode: 'fixed', value: 150 } },
        position: { left: 1636, top: 224 },
        style: { background: '#0f172a', borderWidth: 1, borderColor: '#164e63', borderRadius: 0 }, flags: {} },
      quest_title: { id: 'quest_title', type: 'text', name: '任务标题', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 14, fontWeight: 'bold', color: '#38bdf8' }, flags: {} },
      quest_1: { id: 'quest_1', type: 'text', name: '任务一', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 13, color: '#e0f2fe' }, flags: {} },
      quest_2: { id: 'quest_2', type: 'text', name: '任务二', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 13, color: '#e0f2fe' }, flags: {} },
      quest_3: { id: 'quest_3', type: 'text', name: '任务三', parent: 'quest_list',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 13, color: '#38bdf8' }, flags: {} },
      settings_panel: { id: 'settings_panel', type: 'container', name: '设置面板', parent: 'panels_root',
        children: ['settings_title', 'settings_close'],
        layout: { mode: 'vertical', gap: 10, padding: 16 },
        size: { width: { mode: 'fixed', value: 360 }, height: { mode: 'fixed', value: 220 } },
        position: { left: 780, top: 400 },
        style: { background: '#0f172a', borderWidth: 1, borderColor: '#164e63', borderRadius: 0 }, flags: {} },
      settings_title: { id: 'settings_title', type: 'text', name: '设置标题', parent: 'settings_panel',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 16, fontWeight: 'bold', color: '#e0f2fe' }, flags: {} },
      settings_close: { id: 'settings_close', type: 'button', name: '关闭按钮', parent: 'settings_panel',
        size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
        style: { background: '#0f172a', color: '#38bdf8', fontSize: 14, borderRadius: 6, borderWidth: 1, borderColor: '#164e63', padding: [8, 16, 8, 16] }, flags: {} },
      map_box: { id: 'map_box', type: 'container', name: '小地图', parent: 'panels_root',
        children: ['map_view', 'map_label'],
        layout: { mode: 'vertical', gap: 6, padding: 8 },
        size: { width: { mode: 'fixed', value: 180 }, height: { mode: 'fixed', value: 180 } },
        position: { left: 1716, top: 24 },
        style: { background: '#020617', borderWidth: 1, borderColor: '#164e63', borderRadius: 0 }, flags: {} },
      map_view: { id: 'map_view', type: 'rect', name: '地图画面', parent: 'map_box',
        size: { width: { mode: 'fill' }, height: { mode: 'fill' } },
        style: { background: '#0f172a' }, flags: {} },
      map_label: { id: 'map_label', type: 'text', name: '地图标注', parent: 'map_box',
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { fontSize: 12, color: '#38bdf8' }, flags: {} },
    },
  };
}

// ---------- 合法性与快照等价 ----------
test('冻结样例每个 variant 都能解析且解析结果通过 v2 校验（0 错误）', () => {
  const doc = loadSample();
  assert.equal(doc.variants.length, 6, '样例应有 6 个 variant（2 呈现 × 3 风格）');
  for (const v of doc.variants) {
    const r = resolveVariant(doc, v.id);
    assert.equal(r.format, 'uidoc');
    assert.equal(r.version, 2, '解析结果是 v2 形状文档');
    assert.ok(r.components && r.components.root, '解析结果有根组件 root');
    const rep = validateDoc(r);
    assert.equal(rep.ok, true, `variant ${v.id} 解析结果应通过 v2 校验：${JSON.stringify(rep.errors)}`);
    assert.equal(rep.errors.length, 0);
  }
});

test('快照等价：A1（persistent×modern，含 overrides.tokens 微调）与手写 v2 逐字段一致', () => {
  const doc = loadSample();
  const r = resolveVariant(doc, 'A1');
  assert.deepEqual(r, expectedA1());
  // 原文档不得被解析过程修改
  assert.equal(doc.version, 3, '解析不修改原 v3 文档');
  assert.equal(doc.presentations.persistent.components.root.style.background, '$color.bg', '原文档令牌引用保持原样');
});

test('快照等价：B2（popup×scifi，含 actions/initiallyOpen 剥离）与手写 v2 逐字段一致', () => {
  const doc = loadSample();
  assert.deepEqual(resolveVariant(doc, 'B2'), expectedB2());
});

test('其余 variant：组件集合一致、关键令牌值替换正确（结构断言）', () => {
  const doc = loadSample();
  const rA2 = resolveVariant(doc, 'A2');
  const rA3 = resolveVariant(doc, 'A3');
  const rB1 = resolveVariant(doc, 'B1');
  const rB3 = resolveVariant(doc, 'B3');
  // 组件集合与对应 presentation 完全一致
  for (const [r, pid] of [[rA2, 'persistent'], [rA3, 'persistent'], [rB1, 'popup'], [rB3, 'popup']]) {
    assert.deepEqual(Object.keys(r.components).sort(), Object.keys(doc.presentations[pid].components).sort(), pid);
  }
  // A2 scifi：radius.panel=0、面板底色/描边科幻化
  assert.equal(rA2.components.root.style.background, '#020617');
  assert.equal(rA2.components.life_hud.style.borderRadius, 0);
  assert.equal(rA2.components.settings_btn.style.color, '#38bdf8');
  // A3 fantasy：border.width=2、radius.panel=2
  assert.equal(rA3.components.life_hud.style.borderWidth, 2);
  assert.equal(rA3.components.life_hud.style.borderRadius, 2);
  assert.equal(rA3.components.life_fill.style.background, '#b91c1c');
  // B1 popup×modern：actions 剥离后 menu_btn 仍在、panels_root 样式为空
  assert.equal(rB1.components.menu_btn.style.background, '#ffffff');
  assert.deepEqual(rB1.components.panels_root.style, {});
  // B3 popup×fantasy：accent 金色
  assert.equal(rB3.components.quest_title.style.color, '#d6b25e');
});

// ---------- 令牌替换与变体补丁 ----------
test('令牌替换：overrides.tokens 微调生效；字面量不被令牌覆盖', () => {
  const doc = loadSample();
  const rA1 = resolveVariant(doc, 'A1');
  // 微调：$color.accent → #0ea5e9（modern 基础值 #2563eb）
  assert.equal(rA1.components.life_avatar.style.background, '#0ea5e9');
  const noOv = loadSample();
  noOv.variants[0].overrides.tokens = {};
  assert.equal(resolveVariant(noOv, 'A1').components.life_avatar.style.background, '#2563eb', '无微调时取基础令牌值');
  // 字面量原样保留：life_fill.borderRadius 是字面量 2，不随 radius.panel(=8) 变化
  assert.equal(rA1.components.life_fill.style.borderRadius, 2);
  assert.equal(rA1.components.skill_q.style.fontSize, 18);
  // 令牌引用随令牌表取值：life_bar.borderRadius 引用 $radius.panel → 8
  assert.equal(rA1.components.life_bar.style.borderRadius, 8);
});

test('变体补丁：overrides.components 浅合并进 style 且补丁优先（$ 引用同样替换）', () => {
  const doc = loadSample();
  doc.variants[0].overrides.components['life_hud'] = { borderRadius: 12, background: '$color.accent' };
  doc.variants[0].overrides.components['skill_q'] = { background: '#123456' };
  const r = resolveVariant(doc, 'A1');
  const hud = r.components.life_hud;
  assert.equal(hud.style.borderRadius, 12, '补丁覆盖令牌替换值');
  assert.equal(hud.style.background, '#0ea5e9', '补丁中的 $ 令牌引用被替换');
  assert.equal(hud.style.borderWidth, 1, '浅合并：未补丁的键保持令牌替换结果');
  assert.equal(hud.style.borderColor, '#e2e8f0');
  assert.equal(r.components.skill_q.style.background, '#123456', '补丁字面量优先于基础令牌值');
  assert.equal(r.components.skill_q.style.fontSize, 18, '补丁不影响其他键');
});

// ---------- 剥离与顶层隔离 ----------
test('剥离断言：全部 variant 的解析结果不含 featureId/bind/actions/initiallyOpen，v3 顶层段不进入结果', () => {
  const doc = loadSample();
  for (const v of doc.variants) {
    const r = resolveVariant(doc, v.id);
    for (const id of Object.keys(r.components)) {
      for (const f of V3_COMPONENT_FIELDS) {
        assert.equal(f in r.components[id], false, `variant ${v.id} 组件 ${id} 不应含 v3 字段 ${f}`);
      }
    }
    assert.deepEqual(
      Object.keys(r).sort(),
      ['canvas', 'components', 'format', 'mode', 'name', 'resources', 'revision', 'version'],
      `variant ${v.id} 解析结果顶层 = v2 形状（v3 五段一概不进入）`,
    );
  }
});

test('解析保留 fontFamily/deco（冻结决策 9：解析后同样生效，供渲染层使用）', () => {
  const doc = loadSample();
  const hud = doc.presentations.persistent.components.life_hud.style;
  hud.fontFamily = '$font.body';
  hud.deco = '$deco.panel';
  const rA1 = resolveVariant(doc, 'A1'); // modern：deco.panel = none
  assert.equal(rA1.components.life_hud.style.fontFamily, 'system-ui, sans-serif');
  assert.equal(rA1.components.life_hud.style.deco, 'none');
  const rA2 = resolveVariant(doc, 'A2'); // scifi：deco.panel = corner-cut
  assert.equal(rA2.components.life_hud.style.fontFamily, 'Consolas, monospace');
  assert.equal(rA2.components.life_hud.style.deco, 'corner-cut');
  // 端到端闭合：解析结果（含 fontFamily/deco）必须通过 v2 校验——共享样式白名单的由来
  assert.equal(validateDoc(rA1).ok, true, JSON.stringify(validateDoc(rA1).errors));
  assert.equal(validateDoc(rA2).ok, true, JSON.stringify(validateDoc(rA2).errors));
});

// ---------- 失败路径（结构化错误，绝不回退默认值） ----------
test('失败路径：未知 variantId 抛结构化错误（E_VARIANT_UNKNOWN）', () => {
  const doc = loadSample();
  assert.throws(() => resolveVariant(doc, 'NOPE'), (e) => {
    assert.ok(e instanceof ResolveError, '错误类型为 ResolveError');
    assert.equal(e.code, 'E_VARIANT_UNKNOWN');
    assert.equal(e.variantId, 'NOPE', '错误带定位字段 variantId');
    assert.ok(e.message && e.message.includes('NOPE'), 'message 含变体标识');
    return true;
  });
  // v2 文档没有 variants 段，同样结构化失败
  assert.throws(() => resolveVariant(newDoc('v2 无变体', 'generic'), 'A1'),
    (e) => e instanceof ResolveError && e.code === 'E_VARIANT_UNKNOWN');
});

test('失败路径：令牌替换后取值非法 → E_TOKEN_VALUE_INVALID，不静默降级', () => {
  // M1 校验对令牌值只查 string|number 不查取值——该文档能通过 v3 校验，
  // 非法性只能在解析（替换后）暴露，这正是 resolve 的 E_TOKEN_VALUE_INVALID 职责
  const doc = loadSample();
  doc.styles.modern.tokens['color.bg'] = '1283712387123'; // 超长数字串，root.background 引用它
  assert.equal(validateDoc(doc).ok, true, '构造的文档本身仍通过 v3 校验');
  assert.throws(() => resolveVariant(doc, 'A1'), (e) => {
    assert.ok(e instanceof ResolveError);
    assert.equal(e.code, 'E_TOKEN_VALUE_INVALID');
    assert.equal(e.componentId, 'root');
    assert.equal(e.field, 'style.background');
    assert.equal(e.token, 'color.bg');
    return true;
  });
  // 数值令牌超出字段上限（borderRadius ≤ 2000）
  const doc2 = loadSample();
  doc2.styles.modern.tokens['radius.panel'] = 5000;
  assert.throws(() => resolveVariant(doc2, 'A1'),
    (e) => e instanceof ResolveError && e.code === 'E_TOKEN_VALUE_INVALID' && e.componentId === 'life_hud');
});

test('失败路径：悬空令牌引用 → E_TOKEN_DANGLING（防御：无效文档不静默出结果）', () => {
  const doc = loadSample();
  doc.presentations.persistent.components.root.style.background = '$color.ghost';
  assert.throws(() => resolveVariant(doc, 'A1'),
    (e) => e instanceof ResolveError && e.code === 'E_TOKEN_DANGLING' && e.token === 'color.ghost');
});

test('失败路径：补丁引用树外组件 → E_COMPONENT_MISSING；覆盖未知令牌键 → E_TOKEN_UNKNOWN_OVERRIDE', () => {
  const doc = loadSample();
  doc.variants[0].overrides.components['ghost'] = { background: '#ffffff' };
  assert.throws(() => resolveVariant(doc, 'A1'),
    (e) => e instanceof ResolveError && e.code === 'E_COMPONENT_MISSING' && e.componentId === 'ghost');
  const doc2 = loadSample();
  doc2.variants[0].overrides.tokens['color.nope'] = '#123456';
  assert.throws(() => resolveVariant(doc2, 'A1'),
    (e) => e instanceof ResolveError && e.code === 'E_TOKEN_UNKNOWN_OVERRIDE' && e.token === 'color.nope');
});

// ---------- renderer：fontFamily/deco 渲染支持（Node 侧用最小假 DOM 断言输出） ----------
function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, children: [], dataset: {}, style: {}, textContent: '',
    appendChild(child) { el.children.push(child); },
    classList: {
      add(...cs) { for (const c of cs) classes.add(c); },
      contains(c) { return classes.has(c); },
    },
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  return el;
}

function makeDoc() {
  const injected = [];
  const d = {
    head: { appendChild: (el) => injected.push(el) },
    getElementById: (id) => injected.find((s) => s.id === id) || null,
    createElement: (tag) => makeEl(tag),
  };
  d._injected = injected;
  return d;
}

function findNode(el, id) {
  if (el.dataset && el.dataset.id === id) return el;
  for (const c of el.children || []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function renderToHost(doc) {
  const d = makeDoc();
  const host = makeEl('div');
  host.ownerDocument = d;
  const rootEl = renderDoc(host, doc);
  return { d, host, rootEl };
}

function decoDoc(decoValue, fontFamily) {
  const style = { background: '#ffffff' };
  if (decoValue != null) style.deco = decoValue;
  if (fontFamily != null) style.fontFamily = fontFamily;
  return {
    format: 'uidoc', version: 2, revision: 1, mode: 'generic', name: '渲染测试',
    canvas: { width: 200, height: 200, background: '#ffffff' },
    resources: {},
    components: {
      root: { id: 'root', type: 'container', name: '页面', parent: null, children: ['panel'],
        layout: { mode: 'vertical' },
        size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
        style: {}, flags: {} },
      panel: { id: 'panel', type: 'container', name: '面板', parent: 'root', children: [],
        layout: { mode: 'vertical' },
        size: { width: { mode: 'fixed', value: 120 }, height: { mode: 'fixed', value: 80 } },
        style, flags: {} },
    },
  };
}

test('renderer：fontFamily 原样输出为 CSS font-family', () => {
  const { rootEl } = renderToHost(decoDoc(null, 'Georgia, serif'));
  assert.equal(findNode(rootEl, 'panel').style.fontFamily, 'Georgia, serif');
});

test('renderer：deco=corner-cut 输出固定类名并伴随注入切角 CSS（clip-path）', () => {
  const { d, rootEl } = renderToHost(decoDoc('corner-cut'));
  const panel = findNode(rootEl, 'panel');
  assert.ok(panel.classList.contains('uiw-deco-corner-cut'), '容器应有 corner-cut 装饰类');
  const css = d._injected.find((s) => s.id === 'uiw-deco-style');
  assert.ok(css, '应注入伴随 CSS');
  assert.ok(css.textContent.includes('.uiw-deco-corner-cut'), 'CSS 应含该类选择器');
  assert.ok(css.textContent.includes('clip-path'), '切角用 clip-path 实现');
});

test('renderer：deco=corner-ornament 输出固定类名并伴随注入角饰 CSS（::before/::after）', () => {
  const { d, rootEl } = renderToHost(decoDoc('corner-ornament'));
  assert.ok(findNode(rootEl, 'panel').classList.contains('uiw-deco-corner-ornament'));
  const css = d._injected.find((s) => s.id === 'uiw-deco-style');
  assert.ok(css && css.textContent.includes('.uiw-deco-corner-ornament::before'), '角饰用伪元素实现');
  assert.ok(css.textContent.includes('.uiw-deco-corner-ornament::after'));
});

test('renderer：deco=none 或缺省不加装饰类、不注入装饰 CSS', () => {
  for (const v of ['none', null]) {
    const { d, rootEl } = renderToHost(decoDoc(v));
    assert.ok(!findNode(rootEl, 'panel').className.includes('uiw-deco-'), `deco=${v} 不应有装饰类`);
    assert.equal(d._injected.find((s) => s.id === 'uiw-deco-style'), undefined);
  }
});

test('renderer：v2 旧文档渲染不回归（无装饰类/无装饰 CSS，既有输出不变）', () => {
  let doc = newDoc('v2 渲染回归', 'generic');
  doc = applyOps(doc, [
    { action: 'add', component: { type: 'text', text: '你好', style: { background: '#112233', fontSize: 20 } }, parent: 'root' },
    { action: 'add', component: { type: 'button', text: '点我' }, parent: 'root' },
  ]);
  const { d, host, rootEl } = renderToHost(doc);
  assert.ok(rootEl.className.includes('uiw-root'), '根元素类名保持');
  const text = findNode(host, 'text');
  assert.equal(text.style.background, '#112233', '既有样式字段输出不变');
  assert.equal(text.style.fontSize, '20px');
  assert.equal(text.textContent, '你好');
  assert.equal(findNode(host, 'button').textContent, '点我');
  // 全树无装饰类，且只注入基础 CSS（无 uiw-deco-style）
  const walk = (el) => {
    assert.ok(!String(el.className).includes('uiw-deco-'));
    (el.children || []).forEach(walk);
  };
  walk(rootEl);
  assert.equal(d._injected.find((s) => s.id === 'uiw-deco-style'), undefined);
  assert.ok(d._injected.find((s) => s.id === 'uiw-base-style'), '基础 CSS 照常注入');
});
