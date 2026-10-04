// ============================================================
// UIDoc 静态校验器 —— 浏览器/Node 通用，纯函数
// 同时校验 v1 与 v2 文档（版本差异见 shared/compat.js 与 README）；
// issue 结构：{ severity: 'error'|'warning', code, componentId?, field?, message }
// ============================================================
import {
  COMPONENT_TYPES, STYLE_FIELDS, LAYOUT_MODES, SIZE_MODES,
  JUSTIFY_OPTIONS, ALIGN_OPTIONS, ID_PATTERN, isContainer, LIMITS,
  findComponent, normalizePadding, newComponent, firstFreeGridCell, isAbsolutePlacement,
} from './protocol.js';
import { UI_MODES } from './modes.js';
import { isSupportedVersion, SUPPORTED_VERSIONS } from './compat.js';

const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/;
const FIELD_KEYS = new Set(STYLE_FIELDS.map((f) => f.key));

function issue(list, severity, code, message, componentId, field) {
  const it = { severity, code, message };
  if (componentId) it.componentId = componentId;
  if (field) it.field = field;
  list.push(it);
}

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isInt(v) { return typeof v === 'number' && isFinite(v) && Number.isInteger(v); }

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

  const ids = Object.keys(doc.components);

  // ---------- 逐组件 ----------
  for (const id of ids) {
    const c = doc.components[id];
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
      if (!c.parent || !doc.components[c.parent]) {
        issue(issues, 'error', 'E_PARENT_MISSING', `组件 "${id}" 的父容器 "${c.parent || ''}" 不存在`, id, 'parent');
      } else if (!isContainer(doc.components[c.parent])) {
        issue(issues, 'error', 'E_PARENT_TYPE', `组件 "${id}" 的父组件 "${c.parent}" 不是容器`, id, 'parent');
      } else if (!(doc.components[c.parent].children || []).includes(id)) {
        issue(issues, 'error', 'E_CHILD_MISSING', `组件 "${id}" 未出现在父容器 "${c.parent}" 的 children 中`, id, 'parent');
      } else if (isDescendantOfRaw(doc, c.parent, id)) {
        issue(issues, 'error', 'E_CYCLE', `组件 "${id}" 出现了循环嵌套`, id, 'parent');
      }
    }

    // 尺寸
    validateSize(issues, c, 'width');
    validateSize(issues, c, 'height');

    // 样式
    validateStyle(issues, c);

    // 容器布局
    if (c.type === 'container') validateLayout(issues, doc, c);

    // 类型专属字段
    validateTypeFields(issues, doc, c);
  }

  // children 数组本身的健全性
  for (const id of ids) {
    const c = doc.components[id];
    if (!isContainer(c) || !c.children) continue;
    if (!Array.isArray(c.children)) { issue(issues, 'error', 'E_CHILDREN', `容器 "${id}" 的 children 必须为数组`, id, 'children'); continue; }
    const seen = new Set();
    for (const cid of c.children) {
      if (!doc.components[cid]) issue(issues, 'error', 'E_CHILD_MISSING', `容器 "${id}" 的 children 中包含不存在的组件 "${cid}"`, id, 'children');
      else if (doc.components[cid].parent !== id) issue(issues, 'error', 'E_PARENT_MISMATCH', `容器 "${id}" 的 children 包含 "${cid}"，但后者的 parent 指向 "${doc.components[cid].parent}"`, id, 'children');
      if (seen.has(cid)) issue(issues, 'error', 'E_CHILD_DUP', `容器 "${id}" 的 children 中重复出现 "${cid}"`, id, 'children');
      seen.add(cid);
    }
  }

  return pack(issues);
}

function pack(issues) {
  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === 'warning'), issues };
}

function ids0(map) { return Object.keys(map).join('、'); }

