// ============================================================
// CanvasLoom 复制/粘贴/副本语义（S1 B04/B05）—— 浏览器与 Node 通用纯函数
// 原则（问题与证据.md B04/B05 的修复约定）：
//   · 复制从「原始编辑域」收集完整语义——v3 的 actions/bind/featureId/
//     initiallyOpen/page/$令牌引用全部保留；渲染解析视图只用于显示与测量；
//   · 粘贴按目标文档合并依赖：
//       resources：同 id 同内容复用；同 id 异内容生成新 id；缺失补入；
//       features（v3 目标）：缺失补入；同 id 异内容生成新 id 并重映射
//         featureId 与 bind.text 前缀（不静默覆盖目标已有功能）；
//       令牌：目标活动变体的令牌表中已有 → 保留引用（继续随令牌联动）；
//         没有 → 冻结为来源字面量值；来源也没有 → 整次粘贴拒绝，
//         绝不产出无法渲染/无法保存的文档；
//       跨项目粘贴时子树外部的动作目标（面板/页面）不存在 → 删除该动作
//         并明确提示；同项目粘贴保留外部目标；
//       目标是 v2 时剥除 v3 专属字段并明确提示（不作为未知字段静默写入）；
//   · 副本（duplicate）：先建立子树完整 ID 映射，再克隆并重映射全部内部
//     引用（actions.click.target）——按钮先于目标面板复制也能正确改指；
//     子树外部的目标按规则保留。
// ============================================================
import {
  isContainer, firstFreeGridCell,
  ID_PATTERN, slugify, genId, V3_COMPONENT_EXTRA_FIELDS,
} from './protocol.js';

export const CLIPBOARD_KIND = 'canvasloom-clipboard';
export const CLIPBOARD_VERSION = 1;

function collectStyleTokens(style, into) {
  if (!style || typeof style !== 'object') return;
  for (const v of Object.values(style)) {
    if (typeof v === 'string' && v.startsWith('$') && v.length > 1) into.add(v.slice(1));
  }
}

function collectFeatureRefs(comp, into) {
  if (typeof comp.featureId === 'string' && comp.featureId) into.add(comp.featureId);
  const b = comp.bind && comp.bind.text;
  if (typeof b === 'string' && b.startsWith('feature:')) {
    const fid = b.slice('feature:'.length).split('.')[0].split('[')[0];
    if (fid) into.add(fid);
  }
}

// 目标文档「当前变体」的令牌存在范围：活动变体所用 style 的基础令牌 ∪ 覆盖键。
// 渲染解析（resolveVariant）就按这个范围替换 $ 引用，粘贴的令牌保留判断以它为准。
function activeVariantTokenScope(doc) {
  const set = new Set();
  if (!doc || doc.version !== 3) return set;
  const variant = (Array.isArray(doc.variants) ? doc.variants : []).find((v) => v && v.id === doc.activeVariant);
  if (!variant) return set;
  const st = doc.styles && doc.styles[variant.style];
  if (st && st.tokens && typeof st.tokens === 'object') for (const k of Object.keys(st.tokens)) set.add(k);
  const ov = variant.overrides && variant.overrides.tokens;
  if (ov && typeof ov === 'object') for (const k of Object.keys(ov)) set.add(k);
  return set;
}

function uniqueResourceId(doc, base) {
  let id = base || 'res';
  if (!doc.resources[id]) return id;
  let i = 2;
  while (doc.resources[id + '_' + i]) i++;
  return id + '_' + i;
}

function uniqueFeatureId(doc, base) {
  let id = base + '_copy';
  let i = 2;
  while (doc.features[id]) { id = base + '_copy' + (i > 1 ? '_' + i : ''); i++; }
  return id;
}

