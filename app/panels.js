import { isPresentationDoc } from '../shared/protocol.js';
// ============================================================
// 面板：左侧（组件库 + 层级树）、右侧（属性面板）、模态框、提示
// 属性面板中文标签与 shared/protocol.js 的字段定义同源。
// ============================================================
import { state, mutate, select, toggleSelected, selectedIds, resyncSelection, history, selectedComp, PALETTE_MIME, viewDoc, scopeOf, pagesOfDoc } from './store.js';
import {
  COMPONENT_TYPES, TYPE_IDS, LAYOUT_MODES, SIZE_MODES, LIMITS,
  JUSTIFY_OPTIONS, ALIGN_OPTIONS, STYLE_FIELDS, ID_PATTERN,
  V3_BIND_PATTERN, V3_ACTION_TYPES,
  findComponent, isContainer, listContainers, normalizePadding, isAbsolutePlacement,
  newComponent, cloneSubtree, genId, slugify, firstFreeGridCell, DEFAULT_MODE,
} from '../shared/protocol.js';
import { UI_MODES } from '../shared/modes.js';
import { instantiateBlock } from '../shared/blocks.js';
import { validateDoc } from '../shared/validate.js';
import { designRectById, positionPreservingVisual, parentContentOriginById } from './design-geometry.js';
import { ALIGN_MODES, ALIGN_LABELS, planAlign, planDistribute, sharedParent } from './align.js';
import { remapComponentRefs, cleanupDeletedRefs } from './v3edit.js';
import { collectCopySnapshot, pasteSnapshotIntoDoc, duplicateSubtree, adaptChildToTargetLayout } from '../shared/clipboard.js';
import { intentSection } from './intent-ui.js';

