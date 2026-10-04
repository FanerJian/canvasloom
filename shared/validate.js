// ============================================================
// UIDoc 静态校验器 —— 浏览器/Node 通用，纯函数
// 同时校验 v1/v2/v3 文档（版本差异见 shared/compat.js 与商业级路线图 §4）；
// v3 按冻结决策实现：features/styles/presentations/variants 四段 + $令牌
// + featureId/bind/actions/initiallyOpen；v1/v2 校验路径保持历史行为不变。
// issue 结构：{ severity: 'error'|'warning', code, componentId?, field?, presentation?, message }
// （presentation 为 v3 新增定位字段：标明该 issue 属于哪个呈现方案的组件树）
// ============================================================
import {
  COMPONENT_TYPES, STYLE_FIELDS, LAYOUT_MODES, SIZE_MODES,
  JUSTIFY_OPTIONS, ALIGN_OPTIONS, ID_PATTERN, isContainer, LIMITS,
  findComponent, normalizePadding, newComponent, firstFreeGridCell, isAbsolutePlacement,
  DOC_VERSION_V3, V3_COMPONENT_EXTRA_FIELDS, V3_STYLE_FIELDS,
  V3_ACTION_EVENTS, V3_ACTION_TYPES, V3_BIND_PATTERN,
} from './protocol.js';
import { UI_MODES } from './modes.js';
import { isSupportedVersion, SUPPORTED_VERSIONS } from './compat.js';

const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/;
const FIELD_KEYS = new Set(STYLE_FIELDS.map((f) => f.key));
// v3 样式白名单查找表（v2 字段 + fontFamily/deco，见 protocol.js）
const V3_STYLE_FIELD_MAP = {};
for (const f of V3_STYLE_FIELDS) V3_STYLE_FIELD_MAP[f.key] = f;
const V3_STYLE_FIELD_KEYS = Object.keys(V3_STYLE_FIELD_MAP);

function issue(list, severity, code, message, componentId, field) {
  const it = { severity, code, message };
  if (componentId) it.componentId = componentId;
  if (field) it.field = field;
  list.push(it);
}

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isInt(v) { return typeof v === 'number' && isFinite(v) && Number.isInteger(v); }
// 严格对象判定：null/数组都不算对象（校验白名单一律按此口径）
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// padding 合法值：非负数值，或长度为 2/4 的非负数值数组（其他一律拒绝，不做静默归零）
function isValidPadding(p) {
  if (isNum(p)) return p >= 0;
  if (Array.isArray(p) && (p.length === 2 || p.length === 4)) return p.every((n) => isNum(n) && n >= 0);
  return false;
}

export function validateDoc(doc) {
  const issues = [];
  if (!doc || typeof doc !== 'object') {
    issue(issues, 'error', 'E_DOC_INVALID', '文档不是有效的 JSON 对象');
    return pack(issues);
  }
  // 版本分流（冻结决策 10）：v3 走独立校验分支；version>3 明确拒绝；
  // 以下 v1/v2 路径保持历史行为不变（现有测试为硬准绳）。
  if (doc.version === DOC_VERSION_V3) return validateDocV3(doc);
  if (typeof doc.version === 'number' && doc.version > 3) {
    issue(issues, 'error', 'E_VERSION_UNSUPPORTED',
      `不支持的文档版本：${JSON.stringify(doc.version)}（本实现最高支持版本 ${DOC_VERSION_V3}）。文件未被改动，请用匹配版本的程序处理。`);
    return pack(issues);
  }
  if (doc.format !== 'uidoc') issue(issues, 'error', 'E_FORMAT', '文档 format 必须为 "uidoc"，当前为 ' + JSON.stringify(doc.format));
  if (!isSupportedVersion(doc.version)) {
    issue(issues, 'error', 'E_VERSION',
      `不支持的文档版本：${JSON.stringify(doc.version)}（当前支持版本：${SUPPORTED_VERSIONS.join(' 与 ')}）。文件未被改动，请用匹配版本的程序处理。`);
  }
  if (!isInt(doc.revision) || doc.revision < 1) issue(issues, 'error', 'E_REVISION', 'revision 必须为正整数');
  if (doc.mode != null && !UI_MODES[doc.mode]) {
    issue(issues, 'warning', 'W_MODE_UNKNOWN', `场景模式 "${JSON.stringify(doc.mode)}" 未定义，将按通用模式处理。可用：${Object.keys(UI_MODES).join('、')}`);
  }

  const cv = doc.canvas || {};
  if (!isNum(cv.width) || cv.width < 1 || cv.width > LIMITS.canvasMax) issue(issues, 'error', 'E_CANVAS', `canvas.width 需为 1-${LIMITS.canvasMax} 的数值`, 'root', 'canvas.width');
  if (!isNum(cv.height) || cv.height < 1 || cv.height > LIMITS.canvasMax) issue(issues, 'error', 'E_CANVAS', `canvas.height 需为 1-${LIMITS.canvasMax} 的数值`, 'root', 'canvas.height');
  if (cv.background != null && !(typeof cv.background === 'string' && COLOR_RE.test(cv.background))) {
    issue(issues, 'error', 'E_CANVAS', `canvas.background 不是合法颜色（支持 #RGB/#RRGGBB/#RRGGBBAA/rgba()）：${JSON.stringify(cv.background)}`, 'root', 'canvas.background');
  }

  if (!doc.components || typeof doc.components !== 'object') {
    issue(issues, 'error', 'E_DOC_INVALID', '缺少 components 组件表');
    return pack(issues);
  }
  if (!doc.components.root) {
    issue(issues, 'error', 'E_ROOT_MISSING', '缺少根组件 root');
    return pack(issues);
  }

  validateComponentTable(issues, doc.components, { resources: doc.resources, v3: false, version: doc.version });
  return pack(issues);
}

// 组件表校验核心：v1/v2 顶层组件表与 v3 各 presentation 组件树共用。
// ctx: { resources, v3, version, features?, tokens?, presentationId? }
// v2（v3:false）行为与历史版本完全一致；v3 追加新字段与令牌校验。
function validateComponentTable(issues, comps, ctx) {
  const ids = Object.keys(comps);

  // ---------- 逐组件 ----------
  for (const id of ids) {
    const c = comps[id];
    // 损坏组件守卫：返回结构化错误而不是抛异常
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      issue(issues, 'error', 'E_COMPONENT_INVALID', `组件表中的 "${id}" 不是有效对象（${c === null ? 'null' : typeof c}），无法校验`, id);
      continue;
    }
    if (!ID_PATTERN.test(id)) issue(issues, 'error', 'E_ID_BAD', `组件标识 "${id}" 不合法：需以字母或下划线开头，仅含字母/数字/下划线，长度≤64`, id, 'id');
    // 组件表键名必须与组件内 id 一致
    if (c.id !== id) {
      issue(issues, 'error', 'E_ID_MISMATCH', `组件表键名 "${id}" 与组件内 id "${JSON.stringify(c.id)}" 不一致（key 必须与 id 完全相同）`, id, 'id');
    }
    if (!COMPONENT_TYPES[c.type]) {
      issue(issues, 'error', 'E_TYPE_UNKNOWN', `组件 "${id}" 的类型未知：${JSON.stringify(c.type)}。可用类型：${ids0(COMPONENT_TYPES)}`, id, 'type');
      continue; // 类型未知时不再深入校验
    }
    if (typeof c.name !== 'string') issue(issues, 'warning', 'W_FIELD_INVALID', `组件 "${id}" 的 name 应为字符串`, id, 'name');
    if (c.purpose != null && typeof c.purpose !== 'string') issue(issues, 'warning', 'W_FIELD_INVALID', `组件 "${id}" 的 purpose 应为字符串`, id, 'purpose');

    // 父子关系
    if (id === 'root') {
      if (c.parent != null) issue(issues, 'error', 'E_PARENT', '根组件 root 的 parent 必须为 null', id, 'parent');
    } else {
      if (!c.parent || !comps[c.parent]) {
        issue(issues, 'error', 'E_PARENT_MISSING', `组件 "${id}" 的父容器 "${c.parent || ''}" 不存在`, id, 'parent');
      } else if (!isContainer(comps[c.parent])) {
        issue(issues, 'error', 'E_PARENT_TYPE', `组件 "${id}" 的父组件 "${c.parent}" 不是容器`, id, 'parent');
      } else if (!(comps[c.parent].children || []).includes(id)) {
        issue(issues, 'error', 'E_CHILD_MISSING', `组件 "${id}" 未出现在父容器 "${c.parent}" 的 children 中`, id, 'parent');
      } else if (isDescendantOfRaw(comps, c.parent, id)) {
        issue(issues, 'error', 'E_CYCLE', `组件 "${id}" 出现了循环嵌套`, id, 'parent');
      }
    }

    // 尺寸
    validateSize(issues, c, 'width');
    validateSize(issues, c, 'height');

    // 样式（v3 走扩展白名单 + 令牌引用校验）
    if (ctx.v3) validateStyleV3(issues, c, ctx);
    else validateStyle(issues, c);

    // 容器布局
    if (c.type === 'container') validateLayout(issues, comps, c);

    // 类型专属字段
    validateTypeFields(issues, comps, ctx, c);

    // v3 新增字段（featureId/bind/actions/initiallyOpen + 布局字段令牌误用）
    if (ctx.v3) validateV3Extras(issues, comps, c, ctx);
  }

  // children 数组本身的健全性
  for (const id of ids) {
    const c = comps[id];
    if (!isContainer(c) || !c.children) continue;
    if (!Array.isArray(c.children)) { issue(issues, 'error', 'E_CHILDREN', `容器 "${id}" 的 children 必须为数组`, id, 'children'); continue; }
    const seen = new Set();
    for (const cid of c.children) {
      if (!comps[cid]) issue(issues, 'error', 'E_CHILD_MISSING', `容器 "${id}" 的 children 中包含不存在的组件 "${cid}"`, id, 'children');
      else if (comps[cid].parent !== id) issue(issues, 'error', 'E_PARENT_MISMATCH', `容器 "${id}" 的 children 包含 "${cid}"，但后者的 parent 指向 "${comps[cid].parent}"`, id, 'children');
      if (seen.has(cid)) issue(issues, 'error', 'E_CHILD_DUP', `容器 "${id}" 的 children 中重复出现 "${cid}"`, id, 'children');
      seen.add(cid);
    }
  }
}