// bind.text 前缀重映射：feature:<旧id>.<路径> → feature:<新id>.<路径>
const BIND_TEXT_RE = /^feature:([A-Za-z_][A-Za-z0-9_]{0,63})((\.[A-Za-z_][A-Za-z0-9_]{0,63})|(\[\d+\]))+$/;
function remapBindText(text, fidMap) {
  const groups = typeof text === 'string' ? text.match(BIND_TEXT_RE) : null;
  if (!groups) return text;
  const fid = groups[1];
  const nid = fidMap[fid];
  return nid && nid !== fid ? 'feature:' + nid + text.slice('feature:'.length + fid.length) : text;
}

// ---------- 复制：从原始编辑域收集完整语义 ----------
// scope：编辑域文档（v3 = 浅拷贝视图，components 指向活动 presentation 原树；
// v2 = 文档本体）。opts.sourceProject：复制时的项目身份（跨项目粘贴判定用）。
export function collectCopySnapshot(scope, rootId, opts = {}) {
  const comps = scope && scope.components;
  const start = comps && comps[rootId];
  if (!start) return null;
  const tree = {};
  const walk = (id) => {
    const c = comps[id];
    if (!c) return;
    tree[id] = JSON.parse(JSON.stringify(c));
    if (isContainer(c)) (c.children || []).forEach(walk);
  };
  walk(rootId);
  const resources = {};
  const featureIds = new Set();
  const usedTokens = new Set();
  for (const c of Object.values(tree)) {
    if (c.type === 'image' && c.resourceId && scope.resources && scope.resources[c.resourceId]) {
      resources[c.resourceId] = JSON.parse(JSON.stringify(scope.resources[c.resourceId]));
    }
    collectFeatureRefs(c, featureIds);
    collectStyleTokens(c.style, usedTokens);
  }
  const features = {};
  for (const fid of featureIds) {
    if (scope.features && scope.features[fid]) features[fid] = JSON.parse(JSON.stringify(scope.features[fid]));
  }
  // 来源风格包：只带引用到的令牌所属的包（跨项目冻结字面量值时需要来源取值）
  const styles = {};
  for (const [sid, st] of Object.entries(scope.styles || {})) {
    if (!st || typeof st !== 'object' || !st.tokens || typeof st.tokens !== 'object') continue;
    const owned = Object.keys(st.tokens).filter((tk) => usedTokens.has(tk));
    if (owned.length) styles[sid] = { label: st.label, tokens: Object.fromEntries(owned.map((tk) => [tk, st.tokens[tk]])) };
  }
  return {
    kind: CLIPBOARD_KIND,
    clipboardVersion: CLIPBOARD_VERSION,
    fromVersion: scope.version == null ? null : scope.version,
    sourceProject: opts.sourceProject == null ? null : String(opts.sourceProject),
    rootId,
    name: start.name || rootId,
    copiedAt: Date.now(),
    tree, resources, features, styles,
  };
}