const svgWrap = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`;
const TYPE_ICONS = {
  container: svgWrap('<rect x="3" y="3" width="18" height="18" rx="2.5"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
  text:      svgWrap('<path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
  button:    svgWrap('<rect x="2.5" y="6.5" width="19" height="11" rx="3"/><path d="M7.5 12h9"/>'),
  input:     svgWrap('<rect x="2.5" y="7" width="19" height="10" rx="2.5"/><path d="M6.5 10.5v3"/>'),
  image:     svgWrap('<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.7" cy="8.7" r="1.6"/><path d="M21 15.5l-4.8-4.8L5.5 21"/>'),
  rect:      svgWrap('<rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/>'),
  divider:   svgWrap('<path d="M3 12h18"/>'),
};

// palette 拖拽源：dragover 期间 dataTransfer.getData 不可读，
// payload 同时写入 window.__canvasloomDrag 供画布做幽灵占位，drop 时以 getData 为准
function attachPaletteDrag(btn, payload) {
  btn.draggable = true;
  btn.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(payload));
    window.__canvasloomDrag = payload;
  });
}

// ================= 预设块（可浏览全部场景模式的块库） =================
// 面板顶部场景选择器只决定「待插入清单」的来源；插入动作不改文档模式，
// 也绝不重新美化已有内容。默认跟随当前项目模式。
export function renderBlocks() {
  const host = document.getElementById('pal-blocks');
  if (!host) return;
  const docMode = state.doc ? ((viewDoc() || state.doc).mode || DEFAULT_MODE) : DEFAULT_MODE;
  const viewMode = state.paletteModeId && UI_MODES[state.paletteModeId] ? state.paletteModeId : docMode;
  const key = viewMode + '|' + (state.paletteModeId || '');
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.textContent = '';
  const sel = document.createElement('select');
  sel.className = 'p-input p-blockmode';
  sel.title = '浏览其他场景模式的预设块';
  const follow = document.createElement('option');
  follow.value = '';
  follow.textContent = `跟随项目（${(UI_MODES[docMode] || UI_MODES.generic).label}）`;
  sel.appendChild(follow);
  for (const [id, m] of Object.entries(UI_MODES)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  sel.value = state.paletteModeId || '';
  sel.addEventListener('change', () => { state.paletteModeId = sel.value || null; renderBlocks(); });
  host.appendChild(sel);
  const mode = UI_MODES[viewMode] || UI_MODES.generic;
  for (const blk of mode.blocks || []) {
    const b = document.createElement('button');
    b.className = 'blk-item';
    b.title = `${blk.desc || blk.label}` + (viewMode !== docMode ? `（${mode.label}）` : '');
    b.innerHTML = `<strong>${blk.label}</strong><span>${blk.desc || ''}</span>`;
    b.addEventListener('click', () => insertBlock(blk));
    attachPaletteDrag(b, { kind: 'block', label: blk.label });
    host.appendChild(b);
  }
}

function insertBlock(blk) {
  const target = blockInsertionTarget();
  mutate(`插入预设块 ${blk.label}`, (doc) => {
    const comp = instantiateBlock(doc, blk, target);
    state.pendingSelect = comp.id;
    state.lastAdded = comp.id;
    state.lastBlockId = comp.id;
  });
  toast(`已插入「${blk.label}」`);
}

// 预设块的目标容器：与普通组件不同——刚插完一个块后继续点击，
// 新块应与上一个块平级（追加到同一容器），而不是嵌进上一个块里。
function blockInsertionTarget() {
  const c = selectedComp();
  if (!c) return 'root';
  if (c.id === state.lastBlockId) return c.parent || 'root';
  if (isContainer(c)) return c.id;
  return c.parent || 'root';
}

// ================= 组件库 =================
export function renderPalette() {
  renderRegionPalette();
  const list = document.getElementById('pal-list');
  list.textContent = '';
  for (const type of TYPE_IDS) {
    const def = COMPONENT_TYPES[type];
    const b = document.createElement('button');
    b.className = 'pal-item';
    b.dataset.type = type;
    b.title = def.desc;
    b.innerHTML = `<span class="pal-ico">${TYPE_ICONS[type] || '▪'}</span><span>${def.label}</span>`;
    b.addEventListener('click', () => addComponent(type));
    attachPaletteDrag(b, { kind: 'component', type });
    list.appendChild(b);
  }
}

// ================= 起步区域（S2） =================
// 粗布局入口：带用途说明（purpose）的常用分区，落位后随时改名改样式。
// 列表占位/操作区会带最小内容骨架，说明条目与用途；不预设完整样式。
const REGION_PRESETS = [
  { key: 'region', label: '区域', icon: '▭', desc: '通用分区' },
  { key: 'heading', label: '标题', icon: 'H', desc: '大号标题文字' },
  { key: 'text', label: '文本占位', icon: '≡', desc: '占位文本' },
  { key: 'image', label: '图片占位', icon: '🖼', desc: '图片占位' },
  { key: 'list', label: '列表占位', icon: '☰', desc: '列表骨架（3 条示例）' },
  { key: 'actions', label: '操作区', icon: '⏎', desc: '操作按钮区' },
];

function renderRegionPalette() {
  const wrap = document.getElementById('pal-regions');
  if (!wrap) return;
  wrap.textContent = '';
  for (const p of REGION_PRESETS) {
    const b = document.createElement('button');
    b.className = 'pal-item';
    b.dataset.region = p.key;
    b.title = p.desc;
    b.innerHTML = `<span class="pal-ico">${p.icon}</span><span>${p.label}</span>`;
    b.addEventListener('click', () => addRegion(p.key));
    wrap.appendChild(b);
  }
}

function addRegion(key) {
  const target = insertionTarget();
  mutate('添加起步区域', (doc) => {
    const parent = doc.components[target];
    const freeParent = state.freeMove && parent.layout.mode !== 'free';
    let comp = null;
    const mk = (type, extra) => newComponent(doc, type, target, extra);

    if (key === 'region') {
      comp = mk('container', { name: '区域', purpose: '区域：说明这块放什么内容' });
    } else if (key === 'heading') {
      comp = mk('text', { name: '标题', text: '标题', purpose: '页面或区块的标题' });
      comp.style.fontSize = 22;
      comp.style.fontWeight = 'bold';
    } else if (key === 'text') {
      comp = mk('text', { name: '文本占位', text: '这里是一段占位文字，之后替换成正式内容。', purpose: '文本占位：说明这段文字的用途' });
    } else if (key === 'image') {
      comp = mk('image', { name: '图片占位', purpose: '图片占位：之后替换成真实图片' });
    } else if (key === 'list') {
      comp = mk('container', { name: '列表', purpose: '列表占位：约 3–5 项，条目之后替换' });
      for (let i = 1; i <= 3; i++) {
        const item = newComponent(doc, 'text', comp.id, { name: `条目 ${i}`, text: `列表条目 ${i}`, purpose: '列表条目占位' });
        item.size = { width: { mode: 'fill' }, height: { mode: 'auto' } };
      }
    } else if (key === 'actions') {
      comp = mk('container', { name: '操作区', purpose: '操作区：放主要操作按钮', layoutMode: 'horizontal' });
      comp.layout = { ...comp.layout, justify: 'end', align: 'center', padding: 8 };
      const btn = newComponent(doc, 'button', comp.id, { name: '主操作', text: '主操作', purpose: '主要操作按钮' });
      btn.size = { width: { mode: 'auto' }, height: { mode: 'auto' } };
    }
    if (!comp) return;

    // 自由移动模式下落到画布的组件按绝对摆放（与基础组件行为一致）
    if (freeParent) {
      const dims = { container: [240, 160], text: [160, 40], image: [160, 120] }[comp.type] || [160, 48];
      comp.placement = { mode: 'absolute' };
      comp.position = { left: 24 + ((parent.children.length - 1) % 7) * 18, top: 24 + ((parent.children.length - 1) % 7) * 18 };
      comp.size = { width: { mode: 'fixed', value: dims[0] }, height: { mode: 'fixed', value: dims[1] } };
      delete comp.area;
      for (const cid of comp.children || []) {
        const child = doc.components[cid];
        if (child && child.position) { child.position.left += 12; child.position.top += 12; }
      }
    }
    state.pendingSelect = comp.id;
    state.lastAdded = comp.id;
  });
}

function addComponent(type) {
  const target = insertionTarget();
  mutate(`添加 ${COMPONENT_TYPES[type].label}`, (doc) => {
    const comp = newComponent(doc, type, target);
    const parent = doc.components[target];
    if (state.freeMove && parent.layout.mode !== 'free') {
      const dims = { container: [240, 160], text: [160, 40], button: [120, 40], input: [220, 40], image: [160, 120], rect: [120, 80], divider: [160, 1] }[type] || [160, 48];
      comp.placement = { mode: 'absolute' };
      comp.position = { left: 24 + ((parent.children.length - 1) % 7) * 18, top: 24 + ((parent.children.length - 1) % 7) * 18 };
      comp.size = { width: { mode: 'fixed', value: dims[0] }, height: { mode: 'fixed', value: dims[1] } };
      delete comp.area;
    }
    state.pendingSelect = comp.id;
    state.lastAdded = comp.id; // 画布重建后播放一次脉冲高亮
  });
}

function insertionTarget() {
  const c = selectedComp();
  if (!c) return 'root';
  if (isContainer(c)) return c.id;
  return c.parent || 'root';
}

// ================= 层级树 =================
export function renderTree() {
  const tree = document.getElementById('tree');
  if (!state.doc) { tree.textContent = ''; return; }
  tree.textContent = '';
  const view = viewDoc();
  if (!view) {
    // v3 解析失败：树同样无从展示，画布错误卡已给说明
    const hint = document.createElement('div');
    hint.className = 'p-hint';
    hint.textContent = '文档无法解析，详见画布提示';
    tree.appendChild(hint);
    return;
  }
  const pageSet = new Set(pagesOfDoc()); // 页面图层徽标（v3.1）
  tree.appendChild(treeNode(view.components.root, 0, pageSet));
}

function treeNode(comp, depth, pageSet) {
  const row = document.createElement('div');
  const inSel = state.selection === comp.id;
  const inMulti = !inSel && selectedIds().includes(comp.id);
  row.className = 'tree-row' + (inSel ? ' active' : '') + (inMulti ? ' multi' : '');
  row.dataset.id = comp.id;
  row.draggable = true;
  row.style.paddingLeft = (8 + depth * 14) + 'px';
  const hasChildren = isContainer(comp) && (comp.children || []).length > 0;
  const collapsed = state.collapsedTreeIds.has(comp.id);
  const caret = hasChildren ? (collapsed ? '▸' : '▾') : (isContainer(comp) ? '▸' : '');
  const caretCls = hasChildren ? 'tree-caret tog' : (isContainer(comp) ? 'tree-caret empty' : 'tree-caret');
  row.innerHTML = `<span class="${caretCls}">${caret}</span><span class="tree-ico">${TYPE_ICONS[comp.type] || '▪'}</span>` +
    `<span class="tree-name">${escapeHtml(comp.name || comp.id)}</span>` +
    (pageSet && pageSet.has(comp.id) ? '<em class="tree-page-badge" title="页面图层：铺满画布，可被 goto 动作切换显示">页面</em>' : '') +
    `<span class="tree-id">${escapeHtml(comp.id)}</span>`;
  if (hasChildren) {
    const caretEl = row.querySelector('.tree-caret');
    caretEl.title = collapsed ? '展开子组件' : '折叠子组件';
    caretEl.addEventListener('click', (e) => {
      e.stopPropagation(); // 点箭头只折叠/展开，不改变选中
      if (collapsed) state.collapsedTreeIds.delete(comp.id);
      else state.collapsedTreeIds.add(comp.id);
      renderTree();
    });
  }
  row.addEventListener('click', (e) => { if (e.shiftKey) toggleSelected(comp.id); else select(comp.id); });
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/canvasloom-id', comp.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  if (isContainer(comp)) {
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const dragId = e.dataTransfer.getData('text/canvasloom-id');
      if (!dragId || dragId === comp.id) return;
      // DOM 几何在 mutate 前采集（转自由布局时保持视觉位置与被拉伸的尺寸）
      const geo = { position: positionPreservingVisual(dragId, comp.id), rect: designRectById(dragId) };
      const oldLayout = JSON.parse(JSON.stringify(
        (findComponent(viewDoc(), dragId)?.parent ? findComponent(viewDoc(), findComponent(viewDoc(), dragId).parent)?.layout : null) || {}
      ));
      mutate(`移动 ${dragId} 到 ${comp.name}`, (doc) => {
        const dragged = doc.components[dragId];
        if (!dragged) return;
        // 防环：目标不能是自己的后代
        let cur = doc.components[comp.id];
        while (cur) { if (cur.id === dragId) return; cur = doc.components[cur.parent]; }
        const oldParent = doc.components[dragged.parent];
        if (oldParent) oldParent.children = oldParent.children.filter((x) => x !== dragId);
        comp2(doc, comp.id).children.push(dragId);
        dragged.parent = comp.id;
        adaptChildToTargetLayout(doc, dragged, comp2(doc, comp.id), geo, oldLayout);
      });
    });
  }
  const frag = document.createDocumentFragment();
  frag.appendChild(row);
  if (hasChildren && !collapsed) {
    for (const cid of comp.children || []) {
      const child = findComponent(viewDoc(), cid);
      if (child) frag.appendChild(treeNode(child, depth + 1, pageSet));
    }
  }
  return frag;
}
// 辅助：mutate 回调里拿的是克隆 doc
function comp2(doc, id) { return doc.components[id]; }

// ================= 属性面板 =================
export function renderProperties() {
  const root = document.getElementById('props');
  const comp = selectedComp();
  root.textContent = '';
  // 多选（S2b）：显示整组工具（对齐/等距/删除），单组件属性暂不展开
  if (selectedIds().length > 1) {
    root.appendChild(multiSection());
    return;
  }
  if (!comp) {
    root.appendChild(intentSection(null, { openModal, closeModal, toast }));
    root.appendChild(canvasSection());
    const empty = document.createElement('div');
    empty.className = 'props-empty';
    empty.textContent = '未选中组件';
    root.appendChild(empty);
    return;
  }
  const pmode = comp.parent && findComponent(viewDoc(), comp.parent)?.layout?.mode;

  const sec1 = section('组件');
  sec1.appendChild(rowText('名称', comp.name || '', (v) => patch(comp.id, { name: v }, `重命名 ${comp.id}`, 'name'), 'text'));
  sec1.appendChild(rowText('标识 ID', comp.id, (v) => renameComponent(comp.id, v), 'code'));
  sec1.appendChild(rowArea('用途说明', comp.purpose || '', (v) => patch(comp.id, { purpose: v }, `修改 ${comp.id} 的用途说明`, 'purpose')));
  root.appendChild(sec1);
  root.appendChild(intentSection(comp, { openModal, closeModal, toast }));

  const secPos = section('位置与尺寸');
  if (comp.parent) {
    secPos.appendChild(rowSelect('父容器', containerOptions(comp), comp.parent, (v) => reparent(comp.id, v)));
    const siblings = findComponent(viewDoc(), comp.parent).children || [];
    const i = siblings.indexOf(comp.id);
    secPos.appendChild(rowButtons('排列顺序', [
      ['⬆ 上移', () => reorder(comp.id, i - 1), i <= 0],
      ['⬇ 下移', () => reorder(comp.id, i + 1), i >= siblings.length - 1],
    ]));
  }
  if (comp.id !== 'root' && comp.parent) {
    const absolute = comp.placement?.mode === 'absolute' || (!comp.placement && pmode === 'free');
    secPos.appendChild(rowSelect('摆放方式', [['flow', '参与排列'], ['absolute', '独立摆放']], absolute ? 'absolute' : 'flow', (v) => setComponentPlacement(comp.id, v)));
  }
  secPos.appendChild(sizeRow(comp, 'width', '宽'));
  secPos.appendChild(sizeRow(comp, 'height', '高'));
  const posHint = positionHint(comp, pmode);
  if (posHint) secPos.appendChild(posHint);
  if (pmode === 'free' || comp.placement?.mode === 'absolute') {
    secPos.appendChild(rowNums('位置（相对父容器）', [
      ['左', comp.position?.left ?? 0, (v) => patchPosition(comp.id, 'left', v)],
      ['上', comp.position?.top ?? 0, (v) => patchPosition(comp.id, 'top', v)],
    ]));
  }
  if (pmode === 'grid' && !componentIsAbsolute(comp)) {
    const a = comp.area || { col: 1, row: 1, colSpan: 1, rowSpan: 1 };
    secPos.appendChild(rowNums('网格占格', [
      ['列', a.col, (v) => patchArea(comp.id, 'col', v)],
      ['行', a.row, (v) => patchArea(comp.id, 'row', v)],
      ['跨列', a.colSpan || 1, (v) => patchArea(comp.id, 'colSpan', v)],
      ['跨行', a.rowSpan || 1, (v) => patchArea(comp.id, 'rowSpan', v)],
    ]));
  }
  root.appendChild(secPos);

  if (isContainer(comp)) root.appendChild(layoutSection(comp));

  const secStyle = section('样式');
  // v3：活动变体的 overrides 补丁会遮蔽基础样式——编辑写回呈现方案原样式，需明确提示
  const shadowPatch = v3OverridePatchFor(comp.id);
  if (shadowPatch) {
    const hint = document.createElement('div');
    hint.className = 'p-hint';
    hint.textContent = '当前方案覆盖了样式（' + Object.keys(shadowPatch).join('、') + '）；修改写入呈现基础样式，显示以覆盖为准。';
    secStyle.appendChild(hint);
  }
  for (const f of STYLE_FIELDS) {
    if (f.types && !f.types.includes(comp.type)) continue;
    secStyle.appendChild(styleFieldRow(comp, f));
  }
  root.appendChild(secStyle);

  const def = COMPONENT_TYPES[comp.type];
  if (def.fields && Object.keys(def.fields).length) {
    const secC = section('内容');
    for (const [key, f] of Object.entries(def.fields)) {
      if (f.type === 'longtext') secC.appendChild(rowArea(f.label, comp[key] || '', (v) => patch(comp.id, { [key]: v }, `修改 ${comp.id} 的${f.label}`, key)));
      else if (f.type === 'resource') secC.appendChild(resourceRow(comp));
      else if (f.type === 'enum') secC.appendChild(rowSelect(f.label, optsOf(f.options), comp[key] || Object.keys(f.options)[0], (v) => patch(comp.id, { [key]: v }, `修改 ${comp.id} 的${f.label}`, key)));
      else if (f.type === 'number') secPosLikeNum(secC, f.label, comp[key], (v) => patch(comp.id, { [key]: v }, `修改 ${comp.id} 的${f.label}`, key));
      else secC.appendChild(rowText(f.label, comp[key] || '', (v) => patch(comp.id, { [key]: v }, `修改 ${comp.id} 的${f.label}`, key)));
    }
    root.appendChild(secC);
  }

  const secF = section('检查行为', false);
  secF.appendChild(rowCheck('豁免"溢出父容器"判错（有意出血时勾选）', !!(comp.flags?.allowOverflow), (v) => patchFlags(comp.id, 'allowOverflow', v)));
  if (pmode === 'free' || componentIsAbsolute(comp)) {
    secF.appendChild(rowCheck('禁止与兄弟元素重叠（违规则判错误）', !!(comp.flags?.noOverlap), (v) => patchFlags(comp.id, 'noOverlap', v)));
  }
  root.appendChild(secF);

  // v3 组件扩展：功能绑定与交互（编辑器内存直改 presentation 原树；v2 文档不显示）
  if (state.doc && isPresentationDoc(state.doc)) root.appendChild(v3BindingSection(comp));

  if (comp.id !== 'root') {
    const secD = section('危险操作', false);
    secD.appendChild(rowButtons('', [
      ['🗑 删除组件（连同子级）', () => deleteComponent(comp.id), false],
    ], 'danger'));
    root.appendChild(secD);
  }
}

// 活动变体对指定组件的样式补丁（无则 null）——用于面板遮蔽提示
function v3OverridePatchFor(compId) {
  const doc = state.doc;
  if (!doc || !isPresentationDoc(doc)) return null;
  const v = (Array.isArray(doc.variants) ? doc.variants : []).find((x) => x && x.id === doc.activeVariant);
  const patches = v && v.overrides && v.overrides.components;
  return (patches && patches[compId]) || null;
}

// ---- 画布设置（未选中组件时显示） ----
function canvasSection() {
  const sec = section('画布设置', true);
  const doc = viewDoc();
  if (!doc) return sec;
  const root = doc.components.root;

  sec._body.appendChild(rowNums('画布尺寸（px）', [
    ['宽', doc.canvas.width, (v) => commitCanvasSize('width', v)],
    ['高', doc.canvas.height, (v) => commitCanvasSize('height', v)],
  ]));

  const bgRow = mkRow('画布背景');
  bgRow.classList.add('p-multi');
  const color = document.createElement('input');
  color.type = 'color';
  color.value = /^#[0-9a-fA-F]{6}$/.test(doc.canvas.background || '') ? doc.canvas.background : '#ffffff';
  const text = document.createElement('input');
  text.type = 'text';
  text.className = 'p-input mono';
  text.value = doc.canvas.background || '';
  text.placeholder = '#rrggbb';
  const commitBg = () => {
    const v = text.value || color.value;
    mutate('修改画布背景', (d) => { d.canvas.background = v; }, { skipPanels: true });
  };
  color.addEventListener('change', () => { text.value = color.value; commitBg(); });
  text.addEventListener('change', commitBg);
  bgRow.appendChild(color);
  bgRow.appendChild(text);
  sec._body.appendChild(bgRow);

  const ws = (root.size || {}).width || {}, hs = (root.size || {}).height || {};
  const following = ws.mode === 'percent' && ws.value === 100 && hs.mode === 'percent' && hs.value === 100;
  sec._body.appendChild(rowCheck(
    '根容器跟随画布尺寸（画布改变时自动伸缩）',
    following,
    (v) => {
      mutate(v ? '根容器改为跟随画布' : '根容器改为固定尺寸', (d) => {
        const r = d.components.root;
        if (v) {
          r.size = { width: { mode: 'percent', value: 100 }, height: { mode: 'percent', value: 100 } };
        } else {
          r.size = { width: { mode: 'fixed', value: d.canvas.width }, height: { mode: 'fixed', value: d.canvas.height } };
        }
      });
    }
  ));

  const hint = document.createElement('div');
  hint.className = 'p-hint';
  hint.textContent = following
    ? '根容器跟随画布。'
    : '根容器为固定尺寸，不随画布变化；如需跟随请启用上方选项。';
  sec._body.appendChild(hint);
  return sec;
}

function commitCanvasSize(axis, v) {
  if (!isFinite(v)) return;
  if (v < 1 || v > LIMITS.canvasMax) {
    toast(`画布${axis === 'width' ? '宽' : '高'}需为 1-${LIMITS.canvasMax} 的数值`, 'bad');
    renderProperties();
    return;
  }
  mutate(`修改画布${axis === 'width' ? '宽' : '高'}`, (d) => { d.canvas[axis] = Math.round(v); }, { skipPanels: true });
}

function section(title, open = true) {
  const s = document.createElement('details');
  s.className = 'props-sec';
  if (open) s.open = true;
  const sum = document.createElement('summary');
  sum.textContent = title;
  s.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'props-body';
  s.appendChild(body);
  s._body = body;
  return s;
}
function secPosLikeNum(sec, label, value, onCommit) {
  sec._body.appendChild(rowText(label, value == null ? '' : String(value), onCommit, 'number'));
}

// ---- 通用控件 ----
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function mkRow(label) {
  const row = document.createElement('div');
  row.className = 'p-row';
  if (label) {
    const l = document.createElement('label');
    l.className = 'p-label';
    l.textContent = label;
    row.appendChild(l);
  }
  return row;
}
function rowText(label, value, onCommit, kind = 'text', placeholder = '') {
  const row = mkRow(label);
  const input = document.createElement('input');
  input.type = kind === 'code' ? 'text' : kind;
  input.className = 'p-input' + (kind === 'code' ? ' mono' : '');
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('change', () => onCommit(input.value));
  row.appendChild(input);
  return row;
}
function rowArea(label, value, onCommit) {
  const row = mkRow(label);
  const ta = document.createElement('textarea');
  ta.className = 'p-input p-area';
  ta.rows = 2;
  ta.value = value;
  ta.addEventListener('change', () => onCommit(ta.value));
  row.appendChild(ta);
  return row;
}
function rowNums(label, items) {
  const row = mkRow(label);
  row.classList.add('p-multi');
  for (const [lab, val, commit] of items) {
    const wrap = document.createElement('span');
    wrap.className = 'p-num';
    const inn = document.createElement('label');
    inn.textContent = lab;
    const input = document.createElement('input');
    input.type = 'number';
    input.value = val;
    input.addEventListener('change', () => commit(parseFloat(input.value)));
    wrap.appendChild(inn);
    wrap.appendChild(input);
    row.appendChild(wrap);
  }
  return row;
}
function rowSelect(label, options, value, onCommit) {
  const row = mkRow(label);
  const sel = document.createElement('select');
  sel.className = 'p-input';
  for (const [v, lab] of options) {
    const o = document.createElement('option');
    o.value = v; o.textContent = lab;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener('change', () => onCommit(sel.value));
  row.appendChild(sel);
  return row;
}
function rowCheck(label, checked, onCommit) {
  const row = mkRow('');
  const l = document.createElement('label');
  l.className = 'p-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onCommit(input.checked));
  l.appendChild(input);
  l.appendChild(document.createTextNode(' ' + label));
  row.appendChild(l);
  return row;
}
function rowButtons(label, buttons, cls = '') {
  const row = mkRow(label);
  row.classList.add('p-btnrow');
  for (const [text, fn, disabled] of buttons) {
    const b = document.createElement('button');
    b.className = 'p-btn ' + cls;
    b.textContent = text;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    row.appendChild(b);
  }
  return row;
}
function optsOf(options) {
  return Object.entries(options).map(([k, v]) => [k, (v && typeof v === 'object') ? v.label : v]);
}
function containerOptions(comp) {
  const out = [];
  const view = viewDoc();
  for (const c of listContainers(view)) {
    if (c.id === comp.id) continue;
    // 排除自己的后代
    let cur = view.components[c.id];
    let bad = false;
    while (cur && cur.parent) { if (cur.parent === comp.id) { bad = true; break; } cur = view.components[cur.parent]; }
    if (!bad) out.push([c.id, `${c.name}（${c.id}）`]);
  }
  return out;
}

// ---- 变更动作 ----
function patch(id, fields, label, fieldKey) {
  mutate(label, (doc) => { Object.assign(doc.components[id], fields); },
    { coalesceKey: id + ':' + fieldKey, skipPanels: false });
}
function patchFlags(id, key, v) {
  mutate(`修改 ${id} 的检查标志`, (doc) => {
    const c = doc.components[id];
    c.flags = c.flags || {};
    if (v) c.flags[key] = true; else delete c.flags[key];
  });
}
function patchPosition(id, axis, v) {
  if (!isFinite(v)) return;
  mutate(`修改 ${id} 位置`, (doc) => { doc.components[id].position[axis] = v; },
    { coalesceKey: id + ':pos:' + axis, skipPanels: true });
}
function setComponentPlacement(id, mode) {
  const comp = findComponent(viewDoc(), id);
  if (!comp || !comp.parent) return;
  const parent = findComponent(viewDoc(), comp.parent);
  const rect = designRectById(id);
  const origin = parent && designRectById(parent.id);
  const parentNode = document.querySelector(`#artboard [data-id="${CSS.escape(parent.id)}"]`);
  const parentStyle = parentNode ? getComputedStyle(parentNode) : null;
  if (mode === 'flow' && parent.layout.mode === 'free') { toast('自由布局容器中的子组件必须独立摆放', 'info'); return; }
  if (state.mode !== 'design' || !rect || !origin || !parentStyle) {
    toast('无法获取实测位置，已取消转换', 'info');
    return;
  }
  const left = Math.round(rect.x - origin.x - (parseFloat(parentStyle.borderLeftWidth) || 0) - normalizePadding(parent.layout.padding)[3]);
  const top = Math.round(rect.y - origin.y - (parseFloat(parentStyle.borderTopWidth) || 0) - normalizePadding(parent.layout.padding)[0]);
  const width = rect ? Math.round(rect.w) : null, height = rect ? Math.round(rect.h) : null;
  mutate(`${mode === 'absolute' ? '独立摆放' : '参与排列'} ${comp.name}`, (doc) => {
    const c = doc.components[id];
    if (mode === 'absolute') {
      c.placement = { mode: 'absolute' };
      c.position = { left, top };
      delete c.area;
      for (const axis of ['width', 'height']) c.size[axis] = { mode: 'fixed', value: axis === 'width' ? width : height };
    } else {
      c.placement = { mode: 'flow' };
      delete c.position;
      if (parent.layout.mode === 'grid') c.area = firstFreeGridCell(parent, doc);
      else delete c.area;
    }
  });
}
function patchArea(id, key, v) {
  if (!isFinite(v)) return;
  mutate(`修改 ${id} 占格`, (doc) => {
    doc.components[id].area[key] = Math.max(1, Math.round(v));
  }, { coalesceKey: id + ':area:' + key, skipPanels: true });
}
function renameComponent(id, v) {
  const nid = slugify(v);
  if (!ID_PATTERN.test(nid)) { alert('标识需以字母或下划线开头，仅含字母/数字/下划线'); renderProperties(); return; }
  if (nid === id) return;
  if (scopeOf(state.doc).components[nid]) { alert(`标识 "${nid}" 已存在`); renderProperties(); return; }
  mutate(`重命名标识 ${id} → ${nid}`, (doc) => {
    const c = doc.components[id];
    const parent = c.parent ? doc.components[c.parent] : null;
    if (parent) parent.children = parent.children.map((x) => (x === id ? nid : x));
    const rewalk = (cid) => {
      const cc = doc.components[cid];
      if (cc && cc.children) for (const k of cc.children) rewalk(k);
    };
    rewalk('root');
    doc.components[nid] = c;
    delete doc.components[id];
    c.id = nid;
    for (const other of Object.values(doc.components)) {
      if (other.parent === id) other.parent = nid;
    }
    // v3：联动重映射 actions.target 与指向该 presentation 的变体补丁键
    if (isPresentationDoc(doc)) remapComponentRefs(doc, doc.__presentationId, { [id]: nid });
    if (state.selection === id) state.selection = nid;
  });
}
function reparent(id, newParent) {
  // DOM 几何在 mutate 前采集；转自由布局保持视觉位置，转网格分配空闲格
  const geo = { position: positionPreservingVisual(id, newParent), rect: designRectById(id) };
  const oldLayout = JSON.parse(JSON.stringify(
    (findComponent(viewDoc(), id)?.parent ? findComponent(viewDoc(), findComponent(viewDoc(), id).parent)?.layout : null) || {}
  ));
  mutate(`移动 ${id} 到 ${newParent}`, (doc) => {
    const c = doc.components[id];
    const oldParent = doc.components[c.parent];
    const target = doc.components[newParent];
    if (!target || !isContainer(target)) return;
    if (oldParent) oldParent.children = oldParent.children.filter((x) => x !== id);
    target.children = target.children || [];
    target.children.push(id);
    c.parent = newParent;
    adaptChildToTargetLayout(doc, c, target, geo, oldLayout);
  });
}
export function reorder(id, index) {
  mutate(`调整 ${id} 顺序`, (doc) => {
    const c = doc.components[id];
    const parent = doc.components[c.parent];
    const i = parent.children.indexOf(id);
    const j = Math.max(0, Math.min(parent.children.length - 1, index));
    parent.children.splice(i, 1);
    parent.children.splice(j, 0, id);
  });
}

