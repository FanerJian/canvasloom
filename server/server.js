// ============================================================
// CanvasLoom 本地服务端 —— 零依赖，仅监听 127.0.0.1
//   静态托管 app/ shared/ vendor/
//   项目文件读写 API（修订号冲突检测 + 原子写入 + SSE 通知）
//   导出包落盘（设计文件 + 快照 + 报告 + 自包含预览页 + 截图）
// 本服务不向任何外部地址发起请求，也不启动任何子进程。
// ============================================================
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateDoc } from '../shared/validate.js';
import { newDoc } from '../shared/protocol.js';
import { applyTemplate } from '../shared/templates.js';
import { UI_MODES, DEFAULT_MODE } from '../shared/modes.js';
import { buildPreviewHtml } from '../shared/export-html.js';
import { withFileLock, lockFileFor } from '../shared/filelock.js';
import { backupV1BeforeWrite, backupBeforeUpgrade } from '../shared/backup.js';
import { checkAiPolicy } from '../shared/intent.js';
import { publishExportDir, exportTaskSuffix } from '../shared/exportdir.js';
import { inspectDocVersion, isSupportedVersion, SUPPORTED_VERSIONS, CompatError } from '../shared/compat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const EXPORTS_DIR = path.join(ROOT, 'exports');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const SHARED_DIR = path.join(ROOT, 'shared');
const APP_DIR = path.join(ROOT, 'app');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = parseInt(argValue('--port', '8520'), 10) || 8520;

const NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5][A-Za-z0-9_\-\u4e00-\u9fa5 ]{0,63}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};

// ---------- SSE ----------
const sseClients = new Set();
const projectMtimes = new Map();
function rememberProjectWrite(name, file) {
  try { projectMtimes.set(name, fsSync.statSync(file).mtimeMs); } catch { /* 轮询下一次重新读取 */ }
}
function broadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}

// ---------- 工具 ----------
function send(res, status, data, mime = 'application/json; charset=utf-8') {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  res.end(body);
}
function badRequest(res, msg) { send(res, 400, { ok: false, error: msg }); }

function safeName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) return null;
  return name;
}
const projectFile = (name) => path.join(PROJECTS_DIR, name + '.uidoc.json');

async function readProject(name) {
  const raw = await fs.readFile(projectFile(name), 'utf8');
  return JSON.parse(raw);
}

