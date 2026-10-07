// ============================================================
// M5 功能风格面板 + 变体向导（v3 文档专属，UI 遵循路线图 §7 简洁原则）
// 左栏第三个标签页：变体一览 / 功能（features）/ 风格（styles）/ 呈现（presentations）。
// 全部编辑走 mutate/mutateDoc 内存直改原文档（保存时整体写盘）；
// 变体切换与新建都可通过 Ctrl+Z 撤销。v1/v2 文档只显示一句说明。
// ============================================================
import { state, mutate, mutateDoc } from './store.js';
import { ID_PATTERN, createFeature, createStyle, createVariant } from '../shared/protocol.js';
import { openModal, closeModal, toast } from './panels.js';
import { uniqueVariantId, uniquePresentationId } from './v3edit.js';

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
function countComps(pres) { return pres && pres.components ? Object.keys(pres.components).length : 0; }

// 功能被引用次数（featureId 直引 + bind 路径引用，覆盖全部 presentation）
function countFeatureRefs(doc, fid) {
  let n = 0;
  const pres = doc.presentations || {};
  for (const pid of Object.keys(pres)) {
    const comps = (pres[pid] && pres[pid].components) || {};
    for (const c of Object.values(comps)) {
      if (!c) continue;
      if (c.featureId === fid) n++;
      if (c.bind && typeof c.bind.text === 'string' && c.bind.text.startsWith('feature:' + fid + '.')) n++;
    }
  }
  return n;
}

// ================= 面板主体 =================
export function renderFeaturesPanel() {
  const host = document.getElementById('fs-panel');
  if (!host) return;
  host.textContent = '';
  if (!state.doc || state.doc.version !== 3) {
    host.appendChild(el('div', 'p-hint',
      state.doc ? '当前项目是 v1/v2 文档。功能 / 风格 / 方案是 v3 能力，v2 项目可长期保持原样。'
        : '先打开或新建一个项目。'));
    return;
  }
  const doc = state.doc;
  host.appendChild(variantSection(doc));
  host.appendChild(featuresSection(doc));
  host.appendChild(stylesSection(doc));
  host.appendChild(presentationsSection(doc));
}

function secTitle(text, extra) {
  const h = el('div', 'fs-sec-title');
  const t = el('strong', null, text);
  h.appendChild(t);
  if (extra) h.appendChild(extra);
  return h;
}

// ---- 变体 ----
function variantSection(doc) {
  const wrap = el('section', 'side-sec');
  wrap.appendChild(secTitle('方案', null));
  const list = el('div', 'fs-list');
  const variants = Array.isArray(doc.variants) ? doc.variants : [];
  for (const v of variants) {
    if (!v) continue;
    const row = el('button', 'fs-item' + (v.id === doc.activeVariant ? ' current' : ''));
    const pres = (doc.presentations || {})[v.presentation];
    const style = (doc.styles || {})[v.style];
    row.innerHTML = `<strong>${escapeHtml(v.label || v.id)}</strong>` +
      `<span>${escapeHtml((style && style.label) || v.style || '?')} · ${escapeHtml((pres && pres.label) || v.presentation || '?')}</span>` +
      (v.id === doc.activeVariant ? '<em class="fs-badge">当前</em>' : '');
    row.addEventListener('click', () => switchVariant(v));
    list.appendChild(row);
  }
  wrap.appendChild(list);
  const add = el('button', 'p-btn fs-add-btn', '＋ 新建方案（向导）');
  add.addEventListener('click', () => openVariantWizard());
  wrap.appendChild(add);
  return wrap;
}

export function switchVariant(v) {
  if (v.id === state.doc.activeVariant) return;
  mutateDoc(`切换到变体「${v.label || v.id}」`, (d) => { d.activeVariant = v.id; });
}

