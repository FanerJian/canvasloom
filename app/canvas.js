// ============================================================
// 设计画布：渲染 + 选中框 + 拖拽（自由/排列/网格三种语义）+ 缩放手柄
// 交互约定：自由布局拖动改位置；横向/纵向拖动改顺序；网格拖动改占格。
// 缩放手柄改尺寸：fill 轴拖后转固定、percent 轴按新比例重算（网格父容器中调跨格数）。
// 画布通过 transform:scale 缩放，所有指针位移按 1/zoom 换算为设计坐标。
// ============================================================
import { state, mutate, select, setZoom, setSnapEnabled, PALETTE_MIME, viewDoc } from './store.js';
import {
  findComponent, isContainer, normalizePadding, LIMITS, isAbsolutePlacement,
  COMPONENT_TYPES, defaultSizeFor, firstFreeGridCell, newComponent,
} from '../shared/protocol.js';
import { renderDoc } from '../shared/renderer.js';
import { blocksOf, instantiateBlock } from '../shared/blocks.js';
import { openContextMenu } from './ctxmenu.js';
import { toast } from './panels.js';

const el = {
  wrap: null, stage: null, scaler: null, artboard: null, overlay: null,
};
let zoom = 1;

export function initCanvas() {
  el.wrap = document.getElementById('canvas-wrap');
  el.stage = document.getElementById('canvas-stage');
  el.scaler = document.getElementById('canvas-scaler');
  el.artboard = document.getElementById('artboard');
  el.overlay = document.getElementById('overlay');

  el.scaler.addEventListener('pointerdown', onPointerDown);
  el.wrap.addEventListener('wheel', onWheel, { passive: false });
  // 画布内容不允许触发浏览器原生拖拽（否则真实鼠标按下拖动会被 DnD 劫持，pointermove 全部消失）
  el.scaler.addEventListener('dragstart', (e) => e.preventDefault());
  // 双击文本/按钮直接改字；右键呼出上下文菜单；组件库/预设块可拖入画布
  el.scaler.addEventListener('dblclick', onDblClick);
  el.scaler.addEventListener('contextmenu', onContextMenu);
  el.scaler.addEventListener('dragover', onPaletteDragOver);
  el.scaler.addEventListener('dragleave', onPaletteDragLeave);
  el.scaler.addEventListener('drop', onPaletteDrop);
  window.addEventListener('dragend', onPaletteDragEnd);
}

export function renderCanvas() {
  if (!state.doc) return;
  // v3 解析失败：显示结构化错误卡（错误码+信息），不白屏、不回退默认变体
  if (state.viewError || !state.view) { renderViewError(); return; }
  const doc = viewDoc();
  zoom = state.zoom;
  const w = doc.canvas.width, h = doc.canvas.height;
  el.scaler.style.width = w + 'px';
  el.scaler.style.height = h + 'px';
  el.scaler.style.transform = `scale(${zoom})`;
  el.stage.style.width = (w * zoom) + 'px';
  el.stage.style.height = (h * zoom) + 'px';
  el.artboard.style.background = doc.canvas.background || '#ffffff';
  // 设计视图「显示画布外内容」开关：只影响编辑视图的裁剪，
  // 预览/导出的最终裁剪仍由设计规则（根容器 overflow 与视口）决定
  el.artboard.style.overflow = state.showOutsideCanvas ? 'visible' : 'hidden';
  renderDoc(el.artboard, doc, { viewport: { width: w, height: h }, canvasMode: true, showOverflow: state.showOutsideCanvas, editable: false });
  refreshOverlay();
}

// v3 文档解析失败的错误卡（与导出页 showRenderError 同语义）
function renderViewError() {
  const doc = state.doc;
  const w = doc.canvas.width, h = doc.canvas.height;
  zoom = state.zoom;
  el.scaler.style.width = w + 'px';
  el.scaler.style.height = h + 'px';
  el.scaler.style.transform = `scale(${zoom})`;
  el.stage.style.width = (w * zoom) + 'px';
  el.stage.style.height = (h * zoom) + 'px';
  el.artboard.style.background = '#ffffff';
  el.artboard.style.overflow = 'hidden';
  el.artboard.textContent = '';
  el.overlay.textContent = '';
  const card = document.createElement('div');
  card.className = 'ui-view-error';
  const head = document.createElement('div');
  head.className = 'uve-head';
  head.textContent = '✗ 设计视图无法渲染';
  const code = document.createElement('div');
  code.textContent = '错误码：' + (state.viewError.code || 'E_RESOLVE');
  const msg = document.createElement('div');
  msg.textContent = '信息：' + (state.viewError.message || '未知错误');
  card.appendChild(head);
  card.appendChild(code);
  card.appendChild(msg);
  el.artboard.appendChild(card);
}

// ---------- 坐标换算 ----------
function designPoint(clientX, clientY) {
  const br = el.artboard.getBoundingClientRect();
  return { x: (clientX - br.left) / zoom, y: (clientY - br.top) / zoom };
}
function nodeRect(node) {
  const br = el.artboard.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  return { x: (r.left - br.left) / zoom, y: (r.top - br.top) / zoom, w: r.width / zoom, h: r.height / zoom };
}

// 供其他面板使用的共享几何：按组件 id 返回画布设计坐标系中的视觉矩形（边框盒）。
// 无 DOM（组件不在画布上）时返回 null，调用方需自行回退到默认转换。
export function designRectById(id) {
  if (!el.artboard || !state.doc) return null;
  const node = el.artboard.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!node) return null;
  return nodeRect(node);
}

// ---------- 缩放滚轮（以光标为中心） ----------
const STAGE_MARGIN = 28; // 与 styles.css 中 #canvas-stage 的 margin 保持一致
function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const old = state.zoom;
  // 边界由 store.setZoom 依 LIMITS 统一收口（5%–800%），此处不再单独钳制
  const next = old * (e.deltaY < 0 ? 1.1 : 0.9);
  if (next === old) return;
  const wrapRect = el.wrap.getBoundingClientRect();
  const cx = e.clientX - wrapRect.left, cy = e.clientY - wrapRect.top;
  // 光标下的内容点（缩放前的 scaled 内容坐标）
  const px = el.wrap.scrollLeft + cx, py = el.wrap.scrollTop + cy;
  setZoom(next); // 触发 renderAll → renderCanvas，同步更新 stage 尺寸
  // stage 外边距不参与缩放，内容点绕 stage 原点放大 k 倍
  const k = next / old;
  el.wrap.scrollLeft = STAGE_MARGIN + (px - STAGE_MARGIN) * k - cx;
  el.wrap.scrollTop = STAGE_MARGIN + (py - STAGE_MARGIN) * k - cy;
}

// ---------- 选中框与手柄 ----------
// 所有尺寸模式的轴都可拖拽手柄：fixed/auto 直接改值；fill 拖后转固定；percent 拖后按新比例重算
// （网格父容器中拖手柄 = 调跨格数，见 onResizeMove）

