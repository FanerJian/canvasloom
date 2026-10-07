// ============================================================
// 编辑器入口：装配、工具栏、快捷键、保存与外部修改协同
// ============================================================
import { state, on, select, undo, redo, loadProject, adoptExternal, adoptDraft, pushUndoEntry, selectedComp, setMode, setSnapEnabled, setFreeMove, setShowOutsideCanvas, viewDoc, pagesOfDoc, setActivePage, addPage, mutateDoc, saveDraftNow, scheduleDraftSave, clearDraft, loadDraft } from './store.js';
import { UI_MODES } from '../shared/modes.js';
import { TEMPLATES, DEFAULT_TEMPLATE } from '../shared/templates.js';
import { LIMITS } from '../shared/protocol.js';
import { validateDoc } from '../shared/validate.js';
import { initCanvas, renderCanvas, refreshOverlay, fitZoom, nudge } from './canvas.js';
import { renderPalette, renderBlocks, renderTree, renderProperties, renderToolbarState, openModal, closeModal, toast, copySelection, pasteClipboard, deleteComponent, duplicateComponent } from './panels.js';
import { renderFeaturesPanel, openVariantWizard, switchVariant } from './v3panels.js';
import { initPreviewBar, renderPreviewPane, runCheck, runExport } from './preview.js';
import { listProjects, getProject, createProject, saveProject, connectEvents } from './api.js';
import { closeContextMenu } from './ctxmenu.js';
import { upgradeDoc, upgradeDocToV3, CompatError } from '../shared/compat.js';

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 服务端协议能力探测：旧服务进程不认识 v2 时，前端保持 v1 行为（保存旧版本号），
// 避免新旧代码混跑期间出现"编辑器能画、服务端拒收"的窗口期。
let serverProtocolVersion = 0;
async function probeServerProtocol() {
  try {
    const r = await fetch('/api/hello');
    const j = await r.json();
    serverProtocolVersion = j.protocolVersion || 1;
  } catch { serverProtocolVersion = 1; }
}
const serverSupportsV2 = () => serverProtocolVersion >= 2;
// 仅在服务端支持 v2 时把内存中的文档升级为 v2（v1 文件本身不动）
function adoptDocForSession(rawDoc) {
  return serverSupportsV2() ? upgradeDoc(rawDoc) : rawDoc;
}

// ---------- 全局脚本错误提示（便于发现缓存混页/扩展冲突导致的"页面没反应"） ----------
let lastErrToast = 0;
window.addEventListener('error', (e) => {
  const now = Date.now();
  if (now - lastErrToast < 4000) return;
  lastErrToast = now;
  try {
    toast(`页面脚本异常（${(e.message || '未知错误').slice(0, 60)}），建议按 Ctrl+F5 强制刷新`, 'bad');
  } catch { /* 模块未就绪时忽略 */ }
});

// ---------- 渲染调度 ----------
function renderAll(detail = {}) {
  if (state.doc) {
    if (state.mode === 'design') {
      // 仅选中变化时只刷新选中框，避免重建画布打断进行中的拖拽；
      // 但选点跨页面时需要重建画布（页面显随选点切换，v3.1）
      if (detail.reason === 'select') {
        // 选中/取消选中时自动展开右栏（组件属性或画布设置）；之后仍可手动收起
        document.body.classList.remove('hide-right');
        syncPanelToggles();
        if (detail.pageChanged) renderCanvas(); else refreshOverlay();
      } else {
        renderCanvas();
      }
      if (state.lastAdded) {
        const nid = state.lastAdded;
        state.lastAdded = null;
        const node = document.querySelector(`#artboard [data-id="${CSS.escape(nid)}"]`);
        if (node) {
          node.classList.add('uiw-just-added');
          setTimeout(() => node.classList.remove('uiw-just-added'), 750);
        }
      }
    }
    renderPreviewPane();
    if (!detail.skipPanels) {
      renderTree();
      renderProperties();
      renderBlocks();
      renderFeaturesPanel();
    }
  }
  // 空状态引导卡：一旦加载了项目就隐藏
  const esCard = $('empty-state');
  if (esCard) esCard.classList.toggle('hidden', !!state.doc);
  renderToolbarState();
  renderVariantMenu();
  renderPageMenu();
  renderUpgradeEntry();
  // 调试/自动化检查出口（只读快照）
  window.__canvasloom = {
    name: state.name, revision: state.revision, dirty: state.dirty,
    mode: state.mode, selection: state.selection, doc: state.doc,
    view: viewDoc(), viewError: state.viewError || null,
    lastCheck: state.lastCheck || null,
  };
  if (state.pendingSelect) {
    const id = state.pendingSelect;
    state.pendingSelect = null;
    select(id);
  }
}

