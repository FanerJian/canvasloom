// ============================================================
// 面板：左侧（组件库 + 层级树）、右侧（属性面板）、模态框、提示
// 属性面板中文标签与 shared/protocol.js 的字段定义同源。
// ============================================================
import { state, mutate, select, history, selectedComp, PALETTE_MIME, viewDoc, scopeOf } from './store.js';
import {
  COMPONENT_TYPES, TYPE_IDS, LAYOUT_MODES, SIZE_MODES, LIMITS,
  JUSTIFY_OPTIONS, ALIGN_OPTIONS, STYLE_FIELDS, ID_PATTERN,
  V3_BIND_PATTERN, V3_ACTION_TYPES,
  findComponent, isContainer, listContainers, normalizePadding,
  newComponent, cloneSubtree, genId, slugify, firstFreeGridCell, DEFAULT_MODE,
} from '../shared/protocol.js';
import { UI_MODES } from '../shared/modes.js';
import { instantiateBlock } from '../shared/blocks.js';
import { validateDoc } from '../shared/validate.js';
import { designRectById, positionPreservingVisual } from './design-geometry.js';
import { remapComponentRefs, cleanupDeletedRefs } from './v3edit.js';

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
// payload 同时写入 window.__uiforgeDrag 供画布做幽灵占位，drop 时以 getData 为准
function attachPaletteDrag(btn, payload) {
  btn.draggable = true;
  btn.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(payload));
    window.__uiforgeDrag = payload;
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
  sel.title = '选择浏览哪个场景模式的预设块（只影响本清单，不影响当前设计）';
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
    b.title = `${blk.desc || blk.label}（点击加入选中的容器，或直接拖到画布上想放的位置）` +
      (viewMode !== docMode ? `——来自「${mode.label}」预设` : '');
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
  const list = document.getElementById('pal-list');
  list.textContent = '';
  for (const type of TYPE_IDS) {
    const def = COMPONENT_TYPES[type];
    const b = document.createElement('button');
    b.className = 'pal-item';
    b.dataset.type = type;
    b.title = def.desc + '（可点击加入，或直接拖到画布上）';
    b.innerHTML = `<span class="pal-ico">${TYPE_ICONS[type] || '▪'}</span><span>${def.label}</span>`;
    b.addEventListener('click', () => addComponent(type));
    attachPaletteDrag(b, { kind: 'component', type });
    list.appendChild(b);
  }
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
    hint.textContent = '当前文档无法解析为设计视图，请查看画布上的错误说明。';
    tree.appendChild(hint);
    return;
  }
  tree.appendChild(treeNode(view.components.root, 0));
}