export function refreshOverlay() {
  const ov = el.overlay;
  ov.textContent = '';
  const id = state.selection;
  if (!id || !state.doc || !state.view) return;
  const comp = findComponent(viewDoc(), id);
  const node = el.artboard.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!comp || !node) return;
  const r = nodeRect(node);
  const parent = comp.parent ? findComponent(viewDoc(), comp.parent) : null;
  const pmode = parent && parent.layout ? parent.layout.mode : null;
  const independentlyPlaced = isAbsolutePlacement(comp, parent) || (!!state.freeMove && !!parent);

  const box = mk('div', 'ui-selbox');
  box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
  ov.appendChild(box);

  const badge = mk('div', 'ui-badge');
  badge.textContent = `${comp.name} · ${comp.id}`;
  badge.style.cssText = `left:${r.x}px;top:${Math.max(0, r.y - 18 / zoom)}px;transform:scale(${1 / zoom});transform-origin:0 100%;`;
  ov.appendChild(badge);

  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  for (const dir of dirs) {
    if (!independentlyPlaced && dir === 'w' && pmode && pmode !== 'free') continue;
    if (!independentlyPlaced && dir === 'n' && pmode && pmode !== 'free') continue;
    if (!independentlyPlaced && (dir === 'nw' || dir === 'sw') && pmode && pmode !== 'free') continue;
    if (!independentlyPlaced && dir === 'ne' && pmode && pmode !== 'free') continue;
    const hd = mk('div', 'ui-handle ui-handle-' + dir);
    hd.dataset.dir = dir;
    const px = dir.includes('w') ? r.x : dir.includes('e') ? r.x + r.w : r.x + r.w / 2;
    const py = dir.includes('n') ? r.y : dir.includes('s') ? r.y + r.h : r.y + r.h / 2;
    hd.style.cssText = `left:${px}px;top:${py}px;transform:translate(-50%,-50%) scale(${1 / zoom});`;
    ov.appendChild(hd);
  }
}

function mk(tag, cls) {
  const d = document.createElement(tag);
  d.className = cls;
  return d;
}

// ---------- 指针交互 ----------
function onPointerDown(e) {
  if (e.button !== 0) return;
  const handle = e.target.closest('.ui-handle');
  const node = e.target.closest('#artboard [data-id]');
  if (handle) { startResize(e, handle.dataset.dir); return; }
  if (node) {
    if (node.dataset.id !== state.selection) select(node.dataset.id);
    startDrag(e, node);
  } else if (e.target === el.artboard) {
    select(null);
  }
}

// ---------- 双击就地编辑文字（text / button） ----------
let textEditor = null;

function onDblClick(e) {
  const node = e.target.closest('#artboard [data-id]');
  if (!node) return;
  const comp = findComponent(viewDoc(), node.dataset.id);
  if (!comp) return;
  if (comp.type !== 'text' && comp.type !== 'button') return;
  e.preventDefault();
  select(comp.id);
  openTextEditor(node, comp);
}

// 供右键菜单调用：按组件 id 进入文字编辑
export function beginTextEditMode(id) {
  const comp = findComponent(viewDoc(), id);
  if (!comp || (comp.type !== 'text' && comp.type !== 'button')) return false;
  const node = el.artboard.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!node) return false;
  openTextEditor(node, comp);
  return true;
}

function openTextEditor(node, comp) {
  closeTextEditor(false);
  const r = nodeRect(node);
  const st = comp.style || {};
  const ed = document.createElement('textarea');
  ed.className = 'ui-text-edit';
  ed.value = comp.text != null ? comp.text : '';
  ed.style.cssText = `left:${r.x}px;top:${r.y}px;width:${Math.max(r.w, 36)}px;height:${Math.max(r.h, 26)}px;` +
    `font-size:${st.fontSize || 14}px;font-weight:${st.fontWeight === 'bold' ? '700' : st.fontWeight === 'medium' ? '500' : '400'};` +
    `color:${st.color || '#1f2937'};text-align:${st.textAlign || (comp.type === 'button' ? 'center' : 'left')};`;
  ed.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); closeTextEditor(true); }
    else if (ev.key === 'Escape') { ev.stopPropagation(); closeTextEditor(false); }
  });
  ed.addEventListener('blur', () => closeTextEditor(true));
  el.overlay.appendChild(ed);
  textEditor = { ed, id: comp.id };
  ed.focus();
  ed.select();
}

// commit=false 表示放弃修改；mutate 会触发画布重建，先摘除编辑器再提交
function closeTextEditor(commit) {
  if (!textEditor) return;
  const { ed, id } = textEditor;
  const value = ed.value;
  textEditor = null;
  ed.remove();
  if (!commit) return;
  const comp = findComponent(viewDoc(), id);
  if (comp && (comp.text || '') !== value) {
    mutate(`编辑 ${id} 文字`, (doc) => { doc.components[id].text = value; });
  }
}

// ---------- 右键菜单 ----------
function onContextMenu(e) {
  e.preventDefault();
  const node = e.target.closest('#artboard [data-id]');
  const id = node ? node.dataset.id : (state.selection && findComponent(viewDoc(), state.selection) ? state.selection : null);
  openContextMenu(e, id);
}

// ---------- 组件库 / 预设块拖入画布（HTML5 DnD） ----------
// 悬停即给出落点反馈：容器高亮 + 排列布局插入线 / 网格目标格 / 自由布局幽灵占位；
// 松手后组件（或整块预设结构）落在指针位置：排列=插入到该顺序，网格=该格，自由=该坐标居中。
let paletteHover = null; // { containerId, containerNode, mode, indicator|cellBox|ghost, cell }

function paletteDragActive(e) {
  return !!(e.dataTransfer && [...e.dataTransfer.types].includes(PALETTE_MIME));
}

function clearPaletteHover() {
  if (!paletteHover) return;
  if (paletteHover.containerNode) paletteHover.containerNode.classList.remove('ui-drop-hover');
  if (paletteHover.indicator) paletteHover.indicator.remove();
  if (paletteHover.cellBox) paletteHover.cellBox.remove();
  if (paletteHover.ghost) paletteHover.ghost.remove();
  paletteHover = null;
}

function onPaletteDragEnd() {
  clearPaletteHover();
  window.__canvasloomDrag = null;
}

// 指针下落点上下文：最深组件 → 它所在容器（组件本身是容器则用它）
function resolveDropContext(e) {
  let comp = null;
  if (e.target && e.target.closest) {
    const node = e.target.closest('#artboard [data-id]');
    if (node) comp = findComponent(viewDoc(), node.dataset.id);
  }
  let container = null;
  if (comp) container = isContainer(comp) ? comp : findComponent(viewDoc(), comp.parent);
  if (!container) container = findComponent(viewDoc(), 'root');
  let cNode = el.artboard.querySelector(`[data-id="${CSS.escape(container.id)}"]`);
  if (!cNode) cNode = el.artboard.firstElementChild;
  return {
    container, cNode,
    mode: container.layout ? container.layout.mode : 'vertical',
    point: designPoint(e.clientX, e.clientY),
  };
}