// ---------- 打开项目 ----------
// v1 文档读入后在内存升级为 v2（不写盘）；保存时服务端自动先备份 v1 原文件。
// name 参数是项目的「稳定身份」（= 文件名），展示名在 doc.name（S1 B07）。
async function openProjectByName(name, { silent, checkDraft } = {}) {
  const r = await getProject(name);
  if (!r.ok) {
    if (!silent) toast('打开失败：' + (r.error || '未知错误'), 'bad');
    return false;
  }
  let doc;
  try { doc = adoptDocForSession(r.doc); }
  catch (e) {
    if (!silent) toast('无法打开：' + (e instanceof CompatError ? e.message : '文档版本不兼容'), 'bad');
    return false;
  }
  loadProject(name, doc);
  localStorage.setItem('canvasloom:last', name);
  if (!silent) toast(`已打开「${(doc && doc.name) || name}」（修订号 ${doc.revision}）`, 'ok');
  if (checkDraft) maybeOfferDraftRecovery();
  return true;
}

// ---------- 项目切换守卫（S1 B01）----------
// 新建/打开项目前统一处理未保存修改：保存后继续、保留草稿后继续、明确丢弃。
// 「写入成功才切换」——保存失败或用户取消时停留在当前项目（proceed 不执行）。
function guardSwitchProject(proceed) {
  if (!state.dirty) { proceed(); return; }
  const draftNote = state.draftUnavailable
    ? `<br><strong class="ri-msg" style="color:#b45309">注意：自动草稿不可用（${escapeHtml(state.draftUnavailable)}），"保留草稿"可能失败，建议直接保存。</strong>`
    : '';
  const box = document.createElement('div');
  box.className = 'p-hint';
  box.innerHTML = `当前项目「${escapeHtml((state.doc && state.doc.name) || state.name || '')}」有<strong>未保存的修改</strong>。切换前请选择如何处理：${draftNote}`;
  openModal('未保存的修改', box, [
    ['保存并继续', async () => {
      await save();
      if (!state.dirty) { closeModal(); proceed(); }
      // 保存失败/出现冲突弹窗：停留在当前状态，用户处理后可重试
    }],
    ['保留草稿并继续', () => {
      const ok = saveDraftNow();
      closeModal();
      if (!ok) toast('草稿未能保留（' + (state.draftUnavailable || '未知原因') + '），已按原样切换', 'warn');
      else toast('未保存修改已保留为草稿，下次打开该项目时可找回', 'ok');
      proceed();
    }],
    ['放弃修改并继续', () => { clearDraft(); closeModal(); proceed(); }],
    ['取消', () => closeModal()],
  ]);
}

// ---------- 未保存草稿找回（S1）----------
// 打开项目后若存在该项目的草稿（且与磁盘内容不同），提示恢复或丢弃。
function maybeOfferDraftRecovery() {
  const d = loadDraft(state.name);
  if (!d || !state.doc) return;
  if (JSON.stringify(d.doc) === JSON.stringify(state.doc)) { clearDraft(); return; } // 与磁盘一致的过期草稿
  const stale = d.baseRevision != null && d.baseRevision !== state.revision;
  const box = document.createElement('div');
  box.className = 'p-hint';
  box.innerHTML = `发现项目「${escapeHtml((d.doc && d.doc.name) || state.name)}」的未保存草稿` +
    `（保存于 ${d.savedAt ? escapeHtml(new Date(d.savedAt).toLocaleString()) : '未知时间'}，基于修订号 ${d.baseRevision ?? '?'}）。` +
    (stale ? `<br><strong>注意：</strong>磁盘文件已更新到修订号 ${state.revision}；恢复后保存时会按修订号冲突处理，不会静默覆盖外部修改。` : '') +
    '<br><br>恢复草稿：未保存修改回到画布（Ctrl+Z 可回到磁盘版本）。丢弃草稿：以磁盘内容为准。';
  openModal('找回未保存的草稿', box, [
    ['恢复草稿', () => { closeModal(); adoptDraft(d.doc); clearDraft(); toast('已恢复未保存草稿；Ctrl+Z 可回到磁盘版本', 'ok'); }],
    ['丢弃草稿', () => { clearDraft(); closeModal(); }],
  ]);
}