function treeNode(comp, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row' + (comp.id === state.selection ? ' active' : '');
  row.dataset.id = comp.id;
  row.draggable = true;
  row.style.paddingLeft = (8 + depth * 14) + 'px';
  const hasChildren = isContainer(comp) && (comp.children || []).length > 0;
  const collapsed = state.collapsedTreeIds.has(comp.id);
  const caret = hasChildren ? (collapsed ? '▸' : '▾') : (isContainer(comp) ? '▸' : '');
  const caretCls = hasChildren ? 'tree-caret tog' : (isContainer(comp) ? 'tree-caret empty' : 'tree-caret');
  row.innerHTML = `<span class="${caretCls}">${caret}</span><span class="tree-ico">${TYPE_ICONS[comp.type] || '▪'}</span>` +
    `<span class="tree-name">${escapeHtml(comp.name || comp.id)}</span><span class="tree-id">${escapeHtml(comp.id)}</span>`;
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
  row.addEventListener('click', () => select(comp.id));
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/uiforge-id', comp.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  if (isContainer(comp)) {
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const dragId = e.dataTransfer.getData('text/uiforge-id');
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
      if (child) frag.appendChild(treeNode(child, depth + 1));
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
  if (!comp) {
    root.appendChild(canvasSection());
    const empty = document.createElement('div');
    empty.className = 'props-empty';
    empty.innerHTML = '未选中组件<br><small>点击画布或层级树中的组件查看属性；<br>点击画布空白处可编辑画布设置</small>';
    root.appendChild(empty);
    return;
  }
  const pmode = comp.parent && findComponent(viewDoc(), comp.parent)?.layout?.mode;

  const sec1 = section('组件');
  sec1.appendChild(rowText('名称', comp.name || '', (v) => patch(comp.id, { name: v }, `重命名 ${comp.id}`, 'name'), 'text'));
  sec1.appendChild(rowText('标识 ID', comp.id, (v) => renameComponent(comp.id, v), 'code'));
  sec1.appendChild(rowArea('用途说明', comp.purpose || '', (v) => patch(comp.id, { purpose: v }, `修改 ${comp.id} 的用途说明`, 'purpose')));
  root.appendChild(sec1);

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
    hint.textContent = '注意：当前变体对组件覆盖了样式（' + Object.keys(shadowPatch).join('、') + '）。' +
      '下方修改写入呈现方案基础样式，显示效果仍以变体覆盖为准（覆盖键请用 CLI/JSON 维护）。';
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
  if (state.doc && state.doc.version === 3) root.appendChild(v3BindingSection(comp));

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
  if (!doc || doc.version !== 3) return null;
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
    ? '根容器当前跟随画布（百分比 100%）；预览与导出按视口裁剪。'
    : '根容器当前为固定尺寸：修改画布不会改变它（旧项目语义）。需要自动伸缩请勾选上方选项。';
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
    toast('当前无法读取画布实测位置，暂不能保留原位置切换摆放方式', 'info');
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
    if (doc.version === 3) remapComponentRefs(doc, doc.__presentationId, { [id]: nid });
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
    if (doc.version === 3) cleanupDeletedRefs(doc, doc.__presentationId, removed);
  });
  toast(`已删除「${label}」，Ctrl+Z 可撤销`);
}

// 创建副本（供右键菜单与 Ctrl+D 使用）
export function duplicateComponent(id) {
  const src = findComponent(viewDoc(), id);
  if (!src || id === 'root') return;
  const parentId = src.parent || 'root';
  mutate(`创建副本 ${id}`, (doc) => {
    const idMap = {};
    const copyOne = (sid, pid) => {
      const s = doc.components[sid];
      if (!s) return null;
      const nid = genId(doc, sid + '_copy');
      idMap[sid] = nid;
      const copy = JSON.parse(JSON.stringify(s));
      copy.id = nid;
      copy.parent = pid;
      copy.name = (s.name || sid) + ' 副本';
      // v3：副本内部的点击动作指向也换成副本内的对应组件（外部目标保持不变）
      if (copy.actions && copy.actions.click && idMap[copy.actions.click.target]) {
        copy.actions.click = { ...copy.actions.click, target: idMap[copy.actions.click.target] };
      }
      doc.components[nid] = copy;
      if (isContainer(copy)) copy.children = (s.children || []).map((cid) => copyOne(cid, nid)).filter(Boolean);
      return nid;
    };
    const nid = copyOne(id, parentId);
    const parent = doc.components[parentId];
    const i = parent.children.indexOf(id);
    parent.children.splice(i + 1, 0, nid);
    state.pendingSelect = nid;
  });
  toast(`已创建「${src.name}」的副本`);
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
    if (mode === 'fill') num.title = '伸展比例（份数）';
    else if (mode === 'percent') num.title = `百分比 0-${LIMITS.percentMax}（可大于 100 做出血/超大装饰）`;
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
function adaptChildToTargetLayout(doc, child, target, geo, oldLayout) {
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
    hint.textContent = '自由布局：子元素按"位置与尺寸"中的左/上坐标摆放，画布拖动直接改位置，支持参考线吸附。';
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
    const typeOpts = [['', '（无动作）'], ...V3_ACTION_TYPES.map((t) => [t, { toggle: 'toggle 开/关面板', open: 'open 打开面板', close: 'close 关闭面板' }[t]])];
    sec.appendChild(rowSelect('点击动作（click）', typeOpts, act ? act.type : '', (v) => setActionType(comp.id, v)));
    if (act && act.type) {
      const targets = actionTargets();
      if (!targets.length) {
        const hint = document.createElement('div');
        hint.className = 'p-hint';
        hint.textContent = '本呈现方案还没有「初始收起」的容器：先把某个容器的初始展开关掉，再回来选目标。';
        sec.appendChild(hint);
      } else {
        sec.appendChild(rowSelect('动作目标面板', targets, act.target || '', (v) => setActionTarget(comp.id, v)));
      }
    }
  }

  if (comp.type === 'container') {
    sec.appendChild(rowCheck('初始展开（关闭后可作为点击动作的目标面板）', oc.initiallyOpen !== false, (v) => setInitiallyOpen(comp.id, v)));
  }

  const hint = document.createElement('div');
  hint.className = 'p-hint';
  hint.textContent = '说明：画布上的位置/样式修改写入当前呈现方案，对所有使用它的变体生效；变体差异用「变体向导」与风格令牌表达。';
  sec.appendChild(hint);
  return sec;
}