// ================= 多选工具（S2b）=================
// 作用范围（首版）：同一父容器 + 独立摆放（自由布局或 placement absolute）。
// 不满足时按钮禁用并给出适用范围说明；跨层级不做隐式重组。
function multiSection() {
  const ids = selectedIds();
  const sec = section('多选（' + ids.length + ' 个）');
  const view = viewDoc();
  const comps = ids.map((id) => findComponent(view, id)).filter(Boolean);
  const parentOf = (id) => { const c = findComponent(view, id); return c ? c.parent : null; };
  const parentId = sharedParent(ids, parentOf);
  const parent = parentId ? findComponent(view, parentId) : null;
  const pmode = parent && parent.layout ? parent.layout.mode : null;
  const independentlyPlaced = !!parent && (pmode === 'free' || comps.every((c) => isAbsolutePlacement(c, parent)));

  const hint = document.createElement('div');
  hint.className = 'p-hint';
  hint.textContent = !parentId
    ? '对齐与等距需选中同一父容器内的组件'
    : (!independentlyPlaced ? '对齐与等距仅适用于独立摆放的组件（自由布局或「独立摆放」方式）' : '');
  if (hint.textContent) sec._body.appendChild(hint);

  const runAlign = (mode) => {
    const origin = parentContentOriginById(parentId);
    if (!origin) { toast('无法读取画布位置，已在当前布局内跳过', 'info'); return; }
    const rects = comps.map((c) => {
      const r = designRectById(c.id);
      return r ? { id: c.id, x: r.x - origin.x, y: r.y - origin.y, w: r.w, h: r.h } : null;
    }).filter(Boolean);
    if (rects.length !== comps.length) { toast('部分组件不在当前页面，无法对齐', 'warn'); return; }
    const plan = planAlign(rects, mode);
    if (!plan.length) return;
    mutate(`对齐 ${plan.length} 个组件（${ALIGN_LABELS[mode]}）`, (doc) => {
      for (const p of plan) {
        const c = doc.components[p.id];
        if (!c) continue;
        if (!c.placement && pmode !== 'free') c.placement = { mode: 'absolute' };
        c.position = { left: Math.round(p.x), top: Math.round(p.y) };
      }
    });
  };
  const runDistribute = (axis) => {
    const origin = parentContentOriginById(parentId);
    if (!origin) { toast('无法读取画布位置，已在当前布局内跳过', 'info'); return; }
    const rects = comps.map((c) => {
      const r = designRectById(c.id);
      return r ? { id: c.id, x: r.x - origin.x, y: r.y - origin.y, w: r.w, h: r.h } : null;
    }).filter(Boolean);
    if (rects.length !== comps.length) { toast('部分组件不在当前页面，无法等距分布', 'warn'); return; }
    const plan = planDistribute(rects, axis);
    if (!plan.length) return;
    mutate(`${axis === 'v' ? '垂直' : '水平'}等距 ${plan.length} 个组件`, (doc) => {
      for (const p of plan) {
        const c = doc.components[p.id];
        if (!c) continue;
        if (!c.placement && pmode !== 'free') c.placement = { mode: 'absolute' };
        c.position = { left: Math.round(p.x), top: Math.round(p.y) };
      }
    });
  };

  const grid = document.createElement('div');
  grid.className = 'p-align-grid';
  const mkBtn = (label, disabled, fn, title) => {
    const b = document.createElement('button');
    b.className = 'p-btn';
    b.textContent = label;
    b.disabled = !!disabled;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  for (const mode of ALIGN_MODES) {
    grid.appendChild(mkBtn(ALIGN_LABELS[mode], !parentId || !independentlyPlaced, () => runAlign(mode)));
  }
  const canDistribute = !!parentId && independentlyPlaced && ids.length >= 3;
  grid.appendChild(mkBtn('水平等距', !canDistribute, () => runDistribute('h'),
    ids.length < 3 ? '等距分布需至少 3 个组件' : ''));
  grid.appendChild(mkBtn('垂直等距', !canDistribute, () => runDistribute('v'),
    ids.length < 3 ? '等距分布需至少 3 个组件' : ''));
  sec._body.appendChild(grid);

  sec._body.appendChild(rowButtons('', [
    ['🗑 删除选中（' + ids.length + ' 个）', () => deleteComponents(ids), false],
  ], 'danger'));
  return sec;
}

// 删除多个组件：一次 mutate = 一条撤销记录（S2b）
export function deleteComponents(ids) {
  const list = (ids || []).filter((id) => id && id !== 'root');
  if (!list.length) return;
  if (list.length === 1) { deleteComponent(list[0]); return; }
  mutate(`删除 ${list.length} 个组件`, (doc) => {
    const removed = [];
    const rm = (cid) => {
      const cc = doc.components[cid];
      if (!cc) return;
      removed.push(cid);
      if (cc.children) for (const k of [...cc.children]) rm(k);
      if (cc.parent && doc.components[cc.parent]) doc.components[cc.parent].children = doc.components[cc.parent].children.filter((x) => x !== cid);
      delete doc.components[cid];
    };
    for (const id of list) rm(id);
    if (isPresentationDoc(doc)) cleanupDeletedRefs(doc, doc.__presentationId, removed);
  });
  toast('已删除 ' + list.length + ' 个组件');
  resyncSelection();
}

// 删除不再弹原生 confirm：靠撤销历史兜底，操作更顺手
export function deleteComponent(id) {
  const c = findComponent(viewDoc(), id);
  if (!c || id === 'root') return;
  const label = c.name || id;
  mutate(`删除 ${id}`, (doc) => {
    const removed = [];
    const rm = (cid) => {
      const cc = doc.components[cid];
      if (!cc) return;
      removed.push(cid);
      if (cc.children) for (const k of [...cc.children]) rm(k);
      if (cc.parent && doc.components[cc.parent]) doc.components[cc.parent].children = doc.components[cc.parent].children.filter((x) => x !== cid);
      delete doc.components[cid];
    };
    rm(id);
    // v3：清理指向被删组件的点击动作与变体补丁键，保持文档可保存
    if (isPresentationDoc(doc)) cleanupDeletedRefs(doc, doc.__presentationId, removed);
  });
  toast(`已删除「${label}」`);
  resyncSelection(); // 多选时清理失效选中（S2b）
}

// 创建副本（供右键菜单与 Ctrl+D 使用）
// S1 B05：先建立整棵子树的完整 ID 映射，再克隆并重映射全部内部引用——
// 子树里按钮先于目标面板出现时，副本按钮也能正确指向副本面板（历史缺陷：
// 边克隆边映射，尚未克隆到的目标映射缺失，按钮仍操作原面板）。
export function duplicateComponent(id) {
  const src = findComponent(viewDoc(), id);
  if (!src || id === 'root') return;
  const parentId = src.parent || 'root';
  let newId = null;
  mutate(`创建副本 ${id}`, (doc) => {
    const r = duplicateSubtree(doc, id);
    if (!r) return;
    newId = r.newId;
    const parent = doc.components[parentId];
    if (!parent) return;
    const i = parent.children.indexOf(id);
    parent.children.splice(i + 1, 0, r.newId);
    state.pendingSelect = r.newId;
  });
  if (newId) toast(`已创建「${src.name}」的副本`);
}

// ---- 尺寸行 ----
// 位置/尺寸的语境提示：x/y 坐标只有自由布局父容器可设；fill/percent 轴拖手柄的转换语义
function positionHint(comp, pmode) {
  const parts = [];
  if (componentIsAbsolute(comp)) {
    parts.push('该组件独立摆放，按左/上坐标定位，不占用父容器的排列或网格位置。');
  } else if (pmode === 'horizontal' || pmode === 'vertical') {
    parts.push('当前组件参与排列；打开工具栏「自由移动」后拖动组件可独立摆放，或关闭后按顺序移动。');
  } else if (pmode === 'grid') {
    parts.push(state.freeMove
      ? '当前组件参与网格；自由移动已开启，拖动可独立摆放；关闭自由移动后按占格移动。'
      : '当前组件参与网格；关闭自由移动时按占格移动，也可在下方改占格数值。');
  }
  const wm = (comp.size || {}).width && (comp.size || {}).width.mode;
  const hm = (comp.size || {}).height && (comp.size || {}).height.mode;
  if (wm === 'fill' || hm === 'fill' || wm === 'percent' || hm === 'percent') {
    if (state.freeMove && !componentIsAbsolute(comp)) {
      parts.push('自由移动开启时，首次拖动转为独立摆放，并按当前实测宽高固定尺寸。');
    } else {
      const parent = comp.parent && findComponent(viewDoc(), comp.parent);
      const ratio = !componentIsAbsolute(comp) && parent && ['horizontal', 'vertical'].includes(parent.layout?.mode);
      parts.push(`按布局调整尺寸时，「填满剩余」转为固定值；「百分比」${ratio ? '在横向/纵向排列中按新比例重算' : '在当前布局中转为固定值'}。`);
    }
  }
  if (!parts.length) return null;
  const d = document.createElement('div');
  d.className = 'p-hint';
  d.textContent = parts.join(' ');
  return d;
}

function sizeRow(comp, axis, label) {
  const s = (comp.size || {})[axis] || { mode: 'auto' };
  const row = mkRow(label);
  row.classList.add('p-multi');
  const sel = document.createElement('select');
  sel.className = 'p-input p-sizemode';
  const abs = componentIsAbsolute(comp);
  for (const [v, m] of Object.entries(SIZE_MODES)) {
    if (abs && v === 'fill') continue;
    const o = document.createElement('option');
    o.value = v; o.textContent = m.label;
    sel.appendChild(o);
  }
  sel.value = s.mode;
  const num = document.createElement('input');
  num.type = 'number';
  num.className = 'p-input p-sizeval';
  const refreshNum = () => {
    const mode = sel.value;
    num.style.display = (mode === 'fixed' || mode === 'percent' || mode === 'fill') ? '' : 'none';
    num.value = mode === 'fill' ? (s.flex || 1) : (s.value != null ? s.value : '');
    num.step = mode === 'fill' ? 1 : 'any';
    if (mode === 'fill') num.title = '伸展份数';
    else if (mode === 'percent') num.title = '百分比';
    else num.title = '像素值';
  };
  refreshNum();
  const commit = () => {
    const mode = sel.value;
    const label2 = `修改 ${comp.id} 的${label}尺寸`;
    mutate(label2, (doc) => {
      const t = doc.components[comp.id].size[axis];
      delete t.value; delete t.flex;
      if (mode === 'fixed') { t.mode = 'fixed'; t.value = parseFloat(num.value) || 0; }
      else if (mode === 'percent') { t.mode = 'percent'; t.value = Math.max(0, Math.min(LIMITS.percentMax, parseFloat(num.value) || 0)); }
      else if (mode === 'fill') { t.mode = 'fill'; t.flex = Math.max(1, Math.round(parseFloat(num.value) || 1)); }
      else t.mode = 'auto';
    }, { coalesceKey: comp.id + ':size:' + axis, skipPanels: true });
  };
  sel.addEventListener('change', () => { refreshNum(); commit(); });
  num.addEventListener('change', commit);
  row.appendChild(sel);
  row.appendChild(num);
  return row;
}

function componentIsAbsolute(comp) {
  if (comp?.placement) return comp.placement.mode === 'absolute';
  const parent = comp?.parent && findComponent(viewDoc(), comp.parent);
  return !!(parent?.layout?.mode === 'free');
}

// ---- 样式字段行 ----
function styleFieldRow(comp, f) {
  const cur = (comp.style || {})[f.key];
  if (f.type === 'enum') return rowSelect(f.label, optsOf(f.options), cur || Object.keys(f.options)[0], (v) => patchStyle(comp.id, f.key, v));
  if (f.type === 'color') {
    const row = mkRow(f.label);
    row.classList.add('p-multi');
    const color = document.createElement('input');
    color.type = 'color';
    color.value = /^#[0-9a-fA-F]{6}$/.test(cur || '') ? cur : '#ffffff';
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'p-input mono';
    text.value = cur || '';
    text.placeholder = '#rrggbb';
    const commitColor = () => patchStyle(comp.id, f.key, text.value || color.value);
    color.addEventListener('change', () => { text.value = color.value; commitColor(); });
    text.addEventListener('change', commitColor);
    row.appendChild(color);
    row.appendChild(text);
    return row;
  }
  if (f.type === 'padding') {
    const p = normalizePadding(cur == null ? undefined : cur);
    const empty = cur == null;
    return rowNums(f.label + (empty ? '（默认）' : ''), [
      ['上', p[0], (v) => patchPadding(comp, f.key, 0, v)],
      ['右', p[1], (v) => patchPadding(comp, f.key, 1, v)],
      ['下', p[2], (v) => patchPadding(comp, f.key, 2, v)],
      ['左', p[3], (v) => patchPadding(comp, f.key, 3, v)],
    ]);
  }
  return rowText(f.label, cur == null ? '' : String(cur), (v) => {
    const num = parseFloat(v);
    patchStyle(comp.id, f.key, v === '' ? undefined : (isNaN(num) ? v : num));
  }, 'number');
}
function patchStyle(id, key, value) {
  mutate(`修改 ${id} 样式 ${key}`, (doc) => {
    const c = doc.components[id];
    c.style = c.style || {};
    if (value === undefined || value === '') delete c.style[key];
    else c.style[key] = value;
  }, { coalesceKey: id + ':style:' + key, skipPanels: true });
}
function patchPadding(comp, key, idx, v) {
  if (!isFinite(v)) return;
  mutate(`修改 ${comp.id} 内边距`, (doc) => {
    const c = doc.components[comp.id];
    c.style = c.style || {};
    const p = normalizePadding(c.style[key] == null ? 0 : c.style[key]);
    p[idx] = Math.max(0, v);
    c.style[key] = p;
  }, { coalesceKey: comp.id + ':pad:' + key + ':' + idx, skipPanels: true });
}

// ---- 资源行 ----
function resourceRow(comp) {
  const frag = document.createDocumentFragment();
  const opts = [['', '（未选择）'], ...Object.entries(state.doc.resources || {}).map(([k, r]) => [k, `${k}（${r.name || '图片'}）`])];
  frag.appendChild(rowSelect('图片资源', opts, comp.resourceId || '', (v) => patch(comp.id, { resourceId: v }, `修改 ${comp.id} 的图片资源`, 'resourceId')));
  const row = mkRow('上传新图片');
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.className = 'p-input';
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      mutate(`上传图片 ${f.name}`, (doc) => {
        doc.resources = doc.resources || {};
        const rid = genId({ components: doc.resources }, 'res_' + slugify(f.name.replace(/\.[^.]+$/, '')));
        doc.resources[rid] = { kind: 'image', name: f.name, dataUrl: reader.result };
        doc.components[comp.id].resourceId = rid;
      });
    };
    reader.readAsDataURL(f);
  });
  row.appendChild(file);
  frag.appendChild(row);
  return frag;
}

