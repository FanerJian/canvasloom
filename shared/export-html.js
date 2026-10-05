// ============================================================
// UIDoc 自包含预览页生成器
// 三种运行模式（按 URL 参数自动判定）：
//   ?embed=1   编辑器 iframe 内嵌：监听 postMessage 测量请求，回传快照
//   ?static=1  无头渲染：按窗口大小渲染；&dump=1 时把快照 JSON 写入 <pre id="dump-output">
//   （默认）    独立交互页：视口选择 + 测量 + 截图（html2canvas）+ 快照下载
// v3 文档：按变体（页面注入的 CANVASLOOM_VARIANT 或 activeVariant）解析成 v2 形状
//          再渲染，并接入交互运行时（toggle/open/close、Esc、遮罩、焦点回归）；
//          内联顺序 modes→protocol→resolve→runtime→renderer（inlineModule 剥
//          import/export，多个 <script> 依序共享全局作用域，顺序即依赖）。
// ============================================================

function esc(s) { return String(s).replace(/<\/script/gi, '<\\/script'); }
function jsonForScript(v) { return JSON.stringify(v == null ? null : v).replace(/</g, '\\u003c'); }

// 把 ES 模块源码转成经典脚本（剥掉 import/export，靠多个 <script> 依序共享全局作用域）
function inlineModule(src) {
  return String(src)
    .replace(/^import\s+[^;]*?from\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^import\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/^export\s+(function|const|let|var|class)\s+/gm, '$1 ');
}