function pack(issues) {
  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === 'warning'), issues };
}

function ids0(map) { return Object.keys(map).join('、'); }

function isDescendantOfRaw(comps, maybeChildId, ancestorId) {
  let cur = comps[maybeChildId];
  const guard = new Set();
  while (cur && cur.parent) {
    if (cur.parent === ancestorId) return true;
    if (guard.has(cur.parent)) return false;
    guard.add(cur.parent);
    cur = comps[cur.parent];
  }
  return false;
}

function validateSize(issues, c, axis) {
  const s = (c.size || {})[axis];
  const where = axis === 'width' ? '宽度' : '高度';
  if (!s || typeof s !== 'object') { issue(issues, 'error', 'E_SIZE', `组件 "${c.id}" 缺少 ${where}尺寸定义`, c.id, 'size.' + axis); return; }
  if (!SIZE_MODES[s.mode]) { issue(issues, 'error', 'E_SIZE_MODE', `组件 "${c.id}" 的${where}模式未知：${JSON.stringify(s.mode)}。可用：${Object.keys(SIZE_MODES).join('、')}`, c.id, `size.${axis}.mode`); return; }
  if (s.mode === 'fixed') {
    if (!isNum(s.value) || s.value < 0) issue(issues, 'error', 'E_SIZE_VALUE', `组件 "${c.id}" 的${where}为固定模式，value 需为 ≥0 的数值`, c.id, `size.${axis}.value`);
  } else if (s.mode === 'percent') {
    // 百分比允许有意大于父容器（装饰出血、超大背景），上限为集中配置的容量边界
    if (!isNum(s.value) || s.value < 0 || s.value > LIMITS.percentMax) issue(issues, 'error', 'E_SIZE_VALUE', `组件 "${c.id}" 的${where}为百分比模式，value 需为 0-${LIMITS.percentMax} 的数值`, c.id, `size.${axis}.value`);
  } else if (s.mode === 'fill') {
    if (s.flex != null && (!isNum(s.flex) || s.flex < 1)) issue(issues, 'error', 'E_SIZE_VALUE', `组件 "${c.id}" 的${where}伸展比例 flex 需 ≥1`, c.id, `size.${axis}.flex`);
  }
}

function validateStyle(issues, c) {
  const st = c.style;
  if (st == null) return;
  if (typeof st !== 'object' || Array.isArray(st)) { issue(issues, 'error', 'E_STYLE', `组件 "${c.id}" 的 style 必须为对象`, c.id, 'style'); return; }
  for (const key of Object.keys(st)) {
    if (!FIELD_KEYS.has(key)) {
      issue(issues, 'error', 'E_FIELD_UNKNOWN', `组件 "${c.id}" 的样式字段未知：${key}。可用字段：${[...FIELD_KEYS].join('、')}`, c.id, 'style.' + key);
      continue;
    }
    const def = STYLE_FIELDS.find((f) => f.key === key);
    if (key === 'deco' && c.type !== 'container') {
      issue(issues, 'error', 'E_FIELD_INVALID', `组件 "${c.id}" 的 deco 仅支持 container（当前 ${c.type}）`, c.id, 'style.' + key);
      continue;
    }
    if (def.types && !def.types.includes(c.type)) {
      issue(issues, 'warning', 'W_FIELD_IGNORED', `组件 "${c.id}"（${c.type}）不支持样式字段 ${key}，将被忽略`, c.id, 'style.' + key);
      continue;
    }
    const v = st[key];
    if (def.type === 'color') {
      if (typeof v !== 'string' || !COLOR_RE.test(v)) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${c.id}" 的 ${key} 不是合法颜色（支持 #RGB/#RRGGBB/#RRGGBBAA/rgba()）：${JSON.stringify(v)}`, c.id, 'style.' + key);
    } else if (def.type === 'number') {
      if (!isNum(v) || v < def.min || v > def.max) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${c.id}" 的 ${key} 需为 ${def.min}-${def.max} 的数值：${JSON.stringify(v)}`, c.id, 'style.' + key);
    } else if (def.type === 'font') {
      if (typeof v !== 'string' || !v.trim()) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${c.id}" 的 ${key} 需为非空字符串（系统字体栈）`, c.id, 'style.' + key);
    } else if (def.type === 'enum') {
      if (!def.options[v]) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${c.id}" 的 ${key} 取值需为：${Object.keys(def.options).join('、')}，当前：${JSON.stringify(v)}`, c.id, 'style.' + key);
    } else if (def.type === 'padding') {
      if (!isValidPadding(v)) {
        issue(issues, 'error', 'E_STYLE_VALUE',
          `组件 "${c.id}" 的 padding 需为非负数值，或长度为 2/4 的非负数值数组（如 [8,16] 或 [上,右,下,左]）：${JSON.stringify(v)}`, c.id, 'style.padding');
      }
    }
    if (key === 'overflow' && c.type === 'container' && v === 'hidden') { /* 合法 */ }
  }
  if (c.type === 'container' && st.padding != null) {
    issue(issues, 'error', 'E_FIELD_INVALID', `容器 "${c.id}" 请使用 layout.padding 设置内边距（style.padding 对容器无效）`, c.id, 'style.padding');
  }
}

// v3 样式值校验（组件 style 与 variant 样式补丁共用）：
// 字符串值以 $ 开头视为令牌引用，只查存在性（冻结决策 4）；其余按字段类型校验。
function validateStyleValueV3(issues, componentId, field, key, def, v, compType, tokens) {
  if (key === 'deco' && compType !== 'container') {
    issue(issues, 'error', 'E_FIELD_INVALID', `组件 "${componentId}" 的 deco 仅支持 container（当前 ${compType}）`, componentId, field);
    return;
  }
  if (def.types && !def.types.includes(compType)) {
    issue(issues, 'warning', 'W_FIELD_IGNORED', `组件 "${componentId}"（${compType}）不支持样式字段 ${key}，将被忽略`, componentId, field);
    return;
  }
  if (typeof v === 'string' && v.startsWith('$')) {
    if (!tokens || !tokens.has(v.slice(1))) {
      issue(issues, 'error', 'E_TOKEN_DANGLING',
        `组件 "${componentId}" 的 ${key} 引用了未定义令牌 ${JSON.stringify(v)}（可用范围 = 该 presentation 所用 style 的令牌表及其 variant 覆盖键）`, componentId, field);
    }
    return;
  }
  if (def.type === 'font') {
    if (typeof v !== 'string' || !v.trim()) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${componentId}" 的 ${key} 需为非空字符串（系统字体栈）`, componentId, field);
  } else if (def.type === 'color') {
    if (typeof v !== 'string' || !COLOR_RE.test(v)) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${componentId}" 的 ${key} 不是合法颜色（支持 #RGB/#RRGGBB/#RRGGBBAA/rgba()）：${JSON.stringify(v)}`, componentId, field);
  } else if (def.type === 'number') {
    if (!isNum(v) || v < def.min || v > def.max) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${componentId}" 的 ${key} 需为 ${def.min}-${def.max} 的数值：${JSON.stringify(v)}`, componentId, field);
  } else if (def.type === 'enum') {
    if (!def.options[v]) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${componentId}" 的 ${key} 取值需为：${Object.keys(def.options).join('、')}，当前：${JSON.stringify(v)}`, componentId, field);
  } else if (def.type === 'padding') {
    if (!isValidPadding(v)) {
      issue(issues, 'error', 'E_STYLE_VALUE',
        `组件 "${componentId}" 的 padding 需为非负数值，或长度为 2/4 的非负数值数组（如 [8,16] 或 [上,右,下,左]）：${JSON.stringify(v)}`, componentId, field);
    }
  }
}

