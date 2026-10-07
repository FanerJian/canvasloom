// ============================================================
// 编辑器状态中心：文档、历史（撤销/重做）、选择、缩放、模式
// ============================================================
import { findComponent, isContainer, ancestorsOf, LIMITS, pageIdsOf, newPage } from '../shared/protocol.js';
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
  name: null,         // 项目名（稳定身份 = 文件名；展示名在 doc.name，S1 B07）
  revision: 0,        // 与磁盘一致的修订号
  dirty: false,       // 有未保存修改
  editSeq: 0,         // 编辑序号：任何修改/撤销/载入都会递增（保存会话归属判定，S1）
  draftUnavailable: null, // 草稿持久化失败原因（localStorage 容量不足等；null = 可用）
  selection: null,    // 主选中组件 id（属性面板/手柄跟随）
  multiSelection: null, // 多选列表（含主选中；length>1 时有效，S2b）
  zoom: 1,
  snapEnabled: prefOn(PREF_SNAP, true),               // 吸附参考线（按住 Alt 临时绕过）
  freeMove: prefOn(PREF_FREE_MOVE, true),             // 组件自由移动（视图偏好，不进 UIDoc）
  showOutsideCanvas: prefOn(PREF_SHOW_OUTSIDE, true), // 设计视图显示画布外内容（不影响预览/导出的最终裁剪）
  mode: 'design',     // design | preview
  previewViewport: null, // null = 跟随设计画布；否则 [w,h]
  clipboard: null,    // 复制的完整子树快照（shared/clipboard.js 结构：原始语义 + 依赖）
  lastAdded: null,    // 刚添加的组件 id（画布重建后播放一次高亮）
  lastBlockId: null,  // 刚插入的预设块根 id（连续插入时平级追加，不嵌套）
  lastExternal: null, // 外部修改提示（未被采纳时）
  collapsedTreeIds: new Set(), // 层级树手动折叠的容器 id（纯视图状态，不进文档）
  activePageId: null, // 设计视图当前显示的页面图层 id（纯视图状态，不进文档；v3.1）
  saving: false,      // 正在保存（顶栏状态文字，S2）
  connDown: false,    // 与本地服务连接中断（SSE 断开，自动重连中）
  conflict: false,    // 修订号冲突未处理（顶栏显示「存在冲突」）
};

// 预设块面板的场景过滤：null = 跟随文档模式；否则固定浏览某个模式的块
state.paletteModeId = null;

// ---------- v3.1 页面图层（视图状态） ----------
// 页面 = 编辑域（活动 presentation）root 直接子元素中 page===true 的容器；首个为起始页。
// 设计视图一次只显示一个页面；预览/导出的页面切换由交互运行时按 goto 语义管理。
export function pagesOfDoc() {
  const doc = state.doc;
  if (!doc) return [];
  return pageIdsOf(scopeOf(doc));
}
function ensureActivePage() {
  const pages = pagesOfDoc();
  if (!pages.includes(state.activePageId)) state.activePageId = pages[0] || null;
}
export function setActivePage(id) {
  if (state.activePageId === id) return;
  state.activePageId = id;
  emit({ reason: 'page' });
}
// 新建页面图层并立即切换为当前编辑页面；返回新页面 id
export function addPage(name) {
  if (!state.doc || state.doc.version !== 3) return null;
  let createdId = null;
  mutate(`新建页面「${name}」`, (doc) => {
    const comp = newPage(doc, name);
    createdId = comp.id;
  });
  if (createdId) setActivePage(createdId);
  return createdId;
}

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
// opts.keepHistory（S1 B02）："加载最新"等保留会话历史的路径使用——
// 调用方先把旧文档推成撤销记录，再以 keepHistory 载入新版本，
// 使"采纳外部版本"成为一个可 Ctrl+Z 撤销的动作，而不是清空历史的数据丢失。
export function loadProject(name, doc, opts = {}) {
  state.doc = doc;
  state.name = name;
  state.revision = doc.revision;
  state.dirty = false;
  state.conflict = false; // 载入新文档即离开冲突状态（顶栏状态文字，S2）
  state.selection = null;
  state.mode = 'design';
  state.lastBlockId = null;
  state.lastExternal = null;
  state.collapsedTreeIds.clear(); // 新文档从全展开开始
  if (!opts.keepHistory) {
    history.undo = [];
    history.redo = [];
  }
  coalesce = { key: null, time: 0 };
  state.editSeq++;
  computeView();
  state.activePageId = null; // 页面视图状态从起始页开始（无页面文档保持 null）
  ensureActivePage();
  emit({ reason: 'load' });
}