const BOOTSTRAP = String.raw`
(function () {
  'use strict';
  var DOC = JSON.parse(document.getElementById('doc-data').textContent);
  var params = new URLSearchParams(location.search);
  var MODE = params.get('static') ? 'static' : (params.get('embed') || window.parent !== window ? 'embed' : 'interactive');
  // 独立交互页只有 #frame（视口容器），内嵌/静态页用 #app；统一解析
  var app = document.getElementById('app') || document.getElementById('frame');

  // v3 文档先按变体解析成 v2 形状再渲染（v2 文档原样渲染，行为与今天完全一致）：
  // 变体 = 页面注入的 CANVASLOOM_VARIANT（CLI --variant）或文档的 activeVariant。
  // 解析/渲染失败在页面上显示明确错误卡（错误码+信息），绝不白屏。
  function showRenderError(e) {
    app.textContent = '';
    var card = document.createElement('div');
    card.style.cssText = 'margin:48px auto;max-width:560px;padding:20px 24px;border:1px solid #fca5a5;'
      + 'border-radius:8px;background:#fef2f2;color:#7f1d1d;font:14px/1.9 system-ui,"Microsoft YaHei",sans-serif;';
    var head = document.createElement('div');
    head.textContent = '✗ 渲染失败';
    head.style.cssText = 'font-weight:bold;font-size:15px;margin-bottom:8px;';
    var code = document.createElement('div');
    code.textContent = '错误码：' + (e && e.code ? e.code : 'E_RENDER');
    var msg = document.createElement('div');
    msg.textContent = '信息：' + (e && e.message ? e.message : String(e));
    card.appendChild(head); card.appendChild(code); card.appendChild(msg);
    app.appendChild(card);
  }

  function renderAt(w, h) {
    try {
      var docToRender = DOC;
      if (DOC.version === 3) {
        if (!(window.CanvasLoomResolve && typeof window.CanvasLoomResolve.resolveVariant === 'function')) {
          var err0 = new Error('变体解析器（shared/resolve.js）未随页面加载，无法渲染 v3 文档');
          err0.code = 'E_RESOLVE_SOURCE_MISSING';
          throw err0;
        }
        var vid = (typeof window.CANVASLOOM_VARIANT !== 'undefined' && window.CANVASLOOM_VARIANT) || DOC.activeVariant;
        docToRender = window.CanvasLoomResolve.resolveVariant(DOC, vid);
      }
      if (window.CanvasLoomRenderer && window.CanvasLoomRenderer.renderDoc) {
        return window.CanvasLoomRenderer.renderDoc(app, docToRender, { viewport: { width: w, height: h }, editable: MODE !== 'static' });
      }
      throw new Error('renderer missing');
    } catch (e) {
      showRenderError(e);
      return null;
    }
  }

  // v3 渲染成功后接入交互运行时（toggle/open/close、Esc、遮罩、焦点回归）；
  // spec 从原 v3 文档提取（overrides 只动 style，直接读 presentation 组件树）。
  // v2 文档不 init runtime；static 模式是无头测量，保持完整设计可见性。
  var runtime = null;
  function setupInteractions() {
    if (runtime) { runtime.destroy(); runtime = null; }
    if (DOC.version !== 3 || MODE === 'static') return;
    if (!(window.CanvasLoomRuntime && typeof window.CanvasLoomRuntime.initInteractions === 'function')) return;
    var vid = (typeof window.CANVASLOOM_VARIANT !== 'undefined' && window.CANVASLOOM_VARIANT) || DOC.activeVariant;
    var rootEl = app.firstElementChild;
    if (!rootEl) return;
    var spec = typeof window.CanvasLoomRuntime.extractInteractionSpec === 'function'
      ? window.CanvasLoomRuntime.extractInteractionSpec(DOC, vid)
      : { initiallyClosed: [], actions: {} };
    runtime = window.CanvasLoomRuntime.initInteractions({ rootEl: rootEl, spec: spec });
  }

  function waitImages(root) {
    var imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
    return Promise.all(imgs.map(function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (res) { img.onload = img.onerror = res; });
    }));
  }

  function nextFrames(n) {
    return new Promise(function (res) {
      var i = 0; (function tick() { if (i++ >= n) return res(); requestAnimationFrame(tick); })();
    });
  }

  function computeSnapshot(viewport) {
    var rootEl = app.firstElementChild;
    if (!rootEl) return { revision: DOC.revision, viewport: viewport, measured: {} };
    var base = rootEl.getBoundingClientRect();
    var measured = {};
    var nodes = rootEl.querySelectorAll('[data-id]');
    measured.root = { x: 0, y: 0, width: base.width, height: base.height, visible: base.width > 0 && base.height > 0 };
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      var id = el.getAttribute('data-id');
      // bl/bt：左边框/上边框宽度（自由布局位置检查换算需要，见 measure.js）
      var cs = getComputedStyle(el);
      measured[id] = {
        x: +(r.left - base.left).toFixed(2),
        y: +(r.top - base.top).toFixed(2),
        width: +r.width.toFixed(2),
        height: +r.height.toFixed(2),
        visible: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none',
        bl: parseFloat(cs.borderLeftWidth) || 0,
        bt: parseFloat(cs.borderTopWidth) || 0
      };
    }
    return { revision: DOC.revision, viewport: viewport, measuredAt: new Date().toISOString(), measured: measured };
  }

  // 测量不依赖 rAF（后台标签页 rAF 会被节流到 0 导致永久等待）：
  // getBoundingClientRect 会强制同步布局，图片只等 complete/超时。
  function measure(viewport) {
    var rootEl = app.firstElementChild;
    return waitImages(rootEl || app).then(function () {
      return computeSnapshot(viewport || { width: window.innerWidth, height: window.innerHeight });
    });
  }

  // ---------- embed 模式 ----------
  if (MODE === 'embed') {
    window.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type === 'canvasloom:measure') {
        measure(d.viewport).then(function (snap) {
          window.parent.postMessage({ type: 'canvasloom:measured', snapshot: snap }, '*');
        }).catch(function (e) {
          window.parent.postMessage({ type: 'canvasloom:error', message: String(e && e.message || e) }, '*');
        });
      } else if (d.type === 'canvasloom:render') {
        if (renderAt(d.width || window.innerWidth, d.height || window.innerHeight)) setupInteractions();
      }
    });
    if (renderAt(window.innerWidth, window.innerHeight)) setupInteractions();
    return;
  }

  // ---------- static 模式（无头截图/快照） ----------
  if (MODE === 'static') {
    renderAt(window.innerWidth, window.innerHeight);
    if (params.get('dump')) {
      measure().then(function (snap) {
        var pre = document.createElement('pre');
        pre.id = 'dump-output';
        pre.textContent = 'BEGIN_CANVASLOOM_SNAPSHOT\n' + JSON.stringify(snap) + '\nEND_CANVASLOOM_SNAPSHOT';
        document.body.appendChild(pre);
        document.title = 'CANVASLOOM_DUMP_OK';
      }).catch(function (e) {
        var pre = document.createElement('pre');
        pre.id = 'dump-output';
        pre.textContent = 'BEGIN_CANVASLOOM_SNAPSHOT\n' + JSON.stringify({ error: String(e) }) + '\nEND_CANVASLOOM_SNAPSHOT';
        document.body.appendChild(pre);
      });
    }
    return;
  }

  // ---------- interactive 模式 ----------
  var PRESETS = [
    ['设计画布', null], ['1280 × 800', [1280, 800]], ['1024 × 768', [1024, 768]],
    ['768 × 1024', [768, 1024]], ['375 × 667', [375, 667]]
  ];
  var bar = document.getElementById('bar');
  var stage = document.getElementById('stage');
  var frame = document.getElementById('frame');
  var sel = document.getElementById('viewport-sel');
  var cw = document.getElementById('custom-w'), ch = document.getElementById('custom-h');

  function currentViewport() {
    var v = PRESETS[+sel.value];
    if (!v[1]) {
      var w = parseInt(cw.value, 10) || DOC.canvas.width;
      var h = parseInt(ch.value, 10) || DOC.canvas.height;
      return { width: w, height: h, label: w + ' × ' + h };
    }
    return { width: v[1][0], height: v[1][1], label: v[0] };
  }

  function applyViewport() {
    var v = currentViewport();
    frame.style.width = v.width + 'px';
    frame.style.height = v.height + 'px';
    document.getElementById('viewport-label').textContent = '当前视口：' + v.label + '　修订号：' + DOC.revision;
    if (renderAt(v.width, v.height)) setupInteractions();
  }
  sel.addEventListener('change', function () { applyViewport(); });
  document.getElementById('btn-rerender').addEventListener('click', applyViewport);
  document.getElementById('btn-measure').addEventListener('click', function () {
    var v = currentViewport();
    measure(v).then(function (snap) {
      window.__canvasloomSnapshot = snap;
      var out = document.getElementById('measure-out');
      out.style.display = 'block';
      var rows = [];
      Object.keys(snap.measured).forEach(function (id) {
        var m = snap.measured[id];
        if (!m.visible) return;
        rows.push(id + '：x=' + m.x + ' y=' + m.y + ' w=' + m.width + ' h=' + m.height);
      });
      out.textContent = rows.join('\n');
    });
  });
  document.getElementById('btn-snapshot').addEventListener('click', function () {
    var v = currentViewport();
    measure(v).then(function (snap) {
      download(JSON.stringify(snap, null, 2), 'snapshot.json', 'application/json');
    });
  });
  document.getElementById('btn-shot').addEventListener('click', function () {
    if (!window.html2canvas) { alert('未内置 html2canvas'); return; }
    var v = currentViewport();
    window.html2canvas(app.firstElementChild, { backgroundColor: '#ffffff', scale: 1, windowWidth: v.width, windowHeight: v.height })
      .then(function (canvas) { download(canvas.toDataURL('image/png'), 'screenshot.png', 'image/png'); });
  });
  function download(content, name, mime) {
    var a = document.createElement('a');
    var isData = String(content).indexOf('data:') === 0;
    a.href = isData ? content : URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name; a.click();
  }
  applyViewport();
})();
`;