// ---- 容器布局节 ----
// （布局适配 adaptChildToTargetLayout 已上移到 shared/clipboard.js 供粘贴/移动共用）

// 布局切换（一次转换 = 一次撤销）：DOM 几何读取必须在 mutate 之前完成
function switchLayoutPreserving(id, v) {
  const comp0 = findComponent(viewDoc(), id);
  if (!comp0 || !isContainer(comp0)) return;
  const oldLayout = JSON.parse(JSON.stringify(comp0.layout || {}));
  const geo = {};
  if (v === 'free') {
    for (const cid of comp0.children || []) {
      geo[cid] = { position: positionPreservingVisual(cid, id), rect: designRectById(cid) };
    }
  }
  mutate(`修改 ${id} 布局为 ${LAYOUT_MODES[v].label}`, (doc) => {
    const c = doc.components[id];
    if (!c || !isContainer(c)) return;
    c.layout.mode = v;
    if (v === 'grid' && (!c.layout.tracks || !(c.layout.tracks.columns || []).length)) {
      c.layout.tracks = { columns: [{ mode: 'fill', value: 1 }, { mode: 'fill', value: 1 }], rows: [{ mode: 'fixed', value: 80 }] };
    }
    for (const cid of c.children || []) {
      const ch = doc.components[cid];
      if (!ch) continue;
      adaptChildToTargetLayout(doc, ch, c, geo[cid], oldLayout);
    }
  });
}

