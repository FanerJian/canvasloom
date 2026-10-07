// ============================================================
// CanvasLoom M2 变体解析器 —— v3 文档的指定 variant → v2 形状文档
// resolveVariant(doc, variantId) 产出可直接进入既有渲染/测量/校验/导出管线的
// v2 形状文档（format:"uidoc"、version:2；canvas/resources/mode/name/revision
// 照抄原文档，components 为解析后的组件树）：
//   1. 选定 variant → presentation 组件树深拷贝为解析基座（不修改原文档）；
//   2. 令牌替换：组件 style 中值为 "$令牌名" 的项替换为令牌值；令牌表 =
//      该 presentation 所用 style 的基础 tokens ∪ 该 variant overrides.tokens
//      的微调（覆盖同名键）；字面量（非 $ 开头）原样保留，不被令牌覆盖；
//   3. 变体补丁：overrides.components[组件id] 的样式补丁浅合并进该组件
//      style（补丁优先；补丁中的 $ 令牌引用同样被替换）；
//   4. 剥离 v3 专属字段 featureId/bind/actions/initiallyOpen/page —— 保证解析
//      结果不含任何 v3 组件扩展字段；交互语义由后续运行时模块从原 v3 文档读取；
//   5. v3 顶层段（features/styles/presentations/variants/activeVariant）不进入结果。
// 解析失败一律抛结构化错误 ResolveError（code/message + 定位字段直接挂在错误
// 对象上），绝不回退默认值、绝不静默降级；令牌替换后的取值按 v3 样式字段定义
// 校验（validate 的令牌校验只查存在性，取值合法性只能在替换后判定，冻结决策
// 4/6），非法 → E_TOKEN_VALUE_INVALID。
// 浏览器与 Node 通用：纯函数，不触碰 DOM。
// ============================================================
import { DOC_FORMAT, DOC_VERSION, V3_STYLE_FIELDS } from './protocol.js';

// v3 样式字段定义查找表（v2 全部字段 + fontFamily/deco，单一来源 protocol.js）
const STYLE_FIELD_MAP = {};
for (const f of V3_STYLE_FIELDS) STYLE_FIELD_MAP[f.key] = f;

// 与 validate.js 同口径的颜色判定（validate 未导出该正则，此处保持语义一致）
const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/;

// 结构化解析错误：code/message 与定位字段（variantId/componentId/field/token 等）
// 直接挂在错误对象上，调用方按 code 分支处理，绝不猜测默认值。
export class ResolveError extends Error {
  constructor(payload) {
    super(payload.message);
    this.name = 'ResolveError';
    Object.assign(this, payload);
  }
}

function fail(payload) { throw new ResolveError(payload); }

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function hasToken(tokens, name) { return Object.prototype.hasOwnProperty.call(tokens, name); }

// padding 合法值：与 validate.js isValidPadding 同口径（非负数值或 2/4 非负数值数组）
function isValidPadding(p) {
  if (typeof p === 'number' && isFinite(p) && p >= 0) return true;
  if (Array.isArray(p) && (p.length === 2 || p.length === 4)) return p.every((n) => typeof n === 'number' && isFinite(n) && n >= 0);
  return false;
}

// 令牌替换后的取值校验：与 validate.js validateStyleValueV3 的字面量分支同语义
// （字段类型/取值范围/枚举/padding）；返回 null 表示合法，否则返回错误说明。
function tokenValueError(key, def, v, compType) {
  if (key === 'deco' && compType !== 'container') return 'deco 仅支持 container（当前 ' + compType + '）';
  if (def.types && !def.types.includes(compType)) return null; // 字段与类型不匹配同 validate 为 warning，不拦替换
  if (def.type === 'font') return (typeof v === 'string' && v.trim()) ? null : '需为非空字符串（系统字体栈）';
  if (def.type === 'color') return (typeof v === 'string' && COLOR_RE.test(v)) ? null : '不是合法颜色（支持 #RGB/#RRGGBB/#RRGGBBAA/rgba()）';
  if (def.type === 'number') return (typeof v === 'number' && isFinite(v) && v >= def.min && v <= def.max) ? null : `需为 ${def.min}-${def.max} 的数值`;
  if (def.type === 'enum') return def.options[v] ? null : `取值需为：${Object.keys(def.options).join('、')}`;
  if (def.type === 'padding') return isValidPadding(v) ? null : '需为非负数值，或长度为 2/4 的非负数值数组';
  return null;
}