export function buildPreviewHtml({ doc, modesSource, protocolSource, resolveSource, runtimeSource, rendererSource, html2canvasSource, title, variantId }) {
  const t = title || (doc && doc.name) || 'CanvasLoom 预览';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t)}</title>
<style>
  html, body { margin: 0; padding: 0; background: #eef1f5; height: 100%; }
  /* #app 供 ?static=1 无头渲染使用，撑满视口让 percent 根容器有确定基准 */
  #app { margin: 0; width: 100%; height: 100%; }
  #bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: #1f2937; color: #e5e7eb;
         font: 13px/1.6 "Microsoft YaHei", system-ui, sans-serif; position: sticky; top: 0; z-index: 10; flex-wrap: wrap; }
  #bar button, #bar select, #bar input { font: inherit; padding: 3px 10px; border-radius: 5px; border: 1px solid #4b5563;
         background: #374151; color: #e5e7eb; cursor: pointer; }
  #bar input { width: 64px; cursor: text; }
  #stage { padding: 24px; display: flex; justify-content: center; align-items: flex-start; overflow: auto; }
  #frame { background: #ffffff; box-shadow: 0 2px 16px rgba(0,0,0,.18); position: relative; flex: none; }
  #measure-out { display: none; margin: 0; padding: 12px 16px; background: #0b1220; color: #86efac;
         font: 12px/1.7 Consolas, monospace; white-space: pre; max-height: 220px; overflow: auto; }