function flowIndexAt(container, cNode, point) {
  const horizontal = container.layout.mode === 'horizontal';
  const view = viewDoc();
  let idx = 0;
  for (const cid of container.children || []) {
    if (view.components[cid]?.placement?.mode === 'absolute') continue;
    const n = cNode.querySelector(`[data-id="${CSS.escape(cid)}"]`);
    if (!n) continue;
    const r = nodeRect(n);
    const mid = horizontal ? r.x + r.w / 2 : r.y + r.h / 2;
    if ((horizontal ? point.x : point.y) > mid) idx++;
  }
  return idx;
}

// 与 moveFlow 同语义的插入线位置
function flowIndicatorRect(container, cNode, idx) {
  const horizontal = container.layout.mode === 'horizontal';
  const view = viewDoc();
  const sibs = (container.children || []).filter((id) => view.components[id]?.placement?.mode !== 'absolute');
  const pr = parentContentRect(container, cNode);
  const before = sibs[idx - 1] ? cNode.querySelector(`[data-id="${CSS.escape(sibs[idx - 1])}"]`) : null;
  const after = sibs[idx] ? cNode.querySelector(`[data-id="${CSS.escape(sibs[idx])}"]`) : null;
  if (horizontal) {
    const x = before ? nodeRect(before).x + nodeRect(before).w
      : after ? nodeRect(after).x
      : (container.layout.align === 'end' ? pr.x + pr.w : pr.x);
    return `left:${x}px;top:${pr.y}px;height:${pr.h}px;`;
  }
  const y = before ? nodeRect(before).y + nodeRect(before).h
    : after ? nodeRect(after).y
    : (container.layout.justify === 'end' ? pr.y + pr.h : pr.y);
  return `top:${y}px;left:${pr.x}px;width:${pr.w}px;`;
}

function gridGeometry(container, cNode) {
  const cs = getComputedStyle(cNode);
  const colSizes = (cs.gridTemplateColumns || '').split(' ').map((v) => parseFloat(v)).filter((n) => !isNaN(n));
  const rowSizes = cs.gridTemplateRows && cs.gridTemplateRows !== 'none'
    ? cs.gridTemplateRows.split(' ').map((v) => parseFloat(v)).filter((n) => !isNaN(n)) : [];
  return {
    colSizes, rowSizes,
    gridRect: parentContentRect(container, cNode),
    colGap: container.layout.columnGap || 0,
    rowGap: container.layout.rowGap || 0,
  };
}

function cellFromGeometry(g, point) {
  let run = g.gridRect.x, col = g.colSizes.length;
  for (let i = 0; i < g.colSizes.length; i++) {
    if (point.x <= run + g.colSizes[i] + g.colGap / 2) { col = i + 1; break; }
    run += g.colSizes[i] + g.colGap;
  }
  if (!g.rowSizes.length) return { col: Math.max(1, col), row: 1 };
  let runY = g.gridRect.y, row = g.rowSizes.length;
  for (let i = 0; i < g.rowSizes.length; i++) {
    if (point.y <= runY + g.rowSizes[i] + g.rowGap / 2) { row = i + 1; break; }
    runY += g.rowSizes[i] + g.rowGap;
  }
  return { col: Math.max(1, col), row: Math.max(1, row) };
}

function gridCellTaken(doc, container, col, row) {
  for (const cid of container.children || []) {
    const c = doc.components[cid];
    if (!c || !c.area || c.placement?.mode === 'absolute') continue;
    const cs = c.area.colSpan || 1, rs = c.area.rowSpan || 1;
    if (row >= c.area.row && row < c.area.row + rs && col >= c.area.col && col < c.area.col + cs) return true;
  }
  return false;
}

// 拖入物在自由布局下的估计尺寸（幽灵占位用；文本等 auto 高度取近似值）
function estimateDropSize(payload, modeId) {
  if (payload.kind === 'block') {
    const blk = blocksOf(modeId).find((b) => b.label === payload.label);
    const w = blk && blk.size && blk.size.width && blk.size.width.mode === 'fixed' ? blk.size.width.value : null;
    const h = blk && blk.size && blk.size.height && blk.size.height.mode === 'fixed' ? blk.size.height.value : null;
    const def = defaultSizeFor(blk ? blk.type : 'container', 'free', modeId);
    return { w: w || def.width.value || 160, h: h || (def.height.mode === 'fixed' ? def.height.value : 48) };
  }
  const def = defaultSizeFor(payload.type, 'free', modeId);
  return { w: (def.width && def.width.value) || 160, h: def.height && def.height.mode === 'fixed' ? def.height.value : 28 };
}

function onPaletteDragOver(e) {
  if (!paletteDragActive(e) || !state.doc) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const ctx = resolveDropContext(e);
  if (!ctx.cNode) { clearPaletteHover(); return; }
  if (!paletteHover || paletteHover.containerId !== ctx.container.id) {
    clearPaletteHover();
    paletteHover = { containerId: ctx.container.id, containerNode: ctx.cNode, mode: ctx.mode };
    ctx.cNode.classList.add('ui-drop-hover');
    if (ctx.mode === 'grid') {
      paletteHover.cellBox = mk('div', 'ui-cellbox');
      el.overlay.appendChild(paletteHover.cellBox);
    } else if (ctx.mode === 'free') {
      paletteHover.ghost = mk('div', 'ui-ghost');
      el.overlay.appendChild(paletteHover.ghost);
    } else {
      paletteHover.indicator = mk('div', 'ui-insert');
      el.overlay.appendChild(paletteHover.indicator);
    }
  }
  if (ctx.mode === 'grid') {
    const g = gridGeometry(ctx.container, ctx.cNode);
    const cell = cellFromGeometry(g, ctx.point);
    paletteHover.cell = cell;
    const colW = g.colSizes[cell.col - 1] || 0;
    const rowH = g.rowSizes.length ? (g.rowSizes[cell.row - 1] || 24) : 24;
    const x = g.gridRect.x + (cell.col - 1) * (colW + g.colGap);
    const y = g.rowSizes.length ? g.gridRect.y + (cell.row - 1) * (rowH + g.rowGap) : g.gridRect.y;
    paletteHover.cellBox.style.cssText = `left:${x}px;top:${y}px;width:${colW}px;height:${rowH}px;`;
  } else if (ctx.mode === 'free') {
    const payload = window.__canvasloomDrag;
    const size = payload ? estimateDropSize(payload, viewDoc().mode || 'generic') : { w: 120, h: 40 };
    paletteHover.ghostSize = size;
    paletteHover.ghost.style.cssText = `left:${ctx.point.x - size.w / 2}px;top:${ctx.point.y - size.h / 2}px;width:${size.w}px;height:${size.h}px;`;
  } else {
    const idx = flowIndexAt(ctx.container, ctx.cNode, ctx.point);
    paletteHover.indicator.style.cssText = flowIndicatorRect(ctx.container, ctx.cNode, idx);
  }
}

