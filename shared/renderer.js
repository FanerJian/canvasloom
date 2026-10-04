// ============================================================
// UIDoc v1 渲染器 —— 布局规则 → DOM/CSS
// 供编辑器画布、预览 iframe、导出页共用，保证三处渲染一致。
// 仅在函数内部触碰 DOM，可在 Node 侧安全导入（供静态分析）。
// ============================================================
import { normalizePadding, findComponent, isAbsolutePlacement } from './protocol.js';

const FONT_WEIGHTS = { normal: '400', medium: '500', bold: '700' };

const BASE_CSS = `
.uiw-node { box-sizing: border-box; position: relative; min-width: 0; min-height: 0; }
.uiw-text { white-space: pre-wrap; word-break: break-word; }
.uiw-button { white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; }
.uiw-image img { display: block; width: 100%; height: 100%; }
.uiw-input input { display: block; width: 100%; box-sizing: border-box; border: none; outline: none;
  background: transparent; font: inherit; color: inherit; padding: 0; }
.uiw-input input::placeholder { color: #9ca3af; }
`;

function ensureBaseStyle(docu) {
  const d = docu;
  if (!d.getElementById('uiw-base-style')) {
    const st = d.createElement('style');
    st.id = 'uiw-base-style';
    st.textContent = BASE_CSS;
    d.head.appendChild(st);
  }
}

// ---------- 尺寸模式 → CSS ----------
function applySize(style, comp, axis, ctx) {
  const s = (comp.size || {})[axis];
  if (!s) return;
  const prop = axis === 'width' ? 'width' : 'height';
  switch (s.mode) {
    case 'fixed': style[prop] = s.value + 'px'; break;
    case 'percent': style[prop] = s.value + '%'; break;
    case 'fill': style[prop] = '100%'; break; // 自由/根兜底；排列布局里由 applyChildFlow 覆盖
    case 'auto': default: style[prop] = 'fit-content'; break;
  }
  void ctx;
}

// 排列布局（横向/纵向）子元素的主轴/交叉轴映射
// 语义：fixed/percent 的主轴尺寸不参与 flex 收缩——设计写多少就是多少；
// 空间不足时保持原值并溢出，由布局检查报告溢出问题，而不是静默压缩。
function applyChildFlow(style, comp, parentLayout) {
  const row = parentLayout.mode === 'horizontal';
  const main = row ? 'width' : 'height';
  const cross = row ? 'height' : 'width';
  const ms = (comp.size || {})[main] || { mode: 'auto' };
  const cs = (comp.size || {})[cross] || { mode: 'auto' };
  if (ms.mode === 'fill') {
    style.flexGrow = String(ms.flex || 1);
    style.flexShrink = '1';
    style.flexBasis = '0%';
    if (row) style.minWidth = '0'; else style.minHeight = '0';
  } else if (ms.mode === 'fixed') {
    style[main] = ms.value + 'px';
    style.flexGrow = '0';
    style.flexShrink = '0';
  } else if (ms.mode === 'percent') {
    style[main] = ms.value + '%';
    style.flexShrink = '0';
  } else {
    style[main] = 'fit-content';
  }
  if (cs.mode === 'fill') style.alignSelf = 'stretch';
  else if (cs.mode === 'fixed') style[cross] = cs.value + 'px';
  else if (cs.mode === 'percent') style[cross] = cs.value + '%';
  else style[cross] = 'auto';
}

// 网格子元素：占格 + 对齐
function applyChildGrid(style, comp) {
  const a = comp.area;
  if (a) {
    style.gridColumn = a.col + ' / span ' + (a.colSpan || 1);
    style.gridRow = a.row + ' / span ' + (a.rowSpan || 1);
  }
  const ws = (comp.size || {}).width || { mode: 'fill' };
  const hs = (comp.size || {}).height || { mode: 'fill' };
  if (ws.mode === 'fixed') { style.width = ws.value + 'px'; style.justifySelf = 'start'; }
  else if (ws.mode === 'auto') { style.width = 'fit-content'; style.justifySelf = 'start'; }
  else if (ws.mode === 'percent') style.width = ws.value + '%';
  if (hs.mode === 'fixed') { style.height = hs.value + 'px'; style.alignSelf = 'start'; }
  else if (hs.mode === 'auto') { style.height = 'fit-content'; style.alignSelf = 'start'; }
  else if (hs.mode === 'percent') style.height = hs.value + '%';
}