// v3 样式校验：白名单 = v2 + fontFamily/deco；值可为 "$令牌名"
function validateStyleV3(issues, c, ctx) {
  const st = c.style;
  if (st == null) return;
  if (typeof st !== 'object' || Array.isArray(st)) { issue(issues, 'error', 'E_STYLE', `组件 "${c.id}" 的 style 必须为对象`, c.id, 'style'); return; }
  for (const key of Object.keys(st)) {
    const def = V3_STYLE_FIELD_MAP[key];
    if (!def) {
      issue(issues, 'error', 'E_FIELD_UNKNOWN', `组件 "${c.id}" 的样式字段未知：${key}。可用字段：${V3_STYLE_FIELD_KEYS.join('、')}`, c.id, 'style.' + key);
      continue;
    }
    validateStyleValueV3(issues, c.id, 'style.' + key, key, def, st[key], c.type, ctx.tokens);
  }
  if (c.type === 'container' && st.padding != null) {
    issue(issues, 'error', 'E_FIELD_INVALID', `容器 "${c.id}" 请使用 layout.padding 设置内边距（style.padding 对容器无效）`, c.id, 'style.padding');
  }
}

function validateLayout(issues, comps, c) {
  const L = c.layout;
  if (!L || typeof L !== 'object') { issue(issues, 'error', 'E_LAYOUT', `容器 "${c.id}" 缺少 layout`, c.id, 'layout'); return; }
  if (!LAYOUT_MODES[L.mode]) {
    issue(issues, 'error', 'E_LAYOUT_MODE', `容器 "${c.id}" 的布局模式未知：${JSON.stringify(L.mode)}。可用：${Object.keys(LAYOUT_MODES).join('、')}`, c.id, 'layout.mode');
    return;
  }
  if (L.padding != null) {
    if (!isValidPadding(L.padding)) {
      issue(issues, 'error', 'E_LAYOUT_VALUE',
        `容器 "${c.id}" 的 layout.padding 需为非负数值，或长度为 2/4 的非负数值数组：${JSON.stringify(L.padding)}`, c.id, 'layout.padding');
    }
  }
  if (L.mode === 'horizontal' || L.mode === 'vertical') {
    if (L.gap != null && (!isNum(L.gap) || L.gap < 0)) issue(issues, 'error', 'E_LAYOUT_VALUE', `容器 "${c.id}" 的 gap 需为 ≥0 的数值`, c.id, 'layout.gap');
    if (L.justify != null && !JUSTIFY_OPTIONS[L.justify]) issue(issues, 'error', 'E_LAYOUT_VALUE', `容器 "${c.id}" 的主轴分布 justify 需为：${Object.keys(JUSTIFY_OPTIONS).join('、')}`, c.id, 'layout.justify');
    if (L.align != null && !ALIGN_OPTIONS[L.align]) issue(issues, 'error', 'E_LAYOUT_VALUE', `容器 "${c.id}" 的交叉轴对齐 align 需为：${Object.keys(ALIGN_OPTIONS).join('、')}`, c.id, 'layout.align');
  }
  if (L.mode === 'grid') {
    validateTracks(issues, c, 'columns');
    validateTracks(issues, c, 'rows');
    if (L.columnGap != null && (!isNum(L.columnGap) || L.columnGap < 0)) issue(issues, 'error', 'E_LAYOUT_VALUE', `容器 "${c.id}" 的 columnGap 需为 ≥0`, c.id, 'layout.columnGap');
    if (L.rowGap != null && (!isNum(L.rowGap) || L.rowGap < 0)) issue(issues, 'error', 'E_LAYOUT_VALUE', `容器 "${c.id}" 的 rowGap 需为 ≥0`, c.id, 'layout.rowGap');
    if (L.gap != null) issue(issues, 'warning', 'W_FIELD_IGNORED', `网格容器 "${c.id}" 应使用 columnGap/rowGap（gap 将被忽略）`, c.id, 'layout.gap');
    if (L.justify != null) issue(issues, 'warning', 'W_FIELD_IGNORED', `网格容器 "${c.id}" 不使用 justify`, c.id, 'layout.justify');
    // 子元素 area 与占格重叠
    const cols = (L.tracks && L.tracks.columns || []).length;
    const rows = (L.tracks && L.tracks.rows || []).length;
    const cells = new Map();
    for (const cid of c.children || []) {
      const ch = comps[cid];
      if (!ch || !ch.area || isAbsolutePlacement(ch, c)) continue;
      const a = ch.area;
      if (!isInt(a.col) || a.col < 1 || !isInt(a.row) || a.row < 1) { issue(issues, 'error', 'E_GRID_AREA', `组件 "${cid}" 的网格位置 col/row 需为从 1 开始的整数`, cid, 'area'); continue; }
      const cs = a.colSpan == null ? 1 : a.colSpan, rs = a.rowSpan == null ? 1 : a.rowSpan;
      if (!isInt(cs) || cs < 1 || !isInt(rs) || rs < 1) { issue(issues, 'error', 'E_GRID_SPAN', `组件 "${cid}" 的 colSpan/rowSpan 需为 ≥1 的整数`, cid, 'area'); continue; }
      if (cols && a.col + cs - 1 > cols) issue(issues, 'error', 'E_GRID_AREA', `组件 "${cid}" 占用第 ${a.col}-${a.col + cs - 1} 列，超出网格列数 ${cols}`, cid, 'area.col');
      if (rows && a.row + rs - 1 > rows) issue(issues, 'error', 'E_GRID_AREA', `组件 "${cid}" 占用第 ${a.row}-${a.row + rs - 1} 行，超出网格行数 ${rows}`, cid, 'area.row');
      for (let r = a.row; r < a.row + rs; r++) for (let col = a.col; col < a.col + cs; col++) {
        const k = r * 10000 + col;
        if (cells.has(k)) issue(issues, 'warning', 'W_GRID_OVERLAP', `组件 "${cid}" 与 "${cells.get(k)}" 的网格占格重叠（第 ${r} 行第 ${col} 列）`, cid, 'area');
        else cells.set(k, cid);
      }
    }
  }
  if (L.mode === 'free') {
    // 自由容器：子元素必须有 position，且不允许 fill 尺寸
    for (const cid of c.children || []) {
      const ch = comps[cid];
      if (!ch) continue;
      if (ch.placement && ch.placement.mode === 'flow') continue;
      if (!ch.position || !isNum(ch.position.left) || !isNum(ch.position.top)) {
        issue(issues, 'error', 'E_FREE_POS', `自由布局容器 "${c.id}" 的子元素 "${cid}" 缺少 position.left/top`, cid, 'position');
      }
      for (const axis of ['width', 'height']) {
        const s = (ch.size || {})[axis];
        if (s && s.mode === 'fill') issue(issues, 'error', 'E_FREE_FILL', `组件 "${cid}" 在自由布局中不支持 ${axis} 填满（fill），请改用固定/百分比/自动`, cid, `size.${axis}.mode`);
      }
    }
  }
  if (L.mode !== 'free' && L.allowOverlap != null) {
    issue(issues, 'warning', 'W_FIELD_IGNORED', `容器 "${c.id}" 不是自由布局，allowOverlap 将被忽略`, c.id, 'layout.allowOverlap');
  }
}

function validateTracks(issues, c, which) {
  const t = c.layout && c.layout.tracks;
  const arr = t && t[which];
  if (which === 'columns') {
    if (!Array.isArray(arr) || arr.length === 0) { issue(issues, 'error', 'E_GRID_TRACKS', `网格容器 "${c.id}" 需要至少一列（layout.tracks.columns）`, c.id, 'layout.tracks.columns'); return; }
  }
  if (arr == null) return;
  if (!Array.isArray(arr)) { issue(issues, 'error', 'E_GRID_TRACKS', `网格容器 "${c.id}" 的 tracks.${which} 必须为数组`, c.id, `layout.tracks.${which}`); return; }
  arr.forEach((tr, i) => {
    if (!tr || !SIZE_MODES[tr.mode] || tr.mode === 'auto') {
      issue(issues, 'error', 'E_GRID_TRACKS', `网格容器 "${c.id}" 的 ${which}[${i}] 轨道模式需为 fixed 或 fill`, c.id, `layout.tracks.${which}[${i}]`);
      return;
    }
    if (tr.mode === 'fixed' && (!isNum(tr.value) || tr.value <= 0)) issue(issues, 'error', 'E_GRID_TRACKS', `网格容器 "${c.id}" 的 ${which}[${i}] 固定轨道 value 需 >0`, c.id, `layout.tracks.${which}[${i}].value`);
    if (tr.mode === 'fill' && (!isNum(tr.value) || tr.value < 1)) issue(issues, 'error', 'E_GRID_TRACKS', `网格容器 "${c.id}" 的 ${which}[${i}] 伸展轨道份数 value 需 ≥1`, c.id, `layout.tracks.${which}[${i}].value`);
  });
}