function onPaletteDragLeave(e) {
  if (!paletteDragActive(e)) return;
  if (e.relatedTarget && el.scaler.contains(e.relatedTarget)) return;
  clearPaletteHover();
}

function onPaletteDrop(e) {
  if (!paletteDragActive(e) || !state.doc) return;
  e.preventDefault();
  let payload = null;
  try { payload = JSON.parse(e.dataTransfer.getData(PALETTE_MIME) || 'null'); } catch { /* 数据损坏按无 payload 处理 */ }
  if (!payload && window.__canvasloomDrag) payload = window.__canvasloomDrag;
  window.__canvasloomDrag = null;
  const ctx = resolveDropContext(e);
  clearPaletteHover();
  if (!payload || !ctx.cNode) return;
  const containerId = ctx.container.id;
  const mode = ctx.mode;
  const point = ctx.point;
  const flowIdx = (mode === 'horizontal' || mode === 'vertical') ? flowIndexAt(ctx.container, ctx.cNode, point) : null;
  const cell = mode === 'grid' ? cellFromGeometry(gridGeometry(ctx.container, ctx.cNode), point) : null;
  // 自由布局落点要换算成"相对父容器内容区"的坐标（渲染时 style.left = 内边距 + position）
  const freeDrop = state.freeMove && mode !== 'free';
  const freeContentRect = (mode === 'free' || freeDrop) ? parentContentRect(ctx.container, ctx.cNode) : null;
  const label = payload.kind === 'block' ? payload.label : (COMPONENT_TYPES[payload.type] ? COMPONENT_TYPES[payload.type].label : payload.type);

  mutate(`拖入「${label}」`, (doc) => {
    const cont = doc.components[containerId];
    if (!cont || !isContainer(cont)) return;
    let rootId;
    if (payload.kind === 'block') {
      const blk = blocksOf(doc.mode).find((b) => b.label === payload.label);
      if (!blk) return;
      rootId = instantiateBlock(doc, blk, containerId).id;
    } else {
      if (!COMPONENT_TYPES[payload.type]) return;
      rootId = newComponent(doc, payload.type, containerId, {}).id;
    }
    const created = doc.components[rootId];
    if (mode === 'free' || freeDrop) {
      const size = estimateDropSize(payload, doc.mode || 'generic');
      // 落点不截断：负坐标合法（有意出血/画布外摆放），可用「显示画布外内容」与层级树找回
      created.position = {
        left: Math.round(point.x - freeContentRect.x - size.w / 2),
        top: Math.round(point.y - freeContentRect.y - size.h / 2),
      };
      if (freeDrop) {
        created.placement = { mode: 'absolute' };
        created.size = { width: { mode: 'fixed', value: size.w }, height: { mode: 'fixed', value: size.h } };
        delete created.area;
      }
    } else if (mode === 'grid' && cell) {
      // 目标格空闲才占用，被占时保留自动分配的格子
      if (!gridCellTaken(doc, cont, cell.col, cell.row)) {
        created.area = { col: cell.col, row: cell.row, colSpan: 1, rowSpan: 1 };
      }
    } else if (mode === 'horizontal' || mode === 'vertical') {
      const arr = cont.children;
      const i = arr.indexOf(rootId);
      arr.splice(i, 1);
      arr.splice(Math.max(0, Math.min(arr.length, flowIdx == null ? arr.length : flowIdx)), 0, rootId);
    }
    state.pendingSelect = rootId;
    state.lastAdded = rootId;
    if (payload.kind === 'block') state.lastBlockId = rootId;
  });
  if (payload.kind === 'block') toast(`已插入「${label}」`);
}

let drag = null;

function startDrag(e, node) {
  const doc = viewDoc();
  const comp = findComponent(doc, node.dataset.id);
  if (!comp) return;
  const parent = comp.parent ? findComponent(doc, comp.parent) : null;
  const pmode = parent && parent.layout ? parent.layout.mode : null;
  const free = !!parent && (state.freeMove || isAbsolutePlacement(comp, parent));
  const rect = nodeRect(node);
  drag = {
    kind: 'move', node, comp, parent, pmode,
    id: comp.id, sx: e.clientX, sy: e.clientY, moved: false, free,
    origRect: rect, originalStyle: node.getAttribute('style'),
    orig: {
      position: comp.position ? { ...comp.position } : null,
      area: comp.area ? { ...comp.area } : null,
      index: parent ? (parent.children || []).indexOf(comp.id) : -1,
    },
    originalDoc: state.doc,
  };
  // 指针捕获：拖动过程中光标划出窗口/画布也不丢事件
  try { el.scaler.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针 */ }
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp, { once: true });
  window.addEventListener('pointercancel', onDragCancel, { once: true });
  window.addEventListener('keydown', onDragKeyDown);
}

// 父容器"内容区"矩形（设计坐标）：内容区 = 边框盒内缩 border + padding。
// 之前漏算了 border，导致带边框容器里 position 换算与 CSS 绝对定位
// （相对 padding 盒）差一个边框宽度；此处统一修正，拖拽/转换共用。
function parentContentRect(parentComp, parentNode) {
  const r = nodeRect(parentNode);
  const cs = getComputedStyle(parentNode);
  const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;
  const br2 = parseFloat(cs.borderRightWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
  const pad = normalizePadding(parentComp.layout && parentComp.layout.padding);
  return {
    x: r.x + bl + pad[3], y: r.y + bt + pad[0],
    w: r.w - bl - br2 - pad[3] - pad[1],
    h: r.h - bt - bb - pad[0] - pad[2],
    border: [bt, br2, bb, bl], // [上,右,下,左]
  };
}

function onDragMove(e) {
  if (!drag) return;
  const dx = (e.clientX - drag.sx) / zoom;
  const dy = (e.clientY - drag.sy) / zoom;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 3 / zoom) return;
    drag.moved = true;
    drag.node.classList.add('ui-dragging');
    if (drag.free) prepareIndependentDrag(drag);
    else if (drag.pmode === 'free') prepareFreeDrag(drag);
    else if (drag.pmode === 'grid') prepareGridDrag(drag);
    else if (drag.pmode) prepareFlowDrag(drag);
  }
  if (drag.free) moveFree(e, dx, dy);
  else if (drag.pmode === 'free') moveFree(e, dx, dy);
  else if (drag.pmode === 'grid') moveGrid(e);
  else if (drag.pmode) moveFlow(e);
}