// ---- 功能（features） ----
function featuresSection(doc) {
  const wrap = el('section', 'side-sec');
  wrap.appendChild(secTitle('功能（共享数据源）', null));
  const list = el('div', 'fs-list');
  const features = doc.features || {};
  for (const fid of Object.keys(features)) {
    const f = features[fid] || {};
    const item = el('details', 'fs-item-edit');
    const sum = el('summary', null, `${(f && f.label) || fid}（${fid}）`);
    item.appendChild(sum);
    const body = el('div', 'fs-edit-body');

    const labelRow = el('div', 'fs-row');
    labelRow.appendChild(el('span', 'fs-key', '名称'));
    const labelInput = el('input', 'p-input');
    labelInput.value = (f && f.label) || '';
    labelInput.addEventListener('change', () => {
      const v = labelInput.value.trim();
      if (!v) { alert('功能名称需为非空文字'); renderFeaturesPanel(); return; }
      mutate(`修改功能 ${fid} 名称`, (d) => { d.features[fid].label = v; });
    });
    labelRow.appendChild(labelInput);
    body.appendChild(labelRow);

    const dataRow = el('div', 'fs-row');
    dataRow.appendChild(el('span', 'fs-key', '数据'));
    const dataInput = el('textarea', 'p-input fs-data');
    dataInput.rows = 3;
    dataInput.value = JSON.stringify((f && f.data) != null ? f.data : {}, null, 2);
    dataInput.addEventListener('change', () => {
      let parsed;
      try { parsed = JSON.parse(dataInput.value || '{}'); } catch (e) { alert('数据需为合法 JSON：' + e.message); renderFeaturesPanel(); return; }
      mutate(`修改功能 ${fid} 数据`, (d) => { d.features[fid].data = parsed; });
    });
    dataRow.appendChild(dataInput);
    body.appendChild(dataRow);

    const delRow = el('div', 'fs-row');
    const del = el('button', 'p-btn danger', '删除功能');
    del.addEventListener('click', () => {
      const refs = countFeatureRefs(doc, fid);
      if (refs > 0) { toast(`功能 "${fid}" 仍被 ${refs} 处引用（featureId/bind），先解除绑定再删除`, 'bad'); return; }
      mutate(`删除功能 ${fid}`, (d) => { delete d.features[fid]; });
    });
    delRow.appendChild(del);
    body.appendChild(delRow);

    item.appendChild(body);
    list.appendChild(item);
  }
  wrap.appendChild(list);

  const addRow = el('div', 'fs-add-row');
  const idInput = el('input', 'p-input fs-mini');
  idInput.placeholder = 'id（英文）';
  const labelInput = el('input', 'p-input fs-mini');
  labelInput.placeholder = '名称（中文）';
  const addBtn = el('button', 'p-btn', '＋');
  addBtn.title = '添加功能';
  addBtn.addEventListener('click', () => {
    const fid = idInput.value.trim();
    const label = labelInput.value.trim();
    if (!fid || !label) { toast('需要 id 与名称', 'bad'); return; }
    if (!ID_PATTERN.test(fid)) { toast('id 需以字母/下划线开头，仅含字母数字下划线', 'bad'); return; }
    if (features[fid]) { toast(`功能 "${fid}" 已存在`, 'bad'); return; }
    mutateDoc(`添加功能 ${fid}`, (d) => { d.features[fid] = createFeature(fid, label, {}); });
    idInput.value = ''; labelInput.value = '';
  });
  addRow.appendChild(idInput);
  addRow.appendChild(labelInput);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);
  return wrap;
}

