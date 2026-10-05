// ============================================================
// 编辑器状态中心：文档、历史（撤销/重做）、选择、缩放、模式
// ============================================================
import { findComponent, isContainer, ancestorsOf, LIMITS } from '../shared/protocol.js';
import { resolveVariant } from '../shared/resolve.js';

// 缩放/吸附等视图偏好的持久化键（画布行为偏好不进设计文档）
const PREF_SNAP = 'canvasloom:snap';
const PREF_FREE_MOVE = 'canvasloom:freeMove';
const PREF_SHOW_OUTSIDE = 'canvasloom:showOutside';
function prefOn(key, def = true) {
  try { const v = localStorage.getItem(key); return v == null ? def : v === '1'; } catch { return def; }
}

export const state = {
  doc: null,          // 当前 UIDoc 文档（v3 时永远保存原文档：四段一概不动地进磁盘）
  view: null,         // 设计视图：v2 即 doc 本体；v3 = 按 activeVariant 解析出的 v2 形状文档
  viewError: null,    // v3 解析失败的结构化错误（画布显示错误卡，绝不回退默认变体）
  name: null,         // 项目名
  revision: 0,        // 与磁盘一致的修订号
  dirty: false,       // 有未保存修改
  selection: null,    // 选中组件 id
  zoom: 1,
  snapEnabled: prefOn(PREF_SNAP, true),               // 吸附参考线（按住 Alt 临时绕过）
  freeMove: prefOn(PREF_FREE_MOVE, true),             // 组件自由移动（视图偏好，不进入 UIDoc）
  showOutsideCanvas: prefOn(PREF_SHOW_OUTSIDE, true), // 设计视图显示画布外内容（不影响预览/导出的最终裁剪）
  mode: 'design',     // design | preview
  previewViewport: null, // null = 跟随设计画布；否则 [w,h]
  clipboard: null,    // 复制的完整子树快照 { tree, resources, copiedAt }
  lastAdded: null,    // 刚添加的组件 id（画布重建后播放一次高亮）
  lastBlockId: null,  // 刚插入的预设块根 id（连续插入时平级追加，不嵌套）
  lastExternal: null, // 外部修改提示（未被采纳时）
  collapsedTreeIds: new Set(), // 层级树手动折叠的容器 id（纯视图状态，不进文档）
};

// 预设块面板的场景过滤：null = 跟随文档模式；否则固定浏览某个模式的块
state.paletteModeId = null;

// ---------- v3 解析视图与编辑域（M5） ----------
// 设计视图：v2 文档即 doc 本体；v3 文档按 activeVariant 解析成 v2 形状文档——
// 画布/层级树/属性面板/测量/截图统一读 view。解析失败不回退默认变体：
// viewError 记录结构化错误，画布显示错误卡（与导出页行为一致）。
export function computeView() {
  const doc = state.doc;
  if (!doc || doc.version !== 3) { state.view = doc; state.viewError = null; return; }
  try {
    state.view = resolveVariant(doc, doc.activeVariant);
    state.viewError = null;
  } catch (e) {
    state.view = null;
    state.viewError = { code: e.code || 'E_RESOLVE', message: e.message || String(e) };
  }
}

// 画布等读路径的入口：恒返回「当前应显示/测量」的 v2 形状文档（v3 解析失败时为 null）
export function viewDoc() { return state.view; }

// 编辑域：mutate 回调拿到的 doc。v2 即文档本体；v3 是浅拷贝、components 指向
// activeVariant 指向的 presentation 组件树（冻结决策 11 的编辑器版语义）——
// 既有全部编辑代码（doc.components[...]）零改动落进原树，保存时原文档整体写盘。
export function scopeOf(doc) {
  if (!doc || doc.version !== 3) return doc;
  const variants = Array.isArray(doc.variants) ? doc.variants : [];
  const v = variants.find((x) => x && x.id === doc.activeVariant);
  const presId = v ? v.presentation : null;
  const pres = presId && doc.presentations ? doc.presentations[presId] : null;
  const comps = pres && pres.components ? pres.components : {};
  return Object.assign({}, doc, { components: comps, __presentationId: presId || null });
}

export function setSnapEnabled(v) {
  state.snapEnabled = !!v;
  try { localStorage.setItem(PREF_SNAP, v ? '1' : '0'); } catch { /* 无存储时仅会话内生效 */ }
  emit({ reason: 'view-pref' });
}

export function setFreeMove(v) {
  state.freeMove = !!v;
  try { localStorage.setItem(PREF_FREE_MOVE, v ? '1' : '0'); } catch { /* 无存储时仅会话内生效 */ }
  emit({ reason: 'view-pref' });
}

export function setShowOutsideCanvas(v) {
  state.showOutsideCanvas = !!v;
  try { localStorage.setItem(PREF_SHOW_OUTSIDE, v ? '1' : '0'); } catch { /* 无存储时仅会话内生效 */ }
  emit({ reason: 'view-pref' });
}

export const history = { undo: [], redo: [] };
const MAX_HISTORY = 100;

// 组件库/预设块拖入画布的自定义 MIME（dragover 期间只读 types，drop 时才能读数据）
export const PALETTE_MIME = 'application/x-canvasloom';

const listeners = new Set();
export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(detail = {}) { for (const fn of listeners) fn(detail); }

let coalesce = { key: null, time: 0 };