// 单个组件的 style 解析：$ 令牌替换 + 替换后取值校验（字面量原样保留不校验，
// 字面量的合法性由 v3 文档校验负责，与冻结决策 4 的分工一致）
function resolveStyle(compId, compType, style, tokens) {
  for (const key of Object.keys(style)) {
    const def = STYLE_FIELD_MAP[key];
    if (!def) {
      fail({
        code: 'E_FIELD_UNKNOWN',
        message: `组件 "${compId}" 的样式字段未知：${key}。可用字段：${Object.keys(STYLE_FIELD_MAP).join('、')}`,
        componentId: compId,
        field: 'style.' + key,
      });
    }
    let v = style[key];
    if (typeof v === 'string' && v.startsWith('$')) {
      const name = v.slice(1);
      if (!hasToken(tokens, name)) {
        fail({
          code: 'E_TOKEN_DANGLING',
          message: `组件 "${compId}" 的 ${key} 引用了未定义令牌 ${JSON.stringify(v)}（令牌表 = 该 presentation 所用 style 的基础令牌 ∪ 变体覆盖键）`,
          componentId: compId,
          field: 'style.' + key,
          token: name,
        });
      }
      v = tokens[name];
      style[key] = v;
      const why = tokenValueError(key, def, v, compType);
      if (why) {
        fail({
          code: 'E_TOKEN_VALUE_INVALID',
          message: `组件 "${compId}" 的 ${key} 令牌 "$${name}" 替换后的取值不合法：${why}（当前 ${JSON.stringify(v)}）`,
          componentId: compId,
          field: 'style.' + key,
          token: name,
          value: v,
        });
      }
    }
  }
}