// ---- 风格（styles） ----
function stylesSection(doc) {
  const wrap = el('section', 'side-sec');
  wrap.appendChild(secTitle('风格（令牌包）', null));
  const list = el('div', 'fs-list');
  const styles = doc.styles || {};
  for (const sid of Object.keys(styles)) {
    const s = styles[sid] || {};
    const tokens = (s && s.tokens) || {};
    const item = el('details', 'fs-item-edit');
    item.appendChild(el('summary', null, `${(s && s.label) || sid}（${sid}）· ${Object.keys(tokens).length} 令牌`));
    const body = el('div', 'fs-edit-body');

    const labelRow = el('div', 'fs-row');
    labelRow.appendChild(el('span', 'fs-key', '名称'));
    const labelInput = el('input', 'p-input');
    labelInput.value = (s && s.label) || '';
    labelInput.addEventListener('change', () => {
      const v = labelInput.value.trim();
      if (!v) { alert('风格名称需为非空文字'); renderFeaturesPanel(); return; }
      mutate(`修改风格 ${sid} 名称`, (d) => { d.styles[sid].label = v; });
    });
    labelRow.appendChild(labelInput);
    body.appendChild(labelRow);

    for (const tk of Object.keys(tokens)) {
      const row = el('div', 'fs-row');
      const nameInput = el('input', 'p-input fs-mini mono');
      nameInput.value = tk;
      const valInput = el('input', 'p-input fs-mini mono');
      valInput.value = String(tokens[tk]);
      const del = el('button', 'p-btn p-btn-mini', '×');
      const commitName = () => {
        const nk = nameInput.value.trim();
        if (!nk || nk === tk) { renderFeaturesPanel(); return; }
        mutate(`重命名风格 ${sid} 令牌 ${tk}`, (d) => {
          const t = d.styles[sid].tokens;
          if (Object.prototype.hasOwnProperty.call(t, nk)) { toast(`令牌 "${nk}" 已存在`, 'bad'); return; }
          const keys = Object.keys(t);
          const rebuilt = {};
          for (const k of keys) rebuilt[k === tk ? nk : k] = t[k];
          d.styles[sid].tokens = rebuilt;
        });
      };
      const commitVal = () => {
        const raw = valInput.value;
        mutate(`修改风格 ${sid} 令牌 ${tk} 值`, (d) => {
          const num = Number(raw);
          d.styles[sid].tokens[tk] = (raw.trim() !== '' && isFinite(num) && /^-?\d+(\.\d+)?$/.test(raw.trim())) ? num : raw;
        });
      };
      nameInput.addEventListener('change', commitName);
      valInput.addEventListener('change', commitVal);
      del.addEventListener('click', () => mutate(`删除风格 ${sid} 令牌 ${tk}`, (d) => { delete d.styles[sid].tokens[tk]; }));
      row.appendChild(nameInput);
      row.appendChild(valInput);
      row.appendChild(del);
      body.appendChild(row);
    }

    const addTokenRow = el('div', 'fs-row');
    const addBtn = el('button', 'p-btn', '＋ 添加令牌');
    addBtn.addEventListener('click', () => {
      const name = prompt('令牌名（建议 color.* / font.* / space.* / radius.*）：');
      if (name == null) return;
      const tk = name.trim();
      if (!tk) return;
      if (Object.prototype.hasOwnProperty.call(tokens, tk)) { toast(`令牌 "${tk}" 已存在`, 'bad'); return; }
      mutate(`添加风格 ${sid} 令牌 ${tk}`, (d) => { d.styles[sid].tokens[tk] = '#888888'; });
    });
    addTokenRow.appendChild(addBtn);
    body.appendChild(addTokenRow);

    const delRow = el('div', 'fs-row');
    const del = el('button', 'p-btn danger', '删除风格');
    del.addEventListener('click', () => {
      const used = (Array.isArray(doc.variants) ? doc.variants : []).some((v) => v && v.style === sid);
      if (used) { toast(`风格 "${sid}" 仍被方案使用，先删除或改指向对应方案`, 'bad'); return; }
      mutate(`删除风格 ${sid}`, (d) => { delete d.styles[sid]; });
    });
    delRow.appendChild(del);
    body.appendChild(delRow);

    item.appendChild(body);
    list.appendChild(item);
  }
  wrap.appendChild(list);

  const addRow = el('div', 'fs-add-row');
  const idInput = el('input', 'p-input fs-mini');
  idInput.placeholder = 'id（英文）';
  const labelInput = el('input', 'p-input fs-mini');
  labelInput.placeholder = '名称（中文）';
  const addBtn = el('button', 'p-btn', '＋');
  addBtn.title = '添加风格';
  addBtn.addEventListener('click', () => {
    const sid = idInput.value.trim();
    const label = labelInput.value.trim();
    if (!sid || !label) { toast('需要 id 与名称', 'bad'); return; }
    if (!ID_PATTERN.test(sid)) { toast('id 需以字母/下划线开头，仅含字母数字下划线', 'bad'); return; }
    if (styles[sid]) { toast(`风格 "${sid}" 已存在`, 'bad'); return; }
    mutateDoc(`添加风格 ${sid}`, (d) => { d.styles[sid] = createStyle(sid, label, {}); });
    idInput.value = ''; labelInput.value = '';
  });
  addRow.appendChild(idInput);
  addRow.appendChild(labelInput);
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);
  const hint = el('div', 'p-hint', '删除/重命名被组件引用的令牌后，保存检查会指出悬空引用。');
  wrap.appendChild(hint);
  return wrap;
}