async function atomicWrite(file, content) {
  const tmp = file + '.tmp-' + randomUUID();
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

// 同步原子写（用于写锁临界区内，保证比较与写入是一个事务）
function atomicWriteSync(file, content) {
  const tmp = file + '.tmp-' + randomUUID();
  fsSync.writeFileSync(tmp, content, 'utf8');
  fsSync.renameSync(tmp, file);
}

async function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function loadRendererSource() {
  return fs.readFile(path.join(SHARED_DIR, 'renderer.js'), 'utf8');
}
async function loadModesSource() {
  try { return await fs.readFile(path.join(SHARED_DIR, 'modes.js'), 'utf8'); } catch { return ''; }
}
async function loadProtocolSource() {
  return fs.readFile(path.join(SHARED_DIR, 'protocol.js'), 'utf8');
}
// v3 预览页需要变体解析器与交互运行时（M5 补齐 M3 遗留：编辑器侧导出/独立预览页此前缺这两个源码）
async function loadResolveSource() {
  return fs.readFile(path.join(SHARED_DIR, 'resolve.js'), 'utf8');
}
async function loadRuntimeSource() {
  return fs.readFile(path.join(SHARED_DIR, 'runtime.js'), 'utf8');
}
async function loadHtml2Canvas() {
  try { return await fs.readFile(path.join(VENDOR_DIR, 'html2canvas.min.js'), 'utf8'); }
  catch { return ''; }
}

// 解析 dataURL（用 String.match 而非正则的点号匹配方法）
function dataUrlToBuffer(dataUrl) {
  const m = (dataUrl || '').match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  return { ext: m[1] === 'jpeg' ? 'jpg' : m[1], buf: Buffer.from(m[2], 'base64') };
}

// ---------- API 处理 ----------
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/hello' && req.method === 'GET') {
    return send(res, 200, { ok: true, name: 'CanvasLoom', root: ROOT, projects: PROJECTS_DIR, protocolVersion: 4, supportedVersions: SUPPORTED_VERSIONS, capabilities: { designIntent: true, aiPolicy: true } });
  }

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"hello"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/projects' && req.method === 'GET') {
    let files = [];
    try { files = await fs.readdir(PROJECTS_DIR); } catch { files = []; }
    const list = [];
    for (const f of files) {
      if (!f.endsWith('.uidoc.json')) continue;
      try {
        const st = await fs.stat(path.join(PROJECTS_DIR, f));
        const doc = JSON.parse(await fs.readFile(path.join(PROJECTS_DIR, f), 'utf8'));
        // 项目稳定身份 = 文件名（去掉扩展名）；doc.name 只是展示名，可被 CLI 独立修改。
        // 打开/保存/事件通知一律用稳定身份（S1 B07），展示名仅供界面显示。
        const id = f.slice(0, -'.uidoc.json'.length);
        list.push({ id, name: doc.name || id, file: f, revision: doc.revision, updatedAt: st.mtime.toISOString() });
      } catch { /* 跳过损坏文件 */ }
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return send(res, 200, { ok: true, projects: list });
  }

  if (p === '/api/project' && req.method === 'GET') {
    const name = safeName(url.searchParams.get('name'));
    if (!name) return badRequest(res, '项目名不合法');
    try {
      const doc = await readProject(name);
      try { inspectDocVersion(doc); }
      catch (e) {
        if (e instanceof CompatError) {
          return send(res, 422, { ok: false, error: e.message, code: e.code, version: doc.version });
        }
        throw e;
      }
      return send(res, 200, { ok: true, doc });
    } catch (e) {
      return send(res, 404, { ok: false, error: '项目不存在或读取失败：' + e.message });
    }
  }

  if (p === '/api/project' && req.method === 'POST') { // 新建
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return badRequest(res, 'JSON 解析失败'); }
    const name = safeName(body.name);
    if (!name) return badRequest(res, '项目名不合法（1-64 字符，可为中文）');
    const mode = body.mode && UI_MODES[body.mode] ? body.mode : DEFAULT_MODE;
    // 起步布局：free（自由摆放，推荐）或 vertical（自动排列）；其余按 vertical
    const startLayout = body.layout === 'free' ? 'free' : 'vertical';
    // 起步模板（S2）：blank=纯空白；未知模板名按 blank 处理（applyTemplate 内部兜底）
    const templateId = typeof body.template === 'string' ? body.template : 'blank';
    const file = projectFile(name);
    let result;
    try {
      // 锁内检查存在性并写入，避免并发创建双写
      result = withFileLock(lockFileFor(file), () => {
        if (fsSync.existsSync(file)) return { exists: true };
        const doc = applyTemplate(newDoc(name, mode, startLayout), templateId);
        atomicWriteSync(file, JSON.stringify(doc, null, 2));
        rememberProjectWrite(name, file);
        return { ok: true, doc };
      });
    } catch (e) {
      return send(res, 500, { ok: false, error: '创建失败：' + e.message });
    }
    if (result.exists) return send(res, 409, { ok: false, error: '项目已存在' });
    broadcast({ type: 'projects-changed' });
    return send(res, 200, { ok: true, doc: result.doc });
  }

  if (p === '/api/project' && req.method === 'PUT') { // 保存（修订号冲突检测 + 项目写锁）
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return badRequest(res, 'JSON 解析失败'); }
    const name = safeName(body.name);
    if (!name) return badRequest(res, '项目名不合法');
    const doc = body.doc;
    if (!doc || doc.format !== 'uidoc') return badRequest(res, 'doc 不是有效的 UIDoc 文档');
    if (!isSupportedVersion(doc.version)) {
      return send(res, 422, { ok: false, error: `不支持的文档版本：${JSON.stringify(doc.version)}（支持 ${SUPPORTED_VERSIONS.join('、')}），未保存` });
    }
    const base = body.baseRevision;
    // 编辑器明确声明手动编辑；外部整文档提交默认视为 AI，不能悄悄解除保护。
    const actor = body.actor || 'ai';
    if (!['user', 'ai'].includes(actor)) return badRequest(res, 'actor 须为 user 或 ai');
    if (!Number.isInteger(base)) return badRequest(res, '缺少 baseRevision');
    const file = projectFile(name);
    let result;
    let resultBackup = null;
    let versionBackup = null;
    try {
      // 读修订号 → 比较 → 备份 → 校验 → 写入必须在同一把锁内完成（事务），
      // 否则两个并发保存都会基于同一修订号通过比较、互相覆盖。
      result = withFileLock(lockFileFor(file), () => {
        let currentRevision = 0;
        let currentDoc = null;
        if (fsSync.existsSync(file)) {
          try { currentDoc = JSON.parse(fsSync.readFileSync(file, 'utf8')); currentRevision = currentDoc.revision || 0; } catch { currentRevision = 0; }
        }
        if (base !== currentRevision) {
          return { conflict: true, currentRevision };
        }
        if (currentDoc?.version === 4 && doc.version !== 4) return { invalid: true, errors: [{ code: 'E_VERSION_DOWNGRADE', field: 'version', message: '项目已启用设计意图，不能通过旧版本覆盖保存；请重新启用设计意图后保存' }] };
        if (actor === 'ai') {
          const policy = checkAiPolicy(currentDoc, doc);
          if (!policy.ok) return { invalid: true, errors: policy.errors };
        }
        // 磁盘上还是 v1 的项目，第一次被新版覆盖保存前先做可恢复备份；备份失败则不写入
        try {
          const bk = backupV1BeforeWrite(file);
          if (bk.needed) resultBackup = bk.backupPath;
        } catch (e) {
          return { backupFailed: true, message: 'v1 备份失败，已放弃写入以保护原文件：' + e.message };
        }
        doc.revision = currentRevision + 1;
        doc.name = doc.name || name;
        const report = validateDoc(doc);
        if (!report.ok) {
          return { invalid: true, errors: report.errors };
        }
        try {
          const bk = backupBeforeUpgrade(file, doc.version);
          if (bk.needed) versionBackup = bk.backupPath;
        } catch (e) {
          return { backupFailed: true, message: '升级前备份失败，未保存：' + e.message };
        }
        atomicWriteSync(file, JSON.stringify(doc, null, 2));
        rememberProjectWrite(name, file);
        return { ok: true, revision: doc.revision };
      });
    } catch (e) {
      return send(res, 500, { ok: false, error: '保存失败：' + e.message });
    }
    if (result.conflict) {
      return send(res, 409, { ok: false, error: '修订号冲突：服务器当前为 ' + result.currentRevision + '，提交基于 ' + base, currentRevision: result.currentRevision });
    }
    if (result.backupFailed) {
      return send(res, 500, { ok: false, error: result.message });
    }
    if (result.invalid) {
      return send(res, 422, { ok: false, code: result.errors[0]?.code, error: result.errors[0]?.message || '文档校验未通过，未保存', errors: result.errors });
    }
    broadcast({ type: 'changed', name, revision: result.revision, sourceClient: typeof body.clientId === 'string' ? body.clientId : null, sourceSession: Number.isInteger(body.sessionId) ? body.sessionId : null });
    return send(res, 200, { ok: true, revision: result.revision, v1Backup: resultBackup || undefined, versionBackup: versionBackup || undefined });
  }

  if (p === '/api/external-change' && req.method === 'POST') { // CLI 直写文件后通知编辑器
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { body = {}; }
    const name = safeName(body.name);
    if (!name) return badRequest(res, '项目名不合法');
    broadcast({ type: 'changed', name, revision: body.revision ?? null, source: 'external' });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/export' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return badRequest(res, 'JSON 解析失败'); }
    const name = safeName(body.name) || '未命名设计';
    const doc = body.doc;
    if (!doc || doc.format !== 'uidoc') return badRequest(res, 'doc 不是有效的 UIDoc 文档');
    const report = validateDoc(doc);
    if (!report.ok) return send(res, 422, { ok: false, error: '文档校验未通过，未导出', errors: report.errors });
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    // 先构建全部产物内容（读不到源码就明确报错），再经临时目录一次性发布（S1 B08）：
    // 目录名带唯一任务后缀 + 原子重命名——同一秒的多次导出各得各的目录，绝不互相覆盖；
    // 中途失败清理临时目录，不留下半成品导出包。
    const html = buildPreviewHtml({
      doc, modesSource: await loadModesSource(), protocolSource: await loadProtocolSource(),
      resolveSource: await loadResolveSource(), runtimeSource: await loadRuntimeSource(),
      rendererSource: await loadRendererSource(), html2canvasSource: await loadHtml2Canvas(),
    });
    const img = body.screenshot ? dataUrlToBuffer(body.screenshot) : null;
    const base = `${name}_rev${doc.revision}_${stamp}_${exportTaskSuffix()}`;
    let dir;
    let files = [];
    try {
      dir = await publishExportDir(EXPORTS_DIR, base, async (tmp) => {
        await fs.writeFile(path.join(tmp, 'design.uidoc.json'), JSON.stringify(doc, null, 2), 'utf8'); files.push('design.uidoc.json');
        if (body.snapshot) { await fs.writeFile(path.join(tmp, 'snapshot.json'), JSON.stringify(body.snapshot, null, 2), 'utf8'); files.push('snapshot.json'); }
        if (body.report) { await fs.writeFile(path.join(tmp, 'report.json'), JSON.stringify(body.report, null, 2), 'utf8'); files.push('report.json'); }
        await fs.writeFile(path.join(tmp, 'preview.html'), html, 'utf8'); files.push('preview.html');
        if (img) { await fs.writeFile(path.join(tmp, 'screenshot.' + img.ext), img.buf); files.push('screenshot.' + img.ext); }
      });
    } catch (e) {
      return send(res, 500, { ok: false, error: '导出失败（未产生不完整目录）：' + e.message });
    }
    broadcast({ type: 'exported', dir });
    return send(res, 200, { ok: true, dir, files });
  }

  if (p === '/api/preview-html' && req.method === 'GET') { // 在浏览器打开独立预览页
    const name = safeName(url.searchParams.get('name'));
    if (!name) return badRequest(res, '项目名不合法');
    try {
      const doc = await readProject(name);
      const html = buildPreviewHtml({
        doc, modesSource: await loadModesSource(), protocolSource: await loadProtocolSource(),
        resolveSource: await loadResolveSource(), runtimeSource: await loadRuntimeSource(),
        rendererSource: await loadRendererSource(), html2canvasSource: await loadHtml2Canvas(),
      });
      return send(res, 200, html, 'text/html; charset=utf-8');
    } catch (e) {
      return send(res, 404, { ok: false, error: e.message });
    }
  }

  return send(res, 404, { ok: false, error: '未知 API：' + p });
}

