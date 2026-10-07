#!/usr/bin/env node
import { isPresentationDoc } from '../shared/protocol.js';
// ============================================================
// CanvasLoom agent 命令行入口（零依赖，不访问网络，不启动子进程）
//   catalog                      查看支持的组件、属性和布局模式
//   inspect  <项目|路径> [id]     读取组件树、布局规则和指定组件信息
//   apply    <项目|路径> --ops f  按组件 ID 批量原子提交增改移删（校验失败整体拒绝）
//   validate <项目|路径>          检查文件结构及（可选）实际预览布局
//   export   <项目|路径>          导出设计文件、自包含预览页与检查报告（v3 可 --variant 指定变体）
// ============================================================
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as P from '../shared/protocol.js';
import { validateDoc, applyOps, ApplyError } from '../shared/validate.js';
import { checkSnapshot } from '../shared/measure.js';
import { editScopeOf } from '../shared/resolve.js';
import { buildPreviewHtml } from '../shared/export-html.js';
import { publishExportDir, exportTaskSuffix } from '../shared/exportdir.js';
import { withFileLock, lockFileFor } from '../shared/filelock.js';
import { backupV1BeforeWrite } from '../shared/backup.js';
import { inspectDocVersion, upgradeDoc, isSupportedVersion, SUPPORTED_VERSIONS, CompatError } from '../shared/compat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const EXPORTS_DIR = path.join(ROOT, 'exports');

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') flags.json = true;
  else if (a === '--ops') flags.ops = argv[++i];
  else if (a === '--base-revision') flags.baseRevision = parseInt(argv[++i], 10);
  else if (a === '--snapshot') flags.snapshot = argv[++i];
  else if (a === '--out') flags.out = argv[++i];
  else if (a === '--variant') flags.variant = argv[++i];
  else positional.push(a);
}
const cmd = positional.shift();

function out(obj, human) {
  console.log(flags.json ? JSON.stringify(obj, null, 2) : human);
}
function fail(code, message, extra = {}) {
  out({ ok: false, code, message, ...extra }, `✗ [${code}] ${message}`);
  process.exit(2);
}
function usage() {
  console.log(`CanvasLoom agent 命令行

用法：
  cli.cmd catalog
  cli.cmd inspect <项目名|文件路径> [组件ID] [--variant <id>] [--json]
  cli.cmd apply   <项目名|文件路径> --ops <ops.json> [--base-revision N] [--json]
  cli.cmd validate <项目名|文件路径> [--snapshot snapshot.json] [--variant <id>] [--json]
  cli.cmd export  <项目名|文件路径> [--out 目录] [--variant <id>] [--json]

操作格式（apply 的 ops.json）：
  { "ops": [
      { "action": "add",    "component": { "type": "button", "text": "保存", "name": "保存按钮" }, "parent": "footer", "index": 1 },
      { "action": "update", "id": "save_button", "fields": { "text": "保存更改", "style": { "background": "#16a34a" } } },
      { "action": "updateDocument", "fields": { "canvas": { "width": 1440, "height": 900 } } },
      { "action": "move",   "id": "save_button", "parent": "content", "index": 0 },
      { "action": "remove", "id": "cancel_btn" }
  ], "baseRevision": 12 }

说明：
  · baseRevision 必填：声明"我基于哪个修订号修改"，不匹配即拒绝（E_REVISION_STALE），
    防止覆盖主人或他人刚完成的修改；服务端与 CLI 的写入共用同一把项目文件锁；
  · v3 文档的 inspect / validate --snapshot 默认读 activeVariant 指向的呈现方案
    （原始语义，含 actions/bind/featureId/令牌引用），--variant <id> 可指定其他变体；
  · 导出包中的 preview.html 双击即可打开：含"测量布局 / 下载快照 / 截图"按钮；
  · v3 文档导出时页面内嵌变体解析器与交互运行时（按钮可点开/关面板）：
    缺省按 activeVariant 渲染，--variant <id> 可指定其他变体（不存在即报错），
    v2 文档不支持 --variant（E_VARIANT_FLAG_ON_V2）；
  · validate --snapshot 会先做快照有效性门禁（修订号一致、组件覆盖完整、坐标类型合法），
    再做实测检查（溢出、越界、重叠、固定尺寸与位置与设计规则的一致性）。`);
  process.exit(3);
}