// ---------- 粘贴：物化到目标文档（doc 为可变克隆，mutate 回调内可用） ----------
// opts.currentProject：当前项目稳定身份（编辑器传 state.name）。剪贴板记录了
// 复制时的来源项目——两者不同即跨项目粘贴：子树外部的动作目标不存在于目标
// 项目，相关动作被移除并明确提示；同项目粘贴保留外部目标。
// 返回 { aborted?, newId?, notices: [{level, message}] }；拒绝粘贴时不改动 doc。
export function pasteSnapshotIntoDoc(doc, clip, targetParentId, opts = {}) {
  const notices = [];
  if (!clip || clip.kind !== CLIPBOARD_KIND || clip.clipboardVersion !== CLIPBOARD_VERSION
    || !clip.tree || !clip.tree[clip.rootId]) {
    return { aborted: true, notices: [{ level: 'warn', message: '剪贴板内容无效或来自旧版本复制，请重新复制' }] };
  }
  const srcRoot = clip.tree[clip.rootId];
  const crossProject = clip.sourceProject != null && opts.currentProject != null
    && clip.sourceProject !== opts.currentProject;

  // ---- 目标父容器：显式指定 > 来源父容器（仍存在且是容器）> 根 ----
  let parentId = 'root';
  if (targetParentId && doc.components[targetParentId] && isContainer(doc.components[targetParentId])) {
    parentId = targetParentId;
  } else if (srcRoot.parent && doc.components[srcRoot.parent] && isContainer(doc.components[srcRoot.parent])) {
    parentId = srcRoot.parent;
  }
  const target = doc.components[parentId];

  // ---- 资源合并：同 id 同内容 → 复用；同 id 异内容 → 新 id；缺失 → 补入 ----
  doc.resources = doc.resources || {};
  const ridMap = {};
  for (const [rid, res] of Object.entries(clip.resources || {})) {
    if (doc.resources[rid]) {
      if (JSON.stringify(doc.resources[rid]) === JSON.stringify(res)) { ridMap[rid] = rid; continue; }
      const nid = uniqueResourceId(doc, rid + '_copy');
      doc.resources[nid] = JSON.parse(JSON.stringify(res));
      ridMap[rid] = nid;
    } else {
      doc.resources[rid] = JSON.parse(JSON.stringify(res));
      ridMap[rid] = rid;
    }
  }

  // ---- 功能合并（v3 目标）：冲突不覆盖，生成新 id 并在粘贴树内重映射 ----
  const fidMap = {};
  if (doc.version === 3) {
    doc.features = doc.features || {};
    for (const [fid, feat] of Object.entries(clip.features || {})) {
      if (!doc.features[fid]) {
        doc.features[fid] = JSON.parse(JSON.stringify(feat));
        fidMap[fid] = fid;
      } else if (JSON.stringify(doc.features[fid]) === JSON.stringify(feat)) {
        fidMap[fid] = fid;
      } else {
        const nid = uniqueFeatureId(doc, fid);
        doc.features[nid] = JSON.parse(JSON.stringify(feat));
        fidMap[fid] = nid;
        notices.push({ level: 'warn', message: `功能 "${fid}" 在目标项目中已存在但内容不同：粘贴副本改用新功能 "${nid}"，引用已同步重映射` });
      }
    }
  }

  // ---- 令牌决策：目标活动变体已有 → 保留引用；否则冻结为来源字面量 ----
  const usedTokens = new Set();
  for (const c of Object.values(clip.tree)) collectStyleTokens(c.style, usedTokens);
  const inScope = activeVariantTokenScope(doc);
  const sourceTokenValue = {};
  for (const st of Object.values(clip.styles || {})) {
    if (st && st.tokens) Object.assign(sourceTokenValue, st.tokens);
  }
  const tokenValue = {}; // 令牌名 → 字面量值（undefined = 保留引用）
  const unresolved = new Set();
  for (const tk of usedTokens) {
    if (inScope.has(tk)) continue;
    if (sourceTokenValue[tk] !== undefined) tokenValue[tk] = sourceTokenValue[tk];
    else unresolved.add(tk);
  }
  if (unresolved.size) {
    notices.push({
      level: 'warn',
      message: `粘贴被拒绝：样式引用的令牌 ${[...unresolved].map((t) => '$' + t).join('、')} 在目标项目与复制内容中都没有取值（为避免产出无法渲染的文档，未粘贴）`,
    });
    return { aborted: true, notices };
  }
  const frozen = [...usedTokens].filter((tk) => tokenValue[tk] !== undefined);
  if (frozen.length) {
    notices.push({ level: 'info', message: `令牌 ${frozen.map((t) => '$' + t).join('、')} 在目标项目当前变体中未定义，已冻结为复制时的取值` });
  }

  // ---- 子树物化：全新 ID + 依赖重映射 ----
  const idMap = {};      // 来源 id → 粘贴后新 id（动作目标重映射用）
  const pastedIds = [];  // 粘贴树内的组件 id（第二遍处理动作）
  const strippedFields = new Set();
  const stripPage = [];  // 被剥除 page 标记的组件
  const cloneOne = (srcId, pid) => {
    const src = clip.tree[srcId];
    if (!src) return null;
    const nid = genId(doc, srcId + '_copy');
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = nid;
    copy.parent = pid;
    copy.name = (src.name || srcId) + ' 副本';
    // 令牌冻结（目标令牌表中没有的引用换为字面量）
    if (copy.style && typeof copy.style === 'object') {
      for (const k of Object.keys(copy.style)) {
        const v = copy.style[k];
        if (typeof v === 'string' && v.startsWith('$') && tokenValue[v.slice(1)] !== undefined) {
          copy.style[k] = tokenValue[v.slice(1)];
        }
      }
    }
    if (copy.type === 'image' && copy.resourceId && ridMap[copy.resourceId] != null) {
      copy.resourceId = ridMap[copy.resourceId];
    }
    if (doc.version === 3) {
      if (copy.featureId && fidMap[copy.featureId]) copy.featureId = fidMap[copy.featureId];
      if (copy.bind && typeof copy.bind.text === 'string') copy.bind.text = remapBindText(copy.bind.text, fidMap);
      // 页面图层只能挂在 root 直接子级：粘贴到其他容器时剥除 page 标记（明确提示）
      if (copy.page === true && pid !== 'root') {
        delete copy.page;
        stripPage.push(nid);
      }
    } else {
      for (const k of V3_COMPONENT_EXTRA_FIELDS) {
        if (copy[k] !== undefined) { delete copy[k]; strippedFields.add(k); }
      }
    }
    doc.components[nid] = copy;
    idMap[srcId] = nid;
    pastedIds.push(nid);
    if (isContainer(copy)) copy.children = (src.children || []).map((cid) => cloneOne(cid, nid)).filter(Boolean);
    return nid;
  };
  const nid = cloneOne(clip.rootId, parentId);
  target.children = target.children || [];
  target.children.push(nid);
  // 布局适配：目标容器布局可能与来源不同（自由保持坐标，排列清坐标，网格分格）
  adaptChildToTargetLayout(doc, doc.components[nid], target, null);

  // ---- 动作目标重映射（第二遍）：子树内目标换新 id；跨项目的外部目标删除并提示 ----
  for (const cid of pastedIds) {
    const c = doc.components[cid];
    if (!c || !c.actions || !c.actions.click) continue;
    const t = c.actions.click.target;
    if (idMap[t]) {
      c.actions.click = { ...c.actions.click, target: idMap[t] };
    } else if (crossProject) {
      delete c.actions.click;
      if (!Object.keys(c.actions).length) delete c.actions;
      notices.push({ level: 'warn', message: `组件 "${cid}" 的点击动作目标 "${t}" 不在粘贴内容中且属于来源项目：该动作已移除` });
    }
  }

  if (strippedFields.size) {
    notices.push({ level: 'info', message: `目标为 v${doc.version} 文档：已剥除 v3 专属字段（${[...strippedFields].join('、')}），粘贴的组件按 v2 语义生效` });
  }
  if (stripPage.length) {
    notices.push({ level: 'info', message: `组件 ${stripPage.join('、')} 在来源中是页面图层；页面只能挂在根容器下，粘贴时已按普通容器处理` });
  }
  return { newId: nid, notices };
}