// ---------- 加载最新（S1 B02）----------
// 冲突/外部修改时采纳磁盘版本：把当前未保存文档压成一条撤销记录再载入，
// "采纳外部版本"成为可撤销动作；不再出现"提示可撤销、实际历史已清空"的丢失。
async function reloadLatestFromDisk() {
  const r = await getProject(state.name);
  if (!r.ok) { toast('加载最新失败：' + (r.error || '未知错误'), 'bad'); return; }
  let doc;
  try { doc = adoptDocForSession(r.doc); }
  catch (e) { toast('无法加载最新：' + (e instanceof CompatError ? e.message : '文档版本不兼容'), 'bad'); return; }
  const hadDirty = state.dirty;
  if (hadDirty) {
    pushUndoEntry({ doc: state.doc, label: '加载最新前（未保存修改）', revision: state.revision });
  }
  loadProject(state.name, doc, { keepHistory: true });
  if (hadDirty) toast('已加载最新版本；之前的未保存修改可 Ctrl+Z 找回（本次会话内）', 'ok');
  else toast('已加载最新版本', 'ok');
}

async function showOpenDialog() {
  const projects = await listProjects();
  const box = document.createElement('div');
  box.className = 'open-list';
  if (!projects.length) box.innerHTML = '<div class="p-hint">还没有项目，点击"新建"创建一个。</div>';
  for (const p of projects) {
    const row = document.createElement('button');
    row.className = 'open-item';
    row.title = '项目文件：' + p.id;
    row.innerHTML = `<strong>${escapeHtml(p.name || p.id)}</strong>` +
      `<span>${escapeHtml(p.id)} · 修订号 ${p.revision} · ${new Date(p.updatedAt).toLocaleString()}</span>`;
    row.addEventListener('click', () => {
      closeModal();
      guardSwitchProject(async () => { await openProjectByName(p.id, { checkDraft: true }); });
    });
    box.appendChild(row);
  }
  openModal('打开项目', box, [['取消', () => closeModal()]]);
}

async function showNewDialog() {
  let chosen = 'web';
  let startLayout = 'free'; // 默认建议自由摆放
  const box = document.createElement('div');
  box.className = 'new-box';
  const modeLabel = document.createElement('div');
  modeLabel.className = 'p-label new-label';
  modeLabel.textContent = '选择界面模式（决定画布尺寸、新组件默认样式与预设块）';
  box.appendChild(modeLabel);
  const grid = document.createElement('div');
  grid.className = 'mode-grid';
  for (const [id, m] of Object.entries(UI_MODES)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mode-card' + (id === chosen ? ' active' : '');
    card.innerHTML = `<span class="mode-ico">${m.icon}</span><strong>${m.label}</strong>` +
      `<span class="mode-desc">${m.desc}</span><span class="mode-size">${m.canvas.width} × ${m.canvas.height}</span>`;
    card.addEventListener('click', () => {
      chosen = id;
      grid.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    });
    grid.appendChild(card);
  }
  box.appendChild(grid);
  // 起步模板（S2）：只给结构与用途，区域之后随时可改可删
  let chosenTemplate = DEFAULT_TEMPLATE;
  const tplLabel = document.createElement('div');
  tplLabel.className = 'p-label new-label';
  tplLabel.textContent = '起步模板（区域和用途已标好，内容之后自己填）';
  box.appendChild(tplLabel);
  const tplGrid = document.createElement('div');
  tplGrid.className = 'mode-grid';
  for (const [id, t] of Object.entries(TEMPLATES)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mode-card' + (id === chosenTemplate ? ' active' : '');
    card.innerHTML = `<strong>${t.label}</strong><span class="mode-desc">${t.desc}</span>`;
    card.addEventListener('click', () => {
      chosenTemplate = id;
      tplGrid.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    });
    tplGrid.appendChild(card);
  }
  box.appendChild(tplGrid);
  const layoutLabel = document.createElement('div');
  layoutLabel.className = 'p-label new-label';
  layoutLabel.textContent = '起步方式（之后随时可在右侧面板切换）';
  box.appendChild(layoutLabel);
  const layoutRow = document.createElement('div');
  layoutRow.className = 'mode-grid';
  const LAYOUT_CHOICES = [
    ['free', '✥ 自由摆放', '元素按坐标随意摆放，适合海报、面板、自由构图（推荐）'],
    ['vertical', '⬓ 自动排列', '元素按顺序自动排列，适合表单、列表类页面'],
  ];
  for (const [id, label, desc] of LAYOUT_CHOICES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'mode-card' + (id === startLayout ? ' active' : '');
    card.innerHTML = `<strong>${label}</strong><span class="mode-desc">${desc}</span>`;
    card.addEventListener('click', () => {
      startLayout = id;
      layoutRow.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    });
    layoutRow.appendChild(card);
  }
  box.appendChild(layoutRow);
  const nameLabel = document.createElement('div');
  nameLabel.className = 'p-label new-label';
  nameLabel.textContent = '项目名（可中文）';
  box.appendChild(nameLabel);
  const input = document.createElement('input');
  input.className = 'p-input';
  input.placeholder = '例如：后台管理首页';
  box.appendChild(input);
  openModal('新建项目', box, [
    ['取消', () => closeModal()],
    ['创建', () => {
      const name = input.value.trim();
      if (!name) return;
      guardSwitchProject(async () => {
        const r = await createProject(name, chosen, startLayout, chosenTemplate);
        if (!r.ok) { toast('创建失败：' + (r.error || '未知错误'), 'bad'); return; }
        closeModal(); // 未脏路径下守卫不弹窗，这里负责关掉新建弹窗
        loadProject(name, r.doc);
        localStorage.setItem('canvasloom:last', name);
        toast(`已创建「${name}」（${UI_MODES[chosen].label} · ${TEMPLATES[chosenTemplate].label}）`, 'ok');
      });
    }],
  ]);
  setTimeout(() => input.focus(), 50);
}