// ---------- 项目解析 ----------
function resolveProject(arg) {
  if (!arg) usage();
  let file;
  if (/[/\\]/.test(arg) || arg.endsWith('.json')) file = path.resolve(arg);
  else file = path.join(PROJECTS_DIR, arg.endsWith('.uidoc.json') ? arg : arg + '.uidoc.json');
  if (!fs.existsSync(file)) fail('E_PROJECT_NOT_FOUND', `项目文件不存在：${file}`);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail('E_PROJECT_CORRUPT', `项目文件解析失败（原文件未改动）：${e.message}`); }
  if (doc.format !== 'uidoc') fail('E_FORMAT', '不是 UIDoc 文档：' + file);
  if (!isSupportedVersion(doc.version)) {
    fail('E_VERSION_UNSUPPORTED',
      `不支持的文档版本：${JSON.stringify(doc.version)}（本 CLI 支持 ${SUPPORTED_VERSIONS.join('、')}）。文件保持原样未改动，请用与该版本匹配的程序处理：${file}`);
  }
  return { file, doc };
}

async function atomicWrite(file, content) {
  const tmp = file + '.tmp-' + randomUUID();
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

// 同步原子写（写锁临界区内使用）
function atomicWriteSync(file, content) {
  const tmp = file + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function sizeText(s) {
  if (!s) return '?';
  if (s.mode === 'fixed') return `固定 ${s.value}px`;
  if (s.mode === 'fill') return `填满剩余${s.flex && s.flex !== 1 ? '×' + s.flex : ''}`;
  if (s.mode === 'percent') return `百分比 ${s.value}%`;
  return '自动';
}

function treeLines(doc, id, prefix, lines) {
  const c = P.findComponent(doc, id);
  if (!c) return;
  const isC = P.isContainer(c);
  let mode = '';
  if (isC && c.layout) {
    mode = c.layout.mode === 'grid' ? `网格(${(c.layout.tracks?.columns || []).length}列)`
      : P.LAYOUT_MODES[c.layout.mode]?.label || c.layout.mode;
  }
  const pos = c.position ? ` 位置(${c.position.left},${c.position.top})` : '';
  const placement = c.placement ? ` ${c.placement.mode === 'absolute' ? '独立摆放' : '参与排列'}` : '';
  const area = c.area ? ` 占格(第${c.area.row}行第${c.area.col}列${c.area.colSpan > 1 ? ` 跨${c.area.colSpan}列` : ''}${c.area.rowSpan > 1 ? ` 跨${c.area.rowSpan}行` : ''})` : '';
  lines.push(`${prefix}${c.name} [${c.id}] ${P.COMPONENT_TYPES[c.type]?.label || c.type}${mode ? ' · ' + mode : ''} · 宽${sizeText(c.size?.width)} 高${sizeText(c.size?.height)}${placement}${pos}${area}`);
  if (isC) for (const cid of c.children || []) treeLines(doc, cid, prefix ? prefix + '  ' : '├─ ', lines);
}

// ---------- catalog ----------
function catalog() {
  const types = {};
  for (const [id, def] of Object.entries(P.COMPONENT_TYPES)) {
    types[id] = { label: def.label, desc: def.desc, hasChildren: !!def.hasChildren, fields: def.fields || {} };
  }
  const data = {
    format: 'uidoc', version: P.DOC_VERSION,
    supportedVersions: SUPPORTED_VERSIONS,
    designIntent: { version: 4, project: '{goal,style}', component: '{precision:rough|exact|ai,ai:open|preserve}', policy: 'apply 自动校验保护规则；AI 不得改写意图、解除保护或降级版本。保留相对父容器的几何声明和既有结构，可完善样式与内部内容。' },
    modes: Object.fromEntries(Object.entries(P.UI_MODES).map(([id, m]) => [
      id, { label: m.label, desc: m.desc, canvas: m.canvas, blocks: (m.blocks || []).map((b) => b.label) },
    ])),
    componentTypes: types,
    layoutModes: P.LAYOUT_MODES,
    sizeModes: P.SIZE_MODES,
    styleFields: P.STYLE_FIELDS.map((f) => ({ key: f.key, label: f.label, type: f.type, types: f.types, options: f.options })),
    layoutExtraFields: {
      horizontal: { gap: '子元素间距', padding: '[上,右,下,左]', justify: '主轴分布', align: '交叉轴对齐' },
      vertical: { gap: '子元素间距', padding: '[上,右,下,左]', justify: '主轴分布', align: '交叉轴对齐' },
      grid: { tracks: '{columns:[{mode:fixed|fill,value}],rows:[...]}', columnGap: '列间距', rowGap: '行间距', padding: '[上,右,下,左]' },
      free: { '子元素 position': '{left,top}（相对父容器内容区）' },
      placement: { mode: 'absolute|flow（v2；省略沿用旧父布局语义）', absolute: '独立摆放，退出排列/grid；需 position 且尺寸不可 fill' },
    },
    componentExtraFields: {
      text: { text: '文本内容' }, button: { text: '按钮文字' },
      input: { placeholder: '占位提示', value: '默认值' },
      image: { resourceId: '资源ID（resources 中）', fit: 'cover|contain|fill' },
      divider: { orientation: 'horizontal|vertical', thickness: '粗细px' },
      all: { flags: '{allowOverflow:豁免溢出判错, noOverlap:禁止重叠}' },
    },
    ops: {
      add: { component: '对象（type 必填，可含 id/name/text/style/size/layout 等）', parent: '父容器ID，默认 root', index: '插入位置，默认末尾' },
      update: { id: '组件ID', fields: '要修改的字段对象（style/size/flags 浅合并）' },
      updateDocument: { fields: '文档级修改：canvas:{width,height,background}（部分合并）、mode、name' },
      move: { id: '组件ID', parent: '新父容器ID', index: '位置，默认末尾' },
      remove: { id: '组件ID（连带子树）' },
    },
    example: {
      ops: [
        { action: 'update', id: 'save_button', fields: { text: '保存更改', purpose: '保存并关闭向导' } },
        { action: 'add', component: { type: 'button', text: '重置', name: '重置按钮', style: { background: '#6b7280' } }, parent: 'footer' },
      ],
      baseRevision: 1,
    },
  };
  if (flags.json) return out({ ok: true, catalog: data });

  const L = [];
  L.push('CanvasLoom 布局协议 UIDoc v' + P.DOC_VERSION);
  L.push('\n■ 场景模式（doc.mode，缺省 generic）');
  for (const [id, m] of Object.entries(P.UI_MODES)) {
    L.push(`  ${id.padEnd(8)} ${m.label} —— ${m.desc}（画布 ${m.canvas.width}×${m.canvas.height}）`);
    L.push(`      预设块：${(m.blocks || []).map((b) => b.label).join('、')}`);
  }
  L.push('  说明：模式决定编辑器里新建项目的画布预设与"新组件默认样式"；');
  L.push('  agent 提交时显式给出 style/size 即可不受默认值影响。旧文档无 mode 字段按 generic 处理。');
  L.push('\n■ 组件类型');
  for (const [id, t] of Object.entries(P.COMPONENT_TYPES)) {
    L.push(`  ${id.padEnd(10)} ${t.label} —— ${t.desc}`);
    for (const [k, f] of Object.entries(t.fields || {})) L.push(`      · ${k}: ${f.label}（${f.type}${f.options ? '：' + Object.keys(f.options).join('/') : ''}）`);
  }
  L.push('\n■ 布局模式（容器 layout.mode）');
  for (const [id, m] of Object.entries(P.LAYOUT_MODES)) L.push(`  ${id.padEnd(11)} ${m.label} —— ${m.desc}`);
  L.push('\n■ 尺寸模式（size.width / size.height）');
  for (const [id, m] of Object.entries(P.SIZE_MODES)) L.push(`  ${id.padEnd(8)} ${m.label} —— ${m.desc}`);
  L.push('\n■ 样式字段（style）');
  for (const f of P.STYLE_FIELDS) L.push(`  ${f.key.padEnd(13)} ${f.label}（${f.type}${f.types ? '，仅 ' + f.types.join('/') : ''}）`);
  L.push('\n■ agent 操作（apply）');
  L.push('  add / update / move / remove，批量原子提交；任何操作使文档非法都会整体拒绝。');
  L.push('  提交时带 baseRevision=当前修订号，防止覆盖他人修改。');
  out({ ok: true }, L.join('\n'));
}

// ---------- inspect ----------
// v3 文档：组件树在 presentations 内（S1 B03）。默认读 activeVariant 指向的
// 呈现方案（原始语义，含 actions/bind/featureId/令牌引用），--variant <id> 可指定。
function inspect() {
  const arg = positional[0];
  const compId = positional[1];
  const { doc } = resolveProject(arg);
  const wantedVariant = flags.variant || doc.activeVariant;
  let scope;
  try { scope = editScopeOf(doc, wantedVariant); }
  catch (e) {
    fail(e.code || 'E_VARIANT_UNKNOWN', e.message + '（inspect 需要定位到具体变体；--variant <id> 可指定）',
      { variantId: wantedVariant == null ? null : String(wantedVariant) });
  }
  const isV3Scope = scope !== doc;
  const scopeLabel = isV3Scope
    ? `变体 "${scope.__variantId}" → 呈现方案 "${scope.__presentationId}"`
    : '文档组件表（v1/v2）';
  if (compId && !P.findComponent(scope, compId)) {
    fail('E_COMPONENT_MISSING', `组件 "${compId}" 不存在（查找范围：${scopeLabel}）`,
      { available: Object.keys(scope.components || {}).slice(0, 200) });
  }
  if (flags.json) {
    const tree = (id) => {
      const c = P.findComponent(scope, id);
      const node = { id: c.id, type: c.type, name: c.name, purpose: c.purpose || undefined, size: c.size };
      if (c.layout) node.layout = c.layout;
      if (c.position) node.position = c.position;
      if (c.placement) node.placement = c.placement;
      if (c.area) node.area = c.area;
      if (c.intent) node.intent = c.intent;
      if (P.isContainer(c)) node.children = (c.children || []).map(tree);
      return node;
    };
    return out({ ok: true, name: doc.name, revision: doc.revision, version: doc.version,
      variant: isV3Scope ? scope.__variantId : undefined,
      presentation: isV3Scope ? scope.__presentationId : undefined,
      canvas: doc.canvas, intent: doc.intent, tree: tree('root'),
      component: compId ? P.findComponent(scope, compId) : undefined });
  }
  const L = [];
  L.push(`设计：${doc.name}（修订号 ${doc.revision}，画布 ${doc.canvas.width}×${doc.canvas.height}，v${doc.version}）`);
  if (isV3Scope) L.push(`读取范围：${scopeLabel}（原始语义；--variant <id> 可换其他变体）`);
  const lines = [];
  treeLines(scope, 'root', '', lines);
  L.push(...lines);
  if (compId) {
    const c = P.findComponent(scope, compId);
    L.push(`\n■ 组件 ${compId} 完整定义（${scopeLabel}）`);
    L.push(JSON.stringify(c, null, 2));
  }
  out({ ok: true }, L.join('\n'));
}

// ---------- apply ----------
async function apply() {
  const arg = positional[0];
  if (!flags.ops) usage();
  const { file } = resolveProject(arg);
  let opsPayload;
  try { opsPayload = JSON.parse(fs.readFileSync(flags.ops, 'utf8')); }
  catch (e) { fail('E_OPS_FILE', `ops 文件读取失败：${e.message}`); }
  const ops = Array.isArray(opsPayload) ? opsPayload : opsPayload.ops;
  const baseRevision = flags.baseRevision ?? (Number.isInteger(opsPayload.baseRevision) ? opsPayload.baseRevision : null);
  // 修订号必须显式声明——这是防覆盖机制的一部分，而不是可选项
  if (baseRevision == null) {
    fail('E_BASE_REVISION_REQUIRED',
      '提交缺少 baseRevision（先用 inspect 查看当前修订号）。修订号声明"我基于哪个版本修改"，防止覆盖他人刚完成的修改。');
  }
  let result;
  try {
    // 读修订号 → 比较 → 应用 → 写入必须在一个事务里：锁内重读文档，
    // 与编辑器/服务端的写入互斥，避免并发下相互覆盖。
    result = withFileLock(lockFileFor(file), () => {
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (onDisk.format !== 'uidoc') return { error: { code: 'E_FORMAT', message: '不是 UIDoc 文档：' + file } };
      if (baseRevision !== onDisk.revision) {
        return { error: { code: 'E_REVISION_STALE', message: `提交基于修订号 ${baseRevision}，但文件当前修订号已是 ${onDisk.revision}（请重新 inspect 后再提交，防止覆盖他人修改）`, currentRevision: onDisk.revision } };
      }
      // 磁盘上是 v1 的项目，首次被新版 CLI 写入前先做可恢复备份；失败则放弃写入。
      // 随后升级为 v2 再应用操作——新版 CLI 的写入产物统一是 v2。
      let backupPath = null;
      try {
        const bk = backupV1BeforeWrite(file);
        if (bk.needed) backupPath = bk.backupPath;
      } catch (e) {
        return { error: { code: 'E_V1_BACKUP_FAILED', message: 'v1 备份失败，已放弃写入以保护原文件：' + e.message } };
      }
      const doc = upgradeDoc(onDisk);
      let next;
      try { next = applyOps(doc, ops); }
      catch (e) {
        if (e instanceof ApplyError) return { error: { code: e.payload.code || 'E_APPLY', message: e.message, ...e.payload } };
        throw e;
      }
      next.revision = onDisk.revision + 1;
      atomicWriteSync(file, JSON.stringify(next, null, 2));
      return { ok: true, revision: next.revision, prevRevision: onDisk.revision, v1Backup: backupPath || undefined, version: next.version };
    });
  } catch (e) {
    if (e && e.code === 'E_LOCK_TIMEOUT') fail('E_LOCK_TIMEOUT', e.message);
    fail('E_CLI_CRASH', (e && e.stack) || String(e));
  }
  if (result.error) fail(result.error.code, result.error.message, result.error);
  out({ ok: true, revision: result.revision, applied: ops.length, version: result.version, v1Backup: result.v1Backup },
    `✓ 已应用 ${ops.length} 个操作，修订号 ${result.prevRevision} → ${result.revision}` +
    (result.v1Backup ? `\n  v1 原文件已备份：${result.v1Backup}` : '') +
    `\n  文件：${file}\n  编辑器若已打开该设计，将在数秒内自动刷新。`);
}

// ---------- validate ----------
async function validate() {
  const arg = positional[0];
  const { file, doc } = resolveProject(arg);
  const staticReport = validateDoc(doc);
  let measureReport = null;
  let measureScope = null;
  if (flags.snapshot) {
    let snap;
    try { snap = JSON.parse(fs.readFileSync(flags.snapshot, 'utf8')); }
    catch (e) { fail('E_SNAPSHOT_FILE', `快照文件读取失败：${e.message}`); }
    // 实测对照在「指定变体的呈现方案组件树」上进行（S1 B03）；v1/v2 即文档本体
    const wantedVariant = flags.variant || doc.activeVariant;
    try { measureScope = editScopeOf(doc, wantedVariant); }
    catch (e) {
      fail(e.code || 'E_VARIANT_UNKNOWN', e.message + '（实测校验需要定位到具体变体；--variant <id> 可指定）',
        { variantId: wantedVariant == null ? null : String(wantedVariant) });
    }
    measureReport = checkSnapshot(measureScope, snap);
  }
  const errors = [...staticReport.errors, ...(measureReport ? measureReport.errors : [])];
  const warnings = [...staticReport.warnings, ...(measureReport ? measureReport.warnings : [])];
  const ok = errors.length === 0;
  out({ ok, file, revision: doc.revision,
      variant: measureScope && measureScope !== doc ? measureScope.__variantId : undefined,
      presentation: measureScope && measureScope !== doc ? measureScope.__presentationId : undefined,
      errors, warnings, checked: { static: true, snapshot: !!flags.snapshot } },
    `${ok ? '✓' : '✗'} ${file}（修订号 ${doc.revision}）\n` +
    `  结构检查：${staticReport.errors.length} 错误 / ${staticReport.warnings.length} 警告` +
    (measureReport ? `\n  实测检查：${measureReport.errors.length} 错误 / ${measureReport.warnings.length} 警告（范围：${measureScope !== doc ? `变体 "${measureScope.__variantId}" → 呈现方案 "${measureScope.__presentationId}"` : '文档组件表'}）` : '') +
    (errors.length ? '\n  错误：\n' + errors.map((e) => `    [${e.code}] ${e.message}`).join('\n') : '') +
    (warnings.length ? '\n  警告：\n' + warnings.map((w) => `    [${w.code}] ${w.message}`).join('\n') : ''));
  process.exit(ok ? 0 : 1);
}

// ---------- export ----------
async function exportProj() {
  const arg = positional[0];
  const { doc } = resolveProject(arg);
  // M4：--variant 只对 v3 文档有意义；显式给出即显式校验，绝不静默忽略。
  // 变体存在性在这里校验（读 doc.variants），页面里的解析器只做最终把关。
  let variantId = null;
  if ('variant' in flags) {
    if (!isPresentationDoc(doc)) {
      fail('E_VARIANT_FLAG_ON_V2', `--variant 只支持 v3/v4 文档（当前文档版本 ${doc.version}），未导出`);
    }
    const ids = (Array.isArray(doc.variants) ? doc.variants : []).map((v) => (v && v.id != null ? String(v.id) : null)).filter(Boolean);
    if (typeof flags.variant !== 'string' || !flags.variant || !ids.includes(flags.variant)) {
      fail('E_VARIANT_UNKNOWN',
        `变体 ${JSON.stringify(flags.variant == null ? null : flags.variant)} 不存在于 variants（可用：${ids.join('、') || '文档缺少 variants 变体清单'}），未导出`,
        { available: ids });
    }
    variantId = flags.variant;
  }
  const effectiveVariant = isPresentationDoc(doc) ? (variantId || doc.activeVariant || null) : null;
  // 先校验再创建任何文件：非法文档直接结构化拒绝，不留下半成品导出包
  const staticReport = validateDoc(doc);
  if (!staticReport.ok) {
    fail('E_INVALID_DOC', `文档校验未通过（${staticReport.errors.length} 个错误），未导出`, { errors: staticReport.errors });
  }
  const baseName = (doc.name || '未命名设计').replace(/[\\/:*?"<>|]/g, '_');
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;

  // 先构建全部产物字符串（读不到渲染器/协议库/解析器/运行时就明确报错，不创建任何文件）
  let rendererSource, protocolSource, resolveSource, runtimeSource, h2cSource = '';
  try { rendererSource = await fsp.readFile(path.join(ROOT, 'shared', 'renderer.js'), 'utf8'); }
  catch (e) { fail('E_EXPORT', '读取渲染器失败：' + e.message); }
  try { protocolSource = await fsp.readFile(path.join(ROOT, 'shared', 'protocol.js'), 'utf8'); }
  catch (e) { fail('E_EXPORT', '读取协议库失败：' + e.message); }
  // v3 页面按变体解析 + 交互（按钮可点）必需这两个模块；读不到就明确报错，不许静默降级
  try { resolveSource = await fsp.readFile(path.join(ROOT, 'shared', 'resolve.js'), 'utf8'); }
  catch (e) { fail('E_EXPORT', '读取变体解析器（shared/resolve.js）失败：' + e.message); }
  try { runtimeSource = await fsp.readFile(path.join(ROOT, 'shared', 'runtime.js'), 'utf8'); }
  catch (e) { fail('E_EXPORT', '读取交互运行时（shared/runtime.js）失败：' + e.message); }
  try { h2cSource = await fsp.readFile(path.join(ROOT, 'vendor', 'html2canvas.min.js'), 'utf8'); } catch { /* 可选 */ }
  const html = buildPreviewHtml({ doc, protocolSource, resolveSource, runtimeSource, rendererSource, html2canvasSource: h2cSource, variantId });
  const report = { generatedAt: ts.toISOString(), tool: 'canvasloom-cli', static: staticReport,
    errors: staticReport.errors, warnings: staticReport.warnings };
  if (effectiveVariant) report.variant = effectiveVariant; // v3：记录本次导出实际渲染的变体
  const readme = [
    'CanvasLoom 导出包（CLI）',
    '',
    '· design.uidoc.json  设计文件（UIDoc v' + doc.version + '，修订号 ' + doc.revision + '）',
    '· preview.html       自包含网页预览（双击打开，无需本编辑器）：',
    '                     - 测量布局：输出每个组件的实际位置尺寸',
    '                     - 下载快照：保存 snapshot.json（供 cli.cmd validate --snapshot 复检）',
    '                     - 截图：保存 PNG（基于 html2canvas）',
    effectiveVariant ? '                     - 交互：带 actions 的按钮可点击开/关面板（Esc 关闭、点外部关闭）\n                       本次按变体 ' + effectiveVariant + ' 渲染' : '',
    '· report.json        结构检查报告（静态校验结果' + (effectiveVariant ? '，含本次渲染的变体' : '') + '）',
    '',
    '如需包含实测快照与截图的一键导出，请在编辑器中点"导出"。',
  ].filter(Boolean).join('\n');

  let dir;
  let files;
  if (flags.out) {
    // 显式 --out：按调用方指定的目录写入（目录已存在时合并写入，保持既有脚本语义）
    dir = path.resolve(flags.out);
    await fsp.mkdir(dir, { recursive: true });
    files = [];
    await fsp.writeFile(path.join(dir, 'design.uidoc.json'), JSON.stringify(doc, null, 2), 'utf8'); files.push('design.uidoc.json');
    await fsp.writeFile(path.join(dir, 'preview.html'), html, 'utf8'); files.push('preview.html');
    await fsp.writeFile(path.join(dir, '使用说明.txt'), readme, 'utf8'); files.push('使用说明.txt');
    await fsp.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8'); files.push('report.json');
  } else {
    // 默认导出目录（S1 B08）：唯一任务标识 + 临时目录 + 全部成功后原子发布。
    // 同一秒的多次导出各得各的目录，绝不互相覆盖；中途失败清理临时目录。
    const base = `${baseName}_cli_rev${doc.revision}_${stamp}_${exportTaskSuffix()}`;
    dir = await publishExportDir(EXPORTS_DIR, base, async (tmp) => {
      await fsp.writeFile(path.join(tmp, 'design.uidoc.json'), JSON.stringify(doc, null, 2), 'utf8');
      await fsp.writeFile(path.join(tmp, 'preview.html'), html, 'utf8');
      await fsp.writeFile(path.join(tmp, '使用说明.txt'), readme, 'utf8');
      await fsp.writeFile(path.join(tmp, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    });
    files = ['design.uidoc.json', 'preview.html', '使用说明.txt', 'report.json'];
  }

  out({ ok: true, dir, files, errors: report.errors.length, warnings: report.warnings.length, variant: effectiveVariant || undefined },
    `✓ 导出完成：${dir}\n  文件：${files.join('、')}\n` +
    (effectiveVariant ? `  渲染变体：${effectiveVariant}\n` : '') +
    (report.errors.length ? `  ⚠ 检查发现 ${report.errors.length} 个错误、${report.warnings.length} 个警告（详见 report.json）\n` : '  结构检查通过，无错误。\n') +
    '  ※ 快照与截图：打开 preview.html 点"测量布局/截图"，或使用编辑器的"导出"。');
}

// ---------- 入口 ----------
(async () => {
  try {
    switch (cmd) {
      case 'catalog': return catalog();
      case 'inspect': return inspect();
      case 'apply': return await apply();
      case 'validate': return await validate();
      case 'export': return await exportProj();
      default: return usage();
    }
  } catch (e) {
    fail('E_CLI_CRASH', e && e.stack || String(e));
  }
})();
