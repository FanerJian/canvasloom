// ============================================================
// CanvasLoom 布局协议 UIDoc —— 协议常量与工厂函数
// 浏览器与 Node 通用：本模块顶层禁止访问 DOM / window
// v2 起逐步开放更自由的设计能力；v1 文档由 shared/compat.js 兼容读取。
// ============================================================
import { UI_MODES, DEFAULT_MODE } from './modes.js';

export const DOC_FORMAT = 'uidoc';
export const DOC_VERSION = 2;
// v3 冻结版本号（商业级路线图 §4 决策 1）。newDoc 仍产 v2；v3 只由明确使用新能力的路径创建，
// v1/v2 项目长期可不入 v3（不自动升级、不自动写回）。
export const DOC_VERSION_V3 = 3;
export { UI_MODES, DEFAULT_MODE };

// ---------- 布局模式 ----------
export const LAYOUT_MODES = {
  free:       { label: '自由布局', desc: '子元素按坐标摆放，适合固定面板、悬浮元素、精确构图' },
  horizontal: { label: '横向排列', desc: '子元素从左到右排列，适合工具栏、按钮组、导航' },
  vertical:   { label: '纵向排列', desc: '子元素从上到下排列，适合表单、设置页、内容列表' },
  grid:       { label: '网格布局', desc: '子元素放入行列网格，适合仪表盘、卡片区、复杂分栏' },
};

// ---------- 尺寸模式 ----------
export const SIZE_MODES = {
  fixed:   { label: '固定', desc: '固定像素值' },
  auto:    { label: '自动', desc: '由内容决定大小' },
  fill:    { label: '填满剩余', desc: '排列方向上伸展占据剩余空间；网格中占满所在格子' },
  percent: { label: '百分比', desc: '相对父容器内容区的百分比' },
};

export const JUSTIFY_OPTIONS = {
  'start':         { label: '起点' },
  'center':        { label: '居中' },
  'end':           { label: '终点' },
  'space-between': { label: '两端对齐' },
};

export const ALIGN_OPTIONS = {
  'start':   { label: '起点' },
  'center':  { label: '居中' },
  'end':     { label: '终点' },
  'stretch': { label: '拉伸' },
};

// ---------- 容量边界（集中配置：校验器、面板、画布手柄、CLI catalog 同源） ----------
// 这是显式的容量控制而非设计限制：普通设计数值尽量放开，超容量边界属异常输入。
export const LIMITS = {
  canvasMax: 20000,      // 画布宽/高上限（px）
  percentMax: 1000,      // 百分比尺寸上限（%，允许有意大于父容器）
  fontSizeMax: 400,      // 字号上限（px）
  fontSizeMin: 1,
  borderRadiusMax: 2000, // 圆角上限（px）
  borderWidthMax: 100,   // 边框宽度上限（px）
  thicknessMax: 100,     // 分割线粗细上限（px）
  zoomMin: 0.05,         // 画布缩放范围（5%–800%）
  zoomMax: 8,
};

// ---------- 样式字段 ----------
// types 未列出 = 全部类型可用；数值上限统一引用 LIMITS，避免多处各养一套
export const STYLE_FIELDS = [
  { key: 'background',   label: '背景色',   type: 'color' },
  { key: 'color',        label: '文字颜色', type: 'color' },
  { key: 'fontSize',     label: '字号',     type: 'number', min: LIMITS.fontSizeMin, max: LIMITS.fontSizeMax },
  { key: 'fontWeight',   label: '字重',     type: 'enum', options: { normal: '常规', medium: '中等', bold: '粗体' } },
  { key: 'textAlign',    label: '文字对齐', type: 'enum', options: { left: '左对齐', center: '居中', right: '右对齐' }, types: ['text', 'button'] },
  { key: 'borderRadius', label: '圆角',     type: 'number', min: 0, max: LIMITS.borderRadiusMax },
  { key: 'borderWidth',  label: '边框宽度', type: 'number', min: 0, max: LIMITS.borderWidthMax },
  { key: 'borderColor',  label: '边框颜色', type: 'color' },
  { key: 'opacity',      label: '不透明度', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'padding',      label: '内边距',   type: 'padding', types: ['text', 'button', 'input'] },
  { key: 'overflow',     label: '溢出裁剪', type: 'enum', options: { visible: '显示溢出', hidden: '裁剪溢出' }, types: ['container'] },
  // 自 M2 起渲染器统一支持 fontFamily/deco（画布/预览/导出三处同源），升为共享白名单（冻结决策 9：解析后同样生效）
  { key: 'fontFamily',   label: '字体族',   type: 'font' },
  { key: 'deco',         label: '装饰',     type: 'enum', options: { none: '无', 'corner-cut': '切角', 'corner-ornament': '角饰' }, types: ['container'] },
];