function validateTypeFields(issues, comps, ctx, c) {
  const def = COMPONENT_TYPES[c.type];
  for (const key of Object.keys(def.fields || {})) {
    const f = def.fields[key];
    const v = c[key];
    if (v == null) {
      // v3 中 text 可由 bind 提供内容，此时不告警
      if (key === 'text' && (c.type === 'text' || c.type === 'button') && !(ctx.v3 && c.bind && c.bind.text != null)) {
        issue(issues, 'warning', 'W_FIELD_MISSING', `组件 "${c.id}"（${def.label}）缺少 ${key} 文本`, c.id, key);
      }
      continue;
    }
    if ((f.type === 'text' || f.type === 'longtext') && typeof v !== 'string') issue(issues, 'error', 'E_FIELD_TYPE', `组件 "${c.id}" 的 ${key} 应为字符串`, c.id, key);
    if (f.type === 'enum' && !f.options[v]) issue(issues, 'error', 'E_FIELD_VALUE', `组件 "${c.id}" 的 ${key} 取值需为：${Object.keys(f.options).join('、')}，当前：${JSON.stringify(v)}`, c.id, key);
    if (f.type === 'number' && (!isNum(v) || v < f.min || v > f.max)) issue(issues, 'error', 'E_FIELD_VALUE', `组件 "${c.id}" 的 ${key} 需为 ${f.min}-${f.max} 的数值`, c.id, key);
    if (f.type === 'resource' && v !== '' && !(ctx.resources && ctx.resources[v])) {
      issue(issues, 'error', 'E_RESOURCE_MISSING', `组件 "${c.id}" 引用的图片资源 "${v}" 不存在于 resources`, c.id, 'resourceId');
    }
  }
  // 未在类型定义中的杂散字段（白名单外；v3 追加四个新字段；placement 为 v2 独立摆放语义，呈现树同构沿用）
  const known = new Set(['id', 'type', 'name', 'purpose', 'parent', 'children', 'layout', 'size', 'style', 'flags', 'position', 'area', 'placement']);
  if (ctx.v3) for (const k of V3_COMPONENT_EXTRA_FIELDS) known.add(k);
  // placement（独立摆放/显式排列）校验：v1 不支持；v2/v3 按以下规则
  if (c.placement != null) {
    if (ctx.version === 1) issue(issues, 'error', 'E_VERSION_FIELD', `UIDoc v1 不支持组件 placement 字段（${c.id}）；请使用 v2`, c.id, 'placement');
    if (!c.placement || typeof c.placement !== 'object' || Array.isArray(c.placement) || !['absolute', 'flow'].includes(c.placement.mode)) {
      issue(issues, 'error', 'E_PLACEMENT', `组件 "${c.id}" 的 placement.mode 只能为 absolute 或 flow`, c.id, 'placement.mode');
    } else if (Object.keys(c.placement).some((k) => k !== 'mode')) {
      issue(issues, 'error', 'E_PLACEMENT', `组件 "${c.id}" 的 placement 仅支持 mode 字段`, c.id, 'placement');
    }
  }
  const parent = c.parent ? comps[c.parent] : null;
  if (c.id === 'root' && c.placement != null) issue(issues, 'error', 'E_PLACEMENT', '根页面不能设置 placement', c.id, 'placement');
  if (c.placement && c.placement.mode === 'flow' && parent && parent.layout && parent.layout.mode === 'free') issue(issues, 'error', 'E_PLACEMENT', `自由布局容器 "${parent.id}" 中不支持显式 flow 子元素`, c.id, 'placement');
  if (c.placement && c.placement.mode === 'flow' && c.position != null) issue(issues, 'error', 'E_PLACEMENT', `参与排列组件 "${c.id}" 不能保留 position`, c.id, 'position');
  if (isAbsolutePlacement(c, parent)) {
    if (!c.position || !isNum(c.position.left) || !isNum(c.position.top)) issue(issues, 'error', 'E_FREE_POS', `独立摆放组件 "${c.id}" 缺少 position.left/top`, c.id, 'position');
    for (const axis of ['width', 'height']) if ((c.size || {})[axis]?.mode === 'fill') issue(issues, 'error', 'E_FREE_FILL', `独立摆放组件 "${c.id}" 不支持 ${axis} 填满（fill），请先改为固定/百分比/自动`, c.id, `size.${axis}.mode`);
  }
  for (const k of Object.keys(def.fields || {})) known.add(k);
  for (const k of Object.keys(c)) {
    if (!known.has(k)) issue(issues, 'error', 'E_FIELD_UNKNOWN', `组件 "${c.id}" 含有未知字段：${k}`, c.id, k);
  }
  if (c.flags != null) {
    if (typeof c.flags !== 'object' || Array.isArray(c.flags)) issue(issues, 'error', 'E_FIELD_TYPE', `组件 "${c.id}" 的 flags 必须为对象`, c.id, 'flags');
    else for (const k of Object.keys(c.flags)) {
      if (!['allowOverflow', 'noOverlap'].includes(k)) issue(issues, 'error', 'E_FIELD_UNKNOWN', `组件 "${c.id}" 的 flags.${k} 未知（可用：allowOverflow、noOverlap）`, c.id, 'flags.' + k);
      else if (typeof c.flags[k] !== 'boolean') issue(issues, 'error', 'E_FIELD_TYPE', `组件 "${c.id}" 的 flags.${k} 必须为布尔值`, c.id, 'flags.' + k);
    }
  }
}

// ---------- v3 组件新字段校验（冻结决策 4/5） ----------
function validateV3Extras(issues, comps, c, ctx) {
  // 布局字段（size/position/layout/area）不允许 $ 令牌引用：换风格不得改变布局
  for (const f of ['size', 'position', 'layout', 'area']) {
    if (c[f] !== undefined) scanTokenMisuse(issues, c, c[f], f);
  }
  // featureId：必须存在于 features
  if (c.featureId !== undefined) {
    if (typeof c.featureId !== 'string' || !ctx.features[c.featureId]) {
      issue(issues, 'error', 'E_FEATURE_UNKNOWN', `组件 "${c.id}" 的 featureId ${JSON.stringify(c.featureId)} 不存在于 features`, c.id, 'featureId');
    }
  }
  // bind：首版仅 text 键；值必须匹配 feature:<id>.<路径>，且 feature 必须存在
  if (c.bind !== undefined) {
    if (!isPlainObject(c.bind)) {
      issue(issues, 'error', 'E_FIELD_TYPE', `组件 "${c.id}" 的 bind 必须为对象`, c.id, 'bind');
    } else {
      for (const k of Object.keys(c.bind)) {
        if (k !== 'text') {
          issue(issues, 'error', 'E_FIELD_UNKNOWN', `组件 "${c.id}" 的 bind.${k} 未知（首版仅支持 text 键）`, c.id, 'bind.' + k);
          continue;
        }
        const v = c.bind[k];
        const m = typeof v === 'string' ? V3_BIND_PATTERN.exec(v) : null;
        if (!m) {
          issue(issues, 'error', 'E_FIELD_VALUE', `组件 "${c.id}" 的 bind.text 需为 "feature:<id>.<路径>" 语法（路径 = 点分键与 [n] 数组下标，至少一段）：${JSON.stringify(v)}`, c.id, 'bind.text');
          continue;
        }
        if (!ctx.features[m[1]]) {
          issue(issues, 'error', 'E_FEATURE_UNKNOWN', `组件 "${c.id}" 的 bind.text 引用了不存在的功能 "${m[1]}"`, c.id, 'bind.text');
        }
      }
    }
  }
  // actions：仅 button；click → { type: toggle|open|close, target }
  if (c.actions !== undefined) {
    if (c.type !== 'button') {
      issue(issues, 'error', 'E_FIELD_INVALID', `组件 "${c.id}"（${c.type}）不支持 actions（仅 button）`, c.id, 'actions');
    } else {
      validateActions(issues, comps, c);
    }
  }
  // initiallyOpen：仅 container，boolean，缺省 true
  if (c.initiallyOpen !== undefined) {
    if (c.type !== 'container') {
      issue(issues, 'error', 'E_FIELD_INVALID', `组件 "${c.id}"（${c.type}）不支持 initiallyOpen（仅 container）`, c.id, 'initiallyOpen');
    } else if (typeof c.initiallyOpen !== 'boolean') {
      issue(issues, 'error', 'E_FIELD_TYPE', `容器 "${c.id}" 的 initiallyOpen 必须为布尔值`, c.id, 'initiallyOpen');
    }
  }
}