// ---------- 保存（保存会话，S1）----------
// 保存是异步的：提交后用户可能继续编辑、甚至切换项目。成功返回时先校验
// 「同一项目 + 同一文档 + 编辑序号未变」再清 dirty——提交的那份文档才算已保存，
// 保存期间的继续编辑不会被误标为已保存（待验证风险项的修复）。
let saving = false;
async function save({ force } = {}) {
  if (!state.doc || !state.name || saving) return;
  saving = true;
  state.saving = true;
  renderToolbarState();
  try {
    const session = { name: state.name, doc: state.doc, seq: state.editSeq };
    const report = validateDoc(session.doc);
    if (!report.ok) {
      const box = document.createElement('div');
      box.className = 'report-list';
      for (const e of report.errors.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = 'report-issue sev-error';
        row.innerHTML = `<span class="ri-badge">错误</span><span class="ri-code">${e.code}</span><span class="ri-msg">${e.message}</span>`;
        box.appendChild(row);
      }
      openModal('无法保存：文档存在结构错误', box, [['知道了', () => closeModal()]]);
      return;
    }
    const base = force ? (state._serverRevision ?? state.revision) : state.revision;
    const r = await saveProject(state.name, session.doc, base);
    if (r.ok) {
      state.revision = r.revision;
      state._serverRevision = r.revision;
      const sameSession = state.name === session.name && state.doc === session.doc && state.editSeq === session.seq;
      if (sameSession) {
        state.dirty = false;
        clearDraft();
        toast(`已保存（修订号 ${r.revision}）`, 'ok');
      } else {
        // 保存期间又有修改（或已切走）：磁盘内容是新修订号，但画布仍是未保存状态
        scheduleDraftSave();
        if (state.name === session.name) toast(`已写入修订号 ${r.revision}；保存期间又有新的修改，当前内容仍为未保存`, 'info');
      }
      renderToolbarState();
      return;
    }
    if (r.status === 409) {
      state._serverRevision = r.currentRevision;
      state.conflict = true; // 顶栏状态显示「存在冲突」，处理完成后随加载/保存清除
      renderToolbarState();
      const box = document.createElement('div');
      box.innerHTML = `<div class="p-hint">文件在编辑器之外被修改（agent 或 CLI）。<br>服务器当前修订号：<strong>${r.currentRevision}</strong>，本次保存基于：<strong>${base}</strong>。<br><br>建议"加载最新"以免覆盖（当前未保存内容会保留为可撤销记录，Ctrl+Z 找回）；选择"强制保存"将以当前画布内容覆盖外部修改（可撤销）。</div>`;
      openModal('修订号冲突', box, [
        ['加载最新', async () => { state.conflict = false; closeModal(); await reloadLatestFromDisk(); }],
        ['强制保存', async () => { state.conflict = false; closeModal(); await save({ force: true }); }, 'danger'],
      ]);
      return;
    }
    toast('保存失败：' + (r.error || '未知错误'), 'bad');
  } finally {
    saving = false;
    state.saving = false;
    renderToolbarState();
  }
}

