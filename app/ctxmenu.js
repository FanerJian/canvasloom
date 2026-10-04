// ============================================================
// 画布右键菜单：常用操作就地可达（编辑文字/复制/副本/层级/删除）
// ============================================================
import { state, select } from './store.js';
import { findComponent, isContainer } from '../shared/protocol.js';
import { copySelection, pasteClipboard, deleteComponent, duplicateComponent, reorder } from './panels.js';
import { beginTextEditMode } from './canvas.js';

let ctxEl = null;

export function closeContextMenu() { close(); }

function close() {
  if (!ctxEl) return;
  ctxEl.remove();
  ctxEl = null;
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('blur', close);
}

function onDocPointerDown(e) {
  if (ctxEl && !ctxEl.contains(e.target)) close();
}

function item(menu, label, fn, cls = '') {
  const b = document.createElement('button');
  b.className = 'ctx-item ' + cls;
  b.textContent = label;
  b.addEventListener('click', () => { close(); if (fn) fn(); });
  menu.appendChild(b);
}
function sep(menu) {
  const d = document.createElement('div');
  d.className = 'ctx-sep';
  menu.appendChild(d);
}

export function openContextMenu(e, compId) {
  close();
  const comp = compId ? findComponent(state.doc, compId) : null;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  if (comp && comp.id !== 'root') {
    const editable = comp.type === 'text' || comp.type === 'button';
    if (editable) item(menu, '✏️ 编辑文字', () => beginTextEditMode(comp.id));
    item(menu, '⧉ 复制', () => copySelection());
    item(menu, '❐ 创建副本', () => duplicateComponent(comp.id));
    if (state.clipboard && isContainer(comp)) {
      item(menu, '⇩ 粘贴到此容器内', () => pasteInto(comp.id));
    }
    sep(menu);
    const parent = comp.parent ? findComponent(state.doc, comp.parent) : null;
    const idx = parent ? (parent.children || []).indexOf(comp.id) : -1;
    const count = parent ? (parent.children || []).length : 0;
    item(menu, '↑ 上移一层', idx > 0 ? () => reorder(comp.id, idx - 1) : null);
    item(menu, '↓ 下移一层', idx >= 0 && idx < count - 1 ? () => reorder(comp.id, idx + 1) : null);
    sep(menu);
    item(menu, '🗑 删除（Ctrl+Z 可撤销）', () => deleteComponent(comp.id), 'danger');
  } else {
    if (state.clipboard) item(menu, '⇩ 粘贴到页面', () => pasteClipboard());
    item(menu, '✕ 取消选择', () => select(null));
  }
  if (!menu.children.length) return;

  const root = document.getElementById('ctx-root') || document.body;
  root.appendChild(menu);
  ctxEl = menu;
  const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 100;
  menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('blur', close);
  }, 0);
}

// 粘贴到指定容器
function pasteInto(containerId) {
  pasteClipboard(containerId);
}
