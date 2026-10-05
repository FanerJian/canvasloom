// ============================================================
// M5 编辑器 v3 引用维护助手（纯函数，Node 可测）
// 画布编辑作用于 presentation 原树；重命名/删除组件时，v3 引用
// （actions.target、overrides.components 补丁键）必须联动维护，
// 否则文档无法通过保存校验（E_ACTION_TARGET_INVALID / E_COMPONENT_MISSING）。
// 输入的 doc 是可变克隆（mutate 回调内的编辑域 scope 同样适用：
// 其 presentations/variants 与克隆文档共享同一批嵌套对象）。
// ============================================================
import { slugify, ID_PATTERN } from '../shared/protocol.js';

function forEachPresentationComponent(doc, presentationId, fn) {
  const pres = doc.presentations && doc.presentations[presentationId];
  if (!pres || !pres.components) return;
  for (const id of Object.keys(pres.components)) fn(pres.components[id]);
}

// 重命名组件后重映射引用（仅作用于该 presentation 的树与指向它的 variants 补丁键）
export function remapComponentRefs(doc, presentationId, idMap) {
  const ids = Object.keys(idMap || {});
  if (!ids.length) return;
  forEachPresentationComponent(doc, presentationId, (c) => {
    if (c.actions && c.actions.click && idMap[c.actions.click.target]) {
      c.actions.click = { ...c.actions.click, target: idMap[c.actions.click.target] };
    }
  });
  for (const v of Array.isArray(doc.variants) ? doc.variants : []) {
    if (!v || v.presentation !== presentationId) continue;
    const patches = v.overrides && v.overrides.components;
    if (!patches) continue;
    for (const oldId of ids) {
      if (!Object.prototype.hasOwnProperty.call(patches, oldId)) continue;
      const newId = idMap[oldId];
      if (newId && !Object.prototype.hasOwnProperty.call(patches, newId)) {
        patches[newId] = patches[oldId];
      }
      delete patches[oldId];
    }
  }
}

// 删除组件后清理悬空引用：按钮指向被删组件的 click 动作整条移除；
// 变体补丁键（被删组件）移除。保持文档结构可保存，无需用户手修。
export function cleanupDeletedRefs(doc, presentationId, deletedIds) {
  const gone = new Set(deletedIds || []);
  if (!gone.size) return;
  forEachPresentationComponent(doc, presentationId, (c) => {
    if (c.actions && c.actions.click && gone.has(c.actions.click.target)) {
      delete c.actions.click;
      if (!Object.keys(c.actions).length) delete c.actions;
    }
  });
  for (const v of Array.isArray(doc.variants) ? doc.variants : []) {
    if (!v || v.presentation !== presentationId) continue;
    const patches = v.overrides && v.overrides.components;
    if (!patches) continue;
    for (const cid of gone) delete patches[cid];
  }
}

// 变体 id：中文名取不到 ASCII slug 时兜底 variant；与既有变体去重（v2、v3…）
export function uniqueVariantId(doc, label) {
  const taken = new Set((Array.isArray(doc.variants) ? doc.variants : []).map((v) => v && v.id));
  let base = slugify(label) || 'variant';
  if (!ID_PATTERN.test(base)) base = 'v_' + base;
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + '_' + i)) i++;
  return base + '_' + i;
}

// 呈现方案 id：复制呈现时生成未占用的新键
export function uniquePresentationId(doc, base) {
  const taken = new Set(doc.presentations ? Object.keys(doc.presentations) : []);
  let id = slugify(base) || 'pres';
  if (!ID_PATTERN.test(id)) id = 'p_' + id;
  if (!taken.has(id)) return id;
  let i = 2;
  while (taken.has(id + '_' + i)) i++;
  return id + '_' + i;
}