// ---------- 外部修改（SSE） ----------
function connect() {
  connectEvents(async (msg) => {
    if (msg.type === 'changed' && msg.name === state.name) {
      const r = await getProject(state.name);
      if (!r.ok) return;
      if (state.dirty) {
        const box = document.createElement('div');
        box.innerHTML = `<div class="p-hint">文件被外部修改（新修订号 ${r.doc.revision}），但当前画布有未保存修改。<br><br>保留我的修改：不做任何变更；加载最新：载入外部版本，当前未保存内容会保留为一条撤销记录（Ctrl+Z 找回，本次会话内有效）。</div>`;
        openModal('外部修改', box, [
          ['保留我的修改', () => { state._serverRevision = r.doc.revision; closeModal(); }],
          ['加载最新', async () => { closeModal(); await reloadLatestFromDisk(); }],
        ]);
      } else {
        adoptExternal(adoptDocForSession(r.doc));
        toast('设计已被外部修改（agent/CLI），已自动刷新；可撤销', 'info');
      }
    }
  }, (down) => { state.connDown = down; renderToolbarState(); });
}

// ---------- 复制/删除 ----------
// 删除不再弹 confirm：撤销历史兜底，操作更顺手
function deleteSelection() {
  const c = selectedComp();
  if (!c || c.id === 'root') return;
  deleteComponent(c.id);
}

// ---------- 快捷键 ----------
function initKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (document.getElementById('modal-root').firstChild && e.key !== 'Escape') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
    if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateComponent(state.selection); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key === 'Escape') { closeContextMenu(); select(null); closeModal(); return; }
    if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
    const step = e.shiftKey;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-1, 0, step); }
    if (e.key === 'ArrowRight') { e.preventDefault(); nudge(1, 0, step); }
    if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -1, step); }
    if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, 1, step); }
  });
}

// ---------- 面板折叠与快捷键帮助 ----------
function syncPanelToggles() {
  $('btn-left-toggle').classList.toggle('active', !document.body.classList.contains('hide-left'));
  $('btn-right-toggle').classList.toggle('active', !document.body.classList.contains('hide-right'));
}

function showShortcuts() {
  const rows = [
    ['双击组件', '就地编辑文字'], ['右键组件', '常用操作菜单'],
    ['Ctrl+S', '保存'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'],
    ['Ctrl+C / Ctrl+V', '复制 / 粘贴'], ['Ctrl+D', '创建副本'],
    ['Delete', '删除选中组件'], ['方向键', '微调位置 / 顺序 / 占格'],
    ['Shift + 方向键', '大幅微调（10px）'], ['Ctrl+滚轮', '以光标为中心缩放'],
    ['Esc', '取消选中 / 关闭弹窗'],
  ];
  const box = document.createElement('div');
  box.className = 'kbd-grid';
  for (const [keys, desc] of rows) {
    const row = document.createElement('div');
    row.className = 'kbd-row';
    row.innerHTML = `<span>${desc}</span><kbd>${keys}</kbd>`;
    box.appendChild(row);
  }
  openModal('键盘快捷键', box, [['知道了', () => closeModal()]]);
}

// ---------- 面板开合记忆（localStorage；首次无存档默认两侧展开，新手能直接看到带文字的工具入口；之后按偏好记忆） ----------
const PANELS_KEY = 'canvasloom.panels';
function loadPanelPrefs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PANELS_KEY) || 'null'); } catch { saved = null; }
  if (saved && typeof saved.left === 'boolean') {
    document.body.classList.toggle('hide-left', !saved.left);
    document.body.classList.toggle('hide-right', !saved.right);
  } else {
    document.body.classList.remove('hide-left', 'hide-right');
  }
  syncPanelToggles();
}
function savePanelPrefs() {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify({
      left: !document.body.classList.contains('hide-left'),
      right: !document.body.classList.contains('hide-right'),
    }));
  } catch { /* localStorage 不可用时忽略 */ }
}