// 自由布局子元素：绝对定位（position 相对父容器"内容区"，需计入内边距）
function applyChildFree(style, comp, parentComp) {
  style.position = 'absolute';
  const pad = parentComp && parentComp.layout ? normalizePadding(parentComp.layout.padding) : [0, 0, 0, 0];
  style.left = (pad[3] + (comp.position ? comp.position.left : 0)) + 'px';
  style.top = (pad[0] + (comp.position ? comp.position.top : 0)) + 'px';
}

function applyStyleFields(style, comp) {
  const st = comp.style || {};
  if (st.background != null) style.background = st.background;
  if (st.color != null) style.color = st.color;
  if (st.fontSize != null) style.fontSize = st.fontSize + 'px';
  if (st.fontWeight != null) style.fontWeight = FONT_WEIGHTS[st.fontWeight] || '400';
  if (st.textAlign != null) style.textAlign = st.textAlign;
  if (st.borderRadius != null) style.borderRadius = st.borderRadius + 'px';
  if (st.borderWidth != null && st.borderWidth > 0) {
    style.border = st.borderWidth + 'px solid ' + (st.borderColor || '#000000');
  }
  if (st.opacity != null) style.opacity = String(st.opacity);
  if (st.padding != null) {
    const p = normalizePadding(st.padding);
    style.padding = p.map((n) => n + 'px').join(' ');
  }
  if (st.overflow != null) style.overflow = st.overflow;
}

function tracksToTemplate(tracks) {
  return (tracks || []).map((t) => {
    if (!t) return 'auto';
    if (t.mode === 'fixed') return t.value + 'px';
    if (t.mode === 'fill') return (t.value || 1) + 'fr';
    return 'auto';
  }).join(' ');
}

function applyContainerLayout(el, comp, doc, ctx) {
  const L = comp.layout || { mode: 'vertical' };
  if (L.padding != null) {
    const p = normalizePadding(L.padding);
    el.style.padding = p.map((n) => n + 'px').join(' ');
  }
  if (L.mode === 'horizontal' || L.mode === 'vertical') {
    el.style.display = 'flex';
    el.style.flexDirection = L.mode === 'horizontal' ? 'row' : 'column';
    if (L.gap != null) el.style.gap = L.gap + 'px';
    if (L.justify) el.style.justifyContent = L.justify;
    if (L.align) el.style.alignItems = L.align;
  } else if (L.mode === 'grid') {
    el.style.display = 'grid';
    el.style.gridTemplateColumns = tracksToTemplate(L.tracks && L.tracks.columns);
    if (L.tracks && L.tracks.rows && L.tracks.rows.length) el.style.gridTemplateRows = tracksToTemplate(L.tracks.rows);
    else el.style.gridAutoRows = 'minmax(24px, auto)';
    if (L.columnGap != null) el.style.columnGap = L.columnGap + 'px';
    if (L.rowGap != null) el.style.rowGap = L.rowGap + 'px';
  } else if (L.mode === 'free') {
    el.style.display = 'block';
  }
  void doc; void ctx;
}