function prepareIndependentDrag(d) {
  const pr = parentContentRect(d.parent, d.node.parentElement);
  const w = d.origRect.w, h = d.origRect.h;
  d.orig.position = { left: d.origRect.x - pr.x, top: d.origRect.y - pr.y };
  d.freeOrigin = pr;
  d.node.style.position = 'absolute';
  d.node.style.flex = 'none';
  d.node.style.gridColumn = 'auto';
  d.node.style.gridRow = 'auto';
  d.node.style.width = w + 'px';
  d.node.style.height = h + 'px';
  // CSS absolute left/top 从父容器边框内侧开始；position 数据则相对 padding 内容区。
  d.node.style.left = (d.origRect.x - (pr.x - freePadOf(d.parent)[3])) + 'px';
  d.node.style.top = (d.origRect.y - (pr.y - freePadOf(d.parent)[0])) + 'px';
  prepareFreeDrag(d);
}

// ===== 自由布局：移动位置 + 吸附参考线 =====
// 注意：渲染器中 style.left = 父内边距 + position.left（position 相对内容区），
// 因此拖拽的视觉坐标与 position 之间差一个内边距，提交时要减回去。
let snapLines = null;
function freePadOf(parentComp) {
  return parentComp && parentComp.layout ? normalizePadding(parentComp.layout.padding) : [0, 0, 0, 0];
}
function prepareFreeDrag(d) {
  snapLines = { v: [], h: [] };
  const pr = parentContentRect(d.parent, d.node.parentElement);
  snapLines.v.push(pr.x, pr.x + pr.w, pr.x + pr.w / 2);
  snapLines.h.push(pr.y, pr.y + pr.h, pr.y + pr.h / 2);
  for (const sib of d.parent.children || []) {
    if (sib === d.id) continue;
    const sNode = el.artboard.querySelector(`[data-id="${CSS.escape(sib)}"]`);
    if (!sNode) continue;
    const r = nodeRect(sNode);
    snapLines.v.push(r.x, r.x + r.w, r.x + r.w / 2);
    snapLines.h.push(r.y, r.y + r.h, r.y + r.h / 2);
  }
}
function bestSnap(points, lines, threshold) {
  let best = null;
  for (const p of points) {
    for (const l of lines) {
      const d = Math.abs(p - l);
      if (d <= threshold && (!best || d < best.d)) best = { offset: l - p, line: l, d };
    }
  }
  return best;
}
function moveFree(e, dx, dy) {
  const { orig, node } = drag;
  const pad = freePadOf(drag.parent);
  const w = nodeRect(node).w, h = nodeRect(node).h;
  const pr = parentContentRect(drag.parent, node.parentElement);
  let targetX = drag.origRect.x + dx;
  let targetY = drag.origRect.y + dy;
  // 吸附开关 + Alt 临时绕过；阈值 6px 按屏幕像素固定，随缩放换算为设计坐标
  const snapping = state.snapEnabled && !e.altKey;
  let snapV = null, snapH = null;
  if (snapping) {
    const th = 6 / zoom;
    snapV = bestSnap([targetX, targetX + w, targetX + w / 2], snapLines.v, th);
    snapH = bestSnap([targetY, targetY + h, targetY + h / 2], snapLines.h, th);
    if (snapV) targetX += snapV.offset;
    if (snapH) targetY += snapH.offset;
  }
  const left = targetX - (pr.x - pad[3]);
  const top = targetY - (pr.y - pad[0]);
  node.style.left = left + 'px';
  node.style.top = top + 'px';
  refreshOverlayRect(node);
  drawFreeGuides(snapV, snapH, drag.parent, drag.node, targetX, targetY, w, h);
}
function refreshOverlayRect(node) {
  const r = nodeRect(node);
  const box = el.overlay.querySelector('.ui-selbox');
  if (box) box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
}
function drawFreeGuides(snapV, snapH, parentComp, node, left, top, w, h) {
  const ov = el.overlay;
  ov.querySelectorAll('.ui-guide,.ui-dist').forEach((n) => n.remove());
  const pr = parentContentRect(parentComp, node.parentElement);
  if (snapV) {
    const g = mk('div', 'ui-guide ui-guide-v');
    g.style.cssText = `left:${snapV.line}px;top:${pr.y}px;height:${pr.h}px;transform:scaleX(${1 / zoom});`;
    ov.appendChild(g);
    const d = mk('div', 'ui-dist');
    d.textContent = `左 ${Math.round(left - pr.x)}`;
    d.style.cssText = `left:${left}px;top:${top - 14 / zoom}px;transform:scale(${1 / zoom});transform-origin:0 0;`;
    ov.appendChild(d);
  }
  if (snapH) {
    const g = mk('div', 'ui-guide ui-guide-h');
    g.style.cssText = `top:${snapH.line}px;left:${pr.x}px;width:${pr.w}px;transform:scaleY(${1 / zoom});`;
    ov.appendChild(g);
  }
}

// ===== 排列布局：拖动改顺序 =====
function prepareFlowDrag(d) {
  d.indicator = mk('div', 'ui-insert');
  el.overlay.appendChild(d.indicator);
}
function moveFlow(e) {
  const d = drag;
  const parentEl = d.node.parentElement;
  const p = designPoint(e.clientX, e.clientY);
  const horizontal = d.pmode === 'horizontal';
  const view = viewDoc();
  const sibs = (d.parent.children || []).filter((cid) => cid !== d.id && view.components[cid]?.placement?.mode !== 'absolute');
  let idx = 0;
  let indRect = null;
  const pr = parentContentRect(d.parent, parentEl);
  for (const cid of sibs) {
    const sNode = parentEl.querySelector(`[data-id="${CSS.escape(cid)}"]`);
    if (!sNode) continue;
    const r = nodeRect(sNode);
    const mid = horizontal ? r.x + r.w / 2 : r.y + r.h / 2;
    const cur = horizontal ? p.x : p.y;
    if (cur > mid) idx++;
  }
  // 计算插入线位置
  const before = sibs[idx - 1] ? parentEl.querySelector(`[data-id="${CSS.escape(sibs[idx - 1])}"]`) : null;
  const after = sibs[idx] ? parentEl.querySelector(`[data-id="${CSS.escape(sibs[idx])}"]`) : null;
  if (horizontal) {
    const x = before ? nodeRect(before).x + nodeRect(before).w
      : after ? nodeRect(after).x
      : (d.parent.layout.align === 'end' ? pr.x + pr.w : pr.x);
    indRect = `left:${x}px;top:${pr.y}px;height:${pr.h}px;`;
  } else {
    const y = before ? nodeRect(before).y + nodeRect(before).h
      : after ? nodeRect(after).y
      : (d.parent.layout.justify === 'end' ? pr.y + pr.h : pr.y);
    indRect = `top:${y}px;left:${pr.x}px;width:${pr.w}px;`;
  }
  d.indicator.style.cssText = indRect;
  const nextFlowId = sibs[idx];
  d.targetIndex = nextFlowId ? d.parent.children.indexOf(nextFlowId)
    : (sibs.length ? d.parent.children.indexOf(sibs[sibs.length - 1]) + 1 : d.parent.children.length);
}
function parentContentRectOf(d) { return parentContentRect(d.parent, d.node.parentElement); }