// 撤销记录压栈（封顶 MAX_HISTORY）。entry: { doc, label, revision? }。
// revision 记录该文档对应的磁盘修订号：undo 恢复文档时一并恢复，
// "加载最新前"的未保存编辑撤回后保存会得到正确的冲突提示，而不是静默错位。
export function pushUndoEntry(entry) {
  history.undo.push(entry);
  if (history.undo.length > MAX_HISTORY) history.undo.shift();
}

// 外部（agent/CLI）修改到达：保留撤销路径，可 Ctrl+Z 回到主人修改前的状态
export function adoptExternal(doc) {
  pushUndoEntry({ doc: state.doc, label: '外部修改前', revision: state.revision });
  history.redo = [];
  state.doc = doc;
  state.revision = doc.revision;
  state.dirty = false;
  state.editSeq++;
  computeView();
  pruneSelection();
  ensureActivePage();
  coalesce = { key: null, time: 0 };
  emit({ reason: 'external' });
}

// 恢复未保存草稿（S1）：磁盘版本先入撤销记录（可 Ctrl+Z 回到磁盘状态），
// 草稿文档成为当前未保存修改（dirty=true）。
export function adoptDraft(doc) {
  pushUndoEntry({ doc: state.doc, label: '恢复草稿前（磁盘版本）', revision: state.revision });
  history.redo = [];
  state.doc = doc;
  state.dirty = true;
  state.editSeq++;
  computeView();
  pruneSelection();
  ensureActivePage();
  coalesce = { key: null, time: 0 };
  scheduleDraftSave();
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
    pushUndoEntry({ doc: prev, label, revision: state.revision });
  }
  coalesce = opts.coalesceKey ? { key: opts.coalesceKey, time: now } : { key: null, time: 0 };
  history.redo = [];
  state.doc = next;
  state.editSeq++;
  computeView();
  state.dirty = true;
  if (state.selection && !findComponent(scopeOf(next), state.selection)) pruneSelection();
  ensureActivePage(); // 页面被删除/撤销时回落到起始页
  scheduleDraftSave(); // 草稿保护：稍后把未保存修改持久化（S1）
  emit({ reason: 'mutate', label, skipPanels: !!opts.skipPanels });
}

export function mutate(label, fn, opts = {}) { applyMutation(label, fn, opts, true); }
export function mutateDoc(label, fn, opts = {}) { applyMutation(label, fn, opts, false); }

export function undo() {
  if (!history.undo.length) return;
  history.redo.push({ doc: state.doc, label: 'redo', revision: state.revision });
  const entry = history.undo.pop();
  state.doc = entry.doc;
  if (entry.revision != null) state.revision = entry.revision;
  state.editSeq++;
  computeView();
  state.dirty = true;
  pruneSelection();
  ensureActivePage();
  coalesce = { key: null, time: 0 };
  scheduleDraftSave();
  emit({ reason: 'history' });
}

export function redo() {
  if (!history.redo.length) return;
  history.undo.push({ doc: state.doc, label: 'undo', revision: state.revision });
  const entry = history.redo.pop();
  state.doc = entry.doc;
  if (entry.revision != null) state.revision = entry.revision;
  state.editSeq++;
  computeView();
  state.dirty = true;
  pruneSelection();
  ensureActivePage();
  coalesce = { key: null, time: 0 };
  scheduleDraftSave();
  emit({ reason: 'history' });
}

// ---------- 普通状态 ----------
// 选中模型（S2b）：state.selection = 主选中（属性面板与缩放手柄跟随它）；
// state.multiSelection = 多选列表（含主选中，length>1 时有效，首项即主选中）。
export function selectedIds() {
  const scope = state.doc ? scopeOf(state.doc) : null;
  const comps = scope && scope.components ? scope.components : null;
  if (!comps) return [];
  if (state.multiSelection && state.multiSelection.length > 1) return state.multiSelection.filter((id) => comps[id]);
  return state.selection && comps[state.selection] ? [state.selection] : [];
}

