// ============================================================
// 多选对齐与等距分布（S2b）：纯几何计算，入参为设计坐标矩形。
// 仅编辑器内使用；不接触文档结构，应用端负责把视觉坐标换算回
// 父容器内容区坐标并写入 position。
// 作用范围（首版）：同一父容器、独立摆放（自由布局或 placement absolute）。
// ============================================================

export const ALIGN_MODES = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'];

export const ALIGN_LABELS = {
  left: '左对齐', hcenter: '水平居中', right: '右对齐',
  top: '顶对齐', vcenter: '垂直居中', bottom: '底对齐',
};

// 对齐：以所选集合的外接矩形为基准。rects: [{ id, x, y, w, h }]
// 返回 [{ id, x, y }]（仅目标位置变化轴有意义的取值）。
export function planAlign(rects, mode) {
  if (!Array.isArray(rects) || rects.length < 2 || !ALIGN_MODES.includes(mode)) return [];
  const left = Math.min(...rects.map((r) => r.x));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return rects.map((r) => {
    let { x, y } = r;
    if (mode === 'left') x = left;
    else if (mode === 'right') x = right - r.w;
    else if (mode === 'hcenter') x = Math.round((left + right) / 2 - r.w / 2);
    else if (mode === 'top') y = top;
    else if (mode === 'bottom') y = bottom - r.h;
    else if (mode === 'vcenter') y = Math.round((top + bottom) / 2 - r.h / 2);
    return { id: r.id, x, y };
  });
}

// 等距分布：首末两项保持不动，其余按相邻边缘间距相等排布。
// 仅在该轴上调整位置；另一轴保持原值。
export function planDistribute(rects, axis) {
  if (!Array.isArray(rects) || rects.length < 3) return [];
  const horizontal = axis !== 'v';
  const key = horizontal ? 'x' : 'y';
  const sizeKey = horizontal ? 'w' : 'h';
  const sorted = [...rects].sort((a, b) => a[key] - b[key]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last[key] + last[sizeKey] - first[key];
  const totalSize = sorted.reduce((s, r) => s + r[sizeKey], 0);
  const gap = (span - totalSize) / (sorted.length - 1);
  const out = [];
  let cursor = first[key];
  for (const r of sorted) {
    const pos = Math.round(cursor);
    out.push(horizontal ? { id: r.id, x: pos, y: r.y } : { id: r.id, x: r.x, y: pos });
    cursor += r[sizeKey] + gap;
  }
  return out;
}

// 多选是否同一父容器（返回父 id 或 null）
export function sharedParent(ids, parentOf) {
  if (!Array.isArray(ids) || ids.length < 2) return null;
  const p = parentOf(ids[0]);
  for (const id of ids.slice(1)) if (parentOf(id) !== p) return null;
  return p;
}