// ---------- 顶栏变体切换菜单（仅 v3 文档显示） ----------
function renderVariantMenu() {
  const wrap = $('variant-wrap'), btn = $('btn-variant'), menu = $('variant-menu'), label = $('variant-label');
  if (!wrap || !btn || !menu || !label) return;
  const doc = state.doc;
  const variants = doc && doc.version === 3 && Array.isArray(doc.variants) ? doc.variants.filter(Boolean) : [];
  const isV3 = variants.length > 0;
  wrap.classList.toggle('hidden', !isV3);
  if (!isV3) { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); return; }
  const cur = variants.find((v) => v.id === doc.activeVariant);
  label.textContent = cur ? (cur.label || cur.id) : (doc.activeVariant || '（未设置）');
  menu.textContent = '';
  for (const v of variants) {
    const item = document.createElement('button');
    item.className = 'tb-btn variant-item' + (v.id === doc.activeVariant ? ' current' : '');
    const style = (doc.styles || {})[v.style];
    const pres = (doc.presentations || {})[v.presentation];
    item.textContent = (v.id === doc.activeVariant ? '✓ ' : '') +
      `${v.label || v.id}（${(style && style.label) || v.style || '?'} · ${(pres && pres.label) || v.presentation || '?'}）`;
    item.addEventListener('click', () => { closeMenus(); switchVariant(v); });
    menu.appendChild(item);
  }
  const sep = document.createElement('div');
  sep.className = 'tb-menu-sep';
  menu.appendChild(sep);
  const add = document.createElement('button');
  add.className = 'tb-btn';
  add.textContent = '＋ 新建方案（向导）…';
  add.addEventListener('click', () => { closeMenus(); openVariantWizard(); });
  menu.appendChild(add);
}

// ---------- 顶栏页面图层菜单（v3 文档显示；v3.1） ----------
function renderPageMenu() {
  const wrap = $('page-wrap'), btn = $('btn-page'), menu = $('page-menu'), label = $('page-label');
  if (!wrap || !btn || !menu || !label) return;
  const doc = state.doc;
  const isV3 = !!doc && doc.version === 3;
  wrap.classList.toggle('hidden', !isV3);
  if (!isV3) { menu.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); return; }
  const pages = pagesOfDoc();
  const view = viewDoc();
  const nameOf = (pid) => {
    const c = view ? view.components[pid] : null;
    return (c && c.name) || pid;
  };
  const cur = pages.includes(state.activePageId) ? state.activePageId : pages[0] || null;
  label.textContent = cur ? nameOf(cur) : '（无页面）';
  menu.textContent = '';
  if (!pages.length) {
    const hint = document.createElement('div');
    hint.className = 'p-hint tb-menu-hint';
    hint.textContent = '页面是铺满画布的图层；给按钮配「goto 跳转页面」动作即可切换页面。';
    menu.appendChild(hint);
  }
  for (const pid of pages) {
    const item = document.createElement('button');
    item.className = 'tb-btn variant-item' + (pid === cur ? ' current' : '');
    item.textContent = (pid === cur ? '✓ ' : '') + `${nameOf(pid)}（${pid}）` + (pages[0] === pid ? ' · 起始页' : '');
    item.addEventListener('click', () => { closeMenus(); setActivePage(pid); });
    menu.appendChild(item);
  }
  if (pages.length) {
    const sep = document.createElement('div');
    sep.className = 'tb-menu-sep';
    menu.appendChild(sep);
  }
  const add = document.createElement('button');
  add.className = 'tb-btn';
  add.textContent = '＋ 新建页面（图层）';
  add.addEventListener('click', () => {
    closeMenus();
    const id = addPage(`页面 ${pages.length + 1}`);
    if (id) toast('已新建页面，画布已切换到它；在「功能与交互」里给按钮配 goto 动作可跳到这页', 'ok');
  });
  menu.appendChild(add);
}

// ---------- 「更多」菜单里的 v2→v3 升级入口（v3.1） ----------
function renderUpgradeEntry() {
  const btn = $('btn-upgrade-v3');
  if (!btn) return;
  btn.classList.toggle('hidden', !(state.doc && state.doc.version !== 3));
}

function showUpgradeDialog() {
  if (!state.doc || state.doc.version === 3) return;
  const box = document.createElement('div');
  box.className = 'p-hint';
  box.innerHTML = '升级后本项目获得 v3 能力：<strong>页面图层</strong>（多个页面互相切换）与' +
    '<strong>点击动作</strong>（按钮开/关面板、跳转页面）。<br><br>' +
    '原设计内容原样保留为「默认呈现」，组件、资源、布局都不变；升级可 Ctrl+Z 撤销，保存后写入文件。';
  openModal('升级为 v3 文档', box, [
    ['取消', () => closeModal()],
    ['升级', () => {
      mutateDoc('升级为 v3 文档', (d) => {
        const up = upgradeDocToV3(d);
        for (const k of Object.keys(d)) delete d[k];
        Object.assign(d, up);
      });
      closeModal();
      toast('已升级为 v3：顶栏出现「页面」菜单，选中按钮可配「点击动作」', 'ok');
    }],
  ]);
}