// ---- 呈现（presentations） ----
function presentationsSection(doc) {
  const wrap = el('section', 'side-sec');
  wrap.appendChild(secTitle('呈现方案', null));
  const list = el('div', 'fs-list');
  const presentations = doc.presentations || {};
  const activePresId = activeVariantPresentationId(doc);
  for (const pid of Object.keys(presentations)) {
    const p = presentations[pid] || {};
    const item = el('details', 'fs-item-edit');
    item.appendChild(el('summary', null, `${(p && p.label) || pid}（${pid}）· ${countComps(p)} 组件` +
      (pid === activePresId ? ' · 当前' : '')));
    const body = el('div', 'fs-edit-body');

    const labelRow = el('div', 'fs-row');
    labelRow.appendChild(el('span', 'fs-key', '名称'));
    const labelInput = el('input', 'p-input');
    labelInput.value = (p && p.label) || '';
    labelInput.addEventListener('change', () => {
      const v = labelInput.value.trim();
      if (!v) { alert('呈现方案名称需为非空文字'); renderFeaturesPanel(); return; }
      mutate(`修改呈现方案 ${pid} 名称`, (d) => { d.presentations[pid].label = v; });
    });
    labelRow.appendChild(labelInput);
    body.appendChild(labelRow);

    const btnRow = el('div', 'fs-row');
    const copyBtn = el('button', 'p-btn', '⧉ 复制为新呈现');
    copyBtn.title = '复制整棵组件树为新呈现；用方案向导为它生成方案后即可编辑';
    copyBtn.addEventListener('click', () => {
      mutateDoc(`复制呈现方案 ${pid}`, (d) => {
        const newId = uniquePresentationId(d, pid + '_copy');
        const cloned = JSON.parse(JSON.stringify(d.presentations[pid]));
        cloned.label = ((d.presentations[pid] && d.presentations[pid].label) || pid) + ' 副本';
        d.presentations[newId] = cloned;
        toast(`已创建呈现「${cloned.label}」（${newId}）；用方案向导为它生成方案后即可编辑`, 'ok');
      });
    });
    btnRow.appendChild(copyBtn);
    body.appendChild(btnRow);

    item.appendChild(body);
    list.appendChild(item);
  }
  wrap.appendChild(list);
  wrap.appendChild(el('div', 'p-hint', '画布编辑的总是「当前方案」指向的呈现；切到指向其他呈现的方案即可编辑它。'));
  return wrap;
}

function activeVariantPresentationId(doc) {
  const v = (Array.isArray(doc.variants) ? doc.variants : []).find((x) => x && x.id === doc.activeVariant);
  return v ? v.presentation : null;
}