// ---------- v3 新增（冻结决策见 商业级路线图.md §4；M1 只做校验，渲染由 M2 实现） ----------
// v3 组件白名单 = v2 组件白名单 + 以下字段（validate.js 据此分流）；
// v3.1（2026-10-07）增补 page（页面图层）
export const V3_COMPONENT_EXTRA_FIELDS = ['featureId', 'bind', 'actions', 'initiallyOpen', 'page'];

// v3 样式白名单：与 v2 共用 STYLE_FIELDS（fontFamily/deco 已并入共享表，见上；令牌值可出现在任何样式字段）
export const V3_STYLE_FIELDS = STYLE_FIELDS;

// actions 仅 click 事件；类型首版 toggle/open/close（冻结决策 5），
// v3.1（2026-10-07）增补 goto（跳转页面）。goto 目标 = 页面容器（page:true，见 newPage）；
// toggle/open/close 目标 = initiallyOpen:false 的普通容器（页面容器不作面板目标，校验层分流）。
export const V3_ACTION_EVENTS = ['click'];
export const V3_ACTION_TYPES = ['toggle', 'open', 'close', 'goto'];

// bind 值语法：feature:<id>.<路径>；路径 = 点分键（标识符）与 [n] 数组下标的组合，至少一段。
// 校验期只查语法与 feature 存在性，路径存在性留给渲染期（冻结决策 5）。
export const V3_BIND_PATTERN = /^feature:([A-Za-z_][A-Za-z0-9_]{0,63})((\.[A-Za-z_][A-Za-z0-9_]{0,63})|(\[\d+\]))+$/;

// v3 新错误码登记（字面量仍分布在 validate.js，与现有风格一致）：
//   E_V3_COMPONENTS_FORBIDDEN  顶层出现 components（组件树只存在于 presentation 内）
//   E_FEATURE_UNKNOWN          featureId/bind 引用了不存在的功能
//   E_FEATURE_UNREACHABLE      某 presentation 没有任何组件引用某功能
//   E_TOKEN_DANGLING           style 值引用了不存在的令牌
//   E_TOKEN_INVALID_CONTEXT    布局字段（size/position/layout/area）出现 $ 令牌引用
//   E_TOKEN_UNKNOWN_OVERRIDE   variant overrides.tokens 新增了基础风格没有的令牌键
//   E_ACTION_TARGET_INVALID    actions 结构非法；或 toggle/open/close 目标不是本 presentation 内
//                              initiallyOpen:false 的普通容器；或 goto 目标不是页面容器（page:true）
//   E_VARIANT_UNKNOWN          variant 引用的 presentation/style 不存在，或 activeVariant 悬空
//   E_V3_SECTION_READONLY      updateDocument 试图修改 v3 只读段
//   E_FEATURE_INVALID / E_STYLE_INVALID / E_PRESENTATION_INVALID / E_VARIANT_INVALID
//                              features/styles/presentations/variants 段的结构错误
//   E_PAGE_INVALID             页面容器（page:true）位置或字段组合非法（v3.1）

// ---------- v3 最小工厂（供后续模块使用；字段全部显式传入，不留隐式默认） ----------
// feature/style 以 id 为键存入对应表，工厂返回表项本体；variant 是数组项，id 在对象内。
export function createFeature(id, label, data) {
  if (!ID_PATTERN.test(id)) throw new Error('feature id 不合法：' + JSON.stringify(id));
  if (typeof label !== 'string' || !label.trim()) throw new Error('feature label 需为非空字符串');
  return { label, data }; // data 必须显式给出（不需要内容时传 {}）
}

export function createStyle(id, label, tokens) {
  if (!ID_PATTERN.test(id)) throw new Error('style id 不合法：' + JSON.stringify(id));
  if (typeof label !== 'string' || !label.trim()) throw new Error('style label 需为非空字符串');
  return { label, tokens }; // tokens 必须显式给出（可为 {}）
}

export function createVariant(id, label, presentation, style, overrides) {
  if (!ID_PATTERN.test(id)) throw new Error('variant id 不合法：' + JSON.stringify(id));
  if (typeof label !== 'string' || !label.trim()) throw new Error('variant label 需为非空字符串');
  return { id, label, presentation, style, overrides }; // overrides 必须显式给出（可为 { tokens: {}, components: {} }）
}