// 变体解析主流程：任何失败都抛 ResolveError，绝不回退默认变体/默认样式
export function resolveVariant(doc, variantId) {
  if (!isPlainObject(doc)) {
    fail({ code: 'E_DOC_INVALID', message: 'resolveVariant：文档不是有效的 JSON 对象' });
  }
  if (!isPlainObject(doc.canvas)) {
    fail({ code: 'E_DOC_INVALID', message: 'resolveVariant：文档缺少 canvas 画布定义', field: 'canvas' });
  }
  // ---------- 选定 variant（不存在即失败） ----------
  const variants = Array.isArray(doc.variants) ? doc.variants : null;
  const variant = variants ? variants.find((v) => isPlainObject(v) && v.id === variantId) : null;
  if (!variant) {
    fail({
      code: 'E_VARIANT_UNKNOWN',
      message: `变体 ${JSON.stringify(variantId == null ? null : String(variantId))} 不存在于 variants` +
        `（可用：${variants ? variants.map((v) => (isPlainObject(v) ? String(v.id) : '?')).join('、') : '文档缺少 variants 变体清单'}），解析失败，不回退默认变体`,
      variantId: variantId == null ? null : String(variantId),
    });
  }
  // ---------- 定位 presentation / style（悬空引用 → E_VARIANT_UNKNOWN） ----------
  const presentations = isPlainObject(doc.presentations) ? doc.presentations : null;
  const pres = presentations ? presentations[variant.presentation] : null;
  if (!isPlainObject(pres) || !isPlainObject(pres.components) || !pres.components.root) {
    fail({
      code: 'E_VARIANT_UNKNOWN',
      message: `变体 "${variant.id}" 引用的呈现方案 ${JSON.stringify(variant.presentation)} 不存在或缺少可用组件树（components.root）`,
      variantId: variant.id,
      field: 'presentation',
    });
  }
  const styles = isPlainObject(doc.styles) ? doc.styles : null;
  const style = styles ? styles[variant.style] : null;
  if (!isPlainObject(style)) {
    fail({
      code: 'E_VARIANT_UNKNOWN',
      message: `变体 "${variant.id}" 引用的风格 ${JSON.stringify(variant.style)} 不存在于 styles`,
      variantId: variant.id,
      field: 'style',
    });
  }
  if (!isPlainObject(style.tokens)) {
    fail({
      code: 'E_STYLE_INVALID',
      message: `风格 "${variant.style}" 的 tokens 必须为对象`,
      variantId: variant.id,
      field: 'style.tokens',
    });
  }
  // ---------- 令牌表 = 基础 tokens ∪ overrides.tokens 微调（覆盖同名键） ----------
  const tokens = Object.assign({}, style.tokens);
  const ov = isPlainObject(variant.overrides) ? variant.overrides : {};
  if (ov.tokens !== undefined) {
    if (!isPlainObject(ov.tokens)) {
      fail({ code: 'E_VARIANT_INVALID', message: `变体 "${variant.id}" 的 overrides.tokens 必须为对象`, variantId: variant.id, field: 'overrides.tokens' });
    }
    for (const tk of Object.keys(ov.tokens)) {
      // 冻结决策 6：overrides.tokens 只允许微调基础风格已有令牌键，新键拒绝
      if (!hasToken(style.tokens, tk)) {
        fail({
          code: 'E_TOKEN_UNKNOWN_OVERRIDE',
          message: `变体 "${variant.id}" 的 overrides.tokens 新增了风格 "${variant.style}" 没有的令牌键 "${tk}"（只允许微调已有令牌）`,
          variantId: variant.id,
          field: 'overrides.tokens.' + tk,
          token: tk,
        });
      }
    }
    Object.assign(tokens, ov.tokens);
  }
  // ---------- 变体样式补丁（组件必须在该 presentation 树中） ----------
  let patches = null;
  if (ov.components !== undefined) {
    if (!isPlainObject(ov.components)) {
      fail({ code: 'E_VARIANT_INVALID', message: `变体 "${variant.id}" 的 overrides.components 必须为对象`, variantId: variant.id, field: 'overrides.components' });
    }
    patches = ov.components;
  }

  // ---------- 解析基座：presentation 组件树深拷贝（不修改原文档） ----------
  const comps = JSON.parse(JSON.stringify(pres.components));
  if (patches) {
    for (const pid of Object.keys(patches)) {
      if (!comps[pid]) {
        fail({
          code: 'E_COMPONENT_MISSING',
          message: `变体 "${variant.id}" 的样式补丁引用的组件 "${pid}" 不在呈现方案 "${variant.presentation}" 的组件树中`,
          variantId: variant.id,
          componentId: pid,
          field: 'overrides.components.' + pid,
        });
      }
    }
  }
  for (const id of Object.keys(comps)) {
    const c = comps[id];
    // 剥离 v3 专属字段：解析结果必须能通过 v2 校验；交互语义（actions/initiallyOpen/page）
    // 由运行时模块从原 v3 文档读取，不进解析结果
    delete c.featureId;
    delete c.bind;
    delete c.actions;
    delete c.initiallyOpen;
    delete c.page;
    // 变体补丁先浅合并（补丁优先），令牌替换随后统一进行——补丁中的 $ 引用同样被替换
    if (patches && patches[id]) {
      c.style = Object.assign({}, c.style, patches[id]);
    }
    if (c.style != null) {
      if (!isPlainObject(c.style)) {
        fail({ code: 'E_STYLE', message: `组件 "${id}" 的 style 必须为对象`, componentId: id, field: 'style' });
      }
      resolveStyle(id, c.type, c.style, tokens);
    }
  }

  // ---------- 组装 v2 形状文档（v3 顶层五段一概不进入结果） ----------
  return {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    revision: doc.revision,
    mode: doc.mode,
    name: doc.name,
    canvas: JSON.parse(JSON.stringify(doc.canvas)),
    resources: doc.resources != null ? JSON.parse(JSON.stringify(doc.resources)) : {},
    components: comps,
  };
}
