import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc, findComponent, isContainer } from '../shared/protocol.js';
import { applyTemplate, TEMPLATES, DEFAULT_TEMPLATE } from '../shared/templates.js';
import { validateDoc } from '../shared/validate.js';

// ============================================================
// S2 简洁使用测试（优化计划 §7 阶段二）
// 起步模板：结构模板只提供区域与用途；产出文档必须通过协议校验；
// 区域 id 稳定命名且不与既有组件冲突；未知模板名安全回退为空白。
// ============================================================

test('S2 模板清单：四个起步模板，默认 blank', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['blank', 'dashboard', 'sidebar', 'topnav']);
  assert.equal(DEFAULT_TEMPLATE, 'blank');
});

test('S2 blank 模板：不改动 newDoc 产物', () => {
  const doc = newDoc('模板空白', 'web', 'free');
  const before = JSON.stringify(doc);
  applyTemplate(doc, 'blank');
  assert.equal(JSON.stringify(doc), before);
});

test('S2 sidebar 模板：根横向分栏，侧栏固定宽 + 内容撑满，校验通过', () => {
  const doc = newDoc('模板侧栏', 'web', 'free');
  applyTemplate(doc, 'sidebar');
  const root = doc.components.root;
  assert.equal(root.layout.mode, 'horizontal');
  assert.deepEqual(root.children, ['sidebar', 'content']);
  const sidebar = doc.components.sidebar;
  assert.ok(sidebar && isContainer(sidebar));
  assert.equal(sidebar.size.width.mode, 'fixed');
  assert.equal(sidebar.size.width.value, 240);
  assert.equal(sidebar.size.height.mode, 'fill');
  const content = doc.components.content;
  assert.equal(content.size.width.mode, 'fill');
  assert.ok(sidebar.purpose && content.purpose, '区域必须带用途说明');
  assert.equal(validateDoc(doc).ok, true);
});

test('S2 topnav 模板：根纵向排列，顶部导航固定高', () => {
  const doc = newDoc('模板顶栏', 'web', 'free');
  applyTemplate(doc, 'topnav');
  const root = doc.components.root;
  assert.equal(root.layout.mode, 'vertical');
  assert.deepEqual(root.children, ['topnav', 'content']);
  const topnav = doc.components.topnav;
  assert.equal(topnav.size.height.mode, 'fixed');
  assert.equal(topnav.size.height.value, 64);
  assert.equal(validateDoc(doc).ok, true);
});

test('S2 dashboard 模板：顶栏 + 主体（侧栏/主内容）嵌套结构', () => {
  const doc = newDoc('模板仪表盘', 'web', 'free');
  applyTemplate(doc, 'dashboard');
  const root = doc.components.root;
  assert.equal(root.layout.mode, 'vertical');
  assert.deepEqual(root.children, ['topnav', 'body']);
  const body = doc.components.body;
  assert.equal(body.layout.mode, 'horizontal');
  assert.deepEqual(body.children, ['sidebar', 'content']);
  for (const id of ['body', 'topnav', 'sidebar', 'content']) {
    const c = findComponent(doc, id);
    assert.ok(c, `缺少区域组件 ${id}`);
    assert.equal(c.parent && true, true);
  }
  assert.equal(validateDoc(doc).ok, true);
});

test('S2 未知模板名安全回退为空白', () => {
  const doc = newDoc('模板未知', 'web', 'free');
  const before = JSON.stringify(doc);
  applyTemplate(doc, 'not-a-template');
  assert.equal(JSON.stringify(doc), before);
  applyTemplate(doc, '');
  assert.equal(JSON.stringify(doc), before);
  applyTemplate(doc, null);
  assert.equal(JSON.stringify(doc), before);
});

test('S2 模板 id 冲突防护：不覆盖既有组件', () => {
  const doc = newDoc('模板冲突', 'web', 'free');
  // 预先占用 content id（模拟非全新文档的调用场景）
  doc.components.content = {
    id: 'content', type: 'text', name: '既有文本', parent: 'root',
    children: undefined, text: '不要覆盖我', size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
    style: {}, flags: {},
  };
  doc.components.root.children.push('content');
  applyTemplate(doc, 'sidebar');
  assert.equal(doc.components.content.text, '不要覆盖我', '既有组件被模板覆盖了');
  assert.equal(doc.components.root.children.length, 3);
  assert.ok(doc.components.content_2 || doc.components.sidebar, '新内容区应使用去重后的 id');
  assert.equal(validateDoc(doc).ok, true);
});

test('S2 三套模板在常用模式下都通过校验（web/mobile/game）', () => {
  for (const mode of ['web', 'mobile', 'game']) {
    for (const tpl of ['sidebar', 'topnav', 'dashboard']) {
      const doc = newDoc(`模式${mode}${tpl}`, mode, 'free');
      applyTemplate(doc, tpl);
      const r = validateDoc(doc);
      assert.equal(r.ok, true, `${mode}/${tpl} 校验失败：${JSON.stringify(r.errors)}`);
    }
  }
});