// ---------- 副本（duplicate）：先建完整 ID 映射，再克隆并重映射内部引用 ----------
// 与粘贴不同：副本发生在同一文档内，子树外部的动作目标按规则保留。
// 返回 { newId, idMap }；根不存在返回 null。
export function duplicateSubtree(doc, rootId, { nameSuffix = ' 副本' } = {}) {
  const src = doc.components && doc.components[rootId];
  if (!src) return null;
  const idMap = {};
  const reserved = new Set();
  const newIdFor = (sid) => {
    let base = slugify(sid + '_copy') || 'comp';
    if (!ID_PATTERN.test(base)) base = 'c_' + base;
    let nid = base;
    let i = 2;
    while (doc.components[nid] || reserved.has(nid)) { nid = base + '_' + i; i++; }
    reserved.add(nid);
    return nid;
  };
  // 第一遍：为整棵子树分配新 id（与克隆顺序无关，前向引用也能映射）
  const assign = (sid) => {
    const s = doc.components[sid];
    if (!s) return;
    idMap[sid] = newIdFor(sid);
    if (isContainer(s)) (s.children || []).forEach(assign);
  };
  assign(rootId);
  // 第二遍：克隆 + 内部引用重映射（actions.click.target 指向子树内 → 换副本 id）
  const cloneOne = (sid, pid) => {
    const s = doc.components[sid];
    if (!s) return null;
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = idMap[sid];
    copy.parent = pid;
    copy.name = (s.name || sid) + nameSuffix;
    if (copy.actions && copy.actions.click && idMap[copy.actions.click.target]) {
      copy.actions.click = { ...copy.actions.click, target: idMap[copy.actions.click.target] };
    }
    doc.components[copy.id] = copy;
    if (isContainer(copy)) copy.children = (s.children || []).map((cid) => cloneOne(cid, copy.id)).filter(Boolean);
    return copy.id;
  };
  const newId = cloneOne(rootId, src.parent || 'root');
  return { newId, idMap };
}