</style>
<script>${html2canvasSource ? esc(html2canvasSource) : ''}</script>
<script>${esc(inlineModule(modesSource || ''))}</script>
<script>${esc(inlineModule(protocolSource || ''))}</script>
<script>${esc(inlineModule(resolveSource || ''))}</script>
<script>${esc(inlineModule(runtimeSource || ''))}</script>
<script>${esc(inlineModule(rendererSource || ''))}</script>
<script>window.CanvasLoomRenderer = { renderDoc: typeof renderDoc === 'function' ? renderDoc : null };</script>
<script>window.CanvasLoomResolve = { resolveVariant: typeof resolveVariant === 'function' ? resolveVariant : null };</script>
<script>window.CanvasLoomRuntime = { initInteractions: typeof initInteractions === 'function' ? initInteractions : null,
  extractInteractionSpec: typeof extractInteractionSpec === 'function' ? extractInteractionSpec : null };</script>
<script>window.CANVASLOOM_VARIANT = ${jsonForScript(variantId)};</script>
</head>
<body>
<div id="bar">
  <strong>CanvasLoom 预览</strong>
  <span id="viewport-label"></span>
  <select id="viewport-sel">
    ${['设计画布', '1280 × 800', '1024 × 768', '768 × 1024', '375 × 667'].map((label, i) => `<option value="${i}">${label}</option>`).join('')}
  </select>
  <input id="custom-w" type="number" placeholder="宽">×<input id="custom-h" type="number" placeholder="高">
  <button id="btn-rerender">应用视口</button>
  <button id="btn-measure">测量布局</button>
  <button id="btn-snapshot">下载快照</button>
  <button id="btn-shot">截图</button>
</div>
<div id="stage"><div id="frame"></div></div>
<pre id="measure-out"></pre>
<script id="doc-data" type="application/json">${jsonForScript(doc)}</script>
<script>${esc(BOOTSTRAP)}</script>
</body>
</html>
`;
}

// 供编辑器 srcdoc 使用的精简内嵌页（只含渲染 + 测量协议；v3 文档附加变体解析与交互运行时）
export function buildEmbedHtml({ doc, modesSource, protocolSource, resolveSource, runtimeSource, rendererSource, viewport }) {
  const vp = viewport || { width: doc.canvas.width, height: doc.canvas.height };
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: #ffffff; width: 100%; height: 100%; }
  /* #app 撑满视口：让 percent 尺寸的根容器有确定的高度基准 */
  #app { width: 100%; height: 100%; position: relative; }
</style>
<script>${esc(inlineModule(modesSource || ''))}</script>
<script>${esc(inlineModule(protocolSource || ''))}</script>
<script>${esc(inlineModule(resolveSource || ''))}</script>
<script>${esc(inlineModule(runtimeSource || ''))}</script>
<script>${esc(inlineModule(rendererSource || ''))}</script>
<script>window.CanvasLoomRenderer = { renderDoc: typeof renderDoc === 'function' ? renderDoc : null };</script>
<script>window.CanvasLoomResolve = { resolveVariant: typeof resolveVariant === 'function' ? resolveVariant : null };</script>
<script>window.CanvasLoomRuntime = { initInteractions: typeof initInteractions === 'function' ? initInteractions : null,
  extractInteractionSpec: typeof extractInteractionSpec === 'function' ? extractInteractionSpec : null };</script>
</head>
<body>
<div id="app"></div>
<script id="doc-data" type="application/json">${jsonForScript(doc)}</script>
<script>${esc(BOOTSTRAP)}</script>
</body>
</html>
`;
}
