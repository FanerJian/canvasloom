// ============================================================
// UIDoc v1 实测检查 —— 基于预览快照（measured rects）做布局体检
// 快照结构：
// { revision, viewport:{width,height}, measuredAt,
//   measured: { [id]: {x,y,width,height,visible} } }  // 相对根元素左上角
//
// 检查分两层：
//   1. 快照有效性门禁（修订号、组件覆盖、坐标类型）——不过门禁就不产生
//      任何"布局验证通过"的结论，全部按错误处理；
//   2. 规则与实测对照（固定尺寸一致、自由布局位置一致）+ 边界/重叠检查。
// ============================================================
import { normalizePadding, findComponent, isAbsolutePlacement } from './protocol.js';

function issue(list, severity, code, message, componentId, field) {
  const it = { severity, code, message, source: 'measure' };
  if (componentId) it.componentId = componentId;
  if (field) it.field = field;
  list.push(it);
}

function rectsIntersect(a, b, tol = 1) {
  return a.x < b.x + b.width - tol && b.x < a.x + a.width - tol &&
         a.y < b.y + b.height - tol && b.y < a.y + a.height - tol;
}

function containedIn(child, parent, tol = 1) {
  return child.x >= parent.x - tol && child.y >= parent.y - tol &&
         child.x + child.width <= parent.x + parent.width + tol &&
         child.y + child.height <= parent.y + parent.height + tol;
}

function overflowDirs(child, parent, tol = 1) {
  const dirs = [];
  if (child.x < parent.x - tol) dirs.push('左');
  if (child.x + child.width > parent.x + parent.width + tol) dirs.push('右');
  if (child.y < parent.y - tol) dirs.push('上');
  if (child.y + child.height > parent.y + parent.height + tol) dirs.push('下');
  return dirs;
}

const SIZE_TOL = 1.5;   // 尺寸/位置对照容差（px），吸收亚像素取整