// ---------- 组件类型 ----------
export const COMPONENT_TYPES = {
  container: {
    label: '容器', hasChildren: true,
    desc: '可嵌套的布局容器，layout 决定子元素的排列方式',
  },
  text: {
    label: '文本',
    fields: { text: { label: '文本内容', type: 'longtext' } },
    desc: '显示一段文字',
  },
  button: {
    label: '按钮',
    fields: { text: { label: '按钮文字', type: 'text' } },
    desc: '可点击的按钮',
  },
  input: {
    label: '输入框',
    fields: {
      placeholder: { label: '占位提示', type: 'text' },
      value:       { label: '默认值',   type: 'text' },
    },
    desc: '单行文本输入框',
  },
  image: {
    label: '图片',
    fields: {
      resourceId: { label: '图片资源', type: 'resource' },
      fit:        { label: '适应方式', type: 'enum', options: { cover: '填充裁剪', contain: '完整显示', fill: '拉伸填满' } },
    },
    desc: '显示项目内图片资源（资源以 dataURL 随设计文件保存）',
  },
  rect: {
    label: '矩形',
    fields: {},
    desc: '纯色/带边框的矩形色块',
  },
  divider: {
    label: '分割线',
    fields: {
      orientation: { label: '方向', type: 'enum', options: { horizontal: '横向', vertical: '纵向' } },
      thickness:   { label: '粗细', type: 'number', min: 1, max: LIMITS.thicknessMax },
    },
    desc: '细分隔线；粗细所在的那一轴尺寸由 thickness 决定，另一轴用尺寸模式',
  },
};

export const TYPE_IDS = Object.keys(COMPONENT_TYPES);

export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// ---------- 工具 ----------
export function isContainer(comp) {
  return !!comp && comp.type === 'container';
}

// 未声明 placement 的旧组件严格沿用原父布局语义。
export function isAbsolutePlacement(comp, parent) {
  if (!comp) return false;
  if (comp.placement) return comp.placement.mode === 'absolute';
  return !!(parent && parent.layout && parent.layout.mode === 'free');
}

export function findComponent(doc, id) {
  return doc && doc.components ? (doc.components[id] || null) : null;
}

export function ancestorsOf(doc, id) {
  const chain = [];
  let cur = findComponent(doc, id);
  const guard = new Set();
  while (cur && cur.parent) {
    if (guard.has(cur.parent)) break; // 环：由 validate 报告
    guard.add(cur.parent);
    chain.push(cur.parent);
    cur = findComponent(doc, cur.parent);
  }
  return chain;
}

export function isDescendantOf(doc, maybeChildId, ancestorId) {
  return ancestorsOf(doc, maybeChildId).includes(ancestorId);
}

export function listContainers(doc) {
  const out = [];
  for (const id of Object.keys(doc.components)) {
    if (isContainer(doc.components[id])) out.push(doc.components[id]);
  }
  return out;
}

// padding 统一为 [上, 右, 下, 左]
export function normalizePadding(p) {
  if (typeof p === 'number' && isFinite(p) && p >= 0) return [p, p, p, p];
  if (Array.isArray(p)) {
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 4) return [p[0], p[1], p[2], p[3]];
  }
  return [0, 0, 0, 0];
}

