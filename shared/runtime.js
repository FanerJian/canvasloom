// ============================================================
// UIForge M3 交互运行时 —— 浏览器侧点击交互（toggle/open/close、Esc、遮罩、焦点回归）
// 职责边界：
//   · 只操作 DOM（inline display / z-index / 焦点 / 事件监听），绝不修改传入的
//     doc/spec 对象——运行态只存在于内存与 DOM，任何情况下不得写回设计文件；
//   · 点击事件委托挂在 rootEl 上，按渲染器输出的 [data-id] 属性匹配动作；
//   · 可见性状态由内部 Set 维护（初始可见 = 渲染结果 - initiallyClosed 集合）。
// 浏览器与 Node 通用：extractInteractionSpec 是纯函数；initInteractions 只在
// 有 DOM 的环境调用（单测用假 DOM 驱动）。
// ============================================================

// ---------- 纯函数：从 v3 文档提取交互 spec（只读 doc，返回全新对象） ----------
// spec = { initiallyClosed: [组件id…], actions: { [按钮id]: { click: { type, target } } } }
// · initiallyClosed：指定变体指向 presentation 的组件树中所有 initiallyOpen===false 的容器；
//   变体 overrides 只微调 style、不动 actions/initiallyOpen，直接读 presentation 即可；
// · actions：所有带 actions.click 的按钮（校验层保证 target 是同树 initiallyOpen:false 的容器）；
// · 变体/presentation 缺失时返回空 spec（渲染层会先行报错，这里保持宽容不抛异常）。
export function extractInteractionSpec(doc, variantId) {
  const empty = { initiallyClosed: [], actions: {} };
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.variants) || doc.presentations == null
    || typeof doc.presentations !== 'object') return empty;
  const variant = doc.variants.find((v) => v && typeof v === 'object' && v.id === variantId);
  const pres = variant ? doc.presentations[variant.presentation] : null;
  const comps = pres && typeof pres === 'object' ? pres.components : null;
  if (!comps || typeof comps !== 'object') return empty;
  const spec = { initiallyClosed: [], actions: {} };
  for (const id of Object.keys(comps)) {
    const c = comps[id];
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'container' && c.initiallyOpen === false) spec.initiallyClosed.push(id);
    if (c.type === 'button' && c.actions && c.actions.click) {
      // 拷贝动作对象：spec 不与 doc 共享内部引用，运行时即使出错也碰不到原文档
      spec.actions[id] = { click: { type: c.actions.click.type, target: c.actions.click.target } };
    }
  }
  return spec;
}