// ================= 变体向导（分步弹层） =================
// 步骤：① 选呈现方案 → ② 选风格 → ③ 命名并生成（生成后设为当前变体）。
// 一次 mutate 完成创建+激活，Ctrl+Z 一步撤销。
export function openVariantWizard() {
  const doc = state.doc;
  if (!doc || doc.version !== 3) return;
  const presIds = Object.keys(doc.presentations || {});
  const styleIds = Object.keys(doc.styles || {});
  if (!presIds.length || !styleIds.length) {
    toast('文档缺少呈现或风格，无法生成方案', 'bad');
    return;
  }
  const activePresId = activeVariantPresentationId(doc);
  const sel = {
    presentation: presIds.includes(activePresId) ? activePresId : presIds[0],
    style: styleIds[0],
  };
  const box = el('div', 'wizard-box');
  const stepsEl = el('div', 'wiz-steps');
  const body = el('div', 'wiz-body');
  const navRow = el('div', 'wiz-nav');
  const backBtn = el('button', 'p-btn', '上一步');
  const nextBtn = el('button', 'p-btn primary', '下一步');
  navRow.appendChild(backBtn);
  navRow.appendChild(nextBtn);
  box.appendChild(stepsEl);
  box.appendChild(body);
  box.appendChild(navRow);

  const STEP_NAMES = ['选呈现方案', '选风格', '命名并生成'];
  let step = 1;

  const wizLabelInput = el('input', 'p-input');
  const wizIdLine = el('div', 'p-hint mono');

  function renderStep() {
    stepsEl.textContent = '';
    STEP_NAMES.forEach((name, i) => {
      const s = el('span', 'wiz-step' + (i + 1 === step ? ' active' : i + 1 < step ? ' done' : ''), `${i + 1}. ${name}`);
      stepsEl.appendChild(s);
    });
    body.textContent = '';
    backBtn.style.display = step === 1 ? 'none' : '';
    nextBtn.textContent = step === 3 ? '生成方案' : '下一步';

    if (step === 1) {
      body.appendChild(el('div', 'p-label', '这一方案显示哪个呈现？（画布编辑的就是它）'));
      for (const pid of presIds) {
        const p = doc.presentations[pid] || {};
        const row = radioRow(pid,
          `${(p && p.label) || pid}（${pid} · ${countComps(p)} 组件）`, sel.presentation === pid);
        row.addEventListener('click', () => { sel.presentation = pid; renderStep(); });
        body.appendChild(row);
      }
    } else if (step === 2) {
      body.appendChild(el('div', 'p-label', '应用哪个风格（令牌决定颜色/字体/圆角等）？'));
      for (const sid of styleIds) {
        const s = doc.styles[sid] || {};
        const toks = Object.entries((s && s.tokens) || {}).slice(0, 4)
          .map(([k, v]) => `${k}=${v}`).join('　');
        const row = radioRow(sid,
          `${(s && s.label) || sid}（${sid}）`, sel.style === sid,
          toks + (Object.keys((s && s.tokens) || {}).length > 4 ? ' …' : ''));
        row.addEventListener('click', () => { sel.style = sid; renderStep(); });
        body.appendChild(row);
      }
    } else {
      body.appendChild(el('div', 'p-label', '方案名称（可中文，会自动生成唯一 id）'));
      if (!wizLabelInput.value) {
        const p = doc.presentations[sel.presentation] || {};
        const s = doc.styles[sel.style] || {};
        wizLabelInput.value = `${(s && s.label) || sel.style} · ${(p && p.label) || sel.presentation}`;
      }
      body.appendChild(wizLabelInput);
      const refreshId = () => { wizIdLine.textContent = 'id：' + uniqueVariantId(doc, wizLabelInput.value); };
      wizLabelInput.oninput = refreshId;
      refreshId();
      body.appendChild(wizIdLine);
      body.appendChild(el('div', 'p-hint',
        '生成后将立即设为当前显示方案（画布跟随），并随下次保存写入文档。Ctrl+Z 可一步撤销。'));
    }
  }

  backBtn.addEventListener('click', () => { if (step > 1) { step--; renderStep(); } });
  nextBtn.addEventListener('click', () => {
    if (step < 3) { step++; renderStep(); return; }
    const label = wizLabelInput.value.trim();
    if (!label) { toast('请填写方案名称', 'bad'); return; }
    const id = uniqueVariantId(doc, label);
    mutateDoc(`新建方案「${label}」`, (d) => {
      d.variants = Array.isArray(d.variants) ? d.variants : [];
      d.variants.push(createVariant(id, label, sel.presentation, sel.style, { tokens: {}, components: {} }));
      d.activeVariant = id;
    });
    closeModal();
    toast(`已创建方案「${label}」并设为当前显示`, 'ok');
  });

  renderStep();
  openModal('新建方案', box, [['关闭', () => closeModal()]]);
  setTimeout(() => { if (step === 3) wizLabelInput.focus(); }, 50);
}

function radioRow(value, labelText, checked, sub) {
  const row = el('button', 'wiz-opt' + (checked ? ' active' : ''));
  row.type = 'button';
  row.innerHTML = `<span class="wiz-radio">${checked ? '●' : '○'}</span>` +
    `<span class="wiz-opt-text"><strong>${escapeHtml(labelText)}</strong>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</span>`;
  return row;
}