// ===== 网格：拖动改占格 =====
function prepareGridDrag(d) {
  d.cellBox = mk('div', 'ui-cellbox');
  el.overlay.appendChild(d.cellBox);
  const gridEl = d.node.parentElement;
  const cs = getComputedStyle(gridEl);
  d.colSizes = cs.gridTemplateColumns.split(' ').map((v) => parseFloat(v)).filter((n) => !isNaN(n));
  d.rowSizes = cs.gridTemplateRows && cs.gridTemplateRows !== 'none'
    ? cs.gridTemplateRows.split(' ').map((v) => parseFloat(v)).filter((n) => !isNaN(n)) : [];
  d.gridRect = parentContentRect(d.parent, gridEl);
}
function gridCellAt(d, p) {
  const { gridRect, colSizes, rowSizes } = d;
  const colGap = (d.parent.layout.columnGap || 0), rowGap = (d.parent.layout.rowGap || 0);
  let run = gridRect.x, col = 0;
  for (let i = 0; i < colSizes.length; i++) {
    if (p.x <= run + colSizes[i] + colGap / 2) { col = i + 1; break; }
    run += colSizes[i] + colGap;
    col = Math.min(i + 2, colSizes.length);
  }
  if (!rowSizes.length) return { col, row: 1 };
  let runY = gridRect.y, row = 0;
  for (let i = 0; i < rowSizes.length; i++) {
    if (p.y <= runY + rowSizes[i] + rowGap / 2) { row = i + 1; break; }
    runY += rowSizes[i] + rowGap;
    row = Math.min(i + 2, rowSizes.length);
  }
  return { col, row };
}
function moveGrid(e) {
  const d = drag;
  const p = designPoint(e.clientX, e.clientY);
  const cell = gridCellAt(d, p);
  d.targetCell = cell;
  const colGap = (d.parent.layout.columnGap || 0), rowGap = (d.parent.layout.rowGap || 0);
  const x = d.gridRect.x + (cell.col - 1) * (d.colSizes[cell.col - 1] + colGap);
  const y = d.rowSizes.length ? d.gridRect.y + (cell.row - 1) * (d.rowSizes[cell.row - 1] + rowGap) : d.gridRect.y;
  d.cellBox.style.cssText = `left:${x}px;top:${y}px;width:${d.colSizes[cell.col - 1]}px;height:${d.rowSizes.length ? d.rowSizes[cell.row - 1] : 24}px;`;
}

function onDragUp(e) {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointercancel', onDragCancel);
  window.removeEventListener('keydown', onDragKeyDown);
  const d = drag;
  drag = null;
  if (!d) return;
  if (!d.moved) { cleanupDragDom(d); return; }
  const name = d.comp.name || d.id;
  if (d.free && d.pmode !== 'free') {
    const pad = freePadOf(d.parent);
    const left = Math.round((parseFloat(d.node.style.left) || 0) - pad[3]);
    const top = Math.round((parseFloat(d.node.style.top) || 0) - pad[0]);
    const width = Math.max(1, Math.round(d.origRect.w));
    const height = Math.max(1, Math.round(d.origRect.h));
    if (!d.comp.placement || d.comp.placement.mode !== 'absolute' || left !== d.orig.position.left || top !== d.orig.position.top) {
      mutate(`移动 ${name}`, (doc) => {
        const c = doc.components[d.id];
        c.placement = { mode: 'absolute' };
        c.position = { left, top };
        delete c.area;
        if (!d.comp.placement || d.comp.placement.mode !== 'absolute') {
          for (const axis of ['width', 'height']) c.size[axis] = { mode: 'fixed', value: axis === 'width' ? width : height };
        }
      });
    } else {
      if (d.originalStyle == null) d.node.removeAttribute('style');
      else d.node.setAttribute('style', d.originalStyle);
      refreshOverlay();
    }
  } else if (d.pmode === 'free') {
    const orig = d.orig.position;
    const pad = freePadOf(d.parent);
    const left = Math.round(parseFloat(d.node.style.left) || 0) - pad[3];
    const top = Math.round(parseFloat(d.node.style.top) || 0) - pad[0];
    if (left !== orig.left || top !== orig.top) {
      mutate(`移动 ${name}`, (doc) => {
        doc.components[d.id].position = { left, top };
      });
    }
  } else if (d.pmode === 'grid') {
    const cell = d.targetCell;
    const orig = d.orig.area;
    if (cell && orig && (cell.col !== orig.col || cell.row !== orig.row)) {
      mutate(`移动 ${name} 到网格第 ${cell.row} 行第 ${cell.col} 列`, (doc) => {
        const a = doc.components[d.id].area;
        a.col = cell.col; a.row = cell.row;
      });
    }
  } else if (d.pmode) {
    const idx = d.targetIndex;
    if (idx != null && idx !== d.orig.index) {
      mutate(`调整 ${name} 的排列顺序`, (doc) => {
        const parent = doc.components[d.comp.parent];
        parent.children = parent.children.filter((x) => x !== d.id);
        parent.children.splice(Math.max(0, idx - (d.orig.index < idx ? 1 : 0)), 0, d.id);
      });
    }
  }
  if (state.doc === d.originalDoc) {
    if (d.originalStyle == null) d.node.removeAttribute('style');
    else d.node.setAttribute('style', d.originalStyle);
  }
  cleanupDragDom(d);
  refreshOverlay();
}
function onDragCancel() {
  if (!drag) return;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragCancel);
  window.removeEventListener('keydown', onDragKeyDown);
  const d = drag; drag = null;
  if (d.originalStyle == null) d.node.removeAttribute('style');
  else d.node.setAttribute('style', d.originalStyle);
  cleanupDragDom(d);
  refreshOverlay();
}
function onDragKeyDown(e) { if (e.key === 'Escape' && drag) { e.preventDefault(); onDragCancel(); } }
function cleanupDragDom(d) {
  if (d.node) d.node.classList.remove('ui-dragging');
  if (d.indicator) d.indicator.remove();
  if (d.cellBox) d.cellBox.remove();
  el.overlay.querySelectorAll('.ui-guide,.ui-dist').forEach((n) => n.remove());
}

