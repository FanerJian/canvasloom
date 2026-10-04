// ============================================================
// UIDoc v1/v2 兼容层 —— 浏览器与 Node 通用（禁止 import node:fs）
// 规则（与 README「版本与迁移」一致）：
//   · 新版读取 v1 与 v2；v1 打开时在内存补齐兼容语义，读取本身不写盘。
//   · 旧项目第一次由新版明确保存时，先做 v1 备份（shared/backup.js，Node 侧），再写 v2。
//   · 迁移只升版本号，不改 ID、父子关系、资源、布局语义、修订号；
//     v2 的新能力（独立定位、扩展样式等）由校验器/渲染器按默认语义解释，不靠迁移批量写字段。
//   · 更高的版本号不支持：明确报错，不自动降级、不丢弃字段。
// ============================================================
import { DOC_VERSION, findComponent } from './protocol.js';

export const SUPPORTED_VERSIONS = [1, 2];

export function isSupportedVersion(v) {
  return v === 1 || v === 2;
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
      `不支持的文档版本：${JSON.stringify(v)}（本版本支持 1 与 2）。文件保持原样未改动，请用与该版本匹配的程序打开。`);
  }
  return { version: v, supported: true };
}

// v1 → v2 内存升级（深拷贝，不动原对象）。v2 原样返回深拷贝。
// 升级是纯语义保持操作：除 version 字段外内容完全一致。
export function upgradeDoc(doc) {
  inspectDocVersion(doc);
  const next = JSON.parse(JSON.stringify(doc));
  if (doc.version === DOC_VERSION) return next;
  // v1 升 v2：只改版本号。结构合法性交给 validateDoc（调用方保存前会校验）。
  next.version = DOC_VERSION;
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