function layoutSection(comp) {
  const L = comp.layout || { mode: 'vertical' };
  const sec = section('子元素布局');
  sec.appendChild(rowSelect('布局模式', Object.entries(LAYOUT_MODES).map(([k, v]) => [k, `${v.label} —— ${v.desc}`]), L.mode, (v) => switchLayoutPreserving(comp.id, v)));
  if (L.mode === 'horizontal' || L.mode === 'vertical') {
    sec.appendChild(rowNums('间距 / 内边距', [
      ['间距', L.gap ?? 0, (v) => patchLayoutNum(comp.id, 'gap', v)],
      ['上', normalizePadding(L.padding)[0], (v) => patchLayoutPad(comp.id, 0, v)],
      ['右', normalizePadding(L.padding)[1], (v) => patchLayoutPad(comp.id, 1, v)],
      ['下', normalizePadding(L.padding)[2], (v) => patchLayoutPad(comp.id, 2, v)],
      ['左', normalizePadding(L.padding)[3], (v) => patchLayoutPad(comp.id, 3, v)],
    ]));
    sec.appendChild(rowSelect('主轴分布（justify）', optsOf(JUSTIFY_OPTIONS), L.justify || 'start', (v) => patchLayoutField(comp.id, 'justify', v)));
    sec.appendChild(rowSelect('交叉轴对齐（align）', optsOf(ALIGN_OPTIONS), L.align || 'stretch', (v) => patchLayoutField(comp.id, 'align', v)));
  }
  if (L.mode === 'grid') {
    sec.appendChild(tracksEditor(comp, 'columns', '列轨道'));
    sec.appendChild(tracksEditor(comp, 'rows', '行轨道'));
    sec.appendChild(rowNums('列间距 / 行间距 / 内边距', [
      ['列', L.columnGap ?? 0, (v) => patchLayoutNum(comp.id, 'columnGap', v)],
      ['行', L.rowGap ?? 0, (v) => patchLayoutNum(comp.id, 'rowGap', v)],
      ['内', normalizePadding(L.padding)[0], (v) => patchLayoutPad(comp.id, 0, v)],
    ]));
  }
  if (L.mode === 'free') {
    const hint = document.createElement('div');
    hint.className = 'p-hint';
    hint.textContent = '自由布局：拖动定位，支持吸附。';
    sec._body.appendChild(hint);
  }
  return sec;
}
function patchLayoutField(id, key, v) {
  mutate(`修改 ${id} 的 ${key}`, (doc) => { doc.components[id].layout[key] = v; });
}
function patchLayoutNum(id, key, v) {
  if (!isFinite(v)) return;
  mutate(`修改 ${id} 的 ${key}`, (doc) => { doc.components[id].layout[key] = Math.max(0, v); },
    { coalesceKey: id + ':layout:' + key, skipPanels: true });
}
function patchLayoutPad(id, idx, v) {
  if (!isFinite(v)) return;
  mutate(`修改 ${id} 内边距`, (doc) => {
    const p = normalizePadding(doc.components[id].layout.padding);
    p[idx] = Math.max(0, v);
    doc.components[id].layout.padding = p;
  }, { coalesceKey: id + ':layoutpad:' + idx, skipPanels: true });
}
function tracksEditor(comp, which, label) {
  const row = mkRow(label);
  row.classList.add('p-tracks');
  const list = document.createElement('div');
  list.className = 'p-track-list';
  const tracks = (comp.layout.tracks || {})[which] || [];
  tracks.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'p-track-item';
    const sel = document.createElement('select');
    sel.className = 'p-input';
    sel.innerHTML = '<option value="fill">填满(份)</option><option value="fixed">固定(px)</option>';
    sel.value = t.mode;
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'p-input';
    num.value = t.value;
    const del = document.createElement('button');
    del.className = 'p-btn p-btn-mini';
    del.textContent = '×';
    const commit = () => mutate(`修改 ${comp.id} 的${label}`, (doc) => {
      const tr = doc.components[comp.id].layout.tracks[which][i];
      tr.mode = sel.value;
      tr.value = Math.max(1, parseFloat(num.value) || 1);
    }, { coalesceKey: `track:${comp.id}:${which}:${i}`, skipPanels: true });
    sel.addEventListener('change', commit);
    num.addEventListener('change', commit);
    del.addEventListener('click', () => mutate(`删除 ${comp.id} 的${label}第 ${i + 1} 项`, (doc) => {
      doc.components[comp.id].layout.tracks[which].splice(i, 1);
    }));
    item.appendChild(sel);
    item.appendChild(num);
    item.appendChild(del);
    list.appendChild(item);
  });
  const add = document.createElement('button');
  add.className = 'p-btn';
  add.textContent = '+ 添加';
  add.addEventListener('click', () => mutate(`添加 ${comp.id} 的${label}`, (doc) => {
    const c = doc.components[comp.id];
    c.layout.tracks = c.layout.tracks || {};
    c.layout.tracks[which] = c.layout.tracks[which] || [];
    c.layout.tracks[which].push(which === 'columns' ? { mode: 'fill', value: 1 } : { mode: 'fixed', value: 80 });
  }));
  row.appendChild(list);
  row.appendChild(add);
  return row;
}