// ---------- 缩放手柄 ----------
let resizing = null;
function startResize(e, dir) {
  const id = state.selection;
  const comp = findComponent(viewDoc(), id);
  if (!comp) return;
  const node = el.artboard.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const parent = comp.parent ? findComponent(viewDoc(), comp.parent) : null;
  resizing = {
    dir, id, comp, node, parent,
    pmode: parent && parent.layout ? parent.layout.mode : null,
    absolute: isAbsolutePlacement(comp, parent) || (!!state.freeMove && !!parent),
    pad: parent && parent.layout ? normalizePadding(parent.layout.padding) : [0, 0, 0, 0],
    sx: e.clientX, sy: e.clientY,
    origRect: nodeRect(node),
    origSize: JSON.parse(JSON.stringify(comp.size)),
    originalDoc: state.doc,
    origArea: comp.area ? { ...comp.area } : null,
    origPos: comp.position ? { ...comp.position } : null,
    originalStyle: node.getAttribute('style'),
    colSizes: null, rowSizes: null,
  };
  if (!resizing.origPos && resizing.absolute && parent) {
    const pr = parentContentRect(parent, node.parentElement);
    resizing.origPos = { left: resizing.origRect.x - pr.x, top: resizing.origRect.y - pr.y };
  }
  if (resizing.pmode === 'grid' && !resizing.absolute) {
    const gridEl = node.parentElement;
    const cs = getComputedStyle(gridEl);
    resizing.colSizes = cs.gridTemplateColumns.split(' ').map((v) => parseFloat(v)).filter((n) => !isNaN(n));
    resizing.rowSizes = cs.gridTemplateRows && cs.gridTemplateRows !== 'none'
      ? cs.gridTemplateRows.split(' ').map((v) => parseFloat(v)).filter((n) => !isNaN(n)) : [];
    resizing.gridRect = parentContentRect(parent, gridEl);
  }
  try { el.scaler.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针 */ }
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', onResizeUp, { once: true });
  window.addEventListener('pointercancel', onResizeCancel, { once: true });
  window.addEventListener('keydown', onResizeKeyDown);
  e.stopPropagation();
}

function onResizeMove(e) {
  const r = resizing;
  if (!r) return;
  const dx = (e.clientX - r.sx) / zoom;
  const dy = (e.clientY - r.sy) / zoom;
  const dir = r.dir;
  if (r.absolute && r.parent && !(r.comp.placement && r.comp.placement.mode === 'absolute') && r.pmode !== 'free') {
    const pad = r.pad;
    r.node.style.position = 'absolute';
    r.node.style.flex = 'none'; r.node.style.gridColumn = 'auto'; r.node.style.gridRow = 'auto';
    r.node.style.left = (pad[3] + r.origPos.left) + 'px';
    r.node.style.top = (pad[0] + r.origPos.top) + 'px';
    r.node.style.width = r.origRect.w + 'px'; r.node.style.height = r.origRect.h + 'px';
  }
  if (r.pmode === 'grid' && !r.absolute) {
    // 调整跨格数
    const colGap = r.parent.layout.columnGap || 0, rowGap = r.parent.layout.rowGap || 0;
    const area = r.comp.area || { col: 1, row: 1, colSpan: 1, rowSpan: 1 };
    let colSpan = area.colSpan || 1, rowSpan = area.rowSpan || 1;
    if (dir.includes('e') && r.colSizes.length) {
      const startX = r.gridRect.x + (area.col - 1) * (r.colSizes[Math.min(area.col - 1, r.colSizes.length - 1)] + colGap);
      let run = startX, span = 0;
      for (let i = area.col - 1; i < r.colSizes.length; i++) {
        run += r.colSizes[i] + (i > area.col - 1 ? colGap : 0);
        span++;
        if (r.origRect.x + r.origRect.w + dx <= run + colGap / 2) break;
      }
      colSpan = Math.max(area.colSpan || 1, Math.min(span, r.colSizes.length - area.col + 1));
    }
    if (dir.includes('s') && r.rowSizes.length) {
      const startY = r.gridRect.y + (area.row - 1) * (r.rowSizes[Math.min(area.row - 1, r.rowSizes.length - 1)] + rowGap);
      let run = startY, span = 0;
      for (let i = area.row - 1; i < r.rowSizes.length; i++) {
        run += r.rowSizes[i] + (i > area.row - 1 ? rowGap : 0);
        span++;
        if (r.origRect.y + r.origRect.h + dy <= run + rowGap / 2) break;
      }
      rowSpan = Math.max(area.rowSpan || 1, Math.min(span, r.rowSizes.length - area.row + 1));
    }
    r.node.style.gridColumn = `${area.col} / span ${colSpan}`;
    r.node.style.gridRow = `${area.row} / span ${rowSpan}`;
    r.newArea = { ...area, colSpan, rowSpan };
  } else {
    // 自由/排列：改尺寸（自由布局 w/n 同时移动位置）。
    // 排列布局中"填满剩余"是 flex-grow 表达的，只写 width/height 不生效，拖拽期间先固定伸缩。
    const minSize = 8;
    if ((r.pmode === 'horizontal' || r.pmode === 'vertical') && !r.absolute) r.node.style.flex = '0 0 auto';
    if (dir.includes('e') || (dir.includes('w') && r.absolute)) {
      let w = r.origRect.w + (dir.includes('e') ? dx : -dx);
      w = Math.max(minSize, w);
      r.node.style.width = w + 'px';
      if (dir.includes('w') && r.absolute) r.node.style.left = (r.pad[3] + r.origPos.left + (r.origRect.w - w)) + 'px';
      r.newW = Math.round(w);
    }
    if (dir.includes('s') || (dir.includes('n') && r.absolute)) {
      let h = r.origRect.h + (dir.includes('s') ? dy : -dy);
      h = Math.max(minSize, h);
      r.node.style.height = h + 'px';
      if (dir.includes('n') && r.absolute) r.node.style.top = (r.pad[0] + r.origPos.top + (r.origRect.h - h)) + 'px';
      r.newH = Math.round(h);
    }
  }
  refreshOverlayRect(r.node);
}

