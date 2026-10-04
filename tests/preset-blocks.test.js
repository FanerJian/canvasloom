// ============================================================
// 预设块自动检查：game 模式「背包 / 设置」新块 —— 清单、实例化、校验、结构
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_MODES } from '../shared/modes.js';
import { blocksOf, instantiateBlock } from '../shared/blocks.js';
import { validateDoc } from '../shared/validate.js';
import { newDoc } from '../shared/protocol.js';

// 从 game 模式预设块清单取块 spec（沿用 blocksOf 的清单获取方式）
function gameBlockSpec(label) {
  const spec = blocksOf('game').find((b) => b.label === label);
  assert.ok(spec, `game 模式预设块清单应包含「${label}」`);
  return spec;
}

function childrenOf(doc, comp) {
  return (comp.children || []).map((cid) => doc.components[cid]);
}

// 在块子树内按 name 深度查找组件
function findByName(doc, comp, name) {
  for (const c of childrenOf(doc, comp)) {
    if (c.name === name) return c;
    const hit = findByName(doc, c, name);
    if (hit) return hit;
  }
  return null;
}

test('game 模式预设清单包含背包与设置块', () => {
  const labels = blocksOf('game').map((b) => b.label);
  assert.ok(labels.includes('背包'), `应有「背包」块，实际：${labels.join('、')}`);
  assert.ok(labels.includes('设置'), `应有「设置」块，实际：${labels.join('、')}`);
  // 数据与 modes.js 导出一致
  assert.ok(UI_MODES.game.blocks.some((b) => b.idBase === 'inventory'));
  assert.ok(UI_MODES.game.blocks.some((b) => b.idBase === 'settings'));
});

test('两个新块实例化进最小合法 v2 文档后校验 0 错误', () => {
  const doc = newDoc('预设块校验', 'game');
  assert.equal(doc.version, 2, '应使用 v2 文档');
  const inv = instantiateBlock(doc, gameBlockSpec('背包'), 'root');
  const set = instantiateBlock(doc, gameBlockSpec('设置'), 'root');
  assert.ok(doc.components[inv.id] && doc.components[set.id], '两个块根都应写入组件表');
  const report = validateDoc(doc);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.errors.length, 0);
});

test('背包块结构：8 个固定尺寸槽位、grid 列数为 4、占格不重叠', () => {
  const doc = newDoc('背包结构', 'game');
  const root = instantiateBlock(doc, gameBlockSpec('背包'), 'root');
  assert.equal(root.id, 'inventory');
  // grid 容器：4 列 × 2 行固定轨道
  const grid = childrenOf(doc, root).find((c) => c.layout && c.layout.mode === 'grid');
  assert.ok(grid, '背包内应有 grid 布局的物品格子容器');
  assert.equal(grid.layout.tracks.columns.length, 4, '网格列数应为 4');
  assert.equal(grid.layout.tracks.rows.length, 2, '网格行数应为 2');
  // 8 个槽位：container 固定尺寸
  const slots = childrenOf(doc, grid);
  assert.equal(slots.length, 8, '应有 8 个槽位');
  for (const s of slots) {
    assert.equal(s.type, 'container', `槽位 ${s.id} 应为 container`);
    assert.equal(s.size.width.mode, 'fixed', `槽位 ${s.id} 宽度应为固定尺寸`);
    assert.equal(s.size.height.mode, 'fixed', `槽位 ${s.id} 高度应为固定尺寸`);
    assert.ok(s.area, `槽位 ${s.id} 应有网格位置`);
  }
  // 8 个槽位占据 8 个不同格子（4×2 无重叠）
  const cells = new Set(slots.map((s) => `${s.area.row},${s.area.col}`));
  assert.equal(cells.size, 8, '8 个槽位应占据 8 个不同格子');
  // 标题与内容示例文案
  assert.equal(findByName(doc, root, '背包标题').text, '背包');
  assert.match(findByName(doc, root, '已用格数').text, /\d+\s*\/\s*\d+\s*已用/, '应有「12 / 24 已用」式示例文案');
});

test('设置块结构：4 行设置项、纵向 gap 存在、每行 label + 按钮', () => {
  const doc = newDoc('设置结构', 'game');
  const root = instantiateBlock(doc, gameBlockSpec('设置'), 'root');
  assert.equal(root.id, 'settings');
  // 纵向排列且 gap 存在
  assert.equal(root.layout.mode, 'vertical', '设置面板应为纵向排列');
  assert.ok(typeof root.layout.gap === 'number' && root.layout.gap > 0, '纵向排列应有 gap');
  assert.ok(root.layout.padding != null, '面板应有内边距');
  // 4 行设置项（容器行）
  const rows = childrenOf(doc, root).filter((c) => c.type === 'container');
  assert.equal(rows.length, 4, '设置面板应有 4 行');
  for (const row of rows) {
    assert.equal(row.layout.mode, 'horizontal', `行 ${row.id} 应为横向排列`);
  }
  // 前三行：label 文本 + 开关/选项按钮
  for (const row of rows.slice(0, 3)) {
    const kids = childrenOf(doc, row);
    assert.equal(kids.length, 2, `行 ${row.id} 应为 标签 + 按钮 两个元素`);
    assert.equal(kids[0].type, 'text', `行 ${row.id} 首元素应为 label 文本`);
    assert.equal(kids[1].type, 'button', `行 ${row.id} 次元素应为开关/选项按钮`);
  }
  // 末行：返回按钮
  const backRow = childrenOf(doc, rows[3]);
  assert.ok(backRow.some((c) => c.type === 'button' && c.text === '返回'), '末行应有「返回」按钮');
  // 标题
  assert.equal(findByName(doc, root, '设置标题').text, '设置');
});

test('新块视觉与现有游戏块一致（深底面板、金色标题、灰描边）', () => {
  // 对照现有对话栏面板样式
  const dialog = UI_MODES.game.blocks.find((b) => b.idBase === 'dialog');
  for (const label of ['背包', '设置']) {
    const spec = gameBlockSpec(label);
    assert.equal(spec.style.background, dialog.style.background, `${label} 面板底色应与对话栏一致`);
    assert.equal(spec.style.borderColor, dialog.style.borderColor, `${label} 面板描边应与对话栏一致`);
  }
  // 金色强调标题（与任务列表标题同色）
  const quest = UI_MODES.game.blocks.find((b) => b.idBase === 'quest_list');
  const gold = quest.children.find((c) => c.idBase === 'quest_title').style.color;
  const doc = newDoc('视觉一致性', 'game');
  const inv = instantiateBlock(doc, gameBlockSpec('背包'), 'root');
  const set = instantiateBlock(doc, gameBlockSpec('设置'), 'root');
  assert.equal(findByName(doc, doc.components[inv.id], '背包标题').style.color, gold);
  assert.equal(findByName(doc, doc.components[set.id], '设置标题').style.color, gold);
});