// ---------- 布局适配（从 panels.js 上移的共享实现；geo 为 DOM 实测快照，可缺失） ----------
// 旧排列布局是否在该轴上把 auto 尺寸拉伸显示：纵向排列的交叉轴（宽）/横向排列的交叉轴（高），
// align 默认 stretch。这种 auto 不是内容宽度，转自由布局时不固化会视觉缩水。
function axisStretchedByOldLayout(oldLayout, axis) {
  if (!oldLayout || (oldLayout.mode !== 'vertical' && oldLayout.mode !== 'horizontal')) return false;
  const cross = oldLayout.mode === 'vertical' ? 'width' : 'height';
  return axis === cross && (oldLayout.align || 'stretch') === 'stretch';
}

// 把（mutate 克隆内的）子组件适配进目标容器布局；geo 为 DOM 实测几何快照（可缺失）。
// 转自由布局：保持转换瞬间的真实视觉位置（含边框换算）；fill 轴与被旧布局拉伸的 auto 轴
// 都按实测尺寸固化为 fixed；转网格：按顺序分配第一个空闲格，避免全部堆在 1,1。
// CLI 无 DOM 时不走这里（见 validate.js opMove）。
export function adaptChildToTargetLayout(doc, child, target, geo, oldLayout) {
  const toMode = target.layout.mode;
  if (child.placement?.mode === 'absolute') {
    child.position = (geo && geo.position) || child.position || { left: 24, top: 24 };
    delete child.area;
    for (const axis of ['width', 'height']) if (child.size[axis]?.mode === 'fill') {
      const rendered = geo?.rect && Math.round(axis === 'width' ? geo.rect.w : geo.rect.h);
      child.size[axis] = rendered ? { mode: 'fixed', value: rendered } : { mode: 'auto' };
    }
    return;
  }
  if (toMode === 'free') {
    delete child.placement;
    child.position = (geo && geo.position) || child.position || { left: 24, top: 24 };
    for (const axis of ['width', 'height']) {
      const s = child.size[axis];
      if (!s) continue;
      const rendered = (geo && geo.rect) ? Math.round(axis === 'width' ? geo.rect.w : geo.rect.h) : null;
      if (s.mode === 'fill') {
        child.size[axis] = rendered != null ? { mode: 'fixed', value: rendered } : { mode: 'auto' };
      } else if (s.mode === 'auto' && rendered != null && axisStretchedByOldLayout(oldLayout, axis)) {
        child.size[axis] = { mode: 'fixed', value: rendered };
      }
    }
  } else {
    delete child.position;
    if (toMode === 'grid') child.area = firstFreeGridCell(target, doc);
    else delete child.area;
  }
}