// 深度扫描：布局字段里出现以 $ 开头的字符串值 → E_TOKEN_INVALID_CONTEXT
function scanTokenMisuse(issues, c, node, path) {
  if (typeof node === 'string') {
    if (node.startsWith('$')) {
      issue(issues, 'error', 'E_TOKEN_INVALID_CONTEXT',
        `组件 "${c.id}" 的布局字段 ${path} 不允许令牌引用 ${JSON.stringify(node)}（令牌只能出现在 style 值位置）`, c.id, path);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((x, i) => scanTokenMisuse(issues, c, x, `${path}[${i}]`));
  } else if (isPlainObject(node)) {
    for (const k of Object.keys(node)) scanTokenMisuse(issues, c, node[k], path + '.' + k);
  }
}

// actions 结构校验：事件仅 click；type 仅 toggle/open/close；
// target 必须是同一 presentation 内存在、且 initiallyOpen === false 的 container。
function validateActions(issues, comps, c) {
  const a = c.actions;
  if (!isPlainObject(a)) { issue(issues, 'error', 'E_FIELD_TYPE', `组件 "${c.id}" 的 actions 必须为对象`, c.id, 'actions'); return; }
  for (const ev of Object.keys(a)) {
    if (!V3_ACTION_EVENTS.includes(ev)) {
      issue(issues, 'error', 'E_FIELD_UNKNOWN', `组件 "${c.id}" 的 actions.${ev} 未知（首版仅支持事件：${V3_ACTION_EVENTS.join('、')}）`, c.id, 'actions.' + ev);
      continue;
    }
    const act = a[ev];
    const at = 'actions.' + ev;
    if (!isPlainObject(act)) {
      issue(issues, 'error', 'E_ACTION_TARGET_INVALID', `组件 "${c.id}" 的 ${at} 必须为对象（{ type, target }）`, c.id, at);
      continue;
    }
    if (typeof act.type !== 'string' || !V3_ACTION_TYPES.includes(act.type)) {
      issue(issues, 'error', 'E_ACTION_TARGET_INVALID', `组件 "${c.id}" 的 ${at}.type 需为：${V3_ACTION_TYPES.join('、')}，当前：${JSON.stringify(act.type)}`, c.id, at + '.type');
      continue;
    }
    if (typeof act.target !== 'string' || !act.target) {
      issue(issues, 'error', 'E_ACTION_TARGET_INVALID', `组件 "${c.id}" 的 ${at}.target 缺失（需指向本 presentation 内 initiallyOpen:false 的容器）`, c.id, at + '.target');
      continue;
    }
    const t = comps[act.target];
    if (!t || t.type !== 'container' || t.initiallyOpen !== false) {
      issue(issues, 'error', 'E_ACTION_TARGET_INVALID',
        `组件 "${c.id}" 的 ${at}.target "${act.target}" 无效：必须是同一 presentation 内存在、且 initiallyOpen 为 false 的容器`, c.id, at + '.target');
    }
  }
}

// ---------- v3 文档校验（冻结决策 1–9） ----------
const V3_TOP_LEVEL_FIELDS = new Set([
  'format', 'version', 'revision', 'name', 'mode', 'canvas', 'resources',
  'features', 'styles', 'presentations', 'variants', 'activeVariant',
]);
const V3_VARIANT_FIELDS = new Set(['id', 'label', 'presentation', 'style', 'overrides']);

function validateDocV3(doc) {
  const issues = [];
  if (doc.format !== 'uidoc') issue(issues, 'error', 'E_FORMAT', '文档 format 必须为 "uidoc"，当前为 ' + JSON.stringify(doc.format));
  if (!isInt(doc.revision) || doc.revision < 1) issue(issues, 'error', 'E_REVISION', 'revision 必须为正整数');
  if (doc.mode != null && !UI_MODES[doc.mode]) {
    issue(issues, 'warning', 'W_MODE_UNKNOWN', `场景模式 "${JSON.stringify(doc.mode)}" 未定义，将按通用模式处理。可用：${Object.keys(UI_MODES).join('、')}`);
  }
  if (typeof doc.name !== 'string' || !doc.name.trim()) issue(issues, 'error', 'E_FIELD_TYPE', 'v3 文档的 name 需为非空字符串', null, 'name');
  if (doc.resources != null && !isPlainObject(doc.resources)) issue(issues, 'error', 'E_FIELD_TYPE', 'resources 必须为对象', null, 'resources');

  const cv = doc.canvas || {};
  if (!isNum(cv.width) || cv.width < 1 || cv.width > LIMITS.canvasMax) issue(issues, 'error', 'E_CANVAS', `canvas.width 需为 1-${LIMITS.canvasMax} 的数值`, 'root', 'canvas.width');
  if (!isNum(cv.height) || cv.height < 1 || cv.height > LIMITS.canvasMax) issue(issues, 'error', 'E_CANVAS', `canvas.height 需为 1-${LIMITS.canvasMax} 的数值`, 'root', 'canvas.height');
  if (cv.background != null && !(typeof cv.background === 'string' && COLOR_RE.test(cv.background))) {
    issue(issues, 'error', 'E_CANVAS', `canvas.background 不是合法颜色（支持 #RGB/#RRGGBB/#RRGGBBAA/rgba()）：${JSON.stringify(cv.background)}`, 'root', 'canvas.background');
  }

  // 顶层白名单：components 禁止（组件树只存在于 presentation 内），其余未知字段拒绝（冻结决策 1）
  for (const k of Object.keys(doc)) {
    if (k === 'components') {
      issue(issues, 'error', 'E_V3_COMPONENTS_FORBIDDEN', 'v3 文档顶层不允许 components 段（组件树位于各 presentation 内）', 'root', 'components');
    } else if (!V3_TOP_LEVEL_FIELDS.has(k)) {
      issue(issues, 'error', 'E_FIELD_UNKNOWN', `v3 顶层未知字段：${k}。可用：${[...V3_TOP_LEVEL_FIELDS].join('、')}`, null, k);
    }
  }

  // ---------- features（冻结决策 2） ----------
  const features = isPlainObject(doc.features) ? doc.features : null;
  if (!features) {
    issue(issues, 'error', 'E_FEATURE_INVALID', 'v3 文档缺少 features 功能注册表（需为对象）', null, 'features');
  } else {
    for (const fid of Object.keys(features)) {
      const f = features[fid];
      if (!ID_PATTERN.test(fid)) { issue(issues, 'error', 'E_ID_BAD', `功能标识 "${fid}" 不合法：规则同组件 ID`, null, `features.${fid}`); continue; }
      if (!isPlainObject(f)) { issue(issues, 'error', 'E_FEATURE_INVALID', `功能 "${fid}" 必须为对象（{ label, data }）`, null, `features.${fid}`); continue; }
      for (const k of Object.keys(f)) {
        if (k !== 'label' && k !== 'data') issue(issues, 'error', 'E_FIELD_UNKNOWN', `功能 "${fid}" 含有未知字段：${k}`, null, `features.${fid}.${k}`);
      }
      if (typeof f.label !== 'string' || !f.label.trim()) issue(issues, 'error', 'E_FEATURE_INVALID', `功能 "${fid}" 的 label 需为非空字符串`, null, `features.${fid}.label`);
      if (f.data !== undefined) {
        try { JSON.stringify(f.data); } catch (e) {
          issue(issues, 'error', 'E_FEATURE_INVALID', `功能 "${fid}" 的 data 必须可 JSON 序列化：${e.message}`, null, `features.${fid}.data`);
        }
      } // data 缺省按 {} 处理（冻结决策 2）
    }
  }

  // ---------- styles（冻结决策 3；令牌名前缀首版不强制，开放项 O1） ----------
  const styles = isPlainObject(doc.styles) ? doc.styles : null;
  if (!styles) {
    issue(issues, 'error', 'E_STYLE_INVALID', 'v3 文档缺少 styles 风格包表（需为对象）', null, 'styles');
  } else {
    for (const sid of Object.keys(styles)) {
      const s = styles[sid];
      if (!ID_PATTERN.test(sid)) { issue(issues, 'error', 'E_ID_BAD', `风格标识 "${sid}" 不合法：规则同组件 ID`, null, `styles.${sid}`); continue; }
      if (!isPlainObject(s)) { issue(issues, 'error', 'E_STYLE_INVALID', `风格 "${sid}" 必须为对象（{ label, tokens }）`, null, `styles.${sid}`); continue; }
      for (const k of Object.keys(s)) {
        if (k !== 'label' && k !== 'tokens') issue(issues, 'error', 'E_FIELD_UNKNOWN', `风格 "${sid}" 含有未知字段：${k}`, null, `styles.${sid}.${k}`);
      }
      if (typeof s.label !== 'string' || !s.label.trim()) issue(issues, 'error', 'E_STYLE_INVALID', `风格 "${sid}" 的 label 需为非空字符串`, null, `styles.${sid}.label`);
      if (!isPlainObject(s.tokens)) { issue(issues, 'error', 'E_STYLE_INVALID', `风格 "${sid}" 的 tokens 必须为对象`, null, `styles.${sid}.tokens`); continue; }
      for (const tk of Object.keys(s.tokens)) {
        if (!tk) issue(issues, 'error', 'E_STYLE_INVALID', `风格 "${sid}" 存在空令牌名`, null, `styles.${sid}.tokens`);
        else if (typeof s.tokens[tk] !== 'string' && typeof s.tokens[tk] !== 'number') {
          issue(issues, 'error', 'E_STYLE_INVALID', `风格 "${sid}" 的令牌 "${tk}" 值需为 string|number，当前：${JSON.stringify(s.tokens[tk])}`, null, `styles.${sid}.tokens.${tk}`);
        }
      }
    }
  }

  // ---------- presentations（冻结决策 5；组件树内成立全部 v2 同构规则） ----------
  const presentations = isPlainObject(doc.presentations) ? doc.presentations : null;
  if (!presentations) {
    issue(issues, 'error', 'E_PRESENTATION_INVALID', 'v3 文档缺少 presentations 呈现方案表（需为对象）', null, 'presentations');
  } else {
    for (const pid of Object.keys(presentations)) {
      const p = presentations[pid];
      if (!ID_PATTERN.test(pid)) { issue(issues, 'error', 'E_ID_BAD', `呈现方案标识 "${pid}" 不合法：规则同组件 ID`, null, `presentations.${pid}`); continue; }
      if (!isPlainObject(p)) { issue(issues, 'error', 'E_PRESENTATION_INVALID', `呈现方案 "${pid}" 必须为对象（{ label, components }）`, null, `presentations.${pid}`); continue; }
      for (const k of Object.keys(p)) {
        if (k !== 'label' && k !== 'components') issue(issues, 'error', 'E_FIELD_UNKNOWN', `呈现方案 "${pid}" 含有未知字段：${k}`, null, `presentations.${pid}.${k}`);
      }
      if (typeof p.label !== 'string' || !p.label.trim()) issue(issues, 'error', 'E_PRESENTATION_INVALID', `呈现方案 "${pid}" 的 label 需为非空字符串`, null, `presentations.${pid}.label`);
      if (!isPlainObject(p.components)) {
        issue(issues, 'error', 'E_PRESENTATION_INVALID', `呈现方案 "${pid}" 缺少 components 组件表`, null, `presentations.${pid}.components`);
        continue;
      }
      if (!p.components.root) {
        issue(issues, 'error', 'E_ROOT_MISSING', `呈现方案 "${pid}" 缺少根组件 root`, 'root', `presentations.${pid}.components`);
        continue;
      }
      // 令牌存在范围（冻结决策 4）＝ 该 presentation 所用各 style 的基础令牌 ∪ 对应 variant 的覆盖键
      const tokens = tokenScopeForPresentation(presentations, styles || {}, doc.variants, pid);
      const start = issues.length;
      validateComponentTable(issues, p.components, { resources: doc.resources, features: features || {}, tokens, v3: true, version: doc.version });
      for (let i = start; i < issues.length; i++) issues[i].presentation = pid; // 定位增强：标明所属呈现方案
      // 功能可达（冻结决策 8）：每个 feature 至少被本树中一个组件的 featureId 引用
      if (features) {
        const referenced = new Set();
        for (const cid of Object.keys(p.components)) {
          const cc = p.components[cid];
          if (cc && typeof cc === 'object' && !Array.isArray(cc) && typeof cc.featureId === 'string') referenced.add(cc.featureId);
        }
        for (const fid of Object.keys(features)) {
          if (!referenced.has(fid)) {
            const it = { severity: 'error', code: 'E_FEATURE_UNREACHABLE', message: `呈现方案 "${pid}" 没有任何组件引用功能 "${fid}"（每个功能须至少被一个 featureId 引用）`, componentId: 'root', field: `presentations.${pid}`, presentation: pid };
            issues.push(it);
          }
        }
      }
    }
  }

  // ---------- variants（冻结决策 6） ----------
  const variants = Array.isArray(doc.variants) ? doc.variants : null;
  const variantIds = new Set();
  if (!variants) {
    issue(issues, 'error', 'E_VARIANT_INVALID', 'v3 文档缺少 variants 变体清单（需为数组）', null, 'variants');
  } else {
    variants.forEach((v, i) => {
      const at = `variants[${i}]`;
      if (!isPlainObject(v)) { issue(issues, 'error', 'E_VARIANT_INVALID', `变体 ${at} 必须为对象`, null, at); return; }
      for (const k of Object.keys(v)) {
        if (!V3_VARIANT_FIELDS.has(k)) issue(issues, 'error', 'E_FIELD_UNKNOWN', `变体 ${at} 含有未知字段：${k}`, null, `${at}.${k}`);
      }
      if (typeof v.id !== 'string' || !ID_PATTERN.test(v.id)) {
        issue(issues, 'error', 'E_ID_BAD', `变体标识 ${at}.id 不合法：规则同组件 ID，当前：${JSON.stringify(v.id)}`, null, `${at}.id`);
      } else if (variantIds.has(v.id)) {
        issue(issues, 'error', 'E_ID_DUP', `变体 id "${v.id}" 重复（${at}）`, null, `${at}.id`);
      } else {
        variantIds.add(v.id);
      }
      if (typeof v.label !== 'string' || !v.label.trim()) issue(issues, 'error', 'E_VARIANT_INVALID', `变体 ${at} 的 label 需为非空字符串`, null, `${at}.label`);
      if (typeof v.presentation !== 'string' || !presentations || !presentations[v.presentation]) {
        issue(issues, 'error', 'E_VARIANT_UNKNOWN', `变体 "${v.id || at}" 引用的呈现方案 ${JSON.stringify(v.presentation)} 不存在于 presentations`, null, `${at}.presentation`);
      }
      if (typeof v.style !== 'string' || !styles || !styles[v.style]) {
        issue(issues, 'error', 'E_VARIANT_UNKNOWN', `变体 "${v.id || at}" 引用的风格 ${JSON.stringify(v.style)} 不存在于 styles`, null, `${at}.style`);
      }
      if (v.overrides === undefined) return;
      if (!isPlainObject(v.overrides)) { issue(issues, 'error', 'E_VARIANT_INVALID', `变体 "${v.id}" 的 overrides 必须为对象`, null, `${at}.overrides`); return; }
      for (const k of Object.keys(v.overrides)) {
        if (k !== 'tokens' && k !== 'components') issue(issues, 'error', 'E_FIELD_UNKNOWN', `变体 "${v.id}" 的 overrides.${k} 未知（可用：tokens、components）`, null, `${at}.overrides.${k}`);
      }
      // overrides.tokens：只允许微调基础风格已有令牌键（冻结决策 6）
      if (v.overrides.tokens !== undefined) {
        if (!isPlainObject(v.overrides.tokens)) {
          issue(issues, 'error', 'E_VARIANT_INVALID', `变体 "${v.id}" 的 overrides.tokens 必须为对象`, null, `${at}.overrides.tokens`);
        } else {
          for (const tk of Object.keys(v.overrides.tokens)) {
            const st = styles && styles[v.style];
            if (!st || !isPlainObject(st.tokens) || !Object.prototype.hasOwnProperty.call(st.tokens, tk)) {
              issue(issues, 'error', 'E_TOKEN_UNKNOWN_OVERRIDE', `变体 "${v.id}" 的 overrides.tokens 新增了风格 "${v.style}" 没有的令牌键 "${tk}"（只允许微调已有令牌）`, null, `${at}.overrides.tokens.${tk}`);
              continue;
            }
            const tv = v.overrides.tokens[tk];
            if (typeof tv !== 'string' && typeof tv !== 'number') {
              issue(issues, 'error', 'E_VARIANT_INVALID', `变体 "${v.id}" 的覆盖令牌 "${tk}" 值需为 string|number`, null, `${at}.overrides.tokens.${tk}`);
            }
          }
        }
      }
      // overrides.components：{ 组件id: 样式补丁 }，组件须在该 presentation 树中，补丁过 v3 样式白名单
      if (v.overrides.components !== undefined) {
        if (!isPlainObject(v.overrides.components)) {
          issue(issues, 'error', 'E_VARIANT_INVALID', `变体 "${v.id}" 的 overrides.components 必须为对象`, null, `${at}.overrides.components`);
        } else {
          const pres = presentations ? presentations[v.presentation] : null;
          const table = pres && isPlainObject(pres.components) ? pres.components : null;
          // 补丁中令牌引用的存在范围 ＝ 本变体所用 style 的基础令牌 ∪ 本变体覆盖键
          const tokens = tokenScopeForVariant(styles || {}, v);
          for (const cid of Object.keys(v.overrides.components)) {
            if (!table || !table[cid]) {
              issue(issues, 'error', 'E_COMPONENT_MISSING', `变体 "${v.id}" 的样式补丁引用的组件 "${cid}" 不在呈现方案 "${v.presentation}" 的组件树中`, cid, `${at}.overrides.components.${cid}`);
              continue;
            }
            const patch = v.overrides.components[cid];
            if (!isPlainObject(patch)) {
              issue(issues, 'error', 'E_FIELD_TYPE', `变体 "${v.id}" 对组件 "${cid}" 的样式补丁必须为对象`, cid, `${at}.overrides.components.${cid}`);
              continue;
            }
            const compType = table[cid] && table[cid].type ? table[cid].type : 'container';
            for (const sk of Object.keys(patch)) {
              const def = V3_STYLE_FIELD_MAP[sk];
              if (!def) {
                issue(issues, 'error', 'E_FIELD_UNKNOWN', `变体 "${v.id}" 对组件 "${cid}" 的样式补丁含未知字段：${sk}。可用字段：${V3_STYLE_FIELD_KEYS.join('、')}`, cid, `${at}.overrides.components.${cid}.${sk}`);
                continue;
              }
              validateStyleValueV3(issues, cid, `${at}.overrides.components.${cid}.${sk}`, sk, def, patch[sk], compType, tokens);
            }
          }
        }
      }
    });
  }

  // ---------- activeVariant（冻结决策 7） ----------
  if (typeof doc.activeVariant !== 'string' || !variants || !variants.some((v) => v && v.id === doc.activeVariant)) {
    issue(issues, 'error', 'E_VARIANT_UNKNOWN', `activeVariant ${JSON.stringify(doc.activeVariant)} 不存在于 variants`, null, 'activeVariant');
  }

  return pack(issues);
}

// 某 presentation 的令牌存在范围（冻结决策 4 的校验口径）
function tokenScopeForPresentation(presentations, styles, variants, pid) {
  const set = new Set();
  if (!Array.isArray(variants)) return set;
  for (const v of variants) {
    if (!isPlainObject(v) || v.presentation !== pid) continue;
    collectVariantTokens(styles, v, set);
  }
  return set;
}

// 单个变体的令牌存在范围：所用 style 的基础令牌 ∪ 本变体覆盖键
function tokenScopeForVariant(styles, v) {
  const set = new Set();
  collectVariantTokens(styles, v, set);
  return set;
}

function collectVariantTokens(styles, v, set) {
  const st = styles && styles[v.style];
  if (st && isPlainObject(st.tokens)) for (const k of Object.keys(st.tokens)) set.add(k);
  const ov = v.overrides && v.overrides.tokens;
  if (isPlainObject(ov)) for (const k of Object.keys(ov)) set.add(k);
}

// ---------- 操作（agent apply）校验与执行 ----------
// ops: [{action:'add'|'update'|'move'|'remove', ...}]
export class ApplyError extends Error {
  constructor(payload) { super(payload.message); this.payload = payload; }
}

export function applyOps(doc, ops) {
  if (!Array.isArray(ops)) throw new ApplyError({ code: 'E_OPS', message: 'ops 必须为数组' });
  // v3（冻结决策 11）：组件 ops 作用于 activeVariant 指向的 presentation 树
  if (doc && typeof doc === 'object' && doc.version === DOC_VERSION_V3) return applyOpsV3(doc, ops);
  const next = JSON.parse(JSON.stringify(doc));
  for (let i = 0; i < ops.length; i++) {
    try { applyOne(next, ops[i]); }
    catch (e) {
      if (e instanceof ApplyError) { e.payload.opIndex = i; throw e; }
      throw new ApplyError({ code: 'E_OP_FAILED', message: '第 ' + (i + 1) + ' 个操作执行失败：' + e.message, opIndex: i });
    }
  }
  const report = validateDoc(next);
  if (!report.ok) {
    const first = report.errors[0];
    throw new ApplyError({ code: first.code, message: '操作会使文档进入非法状态，已整体拒绝。首个错误：' + first.message, componentId: first.componentId, field: first.field });
  }
  return next;
}

// v3 ops 执行器：add/update/move/remove 作用于 activeVariant 指向的 presentation 组件树；
// updateDocument 仍作用于文档本体（v3 只读段见 opUpdateDocument）。
// baseRevision、原子性、错误定位语义与 v2 完全一致。
function applyOpsV3(doc, ops) {
  const next = JSON.parse(JSON.stringify(doc));
  const variant = Array.isArray(next.variants) ? next.variants.find((v) => v && v.id === next.activeVariant) : null;
  if (!variant) {
    throw new ApplyError({ code: 'E_VARIANT_UNKNOWN', message: `activeVariant ${JSON.stringify(next.activeVariant)} 不存在，无法定位组件 ops 的目标 presentation` });
  }
  const pres = next.presentations && next.presentations[variant.presentation];
  if (!pres || !pres.components || !pres.components.root) {
    throw new ApplyError({ code: 'E_VARIANT_UNKNOWN', message: `activeVariant 指向的呈现方案 "${variant.presentation}" 缺少可用组件树` });
  }
  // 视图对象：components 指向该 presentation 的组件表，其余字段（mode/resources 等）回退到文档本体
  const view = Object.create(next);
  view.components = pres.components;
  for (let i = 0; i < ops.length; i++) {
    try { applyOne(next, ops[i], view); }
    catch (e) {
      if (e instanceof ApplyError) { e.payload.opIndex = i; throw e; }
      throw new ApplyError({ code: 'E_OP_FAILED', message: '第 ' + (i + 1) + ' 个操作执行失败：' + e.message, opIndex: i });
    }
  }
  const report = validateDoc(next);
  if (!report.ok) {
    const first = report.errors[0];
    throw new ApplyError({ code: first.code, message: '操作会使文档进入非法状态，已整体拒绝。首个错误：' + first.message, componentId: first.componentId, field: first.field });
  }
  return next;
}

function applyOne(doc, op, target) {
  if (!op || typeof op !== 'object') throw new ApplyError({ code: 'E_OP', message: '操作必须为对象' });
  const t = target || doc; // v3 时 target 为 presentation 组件树视图；v1/v2 与 doc 相同
  switch (op.action) {
    case 'add': return opAdd(t, op);
    case 'update': return opUpdate(t, op);
    case 'updateDocument': return opUpdateDocument(doc, op); // 文档级字段始终作用于文档本体
    case 'move': return opMove(t, op);
    case 'remove': return opRemove(t, op);
    default: throw new ApplyError({ code: 'E_OP_UNKNOWN', message: '未知操作 action：' + JSON.stringify(op.action) + '（可用：add、update、updateDocument、move、remove）' });
  }
}

// 文档级修改（编辑器/CLI 通用）：canvas（部分合并）、mode、name。
// 与组件 ops 一样：任何使文档非法的修改都会被整体拒绝。
// v3（冻结决策 11）：features/styles/presentations/variants/activeVariant/components 为只读段。
function opUpdateDocument(doc, op) {
  const fields = op.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new ApplyError({ code: 'E_OP', message: 'updateDocument 操作缺少 fields 对象' });
  }
  const allowed = new Set(['canvas', 'mode', 'name']);
  const v3Readonly = doc.version === DOC_VERSION_V3
    ? new Set(['features', 'styles', 'presentations', 'variants', 'activeVariant', 'components'])
    : null;
  for (const k of Object.keys(fields)) {
    if (v3Readonly && v3Readonly.has(k)) {
      throw new ApplyError({ code: 'E_V3_SECTION_READONLY', message: `v3 文档不允许通过 updateDocument 修改 "${k}" 段（这些段由向导/编辑器管理，组件 ops 作用于 activeVariant 树）`, field: k });
    }
    if (!allowed.has(k)) {
      throw new ApplyError({ code: 'E_FIELD_UNKNOWN', message: `updateDocument 不支持字段：${k}（可用：canvas、mode、name）`, field: k });
    }
  }
  if (fields.canvas != null) {
    if (typeof fields.canvas !== 'object' || Array.isArray(fields.canvas)) {
      throw new ApplyError({ code: 'E_FIELD_TYPE', message: 'updateDocument 的 canvas 需为对象', field: 'canvas' });
    }
    const canvasAllowed = new Set(['width', 'height', 'background']);
    for (const k of Object.keys(fields.canvas)) {
      if (!canvasAllowed.has(k)) {
        throw new ApplyError({ code: 'E_FIELD_UNKNOWN', message: `canvas 不支持字段：${k}（可用：width、height、background）`, field: 'canvas.' + k });
      }
      const v = fields.canvas[k];
      if ((k === 'width' || k === 'height') && (!isNum(v) || v < 1 || v > LIMITS.canvasMax)) {
        throw new ApplyError({ code: 'E_CANVAS', message: `canvas.${k} 需为 1-${LIMITS.canvasMax} 的数值`, field: 'canvas.' + k });
      }
      if (k === 'background' && !(typeof v === 'string' && COLOR_RE.test(v))) {
        throw new ApplyError({ code: 'E_CANVAS', message: `canvas.background 不是合法颜色：${JSON.stringify(v)}`, field: 'canvas.background' });
      }
    }
    doc.canvas = Object.assign({}, doc.canvas, fields.canvas);
  }
  if (fields.mode !== undefined) {
    if (fields.mode !== null && !UI_MODES[fields.mode]) {
      throw new ApplyError({ code: 'E_FIELD_VALUE', message: `mode 未知：${JSON.stringify(fields.mode)}（可用：${Object.keys(UI_MODES).join('、')}，或 null 表示按 generic）`, field: 'mode' });
    }
    doc.mode = fields.mode;
  }
  if (fields.name !== undefined) {
    if (typeof fields.name !== 'string' || !fields.name.trim()) {
      throw new ApplyError({ code: 'E_FIELD_TYPE', message: 'name 需为非空字符串', field: 'name' });
    }
    doc.name = fields.name;
  }
}