// ---------- 静态文件 ----------
// no-store：本地零依赖应用，杜绝浏览器缓存旧模块（历史上多次因混缓存"页面没反应"）
function serveStatic(res, absFile) {
  fsSync.readFile(absFile, (err, data) => {
    if (err) return send(res, 404, { ok: false, error: '未找到：' + path.basename(absFile) });
    const mime = MIME[path.extname(absFile).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(APP_DIR, 'index.html'));
    if (p === '/canvasloom.ico' || p === '/favicon.ico') return serveStatic(res, path.join(ROOT, 'canvasloom.ico'));

    const under = [['/app/', APP_DIR], ['/shared/', SHARED_DIR], ['/vendor/', VENDOR_DIR]];
    for (const [prefix, dir] of under) {
      if (p.startsWith(prefix)) {
        const rel = p.slice(prefix.length);
        const abs = path.resolve(dir, rel);
        if (!abs.startsWith(path.resolve(dir) + path.sep) && abs !== path.resolve(dir)) {
          return send(res, 403, { ok: false, error: '禁止访问' });
        }
        return serveStatic(res, abs);
      }
    }
    return send(res, 404, { ok: false, error: '未找到：' + p });
  } catch (e) {
    return send(res, 500, { ok: false, error: '服务器内部错误：' + e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`[CanvasLoom] 端口 ${PORT} 已被占用，编辑器可能已在运行（直接刷新浏览器即可）。`);
    process.exit(0);
  }
  console.error('[CanvasLoom] 服务器错误：', e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[CanvasLoom] 编辑器已启动：http://127.0.0.1:${PORT}`);
  console.log(`[CanvasLoom] 项目目录：${PROJECTS_DIR}`);
  console.log('[CanvasLoom] 关闭本窗口即退出编辑器。');
  startProjectWatcher();
});

// ---------- 项目文件轮询：感知 agent/CLI 的直接文件修改 ----------
const WATCH_INTERVAL = 1500;
async function startProjectWatcher() {
  const mtimes = projectMtimes; // API 自己的写入已记录，不重复当成外部修改。
  setInterval(async () => {
    let files = [];
    try { files = await fs.readdir(PROJECTS_DIR); } catch { return; }
    const seen = new Set();
    for (const f of files) {
      if (!f.endsWith('.uidoc.json') || f.includes('.tmp-')) continue;
      const name = f.slice(0, -'.uidoc.json'.length);
      seen.add(name);
      try {
        const st = await fs.stat(path.join(PROJECTS_DIR, f));
        const prev = mtimes.get(name);
        if (prev !== undefined && prev !== st.mtimeMs) {
          let revision = null;
          try { revision = JSON.parse(await fs.readFile(path.join(PROJECTS_DIR, f), 'utf8')).revision ?? null; } catch { /* 忽略 */ }
          if (mtimes.get(name) !== prev) continue; // 异步读取期间 API 已完成新写入。
          broadcast({ type: 'changed', name, revision, source: 'external' });
        }
        mtimes.set(name, st.mtimeMs);
      } catch { /* 文件可能正被原子替换，下轮再看 */ }
    }
    for (const name of [...mtimes.keys()]) {
      if (!seen.has(name)) mtimes.delete(name);
    }
  }, WATCH_INTERVAL);
}