// 统一落选：去重、主选中=首项、页面跟随、祖先展开、撤销块记忆
function applySelection(ids) {
  const prevPage = state.activePageId;
  const list = (ids || []).filter((id, i, a) => id && a.indexOf(id) === i);
  state.selection = list[0] || null;
  state.multiSelection = list.length > 1 ? list : null;
  // 选点落在某个页面图层内（或就是页面）时，设计视图自动切到该页面（v3.1）
  if (state.selection) {
    const scope = scopeOf(state.doc);
    let ownerPage = null;
    const self = scope.components ? scope.components[state.selection] : null;
    if (self && self.page === true) ownerPage = state.selection;
    if (!ownerPage) {
      for (const pid of ancestorsOf(scope, state.selection)) {
        const c = scope.components[pid];
        if (c && c.page === true) { ownerPage = pid; break; }
      }
    }
    if (ownerPage) state.activePageId = ownerPage;
  }
  // 新选点若落在折叠的子树里，展开其祖先链，保证层级树中可见
  if (state.selection) for (const pid of ancestorsOf(scopeOf(state.doc), state.selection)) state.collapsedTreeIds.delete(pid);
  // 用户把选点移到别处后，"连续插入预设块"的平级追加记忆即失效
  if (state.selection !== state.lastBlockId) state.lastBlockId = null;
  emit({ reason: 'select', pageChanged: state.activePageId !== prevPage });
}

export function select(id) {
  if (state.selection === id && !state.multiSelection) return;
  applySelection(id ? [id] : []);
}

// Shift+点击：加选 / 减选（多选，S2b）
export function toggleSelected(id) {
  if (!id) return;
  const cur = selectedIds();
  const i = cur.indexOf(id);
  if (i >= 0) cur.splice(i, 1);
  else cur.push(id);
  applySelection(cur);
}

// 文档变化后清理失效的选中 id（主选中失效时用剩余项补位）
export function pruneSelection() {
  const scope = state.doc ? scopeOf(state.doc) : null;
  const comps = scope && scope.components ? scope.components : {};
  const alive = (state.multiSelection || []).filter((id) => comps[id]);
  if (alive.length > 1) {
    state.multiSelection = alive;
    if (!comps[state.selection]) state.selection = alive[0];
  } else {
    state.multiSelection = null;
    if (state.selection && !comps[state.selection]) state.selection = alive[0] || null;
  }
}

// 删除等路径：清理选中并按选中语义刷新界面（面板/选中框）
export function resyncSelection() {
  pruneSelection();
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

// ---------- 草稿保护（S1）----------
// 未保存修改按「项目稳定身份」持久化到 localStorage（编辑器会话数据，不进 UIDoc）：
// 崩溃、误关窗口、未保存切换项目后重新打开该项目即可找回。
// 草稿随磁盘修订号一起记录：恢复时能识别"外部已更新"，恢复后保存会走正常的冲突流程。
const DRAFT_PREFIX = 'canvasloom:draft:';
let draftTimer = null;

function draftKey(name) { return DRAFT_PREFIX + (name || ''); }

export function saveDraftNow() {
  if (!state.doc || !state.name || !state.dirty) return false;
  try {
    localStorage.setItem(draftKey(state.name), JSON.stringify({
      kind: 'canvasloom-draft',
      doc: state.doc,
      baseRevision: state.revision,
      savedAt: new Date().toISOString(),
    }));
    state.draftUnavailable = null;
    return true;
  } catch (e) {
    state.draftUnavailable = (e && (e.name === 'QuotaExceededError' || e.code === 22))
      ? '浏览器存储空间不足（文档可能嵌入了大图片）'
      : String((e && e.message) || e);
    return false;
  }
}

export function scheduleDraftSave(delay = 1200) {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { draftTimer = null; saveDraftNow(); }, delay);
}

export function clearDraft(name) {
  try { localStorage.removeItem(draftKey(name == null ? state.name : name)); } catch { /* 忽略 */ }
}

export function loadDraft(name) {
  try {
    const raw = localStorage.getItem(draftKey(name));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.kind !== 'canvasloom-draft' || !d.doc || d.doc.format !== 'uidoc') return null;
    return d;
  } catch { return null; }
}