// ---- v3 功能绑定与交互（M5） ----
// v3 专属字段（featureId/bind/actions/initiallyOpen）在解析视图中已被剥除，
// 这里读原文档（编辑域 scope）取值；写入仍走 mutate → 编辑域 → presentation 原树。
function v3BindingSection(comp) {
  const scope = scopeOf(state.doc);
  const oc = (scope.components && scope.components[comp.id]) || comp;
  const features = state.doc.features || {};
  const sec = section('功能与交互（v3）');

  const featOpts = [['', '（无）'], ...Object.keys(features).map((fid) => [fid, `${(features[fid] && features[fid].label) || fid}（${fid}）`])];
  sec.appendChild(rowSelect('绑定功能 featureId', featOpts, oc.featureId || '', (v) => patchV3Field(comp.id, 'featureId', v)));

  // bind 首版仅支持键 text（冻结决策 5）
  if ((comp.type === 'text' || comp.type === 'button') && oc.featureId) {
    const bindVal = oc.bind && oc.bind.text ? oc.bind.text : '';
    sec.appendChild(rowText('文本绑定 bind（feature:功能.路径）', bindVal, (v) => setBindText(comp.id, v), 'code', 'feature:bag.items[0]'));
  }

  if (comp.type === 'button') {
    const act = oc.actions && oc.actions.click ? oc.actions.click : null;
    const typeOpts = [['', '（无动作）'], ...V3_ACTION_TYPES.map((t) => [t, { toggle: 'toggle 开/关面板', open: 'open 打开面板', close: 'close 关闭面板', goto: 'goto 跳转页面' }[t]])];
    sec.appendChild(rowSelect('点击动作（click）', typeOpts, act ? act.type : '', (v) => setActionType(comp.id, v)));
    if (act && act.type) {
      const isGoto = act.type === 'goto';
      const targets = isGoto ? pageTargets() : actionTargets();
      if (!targets.length) {
        const hint = document.createElement('div');
        hint.className = 'p-hint';
        hint.textContent = isGoto
          ? '暂无页面，请先在「页面」菜单新建。'
          : '暂无收起的面板，请先将某个容器的初始展开关闭。';
        sec.appendChild(hint);
      } else {
        sec.appendChild(rowSelect(isGoto ? '跳转目标页面' : '动作目标面板', targets, act.target || '', (v) => setActionTarget(comp.id, v)));
      }
    }
  }

  if (comp.type === 'container') {
    if (oc.page === true) {
      // 页面图层：显隐由页面切换管理，不提供「初始展开」；给出起始页设置
      const pages = pageTargets();
      const isStart = pages.length > 0 && pages[0][0] === comp.id;
      const phint = document.createElement('div');
      phint.className = 'p-hint';
      phint.textContent = '页面图层：铺满画布，由跳转动作切换显示。' + (isStart ? '当前为起始页。' : '');
      sec.appendChild(phint);
      if (!isStart) {
        sec.appendChild(rowButtons('页面顺序', [['设为起始页', () => makeStartPage(comp.id), false]]));
      }
    } else {
      sec.appendChild(rowCheck('初始展开', oc.initiallyOpen !== false, (v) => setInitiallyOpen(comp.id, v)));
    }
  }

  const hint = document.createElement('div');
  hint.className = 'p-hint';
  hint.textContent = '画布修改写入当前呈现，对该呈现的所有方案生效。';
  sec.appendChild(hint);
  return sec;
}