export function slugify(s) {
  const out = String(s || '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .toLowerCase();
  return out; // 纯中文等取不到 ASCII 时返回 ''，由调用方决定兜底
}

export function genId(doc, base) {
  let id = slugify(base || '') || 'comp';
  if (!ID_PATTERN.test(id)) id = 'c_' + id;
  if (!doc.components[id]) return id;
  let i = 2;
  while (doc.components[id + '_' + i]) i++;
  return id + '_' + i;
}

// ---------- 默认值工厂 ----------
export function defaultLayout(mode) {
  const base = { mode };
  if (mode === 'horizontal' || mode === 'vertical') {
    base.gap = 8;
    base.padding = 0;
    base.justify = 'start';
    base.align = 'stretch';
  } else if (mode === 'grid') {
    base.padding = 0;
    base.columnGap = 12;
    base.rowGap = 12;
    base.tracks = { columns: [{ mode: 'fill', value: 1 }, { mode: 'fill', value: 1 }, { mode: 'fill', value: 1 }], rows: [{ mode: 'fixed', value: 80 }] };
  } else if (mode === 'free') {
    // 自由布局无对齐概念，子元素用 position
  }
  return base;
}

// 依据父容器布局模式给出新组件的合理默认尺寸（modeId 可覆盖个别类型的默认值）
export function defaultSizeFor(type, parentMode, modeId) {
  const mode = UI_MODES[modeId || DEFAULT_MODE] || UI_MODES.generic;
  const over = mode.sizeOverrides && mode.sizeOverrides[type];
  if (over) {
    return { width: { mode: 'fixed', value: over.width }, height: { mode: 'fixed', value: over.height } };
  }
  const size = { width: { mode: 'fill' }, height: { mode: 'auto' } };
  if (parentMode === 'free') {
    const fixed = { width: { mode: 'fixed', value: 160 }, height: { mode: 'fixed', value: 48 } };
    if (type === 'container') { fixed.width.value = 240; fixed.height.value = 160; }
    if (type === 'image')     { fixed.width.value = 160; fixed.height.value = 120; }
    if (type === 'text')      { fixed.height.mode = 'auto'; }
    if (type === 'divider')   { fixed.height.mode = 'auto'; }
    return fixed;
  }
  if (type === 'button') { return { width: { mode: 'auto' }, height: { mode: 'auto' } }; }
  if (type === 'image')  { return { width: { mode: 'fixed', value: 160 }, height: { mode: 'fixed', value: 120 } }; }
  if (type === 'rect')   { return { width: { mode: 'fill' }, height: { mode: 'fixed', value: 80 } }; }
  if (type === 'divider') {
    if (parentMode === 'horizontal') return { width: { mode: 'auto' }, height: { mode: 'fill' } };
    return { width: { mode: 'fill' }, height: { mode: 'auto' } };
  }
  if (type === 'input') { return { width: { mode: 'fill' }, height: { mode: 'auto' } }; }
  // container / text
  if (parentMode === 'horizontal') return { width: { mode: 'fixed', value: type === 'container' ? 240 : 120 }, height: { mode: 'fill' } };
  return size; // vertical / grid：宽填满、高自适应
}

// 类型基础默认样式 + 场景模式覆盖（见 shared/modes.js 的 styles 段）
export function defaultStyleFor(type, modeId) {
  const s = {};
  if (type === 'container') s.background = '#ffffff';
  if (type === 'text')      { s.color = '#1f2937'; s.fontSize = 14; }
  if (type === 'button')    { s.background = '#2563eb'; s.color = '#ffffff'; s.fontSize = 14; s.borderRadius = 6; s.padding = [8, 16, 8, 16]; }
  if (type === 'input')     { s.background = '#ffffff'; s.color = '#1f2937'; s.fontSize = 14; s.borderRadius = 6; s.borderWidth = 1; s.borderColor = '#d1d5db'; s.padding = [8, 12, 8, 12]; }
  if (type === 'rect')      { s.background = '#dbeafe'; s.borderRadius = 4; }
  if (type === 'divider')   { s.background = '#d1d5db'; }
  const mode = UI_MODES[modeId || DEFAULT_MODE] || UI_MODES.generic;
  return Object.assign(s, (mode.styles && mode.styles[type]) || {});
}

// 在文档中新建组件（自动生成唯一 id、接入父容器 children）
// extra 仅接受：id / name / purpose / text / layoutMode，其余字段由调用方在创建后设置
export function newComponent(doc, type, parentId, extra = {}) {
  const parent = findComponent(doc, parentId);
  if (!parent || !isContainer(parent)) throw new Error('父容器不存在或不是容器：' + parentId);
  const parentMode = parent.layout ? parent.layout.mode : 'vertical';
  const modeId = doc.mode || DEFAULT_MODE;
  let base = extra.id;
  if (!base) {
    const s = slugify(extra.name || '');
    base = s || type; // 中文名取不到 ASCII slug 时，用组件类型作为 id 基础
  }
  const id = genId(doc, base);
  const comp = {
    id,
    type,
    name: extra.name || (COMPONENT_TYPES[type].label),
    purpose: extra.purpose || '',
    parent: parentId,
    size: defaultSizeFor(type, parentMode, modeId),
    style: defaultStyleFor(type, modeId),
    flags: {},
  };
  if (isContainer(comp)) {
    comp.children = [];
    comp.layout = defaultLayout(extra.layoutMode || 'vertical');
  }
  if (parentMode === 'free') {
    const siblings = parent.children || [];
    comp.position = { left: 24 + (siblings.length % 8) * 20, top: 24 + (siblings.length % 8) * 20 };
  }
  if (parentMode === 'grid') {
    comp.area = firstFreeGridCell(parent, doc);
  }
  if (type === 'text') comp.text = extra.text != null ? extra.text : '文本内容';
  if (type === 'button') comp.text = extra.text != null ? extra.text : '按钮';
  if (type === 'input') { comp.placeholder = '请输入内容'; comp.value = ''; }
  if (type === 'image') { comp.fit = 'cover'; comp.resourceId = ''; }
  if (type === 'divider') { comp.orientation = parentMode === 'horizontal' ? 'vertical' : 'horizontal'; comp.thickness = 1; }
  doc.components[id] = comp;
  parent.children = parent.children || [];
  parent.children.push(id);
  return comp;
}

// ---------- v3.1 页面图层 ----------
// 页面 = root 的直接子容器，铺满画布（独立摆放 + percent 100×100，不受 root 布局模式影响），
// 显隐由运行时/设计视图按「页面切换」管理（不走 initiallyOpen，校验层禁止两者混用）。
// root.children 顺序即页面顺序，第一个页面为起始页。
export function newPage(doc, name) {
  const rootComp = findComponent(doc, 'root');
  if (!rootComp || !isContainer(rootComp)) throw new Error('缺少根组件 root，无法创建页面');
  const comp = newComponent(doc, 'container', 'root', { name: name || '页面', layoutMode: 'free' });
  comp.page = true;
  comp.placement = { mode: 'absolute' };
  comp.position = { left: 0, top: 0 };
  comp.size = { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } };
  delete comp.area;
  return comp;
}

