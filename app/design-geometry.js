// ============================================================
// 画布几何查询（面板与画布共用）：设计坐标系中的矩形与父内容区原点
// 设计坐标 = 画布左上角为原点、按当前缩放换算回 1px = 1 设计单位的坐标系。
// 仅供编辑器内使用；页面不在画布上渲染时返回 null，调用方需回退默认转换。
// ============================================================
import { state } from './store.js';
import { normalizePadding } from '../shared/protocol.js';

function artboardEl() { return document.getElementById('artboard'); }

// 组件视觉矩形（边框盒，设计坐标）
export function designRectById(id) {
  const ab = artboardEl();
  if (!ab || !state.doc) return null;
  const node = ab.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!node) return null;
  const br = ab.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const z = state.zoom || 1;
  return { x: (r.left - br.left) / z, y: (r.top - br.top) / z, w: r.width / z, h: r.height / z };
}

// 父容器「内容区」原点（设计坐标）：边框盒内缩 border + padding。
// 与 CSS 绝对定位（相对 padding 盒）+ 渲染器 style.left = padding + position 的约定一致；
// 旧实现漏算 border，带边框容器的位置换算会偏差一个边框宽度。
export function parentContentOriginById(parentId) {
  const comp = state.doc ? state.doc.components[parentId] : null;
  const rect = designRectById(parentId);
  const ab = artboardEl();
  if (!comp || !rect || !ab) return null;
  const node = ab.querySelector(`[data-id="${CSS.escape(parentId)}"]`);
  if (!node) return null;
  const cs = getComputedStyle(node);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const pad = normalizePadding(comp.layout && comp.layout.padding);
  return { x: rect.x + bl + pad[3], y: rect.y + bt + pad[0] };
}

// 保持视觉位置的换算：转自由布局/换父容器时，position = 视觉左上角 - 目标父内容区原点
export function positionPreservingVisual(id, targetParentId) {
  const rect = designRectById(id);
  const origin = parentContentOriginById(targetParentId);
  if (!rect || !origin) return null;
  return { left: Math.round(rect.x - origin.x), top: Math.round(rect.y - origin.y) };
}