// ---------- 文档载入 ----------
export function loadProject(name, doc) {
  state.doc = doc;
  state.name = name;
  state.revision = doc.revision;
  state.dirty = false;
  state.selection = null;
  state.mode = 'design';
  state.lastBlockId = null;
  state.lastExternal = null;
  state.collapsedTreeIds.clear(); // 新文档从全展开开始
  history.undo = [];
  history.redo = [];
  coalesce = { key: null, time: 0 };
  computeView();
  emit({ reason: 'load' });
}

// 外部（agent/CLI）修改到达：保留撤销路径，可 Ctrl+Z 回到主人修改前的状态
export function adoptExternal(doc) {
  history.undo.push({ doc: state.doc, label: '外部修改前' });
  if (history.undo.length > MAX_HISTORY) history.undo.shift();
  history.redo = [];
  state.doc = doc;
  state.revision = doc.revision;
  state.dirty = false;
  computeView();
  if (state.selection && !findComponent(scopeOf(doc), state.selection)) state.selection = null;
  coalesce = { key: null, time: 0 };
  emit({ reason: 'external' });
}

// ---------- 变更（可撤销） ----------
// mutate：组件编辑入口，回调拿「编辑域 scope」（v3 = 浅拷贝 + components 指向活动
// presentation 树；嵌套字段的修改与新增键都会落进克隆文档）。
// mutateDoc：v3 四段编辑入口（向导/功能风格面板），回调拿克隆的原文档本体——
// 顶层字段赋值（如 activeVariant）只有在本体上才持久化。
function applyMutation(label, fn, opts, scopeEdit) {
  const prev = state.doc;
  const next = structuredClone(prev);
  if (next.version === 3 && next.resources == null) next.resources = {}; // 粘贴等路径会对 resources 赋值，先保证可别名写回
  fn(scopeEdit ? scopeOf(next) : next);
  const now = Date.now();
  const canCoalesce = opts.coalesceKey && coalesce.key === opts.coalesceKey && (now - coalesce.time) < 900 && history.undo.length;
  if (!canCoalesce) {
    history.undo.push({ doc: prev, label });
    if (history.undo.length > MAX_HISTORY) history.undo.shift();
  }
  coalesce = opts.coalesceKey ? { key: opts.coalesceKey, time: now } : { key: null, time: 0 };
  history.redo = [];
  state.doc = next;
  computeView();
  state.dirty = true;
  if (state.selection && !findComponent(scopeOf(next), state.selection)) state.selection = null;
  emit({ reason: 'mutate', label, skipPanels: !!opts.skipPanels });
}

export function mutate(label, fn, opts = {}) { applyMutation(label, fn, opts, true); }
export function mutateDoc(label, fn, opts = {}) { applyMutation(label, fn, opts, false); }

export function undo() {
  if (!history.undo.length) return;
  history.redo.push({ doc: state.doc, label: 'redo' });
  const entry = history.undo.pop();
  state.doc = entry.doc;
  computeView();
  state.dirty = true;
  if (state.selection && !findComponent(scopeOf(state.doc), state.selection)) state.selection = null;
  coalesce = { key: null, time: 0 };
  emit({ reason: 'history' });
}

export function redo() {
  if (!history.redo.length) return;
  history.undo.push({ doc: state.doc, label: 'undo' });
  const entry = history.redo.pop();
  state.doc = entry.doc;
  computeView();
  state.dirty = true;
  if (state.selection && !findComponent(scopeOf(state.doc), state.selection)) state.selection = null;
  coalesce = { key: null, time: 0 };
  emit({ reason: 'history' });
}

// ---------- 普通状态 ----------
export function select(id) {
  if (state.selection === id) return;
  state.selection = id;
  // 新选点若落在折叠的子树里，展开其祖先链，保证层级树中可见
  if (id) for (const pid of ancestorsOf(scopeOf(state.doc), id)) state.collapsedTreeIds.delete(pid);
  // 用户把选点移到别处后，"连续插入预设块"的平级追加记忆即失效
  if (id !== state.lastBlockId) state.lastBlockId = null;
  emit({ reason: 'select' });
}

export function setZoom(z) {
  // 缩放范围集中在 LIMITS（5%–800%），滚轮/按钮/适应共用同一套边界
  state.zoom = Math.min(LIMITS.zoomMax, Math.max(LIMITS.zoomMin, z));
  emit({ reason: 'zoom' });
}

export function setMode(mode) {
  state.mode = mode;
  emit({ reason: 'mode' });
}

export function setPreviewViewport(vp) {
  state.previewViewport = vp;
  emit({ reason: 'preview-viewport' });
}

// ---------- 选择相关便捷（读路径走解析视图：选中 id 与 presentation 原树同键） ----------
export function selectedComp() {
  return state.selection ? findComponent(viewDoc(), state.selection) : null;
}
export function selectedParent() {
  const c = selectedComp();
  return c && c.parent ? findComponent(viewDoc(), c.parent) : null;
}
// 新组件的目标容器：选中容器 → 其内部；否则选中组件的父容器；否则根
export function insertionContainer() {
  const c = selectedComp();
  if (!c) return findComponent(viewDoc(), 'root');
  if (isContainer(c)) return c;
  return findComponent(viewDoc(), c.parent) || findComponent(viewDoc(), 'root');
}
