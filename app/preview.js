// ============================================================
// 预览与检查：真实视口预览、布局快照实测、检查报告、导出包
// ============================================================
import { state, select, setMode, setPreviewViewport, viewDoc } from './store.js';
import { renderDoc } from '../shared/renderer.js';
import { validateDoc } from '../shared/validate.js';
import { checkSnapshot } from '../shared/measure.js';
import { buildEmbedHtml } from '../shared/export-html.js';
import { loadRendererSource, loadModesSource, loadProtocolSource, loadResolveSource, loadRuntimeSource, exportBundle } from './api.js';
import { openModal, closeModal, toast } from './panels.js';

const VIEWPORTS = [
  ['设计画布', null],
  ['1920 × 1080', [1920, 1080]],
  ['1440 × 900', [1440, 900]],
  ['1280 × 800', [1280, 800]],
  ['1024 × 768', [1024, 768]],
  ['768 × 1024', [768, 1024]],
  ['390 × 844', [390, 844]],
  ['375 × 667', [375, 667]],
];

// ================= 预览面板 =================
export function renderPreviewPane() {
  const pane = document.getElementById('preview-pane');
  const canvasWrap = document.getElementById('canvas-wrap');
  if (state.mode !== 'preview') {
    pane.classList.add('hidden');
    canvasWrap.classList.remove('hidden');
    return;
  }
  pane.classList.remove('hidden');
  canvasWrap.classList.add('hidden');
  buildPreviewFrame();
}

async function buildPreviewFrame() {
  const frame = document.getElementById('pv-frame');
  const vp = state.previewViewport || [state.doc.canvas.width, state.doc.canvas.height];
  frame.style.width = vp[0] + 'px';
  frame.style.height = vp[1] + 'px';
  const [src, protoSrc, modesSrc, resolveSrc, runtimeSrc] = await Promise.all([
    loadRendererSource(), loadProtocolSource(), loadModesSource(), loadResolveSource(), loadRuntimeSource(),
  ]);
  // v3 文档：内嵌变体解析器与交互运行时，预览页与导出页行为一致（按钮可点开/关面板）
  frame.srcdoc = buildEmbedHtml({
    doc: state.doc, modesSource: modesSrc, protocolSource: protoSrc,
    resolveSource: resolveSrc, runtimeSource: runtimeSrc, rendererSource: src,
  });
  const label = document.getElementById('pv-label');
  if (label) label.textContent = `视口 ${vp[0]} × ${vp[1]} · 修订号 ${state.revision}`;
}

export function initPreviewBar() {
  const sel = document.getElementById('pv-viewport');
  for (const [label, vp] of VIEWPORTS) {
    const o = document.createElement('option');
    o.value = vp ? vp.join('x') : 'canvas';
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    const v = sel.value;
    setPreviewViewport(v === 'canvas' ? null : v.split('x').map(Number));
  });
  document.getElementById('pv-close').addEventListener('click', () => setMode('design'));
}

// ================= 隐藏实测（布局快照） =================
// 注意：测量不依赖 requestAnimationFrame（页面隐藏时 rAF 会被节流到 0）。
// getBoundingClientRect 本身会强制同步布局；图片用 complete/decode 等待。
async function waitForImages(scope) {
  const imgs = [...scope.querySelectorAll('img')];
  await Promise.all(imgs.map((img) => {
    if (img.complete) return Promise.resolve();
    return Promise.race([
      new Promise((res) => { img.onload = img.onerror = res; }),
      new Promise((res) => setTimeout(res, 3000)),
    ]);
  }));
}

export async function measureHidden(doc, viewport) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + viewport.width + 'px;height:' + viewport.height + 'px;overflow:hidden;';
  const inner = document.createElement('div');
  inner.style.cssText = 'width:' + viewport.width + 'px;height:' + viewport.height + 'px;position:relative;overflow:hidden;';
  holder.appendChild(inner);
  document.body.appendChild(holder);
  try {
    renderDoc(inner, doc, { viewport, editable: false });
    await waitForImages(inner);
    const rootEl = inner.firstElementChild;
    const base = rootEl.getBoundingClientRect();
    const measured = {
      root: { x: 0, y: 0, width: round2(base.width), height: round2(base.height), visible: base.width > 0 && base.height > 0 },
    };
    for (const node of rootEl.querySelectorAll('[data-id]')) {
      const r = node.getBoundingClientRect();
      // 边框宽度随快照记录：自由布局 position 相对父容器内容区（padding 盒 + padding），
      // 检查换算需要 border 偏移（与渲染器 style.left = padding + position 的约定一致）
      const cs = getComputedStyle(node);
      measured[node.dataset.id] = {
        x: round2(r.left - base.left), y: round2(r.top - base.top),
        width: round2(r.width), height: round2(r.height),
        visible: r.width > 0 && r.height > 0 && getComputedStyle(node).display !== 'none',
        bl: (parseFloat(cs.borderLeftWidth) || 0), bt: (parseFloat(cs.borderTopWidth) || 0),
      };
    }
    return {
      revision: doc.revision, viewport,
      measuredAt: new Date().toISOString(),
      measured,
    };
  } finally {
    holder.remove();
  }
}
const round2 = (n) => Math.round(n * 100) / 100;
function nextFrame(n) {
  return new Promise((res) => {
    let i = 0;
    (function tick() { if (i++ >= n) return res(); requestAnimationFrame(tick); })();
  });
}