function opAdd(doc, op) {
  const spec = op.component;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new ApplyError({ code: 'E_OP', message: 'add 操作缺少 component 对象' });
  if (spec.type && !COMPONENT_TYPES[spec.type]) throw new ApplyError({ code: 'E_TYPE_UNKNOWN', message: '未知组件类型：' + JSON.stringify(spec.type), componentId: spec.id });
  // 未知字段直接拒绝（不允许静默丢弃——agent 必须知道字段没有被采纳）
  const addAllowed = new Set(['id', 'type', 'name', 'purpose', 'text', 'placeholder', 'value', 'resourceId', 'fit', 'orientation', 'thickness', 'size', 'style', 'flags', 'position', 'area', 'layout', 'placement']);
  if (doc.version === DOC_VERSION_V3) for (const k of V3_COMPONENT_EXTRA_FIELDS) addAllowed.add(k);
  for (const k of Object.keys(spec)) {
    if (!addAllowed.has(k)) {
      throw new ApplyError({ code: 'E_FIELD_UNKNOWN', message: `add 的 component 含未知字段：${k}（可用字段：${[...addAllowed].join('、')}）`, componentId: spec.id, field: k });
    }
  }
  const type = spec.type || 'container';
  const parent = op.parent != null ? op.parent : 'root';
  const pc = doc.components[parent];
  if (!pc) throw new ApplyError({ code: 'E_PARENT_MISSING', message: `add 的父容器 "${parent}" 不存在` });
  if (!isContainer(pc)) throw new ApplyError({ code: 'E_PARENT_TYPE', message: `add 的目标 "${parent}" 不是容器` });
  if (spec.id && doc.components[spec.id]) throw new ApplyError({ code: 'E_ID_DUP', message: `组件标识 "${spec.id}" 已存在`, componentId: spec.id });
  // 组装新组件（复用编辑器工厂，保证默认值完整）
  const comp = newComponent(doc, type, parent, {
    id: spec.id, name: spec.name, purpose: spec.purpose,
    text: spec.text, layoutMode: spec.layout ? spec.layout.mode : undefined,
  });
  // 应用调用方给定的其余字段
  const allowed = ['name', 'purpose', 'text', 'placeholder', 'value', 'resourceId', 'fit', 'orientation', 'thickness', 'size', 'style', 'flags', 'position', 'area', 'layout', 'placement'];
  if (doc.version === DOC_VERSION_V3) allowed.push(...V3_COMPONENT_EXTRA_FIELDS);
  for (const k of allowed) {
    if (spec[k] !== undefined) {
      if (k === 'layout' && !isContainer(comp)) throw new ApplyError({ code: 'E_FIELD_INVALID', message: `组件 "${comp.id}" 不是容器，不能设置 layout`, componentId: comp.id });
      if (k === 'position' && pc.layout.mode !== 'free' && spec.placement?.mode !== 'absolute') throw new ApplyError({ code: 'E_FIELD_INVALID', message: `父容器 "${parent}" 不是自由布局，不能为 "${comp.id}" 设置 position（需声明 placement.mode=absolute）`, componentId: comp.id });
      comp[k] = spec[k];
    }
  }
  if (op.index != null) {
    if (!isInt(op.index) || op.index < 0 || op.index > pc.children.length) throw new ApplyError({ code: 'E_INDEX', message: `add 的 index 越界：${op.index}（父容器现有 ${pc.children.length} 个子元素）` });
    pc.children.splice(pc.children.indexOf(comp.id), 1);
    pc.children.splice(op.index, 0, comp.id);
  }
}

