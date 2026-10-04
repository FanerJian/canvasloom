// ============================================================
// 编辑器入口：装配、工具栏、快捷键、保存与外部修改协同
// ============================================================
import { state, on, select, undo, redo, loadProject, adoptExternal, selectedComp, setMode, setSnapEnabled, setFreeMove, setShowOutsideCanvas } from './store.js';
import { UI_MODES } from '../shared/modes.js';
import { LIMITS } from '../shared/protocol.js';
import { validateDoc } from '../shared/validate.js';
import { initCanvas, renderCanvas, refreshOverlay, fitZoom, nudge } from './canvas.js';
import { renderPalette, renderBlocks, renderTree, renderProperties, renderToolbarState, openModal, closeModal, toast, copySelection, pasteClipboard, deleteComponent, duplicateComponent } from './panels.js';
import { initPreviewBar, renderPreviewPane, runCheck, runExport } from './preview.js';
import { listProjects, getProject, createProject, saveProject, connectEvents } from './api.js';
import { closeContextMenu } from './ctxmenu.js';
import { upgradeDoc, CompatError } from '../shared/compat.js';

const $ = (id) => document.getElementById(id);

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
      // 仅选中变化时只刷新选中框，避免重建画布打断进行中的拖拽
      if (detail.reason === 'select') refreshOverlay();
      else renderCanvas();
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
    }
  }
  renderToolbarState();
  // 调试/自动化检查出口（只读快照）
  window.__uiforge = {
    name: state.name, revision: state.revision, dirty: state.dirty,
    mode: state.mode, selection: state.selection, doc: state.doc,
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
async function openProjectByName(name, { silent } = {}) {
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
  localStorage.setItem('uiforge:last', name);
  if (!silent) toast(`已打开「${name}」（修订号 ${doc.revision}）`, 'ok');
  return true;
}

async function showOpenDialog() {
  const projects = await listProjects();
  const box = document.createElement('div');
  box.className = 'open-list';
  if (!projects.length) box.innerHTML = '<div class="p-hint">还没有项目，点击"新建"创建一个。</div>';
  for (const p of projects) {
    const row = document.createElement('button');
    row.className = 'open-item';
    row.innerHTML = `<strong>${p.name}</strong><span>修订号 ${p.revision} · ${new Date(p.updatedAt).toLocaleString()}</span>`;
    row.addEventListener('click', async () => {
      closeModal();
      if (state.dirty && !confirm('当前有未保存的修改，打开其他项目将丢弃这些修改。继续？')) return;
      await openProjectByName(p.name);
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
    ['创建', async () => {
      const name = input.value.trim();
      if (!name) return;
      const r = await createProject(name, chosen, startLayout);
      if (!r.ok) { toast('创建失败：' + (r.error || '未知错误'), 'bad'); return; }
      closeModal();
      loadProject(name, r.doc);
      localStorage.setItem('uiforge:last', name);
      toast(`已创建「${name}」（${UI_MODES[chosen].label} · ${startLayout === 'free' ? '自由摆放' : '自动排列'}）`, 'ok');
    }],
  ]);
  setTimeout(() => input.focus(), 50);
}

// ---------- 保存 ----------
async function save({ force } = {}) {
  if (!state.doc || !state.name) return;
  const doc = state.doc;
  const report = validateDoc(doc);
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
  const r = await saveProject(state.name, doc, base);
  if (r.ok) {
    state.revision = r.revision;
    state._serverRevision = r.revision;
    state.dirty = false;
    renderToolbarState();
    toast(`已保存（修订号 ${r.revision}）`, 'ok');
    return;
  }
  if (r.status === 409) {
    state._serverRevision = r.currentRevision;
    const box = document.createElement('div');
    box.innerHTML = `<div class="p-hint">文件在编辑器之外被修改（agent 或 CLI）。<br>服务器当前修订号：<strong>${r.currentRevision}</strong>，本次保存基于：<strong>${base}</strong>。<br><br>建议"加载最新"以免覆盖；选择"强制保存"将以当前画布内容覆盖外部修改（可撤销）。</div>`;
    openModal('修订号冲突', box, [
      ['加载最新', async () => { closeModal(); await openProjectByName(state.name, { silent: true }); toast('已加载最新版本', 'ok'); }],
      ['强制保存', async () => { closeModal(); await save({ force: true }); }, 'danger'],
    ]);
    return;
  }
  toast('保存失败：' + (r.error || '未知错误'), 'bad');
}

// ---------- 外部修改（SSE） ----------
function connect() {
  connectEvents(async (msg) => {
    if (msg.type === 'changed' && msg.name === state.name) {
      const r = await getProject(state.name);
      if (!r.ok) return;
      if (state.dirty) {
        const box = document.createElement('div');
        box.innerHTML = `<div class="p-hint">文件被外部修改（新修订号 ${r.doc.revision}），但当前画布有未保存修改。<br><br>保留我的修改：不做任何变更；加载最新：丢弃未保存修改并载入外部版本（未保存内容可撤销找回）。</div>`;
        openModal('外部修改', box, [
          ['保留我的修改', () => { state._serverRevision = r.doc.revision; closeModal(); }],
          ['加载最新', async () => { closeModal(); await openProjectByName(state.name, { silent: true }); }],
        ]);
      } else {
        adoptExternal(adoptDocForSession(r.doc));
        toast('设计已被外部修改（agent/CLI），已自动刷新；可撤销', 'info');
      }
    }
  });
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
  $('btn-left-toggle').addEventListener('click', () => { document.body.classList.toggle('hide-left'); syncPanelToggles(); });
  $('btn-right-toggle').addEventListener('click', () => { document.body.classList.toggle('hide-right'); syncPanelToggles(); });
  $('btn-help').addEventListener('click', showShortcuts);
  $('btn-check').addEventListener('click', runCheck);
  $('btn-export').addEventListener('click', runExport);
  syncPanelToggles();
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

  const last = localStorage.getItem('uiforge:last');
  let opened = false;
  if (last) opened = await openProjectByName(last, { silent: true });
  if (!opened) {
    const projects = await listProjects();
    if (projects.length) opened = await openProjectByName(projects[0].name, { silent: true });
  }
  if (!opened) {
    // 无项目：创建示例（网站模式，方便上手）
    const r = await createProject('示例页面', 'web');
    if (r.ok) await openProjectByName('示例页面', { silent: true });
    else await showOpenDialog();
  }
  setTimeout(fitZoom, 60);
  connect();
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

boot();