// 按顺序列出组件表中的页面容器（root 直接子元素中 page===true 者）；首个为起始页。
// 入参可以是完整文档或仅含 components 的视图对象（编辑域 scope / presentation 组件树同构）。
export function pageIdsOf(doc) {
  const comps = (doc && doc.components) || {};
  const root = comps.root;
  if (!root || !Array.isArray(root.children)) return [];
  return root.children.filter((id) => comps[id] && comps[id].type === 'container' && comps[id].page === true);
}

// 找网格中第一个未被占用的格子（1-based）
export function firstFreeGridCell(gridComp, doc) {
  const tracks = (gridComp.layout && gridComp.layout.tracks) || { columns: [], rows: [] };
  const cols = tracks.columns.length || 1;
  const rows = tracks.rows.length || 1;
  const taken = new Set();
  for (const cid of gridComp.children || []) {
    const c = findComponent(doc, cid);
    if (c && !(c.placement && c.placement.mode === 'absolute') && c.area) {
      for (let r = c.area.row; r < c.area.row + (c.area.rowSpan || 1); r++)
        for (let col = c.area.col; col < c.area.col + (c.area.colSpan || 1); col++)
          taken.add(r * 1000 + col);
    }
  }
  for (let r = 1; r <= rows; r++)
    for (let col = 1; col <= cols; col++)
      if (!taken.has(r * 1000 + col)) return { col, row: r, colSpan: 1, rowSpan: 1 };
  return { col: 1, row: 1, colSpan: 1, rowSpan: 1 };
}

export function newDoc(name, modeId, startLayout = 'vertical') {
  const resolved = modeId && UI_MODES[modeId] ? modeId : DEFAULT_MODE;
  const mode = UI_MODES[resolved];
  const rootMode = startLayout === 'free' ? 'free' : 'vertical';
  const doc = {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    revision: 1,
    mode: resolved,
    name: name || '未命名设计',
    canvas: { width: mode.canvas.width, height: mode.canvas.height, background: mode.canvas.background },
    resources: {},
    components: {},
  };
  doc.components.root = {
    id: 'root',
    type: 'container',
    name: '页面',
    purpose: '页面根容器',
    parent: null,
    children: [],
    layout: defaultLayout(rootMode),
    // 根容器默认「跟随画布」：percent 100 在渲染时按视口（=画布）解析，画布改尺寸自动跟随。
    // 旧文档的固定根保持原语义；编辑器提供明确的跟随/固定切换。
    size: { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } },
    style: { background: mode.rootBackground || '#ffffff' },
    flags: {},
  };
  return doc;
}

// 复制子树（生成全新 id），返回 { comp, idMap }
export function cloneSubtree(doc, rootId) {
  const idMap = {};
  const cloneOne = (id, parentId) => {
    const src = findComponent(doc, id);
    if (!src) return null;
    const newId = genId(doc, src.id + '_copy');
    idMap[id] = newId;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newId;
    copy.parent = parentId;
    doc.components[newId] = copy;
    if (isContainer(copy) && src.children) {
      copy.children = src.children.map((cid) => cloneOne(cid, newId)).filter(Boolean);
    }
    return copy;
  };
  const comp = cloneOne(rootId, findComponent(doc, rootId)?.parent || 'root');
  return { comp, idMap };
}