function opUpdate(doc, op) {
  const comp = doc.components[op.id];
  if (!comp) throw new ApplyError({ code: 'E_COMPONENT_MISSING', message: `update 的组件 "${op.id}" 不存在`, componentId: op.id });
  const fields = op.fields;
  if (!fields || typeof fields !== 'object') throw new ApplyError({ code: 'E_OP', message: 'update 操作缺少 fields 对象' });
  const direct = ['name', 'purpose', 'text', 'placeholder', 'value', 'resourceId', 'fit', 'orientation', 'thickness', 'size', 'style', 'flags', 'position', 'area', 'layout', 'placement'];
  if (doc.version === DOC_VERSION_V3) direct.push(...V3_COMPONENT_EXTRA_FIELDS);
  for (const k of Object.keys(fields)) {
    if (!direct.includes(k)) throw new ApplyError({ code: 'E_FIELD_UNKNOWN', message: `update 不支持字段：${k}`, componentId: op.id, field: k });
    if (k === 'layout' && !isContainer(comp)) throw new ApplyError({ code: 'E_FIELD_INVALID', message: `组件 "${comp.id}" 不是容器，不能设置 layout`, componentId: op.id, field: 'layout' });
    if (k === 'position' && comp.parent && doc.components[comp.parent] && doc.components[comp.parent].layout.mode !== 'free' && !(fields.placement && fields.placement.mode === 'absolute') && !(comp.placement && comp.placement.mode === 'absolute')) {
      throw new ApplyError({ code: 'E_FIELD_INVALID', message: `父容器不是自由布局，不能直接设置 "${comp.id}" 的 position`, componentId: op.id, field: 'position' });
    }
    if (k === 'style' && fields.style && typeof fields.style === 'object') {
      comp.style = Object.assign({}, comp.style, fields.style); // 浅合并样式
    } else if (k === 'flags' && fields.flags && typeof fields.flags === 'object') {
      comp.flags = Object.assign({}, comp.flags, fields.flags);
    } else if (k === 'size' && fields.size && typeof fields.size === 'object') {
      comp.size = Object.assign({}, comp.size);
      for (const axis of ['width', 'height']) if (fields.size[axis]) comp.size[axis] = fields.size[axis];
    } else {
      comp[k] = fields[k];
    }
  }
  delete comp.id; // 不允许改 id（用 move/add 表达结构变化）
  comp.id = op.id;
}