// ---------- 交互运行时 ----------
// initInteractions({ rootEl, spec }) → { isOpen(id), closeAll(), destroy() }
// rootEl：已渲染组件树的容器（#artboard 或预览根）；spec 见 extractInteractionSpec。
export function initInteractions({ rootEl, spec } = {}) {
  if (!rootEl || typeof rootEl.querySelector !== 'function') {
    throw new TypeError('initInteractions：缺少 rootEl（已渲染组件树的容器元素）');
  }
  const s = spec && typeof spec === 'object' ? spec : {};
  const expandableIds = Array.isArray(s.initiallyClosed)
    ? s.initiallyClosed.filter((x) => typeof x === 'string')
    : [];
  const actions = s.actions && typeof s.actions === 'object' ? s.actions : {};
  const ownerDoc = rootEl.ownerDocument || (typeof document !== 'undefined' ? document : null);

  const closed = new Set(expandableIds); // 当前处于隐藏状态的可展开面板 id
  const hidden = new Map();              // 元素 → 隐藏前原始 inline display（恢复用）
  const raised = new Map();              // 元素 → 抬升前原始 inline zIndex（恢复用）
  let lastTrigger = null;                // 最近一次触发动作的按钮（Esc 焦点回归用）
  let overlay = null;                    // 点击捕获遮罩（任一可展开面板可见时挂载）
  let destroyed = false;

  function elOf(id) {
    try { return rootEl.querySelector('[data-id="' + id + '"]'); } catch { return null; }
  }

  // 隐藏/显示：记录渲染器输出的原始 inline display（flex/grid/block…），显示时原样恢复
  function hideEl(el) {
    if (!hidden.has(el)) hidden.set(el, el.style ? (el.style.display || '') : '');
    el.style.display = 'none';
  }
  function showEl(el) {
    el.style.display = hidden.has(el) ? hidden.get(el) : '';
  }
  // 打开的面板抬升 z-index：遮罩(z=1) 高于普通内容(z auto)，面板(z=2) 高于遮罩——
  // 面板内的按钮（如"关闭"）不被遮罩挡住，点面板外才落到遮罩上
  function raiseEl(el) {
    if (!raised.has(el)) raised.set(el, el.style ? el.style.zIndex : '');
    el.style.zIndex = '2';
  }
  function restoreZ(el) {
    if (raised.has(el)) {
      el.style.zIndex = raised.get(el) || ''; // '' = 移除 inline z-index（恢复抬升前的原状）
      raised.delete(el);
    }
  }

  function isOpen(id) {
    return !closed.has(id) && !!elOf(id);
  }

  function openPanel(id) {
    if (!closed.has(id)) return false;
    const el = elOf(id);
    if (!el) return false;
    closed.delete(id);
    showEl(el);       // 目标不可见时显示要恢复其原 display
    raiseEl(el);
    syncOverlay();
    return true;
  }
  function closePanel(id) {
    if (closed.has(id)) return false;
    const el = elOf(id);
    if (!el) return false;
    closed.add(id);
    hideEl(el);
    restoreZ(el);
    syncOverlay();
    return true;
  }

  // 关闭全部当前可见的可展开面板；有实际关闭时返回 true
  function closeAll() {
    let changed = false;
    for (const id of expandableIds) { if (closePanel(id)) changed = true; }
    return changed;
  }

  // 遮罩：全视口纯透明点击捕获层（z=1，低于面板高于其余内容，不加深色），
  // 挂在 rootEl 内，点击它 = 关闭全部打开的可展开面板（等价点外部）
  function syncOverlay() {
    const anyOpen = expandableIds.some((id) => !closed.has(id) && elOf(id));
    if (anyOpen && !overlay) {
      overlay = ownerDoc && ownerDoc.createElement ? ownerDoc.createElement('div') : null;
      if (!overlay) return;
      overlay.className = 'uiw-interact-overlay';
      const st = overlay.style;
      st.position = 'absolute';
      st.left = '0';
      st.top = '0';
      st.width = '100%';
      st.height = '100%';
      st.background = 'transparent';
      st.zIndex = '1';
      overlay.addEventListener('click', onOverlayClick);
      rootEl.appendChild(overlay);
    } else if (!anyOpen && overlay) {
      removeOverlay();
    }
  }
  function removeOverlay() {
    if (!overlay) return;
    overlay.removeEventListener('click', onOverlayClick);
    if (overlay.remove) overlay.remove();
    overlay = null;
  }
  function onOverlayClick() { closeAll(); }

  // 焦点回归：div 默认不可聚焦，先补 tabindex 再 focus（preventScroll 避免页面跳动）
  function focusTrigger(el) {
    if (!el || typeof el.focus !== 'function') return;
    if (el.setAttribute) el.setAttribute('tabindex', '-1');
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  }

  // 点击委托：从事件目标向上找最近的、在 actions 里配了 click 的 [data-id] 节点
  function onRootClick(ev) {
    if (destroyed) return;
    let node = ev && ev.target;
    let triggerId = null;
    while (node && node !== rootEl) {
      const nid = node.dataset && node.dataset.id;
      if (nid && actions[nid] && actions[nid].click) { triggerId = nid; break; }
      node = node.parentElement;
    }
    if (!triggerId) return;
    const act = actions[triggerId].click;
    const triggerEl = elOf(triggerId);
    if (act.type === 'toggle') {
      if (closed.has(act.target)) openPanel(act.target); else closePanel(act.target);
    } else if (act.type === 'open') {
      openPanel(act.target);
    } else if (act.type === 'close') {
      closePanel(act.target);
    }
    // 未知类型忽略（校验层已拒绝非法动作，运行时保持宽容）
    lastTrigger = triggerEl || lastTrigger;
    focusTrigger(triggerEl);
  }

  // Esc：关闭全部当前可见的可展开面板，焦点回到最近一次触发按钮；
  // 没有面板打开时不抢 Esc、不动焦点
  function onKeyDown(ev) {
    if (destroyed) return;
    if (!ev || (ev.key !== 'Escape' && ev.key !== 'Esc')) return;
    if (!closeAll()) return;
    focusTrigger(lastTrigger);
  }

  // 初始化：把 initiallyClosed 集合的元素置为隐藏（记录原 display 以便恢复）
  for (const id of expandableIds) {
    const el = elOf(id);
    if (el) { closed.add(id); hideEl(el); }
  }
  if (rootEl.addEventListener) rootEl.addEventListener('click', onRootClick);
  if (ownerDoc && ownerDoc.addEventListener) ownerDoc.addEventListener('keydown', onKeyDown);

  return {
    isOpen,
    closeAll,
    destroy() {
      destroyed = true;
      if (rootEl.removeEventListener) rootEl.removeEventListener('click', onRootClick);
      if (ownerDoc && ownerDoc.removeEventListener) ownerDoc.removeEventListener('keydown', onKeyDown);
      removeOverlay();
      // 恢复初始可见性：撤销本运行时做过的全部 DOM 修改（显示 + z-index）
      for (const [el, disp] of hidden) { if (el.style) el.style.display = disp || ''; }
      hidden.clear();
      for (const [el, z] of raised) { if (el.style) el.style.zIndex = z || ''; }
      raised.clear();
      closed.clear();
      lastTrigger = null;
    },
  };
}