// ---------- 顶栏「更多」菜单与画布选项弹出层 ----------
function closeMenus() {
  const moreMenu = $('more-menu');
  const optsMenu = $('canvas-opts-menu');
  const moreWrap = $('more-wrap');
  const varMenu = $('variant-menu');
  const varWrap = $('variant-wrap');
  const pageMenu = $('page-menu');
  const pageWrap = $('page-wrap');
  if (moreMenu) moreMenu.classList.add('hidden');
  if (optsMenu) optsMenu.classList.add('hidden');
  if (varMenu) varMenu.classList.add('hidden');
  if (pageMenu) pageMenu.classList.add('hidden');
  if (moreWrap) moreWrap.classList.remove('open');
  if (varWrap) varWrap.classList.remove('open');
  if (pageWrap) pageWrap.classList.remove('open');
  const moreBtn = $('btn-more');
  const optsBtn = $('btn-canvas-opts');
  const varBtn = $('btn-variant');
  const pageBtn = $('btn-page');
  if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  if (optsBtn) { optsBtn.setAttribute('aria-expanded', 'false'); optsBtn.classList.remove('active'); }
  if (varBtn) varBtn.setAttribute('aria-expanded', 'false');
  if (pageBtn) pageBtn.setAttribute('aria-expanded', 'false');
}

function initMenus() {
  const moreBtn = $('btn-more'), moreMenu = $('more-menu'), moreWrap = $('more-wrap');
  const optsBtn = $('btn-canvas-opts'), optsMenu = $('canvas-opts-menu');
  const varBtn = $('btn-variant'), varMenu = $('variant-menu'), varWrap = $('variant-wrap');
  const pageBtn = $('btn-page'), pageMenu = $('page-menu'), pageWrap = $('page-wrap');
  moreBtn.addEventListener('click', () => {
    const open = !moreMenu.classList.toggle('hidden');
    moreWrap.classList.toggle('open', open);
    moreBtn.setAttribute('aria-expanded', String(open));
    optsMenu.classList.add('hidden');
    varMenu.classList.add('hidden');
    pageMenu.classList.add('hidden');
  });
  // 画布选项是开关集合：点选后保持弹层打开，便于连续切换并看到状态变化
  optsBtn.addEventListener('click', () => {
    const open = !optsMenu.classList.toggle('hidden');
    optsBtn.setAttribute('aria-expanded', String(open));
    optsBtn.classList.toggle('active', open);
    moreMenu.classList.add('hidden');
    moreWrap.classList.remove('open');
    varMenu.classList.add('hidden');
    pageMenu.classList.add('hidden');
  });
  // 变体切换菜单（v3 文档；按钮隐藏时点击不到）
  varBtn.addEventListener('click', () => {
    const open = !varMenu.classList.toggle('hidden');
    varBtn.setAttribute('aria-expanded', String(open));
    moreMenu.classList.add('hidden');
    moreWrap.classList.remove('open');
    optsMenu.classList.add('hidden');
    pageMenu.classList.add('hidden');
  });
  // 页面图层菜单（v3 文档；v3.1）
  if (pageBtn && pageMenu && pageWrap) {
    pageBtn.addEventListener('click', () => {
      const open = !pageMenu.classList.toggle('hidden');
      pageBtn.setAttribute('aria-expanded', String(open));
      pageWrap.classList.toggle('open', open);
      moreMenu.classList.add('hidden');
      moreWrap.classList.remove('open');
      optsMenu.classList.add('hidden');
      varMenu.classList.add('hidden');
    });
  }
  // 点选「更多」里的动作项（复制/粘贴/删除/检查布局）后收起
  moreMenu.addEventListener('click', (e) => { if (e.target.closest('button')) closeMenus(); });
  // 点击外部收起（pointerdown 先于 click，不与按钮自身 toggle 冲突）
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#more-wrap') || e.target.closest('#canvas-opts-menu') || e.target.closest('#variant-wrap') || e.target.closest('#page-wrap')) return;
    closeMenus();
  });
  // Esc 收起（initKeys 已处理选中与弹窗，这里只管菜单）
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
}

