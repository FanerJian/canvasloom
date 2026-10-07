// ============================================================
// 起步布局模板（S2）：用户选一个大致结构，区域与用途由模板给出，
// 内容和样式留给用户 / AI 完善。模板只提供结构与用途，随时可改可删。
//
// 作用范围：newDoc 产出的新文档（v2 形状，组件树在顶层 components）。
// 服务端在 /api/project POST 里于 newDoc 之后调用 applyTemplate；
// 每个区域是带用途说明（purpose）的容器，id 采用稳定命名（sidebar/
// content/topnav/body），便于人、AI 与后续交接包共同引用。
// ============================================================

import { defaultLayout } from './protocol.js';

export const TEMPLATES = {
  blank: { label: '空白布局', desc: '从空白画布开始，自己摆放区域' },
  sidebar: { label: '侧栏＋内容', desc: '左侧导航菜单，右侧主内容' },
  topnav: { label: '顶部导航＋内容', desc: '顶部导航栏，下方主内容' },
  dashboard: { label: '仪表盘分区', desc: '顶栏＋侧栏＋主内容，适合后台与看板' },
};

export const DEFAULT_TEMPLATE = 'blank';

// 生成一个区域容器。style 背景用浅灰区分相邻区域；内容留空，不预置组件。
function region(id, name, purpose, size, layout, background) {
  return {
    id,
    type: 'container',
    name,
    purpose,
    parent: null, // applyTemplate 里统一接线
    children: [],
    layout,
    size,
    style: { background },
    flags: {},
  };
}

const fill = { mode: 'fill' };
const fixed = (n) => ({ mode: 'fixed', value: n });

// 流式容器布局：padding/gap 用 number（renderer normalizePadding 兼容 number 与四元数组）
function colLayout(padding, gap) {
  return { ...defaultLayout('vertical'), padding, gap };
}
function rowLayout(padding, gap, align) {
  const l = { ...defaultLayout('horizontal'), padding, gap };
  if (align) l.align = align;
  return l;
}

// 模板里的 id 若与现有组件冲突（理论只在非全新文档发生）则加序号，避免覆盖任何已有组件
function uniqueId(doc, base) {
  if (!doc.components[base]) return base;
  let i = 2;
  while (doc.components[`${base}_${i}`]) i++;
  return `${base}_${i}`;
}

function put(doc, comp, parentId) {
  const id = uniqueId(doc, comp.id);
  comp.id = id;
  comp.parent = parentId;
  doc.components[id] = comp;
  doc.components[parentId].children.push(id);
  return id;
}

// 应用模板：调整 root 布局模式并放入区域容器，返回 doc（就地修改）。
// 未知模板名视为 blank——调用方无需预判。
export function applyTemplate(doc, templateId) {
  if (!doc || !doc.components || !doc.components.root) return doc;
  if (!templateId || templateId === 'blank' || !TEMPLATES[templateId]) return doc;
  const root = doc.components.root;

  if (templateId === 'sidebar') {
    root.layout = rowLayout(0, 0);
    const sidebar = region('sidebar', '侧栏', '导航菜单区：放主要栏目入口', { width: fixed(240), height: fill }, colLayout(12, 8), '#f1f5f9');
    const content = region('content', '内容区', '主内容区：放页面主要内容', { width: fill, height: fill }, colLayout(16, 10), '#ffffff');
    put(doc, sidebar, 'root');
    put(doc, content, 'root');
  } else if (templateId === 'topnav') {
    root.layout = colLayout(0, 0);
    const topnav = region('topnav', '顶部导航', '顶部导航区：放标题、搜索或全局操作', { width: fill, height: fixed(64) }, rowLayout(12, 12, 'center'), '#f8fafc');
    const content = region('content', '内容区', '主内容区：放页面主要内容', { width: fill, height: fill }, colLayout(16, 10), '#ffffff');
    put(doc, topnav, 'root');
    put(doc, content, 'root');
  } else if (templateId === 'dashboard') {
    root.layout = colLayout(0, 0);
    const topnav = region('topnav', '顶栏', '全局栏：放标题、搜索或账号操作', { width: fill, height: fixed(56) }, rowLayout(12, 12, 'center'), '#f8fafc');
    const body = region('body', '主体', '侧栏与主内容的横向容器', { width: fill, height: fill }, rowLayout(0, 0), '#ffffff');
    const sidebar = region('sidebar', '侧栏', '导航菜单区：放主要栏目入口', { width: fixed(220), height: fill }, colLayout(12, 8), '#f1f5f9');
    const content = region('content', '主内容', '仪表盘分区：放统计卡、图表与列表', { width: fill, height: fill }, colLayout(16, 10), '#ffffff');
    const bodyId = put(doc, body, 'root');
    put(doc, sidebar, bodyId);
    put(doc, content, bodyId);
    put(doc, topnav, 'root');
  }
  return doc;
}
