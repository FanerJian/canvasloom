// ============================================================
// 服务端 API 封装（同源 /api/*）
// ============================================================

async function toJson(r) {
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
}

export async function listProjects() {
  const r = await toJson(await fetch('/api/projects'));
  return r.ok ? r.projects : [];
}

export async function getProject(name) {
  return toJson(await fetch('/api/project?name=' + encodeURIComponent(name)));
}

export async function createProject(name, mode, startLayout, template) {
  return toJson(await fetch('/api/project', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mode, layout: startLayout, template: template || 'blank' }),
  }));
}

export async function saveProject(name, doc, baseRevision) {
  return toJson(await fetch('/api/project', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, doc, baseRevision }),
  }));
}

export async function exportBundle(payload) {
  return toJson(await fetch('/api/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

export function connectEvents(handler, onConnChange) {
  const es = new EventSource('/api/events');
  es.onopen = () => { if (onConnChange) onConnChange(false); };
  es.onmessage = (e) => {
    try { handler(JSON.parse(e.data)); } catch { /* 忽略坏消息 */ }
  };
  es.onerror = () => { if (onConnChange) onConnChange(true); /* 断线后 EventSource 自动重连 */ };
  return es;
}

let rendererSrcPromise = null;
let protocolSrcPromise = null;
let modesSrcPromise = null;
let resolveSrcPromise = null;
let runtimeSrcPromise = null;
export function loadRendererSource() {
  if (!rendererSrcPromise) rendererSrcPromise = fetch('/shared/renderer.js').then((r) => r.text());
  return rendererSrcPromise;
}
export function loadModesSource() {
  if (!modesSrcPromise) modesSrcPromise = fetch('/shared/modes.js').then((r) => r.text()).catch(() => '');
  return modesSrcPromise;
}
export function loadProtocolSource() {
  if (!protocolSrcPromise) protocolSrcPromise = fetch('/shared/protocol.js').then((r) => r.text());
  return protocolSrcPromise;
}
// v3 预览需要变体解析器与交互运行时：与 renderer/protocol 同法内联进 srcdoc
export function loadResolveSource() {
  if (!resolveSrcPromise) resolveSrcPromise = fetch('/shared/resolve.js').then((r) => r.text());
  return resolveSrcPromise;
}
export function loadRuntimeSource() {
  if (!runtimeSrcPromise) runtimeSrcPromise = fetch('/shared/runtime.js').then((r) => r.text());
  return runtimeSrcPromise;
}