// ---------- 左栏标签页：添加 / 层级 / 功能风格 ----------
function showLeftTab(which) {
  $('tab-add').classList.toggle('active', which === 'add');
  $('tab-tree').classList.toggle('active', which === 'tree');
  $('tab-fs').classList.toggle('active', which === 'fs');
  $('tab-add').setAttribute('aria-selected', String(which === 'add'));
  $('tab-tree').setAttribute('aria-selected', String(which === 'tree'));
  $('tab-fs').setAttribute('aria-selected', String(which === 'fs'));
  $('left-page-add').classList.toggle('hidden', which !== 'add');
  $('left-page-tree').classList.toggle('hidden', which !== 'tree');
  $('left-page-fs').classList.toggle('hidden', which !== 'fs');
}
function initLeftTabs() {
  $('tab-add').addEventListener('click', () => showLeftTab('add'));
  $('tab-tree').addEventListener('click', () => showLeftTab('tree'));
  $('tab-fs').addEventListener('click', () => showLeftTab('fs'));
}

// ---------- 空状态引导卡 ----------
function initEmptyState() {
  $('es-new').addEventListener('click', showNewDialog);
  $('es-open').addEventListener('click', showOpenDialog);
}

// ---------- 工具栏 ----------
function initToolbar() {
  $('btn-new').addEventListener('click', showNewDialog);
  $('btn-open').addEventListener('click', showOpenDialog);
  $('btn-save').addEventListener('click', () => save());
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-copy').addEventListener('click', copySelection);
  $('btn-paste').addEventListener('click', pasteClipboard);
  $('btn-del').addEventListener('click', deleteSelection);
  $('btn-zoom-out').addEventListener('click', () => { state.zoom = Math.max(LIMITS.zoomMin, state.zoom - 0.1); renderCanvas(); renderToolbarState(); });
  $('btn-zoom-in').addEventListener('click', () => { state.zoom = Math.min(LIMITS.zoomMax, state.zoom + 0.1); renderCanvas(); renderToolbarState(); });
  $('btn-fit').addEventListener('click', fitZoom);
  $('btn-snap').addEventListener('click', () => { setSnapEnabled(!state.snapEnabled); });
  $('btn-free-move').addEventListener('click', () => { setFreeMove(!state.freeMove); });
  $('btn-show-outside').addEventListener('click', () => { setShowOutsideCanvas(!state.showOutsideCanvas); });
  $('btn-mode-design').addEventListener('click', () => setMode('design'));
  $('btn-mode-preview').addEventListener('click', () => setMode('preview'));
  $('btn-left-toggle').addEventListener('click', () => { document.body.classList.toggle('hide-left'); syncPanelToggles(); savePanelPrefs(); });
  $('btn-right-toggle').addEventListener('click', () => { document.body.classList.toggle('hide-right'); syncPanelToggles(); savePanelPrefs(); });
  $('btn-help').addEventListener('click', showShortcuts);
  $('btn-check').addEventListener('click', runCheck);
  $('btn-export').addEventListener('click', runExport);
  const upBtn = $('btn-upgrade-v3');
  if (upBtn) upBtn.addEventListener('click', () => { closeMenus(); showUpgradeDialog(); });
  initMenus();
  initLeftTabs();
  initEmptyState();
  loadPanelPrefs();
}

// ---------- 启动 ----------
async function boot() {
  await probeServerProtocol();
  initCanvas();
  initPreviewBar();
  renderPalette();
  initToolbar();
  initKeys();
  on(renderAll);

  const last = localStorage.getItem('canvasloom:last');
  let opened = false;
  if (last) opened = await openProjectByName(last, { silent: true, checkDraft: true });
  if (!opened) {
    const projects = await listProjects();
    if (projects.length) opened = await openProjectByName(projects[0].id, { silent: true, checkDraft: true });
  }
  if (!opened) {
    // 无项目：画布区显示极简引导卡（新建 / 打开），加载项目后自动隐藏
    $('empty-state').classList.remove('hidden');
  }
  setTimeout(fitZoom, 60);
  connect();
  window.addEventListener('beforeunload', () => {
    // 草稿保护：关闭前尽力把未保存修改存为草稿（localStorage 同步写，可完成）。
    // 不阻止卸载——preventDefault 在浏览器弹原生确认框，在 Electron 壳里却会
    // 静默拒绝关窗（点右上角 × 无任何反应）；数据已有草稿兜底，直接放行。
    if (state.dirty) saveDraftNow();
  });
}

boot();