function onResizeUp() {
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointercancel', onResizeCancel);
  window.removeEventListener('keydown', onResizeKeyDown);
  const r = resizing;
  resizing = null;
  if (!r) return;
  const name = r.comp.name || r.id;
  if (r.pmode === 'grid' && !r.absolute && r.newArea) {
    const a = r.origArea;
    if (r.newArea.colSpan !== a.colSpan || r.newArea.rowSpan !== a.rowSpan) {
      mutate(`调整 ${name} 的跨格`, (doc) => {
        doc.components[r.id].area = r.newArea;
      });
    }
  } else {
    const sizePatch = {};
    if (r.newW != null) sizePatch.width = commitAxisSize(r, 'width');
    if (r.newH != null) sizePatch.height = commitAxisSize(r, 'height');
    const posPatch = {};
    if (r.dir.includes('w') && r.absolute) posPatch.left = Math.round(parseFloat(r.node.style.left)) - r.pad[3];
    if (r.dir.includes('n') && r.absolute) posPatch.top = Math.round(parseFloat(r.node.style.top)) - r.pad[0];
    if (Object.keys(sizePatch).length || Object.keys(posPatch).length) {
      // 「填满剩余/自动」被手柄拖成固定值：显式提示模式变化（Ctrl+Z 可撤销回原语义）
      const converted = ['width', 'height'].filter((axis) => {
        const om = r.origSize && r.origSize[axis] && r.origSize[axis].mode;
        return sizePatch[axis] && (om === 'fill' || om === 'auto');
      });
      mutate(`调整 ${name} 的尺寸`, (doc) => {
        const c = doc.components[r.id];
        const converting = r.absolute && !(r.comp.placement && r.comp.placement.mode === 'absolute') && r.pmode !== 'free';
        if (converting) {
          c.placement = { mode: 'absolute' };
          c.position = { left: posPatch.left ?? r.origPos.left, top: posPatch.top ?? r.origPos.top };
          delete c.area;
          for (const axis of ['width', 'height']) if (!sizePatch[axis]) sizePatch[axis] = { mode: 'fixed', value: Math.round(axis === 'width' ? r.origRect.w : r.origRect.h) };
        }
        Object.assign(c.size, sizePatch);
        if (Object.keys(posPatch).length) Object.assign(c.position, posPatch);
      });
      if (converted.length) {
        toast(`已把「${converted.map((a) => (a === 'width' ? '宽' : '高')).join('、')}」从${converted.every((a) => (r.origSize[a].mode === 'fill') ? '填满剩余' : '自动')}转为固定值；Ctrl+Z 可撤销`, 'info');
      }
    }
  }
  if (state.doc === r.originalDoc) {
    if (r.originalStyle == null) r.node.removeAttribute('style');
    else r.node.setAttribute('style', r.originalStyle);
  }
  refreshOverlay();
}
function onResizeCancel() {
  if (!resizing) return;
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', onResizeUp);
  window.removeEventListener('pointercancel', onResizeCancel);
  window.removeEventListener('keydown', onResizeKeyDown);
  const r = resizing; resizing = null;
  if (r.originalStyle == null) r.node.removeAttribute('style'); else r.node.setAttribute('style', r.originalStyle);
  refreshOverlay();
}
function onResizeKeyDown(e) { if (e.key === 'Escape' && resizing) { e.preventDefault(); onResizeCancel(); } }

// 拖拽缩放后的尺寸落库：fill/auto → 固定值（界面明确提示，可撤销）；percent 在排列布局里按父内容区重算
// 百分比（保持伸展语义，上限 LIMITS.percentMax），其余情况转固定
function commitAxisSize(r, axis) {
  const px = axis === 'width' ? r.newW : r.newH;
  const origMode = r.origSize && r.origSize[axis] ? r.origSize[axis].mode : null;
  if (!r.absolute && origMode === 'percent' && r.parent && (r.pmode === 'horizontal' || r.pmode === 'vertical')) {
    const base = percentBaseOf(r.parent, r.node.parentElement, axis);
    if (base > 0) {
      return { mode: 'percent', value: Math.max(0, Math.min(LIMITS.percentMax, Math.round((px / base) * 1000) / 10)) };
    }
  }
  return { mode: 'fixed', value: px };
}

// CSS 百分比尺寸相对父容器"内容盒"解析；nodeRect 是边框盒，重算基准要再减去父容器自身边框
function percentBaseOf(parentComp, parentNode, axis) {
  const rect = nodeRect(parentNode);
  const cs = getComputedStyle(parentNode);
  const pad = normalizePadding(parentComp && parentComp.layout ? parentComp.layout.padding : undefined);
  if (axis === 'width') {
    return rect.w - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0) - pad[3] - pad[1];
  }
  return rect.h - (parseFloat(cs.borderTopWidth) || 0) - (parseFloat(cs.borderBottomWidth) || 0) - pad[0] - pad[2];
}

// ---------- 外部工具：缩放适应 ----------
export function fitZoom() {
  const view = viewDoc();
  if (!view) return;
  const w = el.wrap.clientWidth - 48, h = el.wrap.clientHeight - 48;
  const z = Math.min(w / view.canvas.width, h / view.canvas.height, 1);
  setZoom(Math.max(LIMITS.zoomMin, z));
}

// 供键盘微调用
export function nudge(dx, dy, big) {
  const comp = findComponent(viewDoc(), state.selection);
  if (!comp) return;
  const parent = comp.parent ? findComponent(viewDoc(), comp.parent) : null;
  const pmode = parent && parent.layout ? parent.layout.mode : null;
  const step = big ? 10 : 1;
  const name = comp.name || comp.id;
  if (pmode === 'free') {
    mutate(`微调 ${name} 位置`, (doc) => {
      doc.components[comp.id].position.left += dx * step;
      doc.components[comp.id].position.top += dy * step;
    }, { coalesceKey: 'nudge' + comp.id });
  } else if ((state.freeMove || comp.placement?.mode === 'absolute') && parent && pmode) {
    const node = document.querySelector(`#artboard [data-id="${CSS.escape(comp.id)}"]`);
    const rect = node && nodeRect(node);
    const pr = node && parentContentRect(parent, node.parentElement);
    if (!rect || !pr) return;
    mutate(`微调 ${name} 位置`, (doc) => {
      const c = doc.components[comp.id];
      c.placement = { mode: 'absolute' };
      c.position = { left: Math.round(rect.x - pr.x + dx * step), top: Math.round(rect.y - pr.y + dy * step) };
      delete c.area;
      if (!comp.placement || comp.placement.mode !== 'absolute') for (const axis of ['width', 'height']) c.size[axis] = { mode: 'fixed', value: Math.round(axis === 'width' ? rect.w : rect.h) };
    }, { coalesceKey: 'nudge' + comp.id });
  } else if (pmode === 'grid') {
    if (!dx && !dy) return;
    mutate(`微调 ${name} 占格`, (doc) => {
      const a = doc.components[comp.id].area;
      const tracks = doc.components[comp.parent].layout.tracks;
      a.col = Math.max(1, Math.min((tracks.columns || []).length, a.col + dx));
      a.row = Math.max(1, Math.min((tracks.rows || []).length, a.row + dy));
    }, { coalesceKey: 'nudge' + comp.id });
  } else if (pmode) {
    if (!dx) return;
    mutate(`微调 ${name} 顺序`, (doc) => {
      const parent2 = doc.components[comp.parent];
      const i = parent2.children.indexOf(comp.id);
      const j = Math.max(0, Math.min(parent2.children.length - 1, i + dx));
      if (i !== j) { parent2.children.splice(i, 1); parent2.children.splice(j, 0, comp.id); }
    }, { coalesceKey: 'nudge' + comp.id });
  }
}