// 可作为动作目标的容器：本 presentation 内 initiallyOpen === false 的容器（冻结决策 5）
function actionTargets() {
  const scope = scopeOf(state.doc);
  const pres = scope.__presentationId && state.doc.presentations ? state.doc.presentations[scope.__presentationId] : null;
  const comps = pres && pres.components ? pres.components : {};
  return Object.values(comps)
    .filter((c) => c && c.type === 'container' && c.initiallyOpen === false)
    .map((c) => [c.id, `${c.name || c.id}（${c.id}）`]);
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
  if (!V3_BIND_PATTERN.test(val)) { alert('绑定语法需为 feature:功能id.路径，例如 feature:bag.items[0]'); renderProperties(); return; }
  const fid = val.slice('feature:'.length).split('.')[0].split('[')[0];
  if (!state.doc.features || !state.doc.features[fid]) { alert(`功能 "${fid}" 不存在，请先在「功能风格」面板创建`); renderProperties(); return; }
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
  const targets = actionTargets();
  if (!targets.length) { alert('没有可选目标：需要先把某个容器的「初始展开」关掉'); renderProperties(); return; }
  mutate(`设置 ${id} 点击动作 ${type}`, (doc) => {
    const c = doc.components[id];
    c.actions = c.actions || {};
    c.actions.click = { type, target: (c.actions.click && c.actions.click.target) || targets[0][0] };
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
      alert(`有 ${users.length} 个按钮的点击动作指向本面板；请先移除这些动作，再改为初始展开`);
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
// 复制 = 完整子树快照 + 依赖资源快照：粘贴时从快照物化并生成全新 ID，
// 复制后修改原件、删除原件、切换项目都不影响粘贴结果（A09）。
export function copySelection() {
  const c = selectedComp();
  if (!c || c.id === 'root') return;
  const view = viewDoc();
  const tree = {};
  const collect = (id) => {
    const comp = findComponent(view, id);
    if (!comp) return;
    tree[id] = JSON.parse(JSON.stringify(comp));
    if (isContainer(comp)) (comp.children || []).forEach(collect);
  };
  collect(c.id);
  const resources = {};
  for (const comp of Object.values(tree)) {
    if (comp.type === 'image' && comp.resourceId && view.resources && view.resources[comp.resourceId]) {
      resources[comp.resourceId] = JSON.parse(JSON.stringify(view.resources[comp.resourceId]));
    }
  }
  state.clipboard = { tree, resources, rootId: c.id, name: c.name, copiedAt: Date.now() };
  const n = Object.keys(tree).length;
  toast(`已复制 "${c.name}"（${n} 个组件${Object.keys(resources).length ? `、${Object.keys(resources).length} 个图片资源` : ''}）`);
}

// 资源 id 去重：目标文档已占用该 id 且内容不同时生成新 id
function genResourceId(doc, base) {
  let id = base || 'res';
  if (!doc.resources[id]) return id;
  let i = 2;
  while (doc.resources[id + '_' + i]) i++;
  return id + '_' + i;
}

export function pasteClipboard(targetParentId) {
  const clip = state.clipboard;
  if (!clip || !clip.tree || !clip.tree[clip.rootId]) return;
  mutate('粘贴组件', (doc) => {
    const srcRoot = clip.tree[clip.rootId];
    // 目标父容器：显式指定 > 来源父容器（仍存在且是容器）> 根
    let parentId = 'root';
    if (targetParentId && doc.components[targetParentId] && isContainer(doc.components[targetParentId])) {
      parentId = targetParentId;
    } else if (srcRoot.parent && doc.components[srcRoot.parent] && isContainer(doc.components[srcRoot.parent])) {
      parentId = srcRoot.parent;
    }
    const target = doc.components[parentId];
    // 资源合并：同 id 同内容 → 复用；同 id 异内容 → 新 id；缺失 → 补入
    doc.resources = doc.resources || {};
    const ridMap = {};
    for (const [rid, res] of Object.entries(clip.resources || {})) {
      if (doc.resources[rid]) {
        if (JSON.stringify(doc.resources[rid]) === JSON.stringify(res)) { ridMap[rid] = rid; continue; }
        const nid = genResourceId(doc, rid + '_copy');
        doc.resources[nid] = JSON.parse(JSON.stringify(res));
        ridMap[rid] = nid;
      } else {
        doc.resources[rid] = JSON.parse(JSON.stringify(res));
        ridMap[rid] = rid;
      }
    }
    // 子树物化：全新 ID + 引用重映射
    const cloneOne = (srcId, pid) => {
      const src = clip.tree[srcId];
      if (!src) return null;
      const nid = genId(doc, srcId + '_copy');
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = nid;
      copy.parent = pid;
      copy.name = (src.name || srcId) + ' 副本';
      if (copy.type === 'image' && copy.resourceId && ridMap[copy.resourceId] != null) {
        copy.resourceId = ridMap[copy.resourceId];
      }
      doc.components[nid] = copy;
      if (isContainer(copy)) {
        copy.children = (src.children || []).map((cid) => cloneOne(cid, nid)).filter(Boolean);
      }
      return nid;
    };
    const nid = cloneOne(clip.rootId, parentId);
    target.children = target.children || [];
    target.children.push(nid);
    // 布局适配：目标容器布局可能与来源不同（自由保持坐标，排列清坐标，网格分格）
    adaptChildToTargetLayout(doc, doc.components[nid], target, null);
    state.pendingSelect = nid;
  });
}

// ================= 历史按钮状态 =================
export function renderToolbarState() {
  const set = (id, disabled) => { const b = document.getElementById(id); if (b) b.disabled = disabled; };
  set('btn-undo', !history.undo.length);
  set('btn-redo', !history.redo.length);
  set('btn-paste', !state.clipboard);
  set('btn-save', false);
  const nameEl = document.getElementById('proj-name');
  if (nameEl) nameEl.textContent = state.name || '（未打开）';
  const dirtyEl = document.getElementById('proj-dirty');
  if (dirtyEl) dirtyEl.style.display = state.dirty ? '' : 'none';
  const revEl = document.getElementById('proj-rev');
  if (revEl) revEl.textContent = state.doc ? '修订号 ' + state.revision : '';
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
    snapBtn.title = state.snapEnabled
      ? '吸附参考线：开（点击关闭；拖动时按住 Alt 临时绕过）'
      : '吸附参考线：关（点击开启）';
  }
  const freeBtn = document.getElementById('btn-free-move');
  if (freeBtn) {
    freeBtn.classList.toggle('active', state.freeMove);
    freeBtn.textContent = state.freeMove ? '自由移动' : '按布局移动';
    freeBtn.title = state.freeMove ? '自由移动：开（拖动组件独立摆放）' : '自由移动：关（拖动按父布局排列）';
  }
  const outsideBtn = document.getElementById('btn-show-outside');
  if (outsideBtn) {
    outsideBtn.classList.toggle('active', state.showOutsideCanvas);
    outsideBtn.title = state.showOutsideCanvas
      ? '设计视图显示画布外内容：开（预览/导出仍按视口裁剪）'
      : '设计视图显示画布外内容：关（点击开启）';
  }
  const selEl = document.getElementById('status-sel');
  if (selEl) {
    const c = selectedComp();
    selEl.textContent = c ? `选中：${c.name}（${c.id} · ${COMPONENT_TYPES[c.type].label}）` : '未选中组件';
  }
  const segDesign = document.getElementById('btn-mode-design');
  const segPreview = document.getElementById('btn-mode-preview');
  if (segDesign && segPreview) {
    segDesign.classList.toggle('active', state.mode === 'design');
    segPreview.classList.toggle('active', state.mode === 'preview');
  }
}