function opMove(doc, op) {
  const comp = doc.components[op.id];
  if (!comp) throw new ApplyError({ code: 'E_COMPONENT_MISSING', message: `move 的组件 "${op.id}" 不存在`, componentId: op.id });
  const newParent = doc.components[op.parent];
  if (!newParent) throw new ApplyError({ code: 'E_PARENT_MISSING', message: `move 的目标父容器 "${op.parent}" 不存在`, componentId: op.id });
  if (!isContainer(newParent)) throw new ApplyError({ code: 'E_PARENT_TYPE', message: `move 的目标 "${op.parent}" 不是容器`, componentId: op.id });
  // 防环：不能移入自己或自己的后代
  let cur = newParent;
  while (cur) {
    if (cur.id === op.id) throw new ApplyError({ code: 'E_CYCLE', message: `不能把 "${op.id}" 移入它自身或其后代 "${newParent.id}"`, componentId: op.id });
    cur = doc.components[cur.parent];
  }
  const oldParent = doc.components[comp.parent];
  if (oldParent) oldParent.children = (oldParent.children || []).filter((x) => x !== op.id);
  newParent.children = newParent.children || [];
  const idx = op.index == null ? newParent.children.length : op.index;
  if (!isInt(idx) || idx < 0 || idx > newParent.children.length) throw new ApplyError({ code: 'E_INDEX', message: `move 的 index 越界：${op.index}` });
  newParent.children.splice(idx, 0, op.id);
  comp.parent = newParent.id;
  // 布局语义适配
  const toMode = newParent.layout ? newParent.layout.mode : 'vertical';
  const fromMode = (oldParent && oldParent.layout && oldParent.layout.mode) || 'vertical';
  if (comp.placement && comp.placement.mode === 'absolute') {
    if (!comp.position) comp.position = { left: 24, top: 24 };
    delete comp.area;
    for (const axis of ['width', 'height']) if (comp.size[axis]?.mode === 'fill') comp.size[axis] = { mode: 'auto' };
  } else if (toMode === 'free') {
    if (comp.placement) delete comp.placement;
    if (!comp.position) comp.position = { left: 24, top: 24 };
    // CLI 无浏览器几何可用：不能假造实测尺寸。op 未带显式 size 时，
    // 把 fill 轴换成 auto（自由布局合法、按内容呈现），并要求显式输入的调用方自己给 size。
    for (const axis of ['width', 'height']) {
      if (comp.size[axis] && comp.size[axis].mode === 'fill') comp.size[axis] = { mode: 'auto' };
    }
  } else {
    delete comp.position;
    if (comp.placement) delete comp.placement;
    if (toMode === 'grid' && (!comp.area || fromMode !== 'grid')) comp.area = firstFreeGridCell(newParent, doc);
    if (toMode !== 'grid') delete comp.area;
  }
}

function opRemove(doc, op) {
  const comp = doc.components[op.id];
  if (!comp) throw new ApplyError({ code: 'E_COMPONENT_MISSING', message: `remove 的组件 "${op.id}" 不存在`, componentId: op.id });
  if (op.id === 'root') throw new ApplyError({ code: 'E_ROOT', message: '根组件 root 不能删除', componentId: 'root' });
  const removeRec = (id) => {
    const c = doc.components[id];
    if (c && c.children) for (const cid of [...c.children]) removeRec(cid);
    const p = c && doc.components[c.parent];
    if (p) p.children = (p.children || []).filter((x) => x !== id);
    delete doc.components[id];
  };
  removeRec(op.id);
}