// ================= 检查布局 =================
export async function runCheck() {
  const doc = state.doc;
  const view = viewDoc();
  const renderBase = view || doc; // v3 解析失败时退回原文档给出结构错误
  const vp = state.previewViewport ? { width: state.previewViewport[0], height: state.previewViewport[1] } : { width: renderBase.canvas.width, height: renderBase.canvas.height };
  toast('正在实测布局……');
  const snapshot = await measureHidden(renderBase, vp);
  const staticReport = validateDoc(doc); // 结构检查恒对原文档（v3 覆盖全部 presentation）
  const measureReport = checkSnapshot(renderBase, snapshot);
  state.lastCheck = { snapshot, staticReport, measureReport, viewport: vp };
  window.__lastCheck = state.lastCheck; // 调试/自动化检查出口
  showReport();
}

function showReport() {
  const { staticReport, measureReport, viewport } = state.lastCheck;
  const issues = [...staticReport.issues, ...(measureReport ? measureReport.issues : [])];
  const errCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warning').length;

  const box = document.createElement('div');
  box.className = 'report-box';
  const head = document.createElement('div');
  head.className = 'report-head' + (errCount ? ' bad' : warnCount ? ' warn' : ' good');
  head.innerHTML = `<strong>${errCount ? '✗' : warnCount ? '△' : '✓'} ${errCount} 个错误 · ${warnCount} 个警告</strong>` +
    `<span class="report-scope">视口 ${viewport.width} × ${viewport.height}；结构检查覆盖全部组件，实测检查覆盖该视口下的显示结果。</span>`;
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'report-list';
  if (!issues.length) {
    const empty = document.createElement('div');
    empty.className = 'report-issue';
    empty.textContent = '没有发现问题：结构合法，且在该视口下无溢出、越界或重叠。';
    list.appendChild(empty);
  }
  for (const it of issues) {
    const row = document.createElement('div');
    row.className = 'report-issue sev-' + it.severity;
    row.innerHTML = `<span class="ri-badge">${it.severity === 'error' ? '错误' : '警告'}</span>` +
      `<span class="ri-code">${it.code}</span>` +
      `<span class="ri-msg">${escapeHtml(it.message)}</span>` +
      (it.componentId ? `<button class="p-btn ri-loc">定位</button>` : '');
    if (it.componentId) {
      row.querySelector('.ri-loc').addEventListener('click', () => {
        setMode('design');
        select(it.componentId);
        closeModal();
      });
    }
    list.appendChild(row);
  }
  box.appendChild(list);
  openModal('布局检查结果', box, [['关闭', () => closeModal()]]);
}

// ================= 导出 =================
export async function runExport() {
  const doc = state.doc;
  const box = document.createElement('div');
  box.className = 'export-box';
  box.innerHTML = `
    <div class="p-row"><label class="p-label">预览视口</label>
      <select id="exp-vp" class="p-input">
        ${VIEWPORTS.map(([label, vp]) => `<option value="${vp ? vp.join('x') : 'canvas'}">${label}${vp ? '' : `（${doc.canvas.width}×${doc.canvas.height}）`}</option>`).join('')}
      </select></div>
    <div class="p-row"><label class="p-check"><input type="checkbox" id="exp-shot" checked> 包含页面截图（PNG）</label></div>
    <div class="p-row"><label class="p-check"><input type="checkbox" id="exp-snap" checked> 包含布局快照（实测位置）与检查报告</label></div>
    <div class="p-hint">导出内容写入 exports 目录：设计文件、snapshot.json、report.json、自包含 preview.html、screenshot.png。</div>`;
  openModal('导出设计', box, [
    ['取消', () => closeModal()],
    ['导出', async () => {
      const vpSel = box.querySelector('#exp-vp').value;
      const vp = vpSel === 'canvas' ? { width: doc.canvas.width, height: doc.canvas.height } : (() => { const [w, h] = vpSel.split('x').map(Number); return { width: w, height: h }; })();
      const wantShot = box.querySelector('#exp-shot').checked;
      const wantSnap = box.querySelector('#exp-snap').checked;
      closeModal();
      toast('正在生成导出包……');
      const view = viewDoc() || doc; // 实测/截图按解析视图；结构与打包用原文档
      let snapshot = null, report = null, screenshot = null;
      if (wantSnap || wantShot) snapshot = await measureHidden(view, vp);
      if (wantSnap) {
        const staticReport = validateDoc(doc);
        const mReport = checkSnapshot(view, snapshot);
        report = { static: staticReport, measure: mReport,
          errors: [...staticReport.errors, ...mReport.errors], warnings: [...staticReport.warnings, ...mReport.warnings] };
      }
      if (wantShot) {
        try { screenshot = await capturePng(view, vp); }
        catch (e) { toast('截图失败：' + e.message, 'warn'); }
      }
      const r = await exportBundle({ name: state.name, doc, snapshot, report, screenshot });
      if (r.ok) toast('已导出到 ' + r.dir, 'ok');
      else toast('导出失败：' + (r.error || '未知错误'), 'bad');
    }],
  ]);
}

async function capturePng(doc, viewport) {
  if (typeof window.html2canvas !== 'function') throw new Error('html2canvas 未加载');
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${viewport.width}px;height:${viewport.height}px;overflow:hidden;background:#fff;`;
  const inner = document.createElement('div');
  inner.style.cssText = `width:${viewport.width}px;height:${viewport.height}px;position:relative;`;
  holder.appendChild(inner);
  document.body.appendChild(holder);
  try {
    renderDoc(inner, doc, { viewport, editable: false });
    await waitForImages(inner);
    // html2canvas 内部依赖渲染帧：页面隐藏（rAF 节流）时限时兜底，避免导出卡死
    const canvas = await Promise.race([
      window.html2canvas(inner.firstElementChild, { backgroundColor: '#ffffff', scale: 1, logging: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('截图超时（页面处于后台，请切回编辑器窗口后重试）')), 12000)),
    ]);
    return canvas.toDataURL('image/png');
  } finally {
    holder.remove();
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