function isDescendantOfRaw(doc, maybeChildId, ancestorId) {
  let cur = doc.components[maybeChildId];
  const guard = new Set();
  while (cur && cur.parent) {
    if (cur.parent === ancestorId) return true;
    if (guard.has(cur.parent)) return false;
    guard.add(cur.parent);
    cur = doc.components[cur.parent];
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
    if (def.types && !def.types.includes(c.type)) {
      issue(issues, 'warning', 'W_FIELD_IGNORED', `组件 "${c.id}"（${c.type}）不支持样式字段 ${key}，将被忽略`, c.id, 'style.' + key);
      continue;
    }
    const v = st[key];
    if (def.type === 'color') {
      if (typeof v !== 'string' || !COLOR_RE.test(v)) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${c.id}" 的 ${key} 不是合法颜色（支持 #RGB/#RRGGBB/#RRGGBBAA/rgba()）：${JSON.stringify(v)}`, c.id, 'style.' + key);
    } else if (def.type === 'number') {
      if (!isNum(v) || v < def.min || v > def.max) issue(issues, 'error', 'E_STYLE_VALUE', `组件 "${c.id}" 的 ${key} 需为 ${def.min}-${def.max} 的数值：${JSON.stringify(v)}`, c.id, 'style.' + key);
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

function validateLayout(issues, doc, c) {
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
      const ch = findComponent(doc, cid);
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
      const ch = findComponent(doc, cid);
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

function validateTypeFields(issues, doc, c) {
  const def = COMPONENT_TYPES[c.type];
  for (const key of Object.keys(def.fields || {})) {
    const f = def.fields[key];
    const v = c[key];
    if (v == null) {
      if (key === 'text' && (c.type === 'text' || c.type === 'button')) issue(issues, 'warning', 'W_FIELD_MISSING', `组件 "${c.id}"（${def.label}）缺少 ${key} 文本`, c.id, key);
      continue;
    }
    if ((f.type === 'text' || f.type === 'longtext') && typeof v !== 'string') issue(issues, 'error', 'E_FIELD_TYPE', `组件 "${c.id}" 的 ${key} 应为字符串`, c.id, key);
    if (f.type === 'enum' && !f.options[v]) issue(issues, 'error', 'E_FIELD_VALUE', `组件 "${c.id}" 的 ${key} 取值需为：${Object.keys(f.options).join('、')}，当前：${JSON.stringify(v)}`, c.id, key);
    if (f.type === 'number' && (!isNum(v) || v < f.min || v > f.max)) issue(issues, 'error', 'E_FIELD_VALUE', `组件 "${c.id}" 的 ${key} 需为 ${f.min}-${f.max} 的数值`, c.id, key);
    if (f.type === 'resource' && v !== '' && !(doc.resources && doc.resources[v])) {
      issue(issues, 'error', 'E_RESOURCE_MISSING', `组件 "${c.id}" 引用的图片资源 "${v}" 不存在于 resources`, c.id, 'resourceId');
    }
  }
  // 未在类型定义中的杂散字段（白名单外）
  const known = new Set(['id', 'type', 'name', 'purpose', 'parent', 'children', 'layout', 'size', 'style', 'flags', 'position', 'area', 'placement']);
  if (c.placement != null) {
    if (doc.version === 1) issue(issues, 'error', 'E_VERSION_FIELD', `UIDoc v1 不支持组件 placement 字段（${c.id}）；请使用 v2`, c.id, 'placement');
    if (!c.placement || typeof c.placement !== 'object' || Array.isArray(c.placement) || !['absolute', 'flow'].includes(c.placement.mode)) {
      issue(issues, 'error', 'E_PLACEMENT', `组件 "${c.id}" 的 placement.mode 只能为 absolute 或 flow`, c.id, 'placement.mode');
    } else if (Object.keys(c.placement).some((k) => k !== 'mode')) {
      issue(issues, 'error', 'E_PLACEMENT', `组件 "${c.id}" 的 placement 仅支持 mode 字段`, c.id, 'placement');
    }
  }
  const parent = c.parent ? findComponent(doc, c.parent) : null;
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

// ---------- 操作（agent apply）校验与执行 ----------
// ops: [{action:'add'|'update'|'move'|'remove', ...}]
export class ApplyError extends Error {
  constructor(payload) { super(payload.message); this.payload = payload; }
}

export function applyOps(doc, ops) {
  if (!Array.isArray(ops)) throw new ApplyError({ code: 'E_OPS', message: 'ops 必须为数组' });
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

function applyOne(doc, op) {
  if (!op || typeof op !== 'object') throw new ApplyError({ code: 'E_OP', message: '操作必须为对象' });
  switch (op.action) {
    case 'add': return opAdd(doc, op);
    case 'update': return opUpdate(doc, op);
    case 'updateDocument': return opUpdateDocument(doc, op);
    case 'move': return opMove(doc, op);
    case 'remove': return opRemove(doc, op);
    default: throw new ApplyError({ code: 'E_OP_UNKNOWN', message: '未知操作 action：' + JSON.stringify(op.action) + '（可用：add、update、updateDocument、move、remove）' });
  }
}

// 文档级修改（编辑器/CLI 通用）：canvas（部分合并）、mode、name。
// 与组件 ops 一样：任何使文档非法的修改都会被整体拒绝。
function opUpdateDocument(doc, op) {
  const fields = op.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new ApplyError({ code: 'E_OP', message: 'updateDocument 操作缺少 fields 对象' });
  }
  const allowed = new Set(['canvas', 'mode', 'name']);
  for (const k of Object.keys(fields)) {
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
  for (const k of Object.keys(fields)) {
    if (!direct.includes(k)) throw new ApplyError({ code: 'E_FIELD_UNKNOWN', message: `update 不支持字段：${k}`, componentId: op.id, field: k });
    if (k === 'layout' && !isContainer(comp)) throw new ApplyError({ code: 'E_FIELD_INVALID', message: `组件 "${comp.id}" 不是容器，不能设置 layout`, componentId: op.id, field: 'layout' });
    if (k === 'position' && comp.parent && doc.components[comp.parent] && doc.components[comp.parent].layout.mode !== 'free' && !(fields.placement && fields.placement.mode === 'absolute') && !(comp.placement && comp.placement.mode === 'absolute')) {
      throw new ApplyError({ code: 'E_FIELD_INVALID', message: `父容器不是自由布局，不能直接设置 "${comp.id}" 的 position`, componentId: comp.id, field: 'position' });
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