// 可作为面板动作目标的容器：本 presentation 内 initiallyOpen === false 的普通容器
// （冻结决策 5；页面容器 page:true 由 goto 管理，不作面板目标，v3.1）
function actionTargets() {
  const scope = scopeOf(state.doc);
  const pres = scope.__presentationId && state.doc.presentations ? state.doc.presentations[scope.__presentationId] : null;
  const comps = pres && pres.components ? pres.components : {};
  return Object.values(comps)
    .filter((c) => c && c.type === 'container' && c.initiallyOpen === false && c.page !== true)
    .map((c) => [c.id, `${c.name || c.id}（${c.id}）`]);
}

// goto 的目标：本 presentation 内 page === true 的页面容器（按 root.children 顺序；首个为起始页）
function pageTargets() {
  const scope = scopeOf(state.doc);
  const comps = (scope && scope.components) || {};
  const root = comps.root;
  const out = [];
  for (const id of (root && root.children) || []) {
    const c = comps[id];
    if (c && c.type === 'container' && c.page === true) out.push([id, `${c.name || id}（${id}）`]);
  }
  return out;
}

// 把页面容器移到 root.children 首位（起始页 = 预览打开时最先显示的页面）
function makeStartPage(id) {
  mutate(`设「${id}」为起始页`, (doc) => {
    const root = doc.components.root;
    const arr = root && root.children;
    const i = arr ? arr.indexOf(id) : -1;
    if (i > 0) { arr.splice(i, 1); arr.unshift(id); }
  });
}

function patchV3Field(id, key, value) {
  mutate(`修改 ${id} 的 ${key}`, (doc) => {
    const c = doc.components[id];
    if (!c) return;
    if (value === '' || value == null) delete c[key];
    else c[key] = value;
  });
}

function setBindText(id, v) {
  const val = String(v || '').trim();
  if (!val) {
    mutate(`清除 ${id} 的文本绑定`, (doc) => {
      const c = doc.components[id];
      if (c && c.bind) { delete c.bind.text; if (!Object.keys(c.bind).length) delete c.bind; }
    });
    return;
  }
  if (!V3_BIND_PATTERN.test(val)) { alert('绑定格式：feature:功能ID.路径'); renderProperties(); return; }
  const fid = val.slice('feature:'.length).split('.')[0].split('[')[0];
  if (!state.doc.features || !state.doc.features[fid]) { alert(`功能 "${fid}" 不存在`); renderProperties(); return; }
  mutate(`设置 ${id} 的文本绑定`, (doc) => {
    const c = doc.components[id];
    c.bind = Object.assign({}, c.bind, { text: val });
  });
}