// opts.pageIds（v3.1，可选）：页面图层容器 id 列表。实测快照把全部页面渲染在一起，
// 但运行时它们是互斥显示的——不同页面之间（含页面与常驻层之间）的重叠不报告。
// opts.hiddenIds（S1 B06，可选）：本次渲染中按运行时初始状态隐藏的组件 id
// （初始收起面板 + 非当前页页面图层，含其子树）。隐藏组件不参与可见性结论、
// 规则对照与重叠判定——它们在截图中不可见，报"尺寸不一致/不可见"都是误导。
export function checkSnapshot(doc, snapshot, opts = {}) {
  const issues = [];
  // v3 文档本体没有顶层 components：调用方必须先解析到具体呈现方案（editScopeOf）。
  // 这里给出结构化错误而不是抛异常（S1 B03：CLI validate --snapshot 不再 E_CLI_CRASH）。
  const comps = doc && doc.components && typeof doc.components === 'object' ? doc.components : null;
  if (!comps) {
    issue(issues, 'error', 'E_SNAPSHOT',
      '文档缺少 components 组件表，无法对照实测数据（v3 文档请先解析到具体变体/呈现方案再校验）');
    return pack(issues);
  }
  const pageOwners = new Map(); // 组件id → 所属页面容器id（页面外组件无归属）
  for (const pid of (Array.isArray(opts.pageIds) ? opts.pageIds : [])) {
    const pc = comps[pid];
    if (!pc) continue;
    const walk = (id) => {
      pageOwners.set(id, pid);
      const cc = comps[id];
      if (cc && cc.children) cc.children.forEach(walk);
    };
    walk(pid);
  }
  // 隐藏集合：hiddenIds 及其全部后代（隐藏容器内的组件一并跳过结论）
  const hidden = new Set();
  const addHiddenTree = (id) => {
    if (hidden.has(id) || !comps[id]) return;
    hidden.add(id);
    (comps[id].children || []).forEach(addHiddenTree);
  };
  for (const id of (Array.isArray(opts.hiddenIds) ? opts.hiddenIds : [])) addHiddenTree(id);

  // ---------- 第 1 层：快照有效性门禁 ----------
  if (!snapshot || typeof snapshot !== 'object') {
    issue(issues, 'error', 'E_SNAPSHOT', '快照不是有效的对象');
    return pack(issues);
  }
  if (!snapshot.measured || typeof snapshot.measured !== 'object') {
    issue(issues, 'error', 'E_SNAPSHOT', '缺少有效快照（需要 measured 字段）');
    return pack(issues);
  }
  if (snapshot.revision == null) {
    issue(issues, 'error', 'E_SNAPSHOT_INVALID', '快照缺少 revision 字段，无法确认实测对应的版本');
    return pack(issues);
  }
  if (doc.revision != null && snapshot.revision !== doc.revision) {
    issue(issues, 'error', 'E_REVISION_STALE',
      `快照基于修订号 ${snapshot.revision}，当前文档修订号是 ${doc.revision}——过期快照不能作为当前设计的实测结论（请用当前修订号重新测量）`);
    // 不 return：继续给出仅供参考的问题，但 ok 必为 false
  }
  const vp = snapshot.viewport;
  if (!vp || typeof vp !== 'object' || !isFinite(vp.width) || !isFinite(vp.height)) {
    issue(issues, 'error', 'E_SNAPSHOT_INVALID', '快照缺少有效的 viewport（width/height）');
    return pack(issues);
  }

  const M = snapshot.measured;
  const root = M.root;

  // 覆盖完整性：文档中每个组件都必须有实测数据
  const missing = [];
  for (const comp of Object.values(comps)) {
    if (!comp) continue;
    const m = M[comp.id];
    if (!m || typeof m !== 'object') missing.push(comp.id);
  }
  if (missing.length) {
    const shown = missing.slice(0, 10).join('、') + (missing.length > 10 ? ` 等 ${missing.length} 个` : '');
    issue(issues, 'error', 'E_INCOMPLETE_SNAPSHOT',
      `快照不完整：${shown} 缺少实测数据（快照必须覆盖文档中的全部组件，否则无法给出完整结论）`);
  }
  if (!root || typeof root !== 'object') {
    issue(issues, 'error', 'E_SNAPSHOT', '快照缺少根元素 root 的实测数据');
    return pack(issues);
  }

  // 坐标类型严格校验
  let coordBad = false;
  for (const comp of Object.values(comps)) {
    if (!comp) continue;
    const m = M[comp.id];
    if (!m || typeof m !== 'object') continue;
    for (const k of ['x', 'y', 'width', 'height']) {
      const v = m[k];
      if (typeof v !== 'number' || !isFinite(v)) {
        issue(issues, 'error', 'E_SNAPSHOT_INVALID',
          `组件 "${comp.id}" 的实测 ${k} 不是有限数值（${JSON.stringify(v)}），快照无效`, comp.id, k);
        coordBad = true;
      }
    }
  }
  {
    for (const k of ['x', 'y', 'width', 'height']) {
      const v = root[k];
      if (typeof v !== 'number' || !isFinite(v)) {
        issue(issues, 'error', 'E_SNAPSHOT_INVALID', `根元素 root 的实测 ${k} 不是有限数值（${JSON.stringify(v)}）`, 'root', k);
        coordBad = true;
      }
    }
  }

  // ---------- 第 2 层：规则对照 + 边界/重叠 ----------
  // 允许溢出豁免的组件集合（含其子树）
  const exempt = new Set();
  const collectExempt = (id) => {
    const c = comps[id];
    if (!c) return;
    if (c.flags && c.flags.allowOverflow) {
      exempt.add(id);
      (c.children || []).forEach((cid) => collectExempt(cid));
    } else {
      (c.children || []).forEach((cid) => collectExempt(cid));
    }
  };
  collectExempt('root');

  for (const comp of Object.values(comps)) {
    if (!comp) continue;
    const m = M[comp.id];
    if (!m || typeof m !== 'object') continue;
    if (coordBad && (typeof m.x !== 'number' || typeof m.width !== 'number')) continue;
    if (hidden.has(comp.id)) continue; // 隐藏子树：不参与可见性/规则/越界/溢出结论（S1 B06）
    if (!m.visible || m.width <= 0 || m.height <= 0) {
      issue(issues, 'warning', 'W_INVISIBLE', `组件 "${comp.id}" 在该视口下不可见或尺寸为 0（${m.width}×${m.height}）`, comp.id);
      continue;
    }

    // --- 规则 vs 实测：固定尺寸必须按设计值呈现 ---
    for (const axis of ['width', 'height']) {
      const s = (comp.size || {})[axis];
      if (!s || s.mode !== 'fixed') continue;
      const actual = axis === 'width' ? m.width : m.height;
      if (Math.abs(actual - s.value) > SIZE_TOL) {
        issue(issues, 'error', 'E_SIZE_MISMATCH',
          `组件 "${comp.id}" 的${axis === 'width' ? '宽' : '高'}设计要求固定 ${s.value}px，实测 ${Math.round(actual * 10) / 10}px——渲染结果与设计规则不一致`,
          comp.id, 'size.' + axis);
      }
    }

    // --- 规则 vs 实测：自由布局子元素位置相对父容器内容区 ---
    // 内容区 = 父边框盒内缩 border + padding；快照带 bl/bt（左边框/上边框宽度）时精确换算，
    // 旧快照无该字段按 0 处理（与旧行为一致）
    const parent = comp.parent ? findComponent(doc, comp.parent) : null;
    if (parent && parent.type === 'container' && isAbsolutePlacement(comp, parent) && comp.position) {
      const pm = M[comp.parent];
      if (pm && isFinite(pm.x) && isFinite(pm.y)) {
        const pad = normalizePadding(parent.layout.padding);
        const expX = pm.x + (pm.bl || 0) + pad[3] + comp.position.left;
        const expY = pm.y + (pm.bt || 0) + pad[0] + comp.position.top;
        if (Math.abs(m.x - expX) > SIZE_TOL || Math.abs(m.y - expY) > SIZE_TOL) {
          issue(issues, 'error', 'E_POSITION_MISMATCH',
            `组件 "${comp.id}" 设计要求位于父容器内容区 (${comp.position.left},${comp.position.top})，实测相对根元素位于 (${Math.round(m.x)},${Math.round(m.y)})，预期 (${Math.round(expX)},${Math.round(expY)})——渲染结果与设计规则不一致`,
            comp.id, 'position');
        }
      }
    }

    // 越界检查（相对根元素）：仅当与页面交集很小（<50%）才判"超出可视区域"错误；
    // 部分超出交给下方父容器溢出检查（可豁免、可调整），避免双重误报
    if (!containedIn(m, root, 1.5)) {
      const ix = Math.max(0, Math.min(m.x + m.width, root.x + root.width) - Math.max(m.x, root.x));
      const iy = Math.max(0, Math.min(m.y + m.height, root.y + root.height) - Math.max(m.y, root.y));
      const area = Math.max(1, m.width * m.height);
      const visibleRatio = (ix * iy) / area;
      if (visibleRatio < 0.5) {
        issue(issues, 'error', 'E_OFFSCREEN',
          `组件 "${comp.id}" 大部分超出页面可视区域（仅 ${Math.round(visibleRatio * 100)}% 可见，位于 ${Math.round(m.x)},${Math.round(m.y)}，尺寸 ${Math.round(m.width)}×${Math.round(m.height)}）`, comp.id);
        continue;
      }
    }
    // 溢出父容器检查
    if (comp.parent && M[comp.parent] && !exempt.has(comp.id)) {
      const pm = M[comp.parent];
      const dirs = overflowDirs(m, pm);
      if (dirs.length) {
        const full = !rectsIntersect(m, pm, 2);
        issue(issues, full ? 'error' : 'warning', full ? 'E_OVERFLOW' : 'W_OVERFLOW',
          `组件 "${comp.id}" ${full ? '完全脱离' : '溢出'}父容器 "${comp.parent}" 的边界（${dirs.join('、')}方向超出）` +
          (full ? '' : '；若为有意设计，可在该组件 flags.allowOverflow 标记豁免'),
          comp.id, 'position');
      }
    }
  }

  // 独立摆放组件间、以及独立摆放组件与排列组件间的重叠检查。
  for (const comp of Object.values(doc.components)) {
    if (!comp || comp.type !== 'container' || !comp.children) continue;
    const kids = comp.children.map((cid) => ({ cid, m: M[cid], c: doc.components[cid] }))
      .filter((k) => k.m && typeof k.m.x === 'number' && k.m.visible && k.m.width > 0 && k.m.height > 0);
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i], b = kids[j];
        if (!isAbsolutePlacement(a.c, comp) && !isAbsolutePlacement(b.c, comp)) continue;
        if (hidden.has(a.cid) || hidden.has(b.cid)) continue; // 隐藏组件不参与重叠结论
        if (!rectsIntersect(a.m, b.m, 2)) continue;
        // v3.1 页面豁免：归属不同页面（或一方在页面外）的重叠不判——页面互斥显示
        if (pageOwners.get(a.cid) !== pageOwners.get(b.cid)) continue;
        const ca = doc.components[a.cid], cb = doc.components[b.cid];
        const noOverlap = (ca && ca.flags && ca.flags.noOverlap) || (cb && cb.flags && cb.flags.noOverlap);
        issue(issues, noOverlap ? 'error' : 'warning', noOverlap ? 'E_OVERLAP' : 'W_OVERLAP_FREE',
          `容器 "${comp.id}" 中，"${a.cid}" 与 "${b.cid}" 的独立摆放位置相互重叠` +
          (noOverlap ? '（其中一方标记了 flags.noOverlap，判定为违规）' : '；若为有意的叠层设计可忽略，或用 flags.noOverlap 声明禁止'),
          a.cid, 'position');
      }
    }
  }

  return pack(issues);
}

function pack(issues) {
  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === 'warning'), issues };
}
