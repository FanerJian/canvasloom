// 设计意图面板：仅编辑原始 UIDoc，不把渲染视图当作可写模型。
import { state, scopeOf, mutate, mutateDoc } from './store.js';
import { upgradeDocToV4 } from '../shared/compat.js';
import { PRECISION_OPTIONS, AI_POLICY_OPTIONS } from '../shared/intent.js';

function field(label, value, commit, id, options) {
  const row = document.createElement('div');
  row.className = 'p-row';
  const title = document.createElement('label');
  title.className = 'p-label';
  title.textContent = label;
  title.htmlFor = id;
  const input = document.createElement(options ? 'select' : 'textarea');
  input.id = id;
  input.className = 'p-input' + (options ? '' : ' p-area');
  if (options) {
    for (const [val, text] of options) {
      const option = document.createElement('option');
      option.value = val; option.textContent = text; input.appendChild(option);
    }
  } else { input.rows = 2; input.maxLength = label === '项目目标' ? 4000 : 2000; }
  input.value = value;
  input.addEventListener('change', () => commit(input.value));
  row.append(title, input);
  return row;
}

export function intentSection(comp, dialogs) {
  const section = document.createElement('details');
  section.className = 'props-sec'; section.open = true;
  const summary = document.createElement('summary');
  summary.textContent = comp ? 'AI 修改范围' : '项目目标';
  const body = document.createElement('div'); body.className = 'props-body';
  section.append(summary, body);
  if (!state.doc) return section;
  if (state.doc.version !== 4) {
    const hint = document.createElement('div'); hint.className = 'p-hint';
    hint.textContent = '记录设计目标，并指定 AI 可修改的范围。';
    const button = document.createElement('button'); button.className = 'tb-btn';
    button.textContent = '启用设计意图'; button.addEventListener('click', () => enableIntent(dialogs));
    body.append(hint, button);
    return section;
  }
  if (!comp) {
    for (const [key, label] of [['goal', '项目目标'], ['style', '风格要求']]) {
      body.appendChild(field(label, state.doc.intent?.[key] || '', (value) => {
        mutateDoc('修改' + label, (doc) => { doc.intent[key] = value; }, { skipPanels: true });
      }, 'intent-project-' + key));
    }
  } else {
    const raw = scopeOf(state.doc).components[comp.id];
    const current = raw?.intent || { precision: 'rough', ai: 'open' };
    const update = (key, value) => mutate('修改 AI 设计意图', (scope) => {
      const c = scope.components[comp.id];
      c.intent = { precision: 'rough', ai: 'open', ...c.intent, [key]: value };
    });
    body.appendChild(field('布局精度', current.precision, (v) => update('precision', v), 'intent-component-precision', PRECISION_OPTIONS));
    body.appendChild(field('修改范围', current.ai, (v) => update('ai', v), 'intent-component-ai', AI_POLICY_OPTIONS));
    const hint = document.createElement('div'); hint.className = 'p-hint';
    hint.textContent = current.ai === 'preserve'
      ? '保留既有结构及相对父容器的位置、尺寸；允许完善样式和内部内容。手动编辑仍可修改。'
      : '允许 AI 完善布局、样式和内容；用途说明保持不变。';
    body.appendChild(hint);
  }
  return section;
}

async function enableIntent({ openModal, closeModal, toast }) {
  try {
    const capability = await fetch('/api/hello').then((r) => r.json());
    if (!capability.capabilities?.designIntent) { toast('请重启编辑器后启用设计意图', 'warn'); return; }
  } catch { toast('无法连接服务，请稍后重试', 'bad'); return; }
  const box = document.createElement('div'); box.className = 'p-hint';
  box.textContent = '启用后使用新版文档格式；旧版软件无法编辑。首次保存前自动备份原文件，本次启用可撤销。';
  const session = state.sessionId;
  openModal('启用设计意图', box, [
    ['取消', closeModal],
    ['启用', () => {
      if (state.sessionId !== session || !state.doc) { closeModal(); return; }
      mutateDoc('启用设计意图', (doc) => {
        const next = upgradeDocToV4(doc);
        for (const key of Object.keys(doc)) delete doc[key];
        Object.assign(doc, next);
      });
      closeModal(); toast('已启用设计意图', 'ok');
    }],
  ]);
}