// ---------- 构建单个节点 ----------
function buildNode(doc, comp, parentComp, opts) {
  const d = opts.ownerDocument;
  const parentLayout = parentComp && parentComp.type === 'container' ? parentComp.layout : null;
  const el = d.createElement('div');
  el.className = 'uiw-node uiw-' + comp.type + (opts.canvasMode ? ' uiw-canvas-node' : '');
  el.dataset.id = comp.id;
  applySize(el.style, comp, 'width', opts);
  applySize(el.style, comp, 'height', opts);
  applyStyleFields(el.style, comp);
  // 编辑画布允许组件拖出父容器查看位置；预览/导出仍按原设计 overflow 裁剪。
  if (opts.canvasMode && opts.showOverflow && comp.type === 'container') el.style.overflow = 'visible';

  if (isAbsolutePlacement(comp, parentComp)) applyChildFree(el.style, comp, parentComp);
  else if (parentLayout && parentLayout.mode === 'grid') applyChildGrid(el.style, comp);
  else if (parentLayout) applyChildFlow(el.style, comp, parentLayout);

  switch (comp.type) {
    case 'text': {
      el.classList.add('uiw-text');
      el.textContent = comp.text != null ? comp.text : '';
      break;
    }
    case 'button': {
      el.classList.add('uiw-button');
      el.textContent = comp.text != null ? comp.text : '';
      break;
    }
    case 'input': {
      el.classList.add('uiw-input');
      const input = d.createElement('input');
      input.type = 'text';
      if (comp.placeholder != null) input.placeholder = comp.placeholder;
      if (comp.value != null) input.value = comp.value;
      if (!opts.editable) { input.readOnly = true; input.tabIndex = -1; input.style.pointerEvents = 'none'; }
      el.appendChild(input);
      break;
    }
    case 'image': {
      el.classList.add('uiw-image');
      const res = comp.resourceId ? (doc.resources || {})[comp.resourceId] : null;
      if (res && res.dataUrl) {
        const img = d.createElement('img');
        img.src = res.dataUrl;
        img.alt = comp.name || comp.id;
        img.draggable = false;
        img.style.objectFit = comp.fit || 'cover';
        el.appendChild(img);
      } else {
        el.classList.add('uiw-missing');
        el.textContent = '图片缺失';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.color = '#9ca3af';
        el.style.fontSize = '12px';
        el.style.background = '#f3f4f6';
      }
      break;
    }
    case 'divider': {
      // 粗细所在轴恒为 thickness；另一轴尊重尺寸模式（fixed/percent 已由尺寸逻辑写入，
      // auto/缺省时回退为占满该轴，fill 在排列布局中已由拉伸表达）
      const t = comp.thickness != null ? comp.thickness : 1;
      const vertical = comp.orientation === 'vertical';
      if (vertical) {
        el.style.width = t + 'px';
        const hs = (comp.size || {}).height;
        if (!hs || hs.mode === 'auto') el.style.height = '100%';
      } else {
        el.style.height = t + 'px';
        const ws = (comp.size || {}).width;
        if (!ws || ws.mode === 'auto') el.style.width = '100%';
      }
      break;
    }
    case 'rect': break;
    case 'container': {
      applyContainerLayout(el, comp, doc, opts);
      const kids = comp.children || [];
      for (const cid of kids) {
        const child = findComponent(doc, cid);
        if (child) el.appendChild(buildNode(doc, child, comp, opts));
      }
      if (!kids.length && opts.canvasMode) el.classList.add('uiw-empty');
      break;
    }
    default: break;
  }
  return el;
}

// ---------- 渲染整棵树 ----------
// opts.viewport: {width,height}（预览视口）；缺省用 doc.canvas
// opts.canvasMode: 编辑器画布模式（空容器显示占位轮廓）
// opts.editable: 输入框是否可输入
export function renderDoc(containerEl, doc, opts = {}) {
  const d = containerEl.ownerDocument;
  ensureBaseStyle(d);
  const root = doc.components && doc.components.root;
  containerEl.textContent = '';
  if (!root) {
    const tip = d.createElement('div');
    tip.textContent = '文档缺少根组件 root';
    tip.style.cssText = 'padding:20px;color:#b91c1c;font:14px sans-serif;';
    containerEl.appendChild(tip);
    return null;
  }
  const viewport = opts.viewport || { width: doc.canvas.width, height: doc.canvas.height };
  const rootEl = buildNode(doc, root, null, { ...opts, ownerDocument: d });
  rootEl.classList.add('uiw-root');
  // 根元素尺寸以视口为基准解析 fill/percent
  const ws = (root.size || {}).width || { mode: 'fixed', value: viewport.width };
  const hs = (root.size || {}).height || { mode: 'fixed', value: viewport.height };
  rootEl.style.width = ws.mode === 'fixed' ? ws.value + 'px'
    : ws.mode === 'percent' ? ws.value + '%' : ws.mode === 'fill' ? '100%' : 'fit-content';
  rootEl.style.height = hs.mode === 'fixed' ? hs.value + 'px'
    : hs.mode === 'percent' ? hs.value + '%' : hs.mode === 'fill' ? '100%' : 'fit-content';
  rootEl.style.position = 'relative';
  // 根容器裁剪交给设计规则：style.overflow 未设置时按 CSS 默认 visible；
  // 显式设置 hidden 则根容器裁剪溢出（设计视图的画布外显示开关只影响编辑器画板层）。
  containerEl.appendChild(rootEl);
  return rootEl;
}
