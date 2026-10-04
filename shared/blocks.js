// ============================================================
// 预设块实例化 —— 把 shared/modes.js 的声明式块 spec 物化为普通组件
// 浏览器与 Node 通用：只用 protocol.js 工厂，不触碰 DOM。
// ============================================================
import { newComponent, isContainer } from './protocol.js';
import { UI_MODES, DEFAULT_MODE } from './modes.js';

const COPY_FIELDS = ['text', 'placeholder', 'value', 'orientation', 'thickness', 'fit', 'resourceId'];

// 将块 spec 插入 parent 容器，返回块根组件（id 自动去重，样式走当前文档的模式默认值）
export function instantiateBlock(doc, spec, parentId) {
  const comp = newComponent(doc, spec.type, parentId, {
    id: spec.idBase,
    name: spec.name,
    purpose: spec.purpose,
    text: spec.text,
    layoutMode: spec.layout ? spec.layout.mode : undefined,
  });
  for (const k of COPY_FIELDS) {
    if (spec[k] !== undefined) comp[k] = spec[k];
  }
  if (spec.size) {
    for (const axis of ['width', 'height']) {
      const over = spec.size[axis];
      if (over) comp.size[axis] = Object.assign({}, comp.size[axis], over);
    }
  }
  if (spec.style) comp.style = Object.assign({}, comp.style, spec.style);
  if (isContainer(comp)) {
    if (spec.layout) {
      const merged = Object.assign({}, comp.layout, spec.layout);
      comp.layout = merged;
    }
    for (const child of spec.children || []) instantiateBlock(doc, child, comp.id);
  }
  return comp;
}

// 某模式下的预设块清单
export function blocksOf(modeId) {
  const m = UI_MODES[modeId || DEFAULT_MODE] || UI_MODES.generic;
  return m.blocks || [];
}