function setActionType(id, type) {
  if (!type) {
    mutate(`移除 ${id} 的点击动作`, (doc) => {
      const c = doc.components[id];
      if (c && c.actions) { delete c.actions.click; if (!Object.keys(c.actions).length) delete c.actions; }
    });
    return;
  }
  const targets = type === 'goto' ? pageTargets() : actionTargets();
  if (!targets.length) {
    alert(type === 'goto'
      ? '还没有页面图层：请先用顶栏「页面」菜单新建页面'
      : '没有可选目标：需要先把某个容器的「初始展开」关掉');
    renderProperties();
    return;
  }
  mutate(`设置 ${id} 点击动作 ${type}`, (doc) => {
    const c = doc.components[id];
    c.actions = c.actions || {};
    // 换动作类型时目标列表也会变（页面 vs 面板）：旧目标仍合法才保留，否则取列表第一个
    const old = c.actions.click && c.actions.click.target;
    const keep = old && targets.some(([tid]) => tid === old) ? old : targets[0][0];
    c.actions.click = { type, target: keep };
  });
}

function setActionTarget(id, target) {
  if (!target) return;
  mutate(`修改 ${id} 的动作目标`, (doc) => {
    const c = doc.components[id];
    if (c && c.actions && c.actions.click) c.actions.click.target = target;
  });
}

function setInitiallyOpen(id, open) {
  if (open) {
    // 防悬空：本 presentation 内若有按钮指向本容器，改回「初始展开」会让目标失效
    const scope = scopeOf(state.doc);
    const pres = scope.__presentationId && state.doc.presentations ? state.doc.presentations[scope.__presentationId] : null;
    const comps = pres && pres.components ? pres.components : {};
    const users = Object.values(comps).filter((c) => c && c.actions && c.actions.click && c.actions.click.target === id);
    if (users.length) {
      alert(`有 ${users.length} 个按钮指向此面板，请先移除对应动作`);
      renderProperties();
      return;
    }
  }
  mutate(`${open ? '开启' : '关闭'} ${id} 的初始展开`, (doc) => {
    const c = doc.components[id];
    if (!c) return;
    if (open) delete c.initiallyOpen;
    else c.initiallyOpen = false;
  });
}

// ================= 模态框 =================
export function openModal(title, contentEl, actions = []) {
  const root = document.getElementById('modal-root');
  root.textContent = '';
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal-box';
  const head = document.createElement('div');
  head.className = 'modal-head';
  head.innerHTML = `<span>${escapeHtml(title)}</span>`;
  const close = document.createElement('button');
  close.className = 'modal-close';
  close.textContent = '×';
  close.addEventListener('click', () => closeModal());
  head.appendChild(close);
  const body = document.createElement('div');
  body.className = 'modal-body';
  body.appendChild(contentEl);
  box.appendChild(head);
  box.appendChild(body);
  if (actions.length) {
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    for (const [text, fn, cls] of actions) {
      const b = document.createElement('button');
      b.className = 'p-btn ' + (cls || '');
      b.textContent = text;
      b.addEventListener('click', fn);
      foot.appendChild(b);
    }
    box.appendChild(foot);
  }
  mask.appendChild(box);
  mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  root.appendChild(mask);
}
export function closeModal() {
  document.getElementById('modal-root').textContent = '';
}
export function toast(msg, kind = 'info') {
  const root = document.getElementById('toast-root');
  const t = document.createElement('div');
  t.className = 'toast toast-' + kind;
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4200);
}

// ================= 复制/粘贴 =================
// 复制（S1 B04）：从「原始编辑域」收集完整语义快照（v3 的 actions/bind/
// featureId/$令牌引用全部保留），并带上资源、功能与令牌来源值等依赖。
// 渲染解析视图只用于显示与测量——从它复制会丢语义（历史缺陷 B04）。
// 粘贴时物化并按目标文档合并依赖（shared/clipboard.js）。
export function copySelection() {
  const c = selectedComp();
  if (!c || c.id === 'root') return;
  const clip = collectCopySnapshot(scopeOf(state.doc), c.id, { sourceProject: state.name });
  if (!clip) return;
  state.clipboard = clip;
  renderToolbarState(); // 剪贴板变化立即刷新粘贴按钮（S1 B09）
  const n = Object.keys(clip.tree).length;
  const deps = [
    Object.keys(clip.resources).length ? `${Object.keys(clip.resources).length} 个图片资源` : '',
    Object.keys(clip.features).length ? `${Object.keys(clip.features).length} 个功能` : '',
  ].filter(Boolean).join('、');
  toast(`已复制 "${c.name}"`);
}

export function pasteClipboard(targetParentId) {
  const clip = state.clipboard;
  if (!clip || !clip.tree || !clip.tree[clip.rootId]) return;
  let result = null;
  mutate('粘贴组件', (doc) => {
    result = pasteSnapshotIntoDoc(doc, clip, targetParentId, { currentProject: state.name });
    if (result && !result.aborted && result.newId) state.pendingSelect = result.newId;
  });
  for (const n of (result && result.notices) || []) toast(n.message, n.level === 'warn' ? 'warn' : 'info');
  if (result && !result.aborted && (result.notices || []).some((n) => n.level === 'warn')) {
    toast('粘贴完成，部分依赖已调整', 'warn');
  }
}

// ================= 历史按钮状态 =================
export function renderToolbarState() {
  const set = (id, disabled) => { const b = document.getElementById(id); if (b) b.disabled = disabled; };
  set('btn-undo', !history.undo.length);
  set('btn-redo', !history.redo.length);
  set('btn-paste', !state.clipboard);
  set('btn-save', false);
  const nameEl = document.getElementById('proj-name');
  if (nameEl) {
    // 展示名（doc.name）与稳定身份（文件名 state.name）分离显示（S1 B07）：
    // 展示名可被 CLI 独立修改，打开/保存一律走稳定身份，顶栏悬停可查文件名
    nameEl.textContent = (state.doc && state.doc.name) || state.name || '（未打开）';
    nameEl.title = state.name ? '项目文件：' + state.name : '';
  }
  // 保存状态用明确文字（S2）：存在冲突 > 连接中断 > 保存中 > 未保存 > 已保存。
  // 处理方法放在悬停提示里，不在顶栏堆错误码。
  const statusEl = document.getElementById('proj-status');
  if (statusEl) {
    let txt = '';
    let cls = 'proj-status';
    let tip = '';
    if (!state.doc) {
      txt = '';
    } else if (state.conflict) {
      txt = '存在冲突';
      cls += ' st-bad';
      tip = '项目已在编辑器之外更新';
    } else if (state.connDown) {
      txt = '连接中断';
      cls += ' st-bad';
      tip = '连接中断，正在重连';
    } else if (state.saving) {
      txt = '保存中…';
      cls += ' st-warn';
    } else if (state.dirty) {
      txt = '未保存';
      cls += ' st-warn';
      tip = '存在未保存的修改，Ctrl+S 保存';
    } else {
      txt = '已保存 · 修订号 ' + state.revision;
      cls += ' st-ok';
    }
    statusEl.textContent = txt;
    statusEl.className = cls;
    statusEl.title = tip;
  }
  const modeEl = document.getElementById('proj-mode');
  if (modeEl) {
    const m = state.doc ? (UI_MODES[state.doc.mode || DEFAULT_MODE] || UI_MODES.generic) : null;
    modeEl.textContent = m ? m.label : '';
  }
  const zoomEl = document.getElementById('zoom-label');
  if (zoomEl) zoomEl.textContent = Math.round(state.zoom * 100) + '%';
  const snapBtn = document.getElementById('btn-snap');
  if (snapBtn) {
    snapBtn.classList.toggle('active', state.snapEnabled);
    snapBtn.title = state.snapEnabled ? '吸附参考线：已开启' : '吸附参考线：已关闭';
  }
  const freeBtn = document.getElementById('btn-free-move');
  if (freeBtn) {
    freeBtn.classList.toggle('active', state.freeMove);
    freeBtn.textContent = state.freeMove ? '自由移动' : '按布局移动';
    freeBtn.title = state.freeMove ? '自由移动：已开启' : '自由移动：已关闭';
  }
  const outsideBtn = document.getElementById('btn-show-outside');
  if (outsideBtn) {
    outsideBtn.classList.toggle('active', state.showOutsideCanvas);
    outsideBtn.title = state.showOutsideCanvas ? '显示画布外内容：已开启' : '显示画布外内容：已关闭';
  }
  const selEl = document.getElementById('status-sel');
  if (selEl) {
    const ids = selectedIds();
    const c = selectedComp();
    if (ids.length > 1) selEl.textContent = `已选 ${ids.length} 个组件`;
    else selEl.textContent = c ? `选中：${c.name}` : '未选中组件';
  }
  const segDesign = document.getElementById('btn-mode-design');
  const segPreview = document.getElementById('btn-mode-preview');
  if (segDesign && segPreview) {
    segDesign.classList.toggle('active', state.mode === 'design');
    segPreview.classList.toggle('active', state.mode === 'preview');
  }
}
