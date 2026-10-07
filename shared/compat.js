// ============================================================
// UIDoc v1/v2/v3 兼容层 —— 浏览器与 Node 通用（禁止 import node:fs）
// 规则（与 README「版本与迁移」及商业级路线图 §4 决策 10 一致）：
//   · 新版读取 v1、v2 与 v3；v1 打开时在内存补齐兼容语义，读取本身不写盘。
//   · 旧项目第一次由新版明确保存时，先做 v1 备份（shared/backup.js，Node 侧），再写 v2。
//   · 迁移只升版本号，不改 ID、父子关系、资源、布局语义、修订号；
//     v2 的新能力（独立定位、扩展样式等）由校验器/渲染器按默认语义解释，不靠迁移批量写字段。
//   · v3 原样通过：内存中不升级、不改形、不降级写回 v2（升 v3 只发生在用户明确使用新能力时）。
//   · 更高的版本号不支持：明确报错，不自动降级、不丢弃字段。
// ============================================================
import { DOC_VERSION, DOC_VERSION_V3, findComponent } from './protocol.js';

export const SUPPORTED_VERSIONS = [1, 2, 3];

export function isSupportedVersion(v) {
  return v === 1 || v === 2 || v === DOC_VERSION_V3;
}

export class CompatError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// 打开文档前的兼容检查：只验证可读性，不修改文档。
// 返回 { version, supported }，供调用方决定是否继续。
export function inspectDocVersion(doc) {
  if (!doc || typeof doc !== 'object') throw new CompatError('E_DOC_INVALID', '文档不是有效的 JSON 对象');
  if (doc.format !== 'uidoc') throw new CompatError('E_FORMAT', '文档 format 必须为 "uidoc"');
  const v = doc.version;
  if (!isSupportedVersion(v)) {
    throw new CompatError('E_VERSION_UNSUPPORTED',
      `不支持的文档版本：${JSON.stringify(v)}（本版本支持 1、2 与 3）。文件保持原样未改动，请用与该版本匹配的程序打开。`);
  }
  return { version: v, supported: true };
}

// 打开文档前的内存准备（深拷贝，不动原对象）：
//   v3 → 原样返回（不升级不改形）；v2 → 原样返回深拷贝；v1 → 仅升版本号为 v2。
// 升级是纯语义保持操作：除 version 字段外内容完全一致。
export function upgradeDoc(doc) {
  inspectDocVersion(doc);
  const next = JSON.parse(JSON.stringify(doc));
  if (doc.version === DOC_VERSION_V3) return next; // v3 原样通过
  if (doc.version === DOC_VERSION) return next;
  // v1 升 v2：只改版本号。结构合法性交给 validateDoc（调用方保存前会校验）。
  next.version = DOC_VERSION;
  return next;
}

// ---------- v3.1：v2 → v3 一键升级（编辑器「升级为 v3」入口） ----------
// 纯增量包装：组件树原样成为 presentations.main.components，配套默认风格/变体；
// 不修改任何组件字段、不改 ID 与父子关系，升级结果必须能通过 validateDoc（v3）。
// v3 文档无需升级（抛错）；v1 请先走 upgradeDoc 成为 v2 再升级。
export function upgradeDocToV3(doc) {
  inspectDocVersion(doc);
  if (doc.version === DOC_VERSION_V3) throw new CompatError('E_VERSION', '文档已经是 v3，无需升级');
  if (doc.version !== DOC_VERSION) {
    throw new CompatError('E_VERSION', `仅支持将 v2 文档升级为 v3（当前版本 ${JSON.stringify(doc.version)}；v1 文档保存一次后即为 v2）`);
  }
  const next = JSON.parse(JSON.stringify(doc));
  const components = next.components;
  delete next.components;
  next.version = DOC_VERSION_V3;
  next.features = {};
  next.styles = { main: { label: '默认风格', tokens: {} } };
  next.presentations = { main: { label: '主呈现', components } };
  next.variants = [{ id: 'main', label: '默认', presentation: 'main', style: 'main', overrides: { tokens: {}, components: {} } }];
  next.activeVariant = 'main';
  return next;
}

// 升级前后的语义一致性检查（测试与关键写入路径可选用）：
// 组件表键、父子关系、children 顺序、资源、修订号、画布必须完全一致。
export function migrationPreservesSemantics(before, after) {
  if (after.version !== DOC_VERSION) return { ok: false, reason: '升级后版本号不是 ' + DOC_VERSION };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.components, after.components)) return { ok: false, reason: 'components 不一致' };
  if (!same(before.resources || {}, after.resources || {})) return { ok: false, reason: 'resources 不一致' };
  if (!same(before.canvas || {}, after.canvas || {})) return { ok: false, reason: 'canvas 不一致' };
  if (before.revision !== after.revision) return { ok: false, reason: 'revision 不一致' };
  if (before.name !== after.name) return { ok: false, reason: 'name 不一致' };
  if (before.mode !== after.mode) return { ok: false, reason: 'mode 不一致' };
  if (!findComponent(after, 'root')) return { ok: false, reason: '升级后缺少根组件' };
  return { ok: true };
}
