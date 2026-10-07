// UIDoc v4 的意图字段与 AI 写入规则。纯函数，浏览器、服务端与 CLI 共用。
// purpose 仍承担区域用途；精度描述意图，ai 决定强制保护范围。
export const PRECISION_OPTIONS = [
  ['rough', '大致布局'], ['exact', '精确布局'], ['ai', '由 AI 布局'],
];
export const AI_POLICY_OPTIONS = [
  ['open', '允许完善'], ['preserve', '保留结构与位置'],
];

const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// 比较 JSON 语义，不因对象键顺序不同产生误报。
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (!object(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const pack = (errors) => ({ ok: errors.length === 0, errors });

export function validateIntent(doc) {
  const errors = [];
  const add = (field, message, componentId, presentation) => errors.push({
    severity: 'error', code: 'E_INTENT_INVALID', field, message,
    ...(componentId ? { componentId } : {}), ...(presentation ? { presentation } : {}),
  });
  if (doc?.version !== 4) return pack(errors);
  if (!object(doc.intent)) add('intent', '设计意图须为对象，包含 goal 与 style');
  else {
    for (const k of Object.keys(doc.intent)) if (!['goal', 'style'].includes(k)) add('intent.' + k, '未知设计意图字段：' + k);
    for (const [k, max] of [['goal', 4000], ['style', 2000]]) {
      if (typeof doc.intent[k] !== 'string' || doc.intent[k].length > max) add('intent.' + k, `${k} 须为不超过 ${max} 字的文字`);
    }
  }
  for (const [pid, pres] of Object.entries(doc.presentations || {})) {
    for (const [id, comp] of Object.entries(pres?.components || {})) {
      if (!object(comp) || comp.intent === undefined) continue;
      if (!object(comp.intent)) { add('intent', '组件设计意图须为对象', id, pid); continue; }
      for (const k of Object.keys(comp.intent)) if (!['precision', 'ai'].includes(k)) add('intent.' + k, '未知组件意图字段：' + k, id, pid);
      if (!PRECISION_OPTIONS.some(([v]) => v === comp.intent.precision)) add('intent.precision', '布局精度须为 rough、exact 或 ai', id, pid);
      if (!AI_POLICY_OPTIONS.some(([v]) => v === comp.intent.ai)) add('intent.ai', 'AI 修改范围须为 open 或 preserve', id, pid);
    }
  }
  return pack(errors);
}

// 保留位置 = 相对父容器的原始 position/size/placement/area 声明。
// 同时保留祖先的布局与几何声明；自动排列仍按既有规则响应视口与内容。
// 保留结构 = 既有子树的 ID、类型、父子关系和相对顺序；可添加内部内容。
// AI 不得重写用户意图或解除保护。手动编辑不受这套规则限制。
export function checkAiPolicy(before, after) {
  if (before?.version !== 4) return pack([]);
  const errors = [];
  const add = (componentId, field, message, presentation) => errors.push({
    severity: 'error', code: 'E_AI_POLICY', componentId: componentId || 'root', field, message,
    ...(presentation ? { presentation } : {}),
  });
  if (after?.version !== 4) { add('root', 'version', 'AI 不得降低文档版本或移除设计意图'); return pack(errors); }
  if (!same(before.intent, after.intent)) add('root', 'intent', 'AI 不得改写项目目标与风格意图');
  if (!same(before.activeVariant, after.activeVariant)) add('root', 'activeVariant', 'AI 不得切换用户选定的方案');
  const routes = (d) => (Array.isArray(d.variants) ? d.variants : []).map((v) => ({ id: v?.id, presentation: v?.presentation, style: v?.style }));
  if (!same(routes(before), routes(after))) add('root', 'variants', 'AI 不得改变方案与呈现、风格的关联');

  for (const [pid, pres] of Object.entries(before.presentations || {})) {
    const oldComps = pres?.components || {};
    const newComps = after.presentations?.[pid]?.components || {};
    const compare = (id, field, reason) => {
      if (!same(oldComps[id]?.[field], newComps[id]?.[field])) add(id, field, reason, pid);
    };
    for (const [id, c] of Object.entries(oldComps)) {
      if (!c) continue;
      if (newComps[id]) {
        compare(id, 'intent', 'AI 不得修改组件的布局精度或保护策略');
        compare(id, 'purpose', 'AI 不得改写用户填写的区域用途');
      }
      if (c.intent?.ai !== 'preserve') continue;
      if (!newComps[id]) { add(id, 'component', 'AI 不得删除受保护区域', pid); continue; }
      for (const field of ['size', 'position', 'placement', 'area']) compare(id, field, 'AI 不得修改受保护区域的相对位置或尺寸');
      // 锚定区域及祖先的相对顺序；祖先的几何/排列也不能绕过位置保护。
      let anchor = id;
      const visited = new Set();
      while (oldComps[anchor] && !visited.has(anchor)) {
        visited.add(anchor);
        const a = oldComps[anchor];
        compare(anchor, 'parent', 'AI 不得移动受保护区域或其祖先');
        if (a.parent) {
          const prev = oldComps[a.parent]?.children || [];
          const next = Array.isArray(newComps[a.parent]?.children) ? newComps[a.parent].children : [];
          if (prev.indexOf(anchor) !== next.indexOf(anchor)) add(anchor, 'parent.children', 'AI 不得改变受保护区域或其祖先的排列位置', pid);
        }
        if (anchor !== id) {
          for (const field of ['type', 'layout', 'size', 'position', 'placement', 'area', 'page', 'initiallyOpen']) compare(anchor, field, 'AI 不得通过修改祖先布局改变受保护区域的位置');
          if (!same(oldComps[anchor]?.style?.borderWidth, newComps[anchor]?.style?.borderWidth)) add(anchor, 'style.borderWidth', 'AI 不得改变受保护区域的父容器内容边界', pid);
        }
        anchor = a.parent;
      }
      if (!same(before.canvas.width, after.canvas?.width) || !same(before.canvas.height, after.canvas?.height)) add(id, 'canvas', 'AI 不得改变受保护区域使用的画布尺寸', pid);
      const pending = [id];
      const seen = new Set();
      while (pending.length) {
        const childId = pending.pop();
        if (seen.has(childId)) continue;
        seen.add(childId);
        const child = oldComps[childId];
        if (!child) continue;
        if (!newComps[childId]) { add(childId, 'component', 'AI 不得删除受保护区域内的既有组件', pid); continue; }
        for (const field of ['type', 'parent', 'page', 'initiallyOpen']) compare(childId, field, 'AI 不得改变受保护区域的既有结构');
        if (Array.isArray(child.children)) {
          const nextChildren = Array.isArray(newComps[childId].children) ? newComps[childId].children : [];
          const remaining = nextChildren.filter((cid) => child.children.includes(cid));
          if (!same(child.children, remaining)) add(childId, 'children', 'AI 不得重排或移出受保护区域的既有子级', pid);
          pending.push(...child.children);
        }
      }
    }
  }
  return pack(errors.filter((e, i, all) => all.findIndex((v) => v.componentId === e.componentId && v.field === e.field && v.presentation === e.presentation) === i));
}
