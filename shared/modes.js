// ============================================================
// UIForge 场景模式定义 —— 浏览器/Node 通用纯数据，禁止访问 DOM
// 每种模式决定：画布预设、新组件默认样式、编辑器"预设块"清单。
// doc.mode 缺省视为 generic（兼容旧文档）。
// ============================================================

export const DEFAULT_MODE = 'generic';

// ---------- 预设块 spec 约定 ----------
// spec 节点字段：idBase/type/name/purpose/text/placeholder/value/
//   orientation/thickness/size/style/layout/children
// 由 shared/blocks.js 的 instantiateBlock 物化为普通组件。
// 约束：块内只用 horizontal/vertical/grid 容器（不用 free）；
//   容器内边距一律写 layout.padding（容器禁止 style.padding）。

export const UI_MODES = {
  generic: {
    label: '通用界面',
    icon: '▦',
    desc: '浅色通用风格，适合工具、后台与各类原型',
    canvas: { width: 1280, height: 800, background: '#e5e7eb' },
    rootBackground: '#ffffff',
    styles: {}, // 与 protocol.js 原生默认一致
    blocks: [
      {
        label: '页面标题', desc: '大标题 + 分割线',
        idBase: 'heading', type: 'container',
        layout: { mode: 'vertical', gap: 10 },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        children: [
          { idBase: 'heading_text', type: 'text', name: '标题', text: '页面标题', style: { fontSize: 24, fontWeight: 'bold' } },
          { idBase: 'heading_line', type: 'divider', name: '分割线' },
        ],
      },
      {
        label: '按钮组', desc: '一排常用操作按钮',
        idBase: 'btn_group', type: 'container',
        layout: { mode: 'horizontal', gap: 10 },
        size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
        children: [
          { idBase: 'btn_ok', type: 'button', name: '主要按钮', text: '确定' },
          { idBase: 'btn_cancel', type: 'button', name: '次要按钮', text: '取消', style: { background: '#e5e7eb', color: '#374151' } },
        ],
      },
      {
        label: '信息卡片', desc: '标题 + 正文的卡片',
        idBase: 'info_card', type: 'container',
        layout: { mode: 'vertical', gap: 8, padding: 16 },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb' },
        children: [
          { idBase: 'card_title', type: 'text', name: '卡片标题', text: '卡片标题', style: { fontSize: 16, fontWeight: 'bold' } },
          { idBase: 'card_body', type: 'text', name: '正文', text: '这里是卡片正文内容，简单说明这条信息。', style: { fontSize: 14, color: '#6b7280' } },
        ],
      },
      {
        label: '表单行', desc: '标签 + 输入框',
        idBase: 'form_row', type: 'container',
        layout: { mode: 'horizontal', gap: 10 },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        children: [
          { idBase: 'form_label', type: 'text', name: '标签', text: '名称', size: { width: { mode: 'fixed', value: 90 }, height: { mode: 'auto' } } },
          { idBase: 'form_input', type: 'input', name: '输入框' },
        ],
      },
    ],
  },

  web: {
    label: '网站 UI',
    icon: '🌐',
    desc: '网页主页/落地页：导航、Hero、卡片、页脚',
    canvas: { width: 1280, height: 800, background: '#e2e8f0' },
    rootBackground: '#ffffff',
    styles: {
      text:   { color: '#0f172a' },
      button: { background: '#4f46e5', borderRadius: 8, padding: [10, 20, 10, 20] },
      input:  { borderRadius: 8, borderColor: '#cbd5e1', padding: [10, 14, 10, 14] },
      rect:   { background: '#e0e7ff', borderRadius: 8 },
      divider:{ background: '#cbd5e1' },
    },
    blocks: [
      {
        label: '顶部导航栏', desc: '品牌 + 右侧链接',
        idBase: 'navbar', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 32], justify: 'space-between' },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 64 } },
        style: { background: '#ffffff' },
        children: [
          { idBase: 'nav_logo', type: 'text', name: '品牌名', text: 'LOGO', style: { fontSize: 18, fontWeight: 'bold' } },
          {
            idBase: 'nav_links', type: 'container', name: '导航链接',
            layout: { mode: 'horizontal', gap: 24 },
            size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'nav_home', type: 'text', name: '首页', text: '首页' },
              { idBase: 'nav_products', type: 'text', name: '产品', text: '产品' },
              { idBase: 'nav_contact', type: 'text', name: '联系', text: '联系我们', style: { color: '#64748b' } },
            ],
          },
        ],
      },
      {
        label: '英雄区', desc: '大标题 + 副标题 + 行动按钮',
        idBase: 'hero', type: 'container',
        layout: { mode: 'vertical', gap: 14, padding: 40, justify: 'center', align: 'center' },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 320 } },
        style: { background: '#4f46e5' },
        children: [
          { idBase: 'hero_title', type: 'text', name: '主标题', text: '把想法做成界面', style: { fontSize: 36, fontWeight: 'bold', color: '#ffffff' } },
          { idBase: 'hero_sub', type: 'text', name: '副标题', text: '一句话说明你的产品价值', style: { fontSize: 16, color: '#c7d2fe' } },
          { idBase: 'hero_cta', type: 'button', name: '行动按钮', text: '开始使用', style: { background: '#ffffff', color: '#4f46e5' } },
        ],
      },
      {
        label: '内容卡片', desc: '封面图 + 标题 + 描述',
        idBase: 'card', type: 'container',
        layout: { mode: 'vertical', gap: 10, padding: 14 },
        size: { width: { mode: 'fixed', value: 260 }, height: { mode: 'auto' } },
        style: { background: '#ffffff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0' },
        children: [
          { idBase: 'card_cover', type: 'rect', name: '封面图', size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 130 } }, style: { borderRadius: 8 } },
          { idBase: 'card_title', type: 'text', name: '标题', text: '内容标题', style: { fontSize: 16, fontWeight: 'bold' } },
          { idBase: 'card_desc', type: 'text', name: '描述', text: '一句话描述这条内容。', style: { fontSize: 14, color: '#64748b' } },
        ],
      },
      {
        label: '三列卡片区', desc: '网格并排三张卡片',
        idBase: 'cards_grid', type: 'container',
        layout: { mode: 'grid', columnGap: 16, rowGap: 16, tracks: { columns: [{ mode: 'fill', value: 1 }, { mode: 'fill', value: 1 }, { mode: 'fill', value: 1 }], rows: [{ mode: 'fixed', value: 240 }] } },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        children: [
          {
            idBase: 'gcard_a', type: 'container', name: '卡片 A',
            layout: { mode: 'vertical', gap: 8, padding: 12 },
            style: { background: '#ffffff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0' },
            children: [
              { idBase: 'gcard_a_cover', type: 'rect', name: '封面', size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 90 } }, style: { borderRadius: 8 } },
              { idBase: 'gcard_a_title', type: 'text', name: '标题', text: '卡片 A', style: { fontSize: 15, fontWeight: 'bold' } },
              { idBase: 'gcard_a_desc', type: 'text', name: '描述', text: '简介文字', style: { fontSize: 13, color: '#64748b' } },
            ],
          },
          {
            idBase: 'gcard_b', type: 'container', name: '卡片 B',
            layout: { mode: 'vertical', gap: 8, padding: 12 },
            style: { background: '#ffffff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0' },
            children: [
              { idBase: 'gcard_b_cover', type: 'rect', name: '封面', size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 90 } }, style: { borderRadius: 8 } },
              { idBase: 'gcard_b_title', type: 'text', name: '标题', text: '卡片 B', style: { fontSize: 15, fontWeight: 'bold' } },
              { idBase: 'gcard_b_desc', type: 'text', name: '描述', text: '简介文字', style: { fontSize: 13, color: '#64748b' } },
            ],
          },
          {
            idBase: 'gcard_c', type: 'container', name: '卡片 C',
            layout: { mode: 'vertical', gap: 8, padding: 12 },
            style: { background: '#ffffff', borderRadius: 10, borderWidth: 1, borderColor: '#e2e8f0' },
            children: [
              { idBase: 'gcard_c_cover', type: 'rect', name: '封面', size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 90 } }, style: { borderRadius: 8 } },
              { idBase: 'gcard_c_title', type: 'text', name: '标题', text: '卡片 C', style: { fontSize: 15, fontWeight: 'bold' } },
              { idBase: 'gcard_c_desc', type: 'text', name: '描述', text: '简介文字', style: { fontSize: 13, color: '#64748b' } },
            ],
          },
        ],
      },
      {
        label: '登录卡片', desc: '标题 + 两个输入框 + 按钮',
        idBase: 'login_card', type: 'container',
        layout: { mode: 'vertical', gap: 12, padding: 24 },
        size: { width: { mode: 'fixed', value: 340 }, height: { mode: 'auto' } },
        style: { background: '#ffffff', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0' },
        children: [
          { idBase: 'login_title', type: 'text', name: '标题', text: '登录', style: { fontSize: 20, fontWeight: 'bold' } },
          { idBase: 'login_user', type: 'input', name: '账号输入框', placeholder: '邮箱地址' },
          { idBase: 'login_pass', type: 'input', name: '密码输入框', placeholder: '密码' },
          { idBase: 'login_btn', type: 'button', name: '登录按钮', text: '登录' },
        ],
      },
      {
        label: '页脚', desc: '深色页脚：品牌 + 链接',
        idBase: 'footer', type: 'container',
        layout: { mode: 'horizontal', padding: [24, 40], justify: 'space-between' },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 120 } },
        style: { background: '#0f172a' },
        children: [
          {
            idBase: 'footer_brand', type: 'container', name: '品牌信息',
            layout: { mode: 'vertical', gap: 6 },
            size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'footer_logo', type: 'text', name: '品牌名', text: 'LOGO', style: { fontSize: 16, fontWeight: 'bold', color: '#ffffff' } },
              { idBase: 'footer_icp', type: 'text', name: '备案信息', text: '© 2026 Your Company', style: { fontSize: 12, color: '#94a3b8' } },
            ],
          },
          {
            idBase: 'footer_links', type: 'container', name: '页脚链接',
            layout: { mode: 'horizontal', gap: 18 },
            size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'fl_about', type: 'text', name: '关于我们', text: '关于我们', style: { fontSize: 13, color: '#cbd5e1' } },
              { idBase: 'fl_help', type: 'text', name: '帮助中心', text: '帮助中心', style: { fontSize: 13, color: '#cbd5e1' } },
              { idBase: 'fl_privacy', type: 'text', name: '隐私政策', text: '隐私政策', style: { fontSize: 13, color: '#cbd5e1' } },
            ],
          },
        ],
      },
    ],
  },

  game: {
    label: '游戏 UI',
    icon: '🎮',
    desc: '深色 HUD 风格：血条、技能栏、对话框、任务列表',
    canvas: { width: 1920, height: 1080, background: '#0b0f19' },
    rootBackground: '#111827',
    styles: {
      container: { background: '#1f2937' },
      text:   { color: '#e5e7eb', fontSize: 15 },
      button: { background: '#1f2937', color: '#fbbf24', borderWidth: 1, borderColor: '#f59e0b', borderRadius: 4, padding: [9, 18, 9, 18], fontWeight: 'bold', fontSize: 15 },
      input:  { background: '#111827', color: '#e5e7eb', borderWidth: 1, borderColor: '#4b5563', borderRadius: 4, padding: [8, 12, 8, 12], fontSize: 15 },
      rect:   { background: '#374151', borderRadius: 4 },
      divider:{ background: '#4b5563' },
    },
    blocks: [
      {
        label: '血条 HUD', desc: '头像 + 血条 + 等级文字',
        idBase: 'hp_hud', type: 'container',
        layout: { mode: 'horizontal', gap: 10 },
        size: { width: { mode: 'fixed', value: 420 }, height: { mode: 'auto' } },
        children: [
          { idBase: 'hp_avatar', type: 'rect', name: '头像', size: { width: { mode: 'fixed', value: 44 }, height: { mode: 'fixed', value: 44 } }, style: { background: '#f59e0b', borderRadius: 4 } },
          {
            idBase: 'hp_info', type: 'container', name: '血条区',
            layout: { mode: 'vertical', gap: 4 },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              {
                idBase: 'hp_bar', type: 'container', name: '血条',
                layout: { mode: 'vertical' },
                size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 14 } },
                style: { background: '#111827', borderRadius: 3, borderWidth: 1, borderColor: '#4b5563', overflow: 'hidden' },
                children: [
                  { idBase: 'hp_fill', type: 'rect', name: '血量', size: { width: { mode: 'percent', value: 75 }, height: { mode: 'fill' } }, style: { background: '#dc2626', borderRadius: 2 } },
                ],
              },
              { idBase: 'hp_level', type: 'text', name: '等级', text: 'Lv.12 · 战士', style: { fontSize: 12, color: '#9ca3af' } },
            ],
          },
        ],
      },
      {
        label: '技能栏', desc: 'Q/E/R/F 四个技能位',
        idBase: 'skill_bar', type: 'container',
        layout: { mode: 'horizontal', gap: 8, padding: 10 },
        size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
        style: { background: '#111827', borderRadius: 6, borderWidth: 1, borderColor: '#374151' },
        children: [
          { idBase: 'skill_q', type: 'button', name: '技能 Q', text: 'Q', size: { width: { mode: 'fixed', value: 48 }, height: { mode: 'fixed', value: 48 } }, style: { borderRadius: 6, fontSize: 18, padding: 0 } },
          { idBase: 'skill_e', type: 'button', name: '技能 E', text: 'E', size: { width: { mode: 'fixed', value: 48 }, height: { mode: 'fixed', value: 48 } }, style: { borderRadius: 6, fontSize: 18, padding: 0 } },
          { idBase: 'skill_r', type: 'button', name: '技能 R', text: 'R', size: { width: { mode: 'fixed', value: 48 }, height: { mode: 'fixed', value: 48 } }, style: { borderRadius: 6, fontSize: 18, padding: 0 } },
          { idBase: 'skill_f', type: 'button', name: '技能 F', text: 'F', size: { width: { mode: 'fixed', value: 48 }, height: { mode: 'fixed', value: 48 } }, style: { borderRadius: 6, fontSize: 18, padding: 0 } },
        ],
      },
      {
        label: '对话栏', desc: '说话人 + 台词 + 继续按钮',
        idBase: 'dialog', type: 'container',
        layout: { mode: 'vertical', gap: 10, padding: 18 },
        size: { width: { mode: 'fixed', value: 520 }, height: { mode: 'auto' } },
        style: { background: '#111827', borderRadius: 8, borderWidth: 1, borderColor: '#4b5563' },
        children: [
          { idBase: 'dialog_speaker', type: 'text', name: '说话人', text: '村庄长老', style: { fontSize: 15, fontWeight: 'bold', color: '#fbbf24' } },
          { idBase: 'dialog_line', type: 'divider', name: '分割线' },
          { idBase: 'dialog_text', type: 'text', name: '台词', text: '勇士，你终于来了。北方的黑暗正在蔓延……', style: { fontSize: 15 } },
          {
            idBase: 'dialog_actions', type: 'container', name: '按钮区',
            layout: { mode: 'horizontal', justify: 'end', gap: 10 },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'dialog_next', type: 'button', name: '继续按钮', text: '继续 ▸' },
            ],
          },
        ],
      },
      {
        label: '任务列表', desc: '标题 + 三条任务',
        idBase: 'quest_list', type: 'container',
        layout: { mode: 'vertical', gap: 6, padding: 12 },
        size: { width: { mode: 'fixed', value: 260 }, height: { mode: 'auto' } },
        style: { background: '#111827', borderRadius: 6, borderWidth: 1, borderColor: '#374151' },
        children: [
          { idBase: 'quest_title', type: 'text', name: '任务标题', text: '任务', style: { fontSize: 14, fontWeight: 'bold', color: '#fbbf24' } },
          { idBase: 'quest_1', type: 'text', name: '任务一', text: '▸ 击杀 10 只哥布林', style: { fontSize: 13, color: '#d1d5db' } },
          { idBase: 'quest_2', type: 'text', name: '任务二', text: '▸ 与铁匠对话', style: { fontSize: 13, color: '#d1d5db' } },
          { idBase: 'quest_3', type: 'text', name: '任务三', text: '✓ 修复城墙', style: { fontSize: 13, color: '#6b7280' } },
        ],
      },
      {
        label: '资源栏', desc: '金币/宝石计数',
        idBase: 'res_bar', type: 'container',
        layout: { mode: 'horizontal', gap: 14, padding: [8, 14] },
        size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
        style: { background: '#111827', borderRadius: 6, borderWidth: 1, borderColor: '#374151' },
        children: [
          { idBase: 'coin_icon', type: 'rect', name: '金币图标', size: { width: { mode: 'fixed', value: 16 }, height: { mode: 'fixed', value: 16 } }, style: { background: '#f59e0b', borderRadius: 8 } },
          { idBase: 'coin_num', type: 'text', name: '金币数', text: '× 1,288', style: { fontSize: 14, color: '#fde68a' } },
          { idBase: 'gem_icon', type: 'rect', name: '宝石图标', size: { width: { mode: 'fixed', value: 16 }, height: { mode: 'fixed', value: 16 } }, style: { background: '#38bdf8', borderRadius: 8 } },
          { idBase: 'gem_num', type: 'text', name: '宝石数', text: '× 56', style: { fontSize: 14, color: '#bae6fd' } },
        ],
      },
      {
        label: '小地图', desc: '角落地图占位框',
        idBase: 'minimap', type: 'container',
        layout: { mode: 'vertical', padding: 8, justify: 'end', align: 'end' },
        size: { width: { mode: 'fixed', value: 180 }, height: { mode: 'fixed', value: 180 } },
        style: { background: '#0b0f19', borderRadius: 6, borderWidth: 1, borderColor: '#4b5563' },
        children: [
          { idBase: 'minimap_label', type: 'text', name: '地图标注', text: '小地图', style: { fontSize: 12, color: '#6b7280' } },
        ],
      },
      {
        label: '背包', desc: '标题 + 4×2 物品格子',
        idBase: 'inventory', type: 'container',
        layout: { mode: 'vertical', gap: 10, padding: 14 },
        size: { width: { mode: 'fixed', value: 320 }, height: { mode: 'auto' } },
        style: { background: '#111827', borderRadius: 8, borderWidth: 1, borderColor: '#4b5563' },
        children: [
          {
            idBase: 'inv_header', type: 'container', name: '背包头部',
            layout: { mode: 'horizontal', justify: 'space-between', align: 'center' },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'inv_title', type: 'text', name: '背包标题', text: '背包', style: { fontSize: 14, fontWeight: 'bold', color: '#fbbf24' } },
              { idBase: 'inv_count', type: 'text', name: '已用格数', text: '12 / 24 已用', style: { fontSize: 12, color: '#9ca3af' } },
            ],
          },
          {
            idBase: 'inv_grid', type: 'container', name: '物品格子',
            layout: {
              mode: 'grid', columnGap: 8, rowGap: 8,
              tracks: {
                columns: [
                  { mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 },
                  { mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 },
                ],
                rows: [{ mode: 'fixed', value: 64 }, { mode: 'fixed', value: 64 }],
              },
            },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            style: { background: '#111827' },
            children: [
              {
                idBase: 'inv_slot_1', type: 'container', name: '物品格 1',
                layout: { mode: 'vertical', justify: 'center', align: 'center' },
                size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } },
                style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' },
                children: [
                  { idBase: 'inv_item_1', type: 'rect', name: '物品图标', size: { width: { mode: 'fixed', value: 40 }, height: { mode: 'fixed', value: 40 } }, style: { background: '#f59e0b', borderRadius: 6 } },
                ],
              },
              {
                idBase: 'inv_slot_2', type: 'container', name: '物品格 2',
                layout: { mode: 'vertical', justify: 'center', align: 'center' },
                size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } },
                style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' },
                children: [
                  { idBase: 'inv_item_2', type: 'rect', name: '宝石图标', size: { width: { mode: 'fixed', value: 40 }, height: { mode: 'fixed', value: 40 } }, style: { background: '#38bdf8', borderRadius: 6 } },
                ],
              },
              { idBase: 'inv_slot_3', type: 'container', name: '物品格 3', layout: { mode: 'vertical', justify: 'center', align: 'center' }, size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } }, style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' } },
              { idBase: 'inv_slot_4', type: 'container', name: '物品格 4', layout: { mode: 'vertical', justify: 'center', align: 'center' }, size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } }, style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' } },
              { idBase: 'inv_slot_5', type: 'container', name: '物品格 5', layout: { mode: 'vertical', justify: 'center', align: 'center' }, size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } }, style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' } },
              { idBase: 'inv_slot_6', type: 'container', name: '物品格 6', layout: { mode: 'vertical', justify: 'center', align: 'center' }, size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } }, style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' } },
              { idBase: 'inv_slot_7', type: 'container', name: '物品格 7', layout: { mode: 'vertical', justify: 'center', align: 'center' }, size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } }, style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' } },
              { idBase: 'inv_slot_8', type: 'container', name: '物品格 8', layout: { mode: 'vertical', justify: 'center', align: 'center' }, size: { width: { mode: 'fixed', value: 64 }, height: { mode: 'fixed', value: 64 } }, style: { borderRadius: 6, borderWidth: 1, borderColor: '#374151' } },
            ],
          },
        ],
      },
      {
        label: '设置', desc: '标题 + 设置项行 + 返回',
        idBase: 'settings', type: 'container',
        layout: { mode: 'vertical', gap: 12, padding: 18 },
        size: { width: { mode: 'fixed', value: 360 }, height: { mode: 'auto' } },
        style: { background: '#111827', borderRadius: 8, borderWidth: 1, borderColor: '#4b5563' },
        children: [
          { idBase: 'set_title', type: 'text', name: '设置标题', text: '设置', style: { fontSize: 15, fontWeight: 'bold', color: '#fbbf24' } },
          { idBase: 'set_line', type: 'divider', name: '分割线' },
          {
            idBase: 'set_row_sound', type: 'container', name: '音效行',
            layout: { mode: 'horizontal', justify: 'space-between', align: 'center' },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'set_sound_label', type: 'text', name: '音效标签', text: '音效', style: { fontSize: 14 } },
              { idBase: 'set_sound_toggle', type: 'button', name: '音效开关', text: '开' },
            ],
          },
          {
            idBase: 'set_row_display', type: 'container', name: '全屏行',
            layout: { mode: 'horizontal', justify: 'space-between', align: 'center' },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'set_display_label', type: 'text', name: '全屏标签', text: '全屏', style: { fontSize: 14 } },
              { idBase: 'set_display_toggle', type: 'button', name: '全屏开关', text: '关' },
            ],
          },
          {
            idBase: 'set_row_quality', type: 'container', name: '画质行',
            layout: { mode: 'horizontal', justify: 'space-between', align: 'center' },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'set_quality_label', type: 'text', name: '画质标签', text: '画质', style: { fontSize: 14 } },
              { idBase: 'set_quality_toggle', type: 'button', name: '画质选项', text: '中' },
            ],
          },
          {
            idBase: 'set_row_actions', type: 'container', name: '返回行',
            layout: { mode: 'horizontal', justify: 'end', gap: 10 },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'set_back', type: 'button', name: '返回按钮', text: '返回' },
            ],
          },
        ],
      },
    ],
  },

  mobile: {
    label: '移动应用',
    icon: '📱',
    desc: '手机竖屏 390×844：导航栏、标签栏、列表、卡片',
    canvas: { width: 390, height: 844, background: '#e5e7eb' },
    rootBackground: '#f9fafb',
    styles: {
      text:   { color: '#111827', fontSize: 15 },
      button: { background: '#0d9488', borderRadius: 12, padding: [12, 20, 12, 20], fontSize: 15 },
      input:  { background: '#f9fafb', borderColor: '#d1d5db', borderRadius: 10, padding: [10, 14, 10, 14], fontSize: 15 },
      rect:   { background: '#ccfbf1', borderRadius: 10 },
      divider:{ background: '#e5e7eb' },
    },
    sizeOverrides: { image: { width: 96, height: 72 } },
    blocks: [
      {
        label: '顶部导航栏', desc: '返回 + 标题 + 头像',
        idBase: 'appbar', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 16], align: 'center', gap: 12 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 56 } },
        style: { background: '#ffffff' },
        children: [
          { idBase: 'appbar_back', type: 'text', name: '返回', text: '←', style: { fontSize: 20 } },
          { idBase: 'appbar_title', type: 'text', name: '标题', text: '页面标题', size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: { fontSize: 16, fontWeight: 'bold', textAlign: 'center' } },
          { idBase: 'appbar_avatar', type: 'rect', name: '头像', size: { width: { mode: 'fixed', value: 30 }, height: { mode: 'fixed', value: 30 } }, style: { borderRadius: 15 } },
        ],
      },
      {
        label: '底部标签栏', desc: '四个页签',
        idBase: 'tabbar', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 28], justify: 'space-between', align: 'center' },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 60 } },
        style: { background: '#ffffff' },
        children: [
          {
            idBase: 'tab_home', type: 'container', name: '页签 首页',
            layout: { mode: 'vertical', gap: 3, align: 'center' },
            size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'tab_home_ico', type: 'rect', name: '图标', size: { width: { mode: 'fixed', value: 22 }, height: { mode: 'fixed', value: 22 } }, style: { borderRadius: 6 } },
              { idBase: 'tab_home_txt', type: 'text', name: '文字', text: '首页', style: { fontSize: 10 } },
            ],
          },
          {
            idBase: 'tab_find', type: 'container', name: '页签 发现',
            layout: { mode: 'vertical', gap: 3, align: 'center' },
            size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'tab_find_ico', type: 'rect', name: '图标', size: { width: { mode: 'fixed', value: 22 }, height: { mode: 'fixed', value: 22 } }, style: { borderRadius: 6 } },
              { idBase: 'tab_find_txt', type: 'text', name: '文字', text: '发现', style: { fontSize: 10 } },
            ],
          },
          {
            idBase: 'tab_msg', type: 'container', name: '页签 消息',
            layout: { mode: 'vertical', gap: 3, align: 'center' },
            size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'tab_msg_ico', type: 'rect', name: '图标', size: { width: { mode: 'fixed', value: 22 }, height: { mode: 'fixed', value: 22 } }, style: { borderRadius: 6 } },
              { idBase: 'tab_msg_txt', type: 'text', name: '文字', text: '消息', style: { fontSize: 10 } },
            ],
          },
          {
            idBase: 'tab_me', type: 'container', name: '页签 我的',
            layout: { mode: 'vertical', gap: 3, align: 'center' },
            size: { width: { mode: 'auto' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'tab_me_ico', type: 'rect', name: '图标', size: { width: { mode: 'fixed', value: 22 }, height: { mode: 'fixed', value: 22 } }, style: { borderRadius: 6 } },
              { idBase: 'tab_me_txt', type: 'text', name: '文字', text: '我的', style: { fontSize: 10 } },
            ],
          },
        ],
      },
      {
        label: '列表项', desc: '缩略图 + 标题/副标题 + 箭头',
        idBase: 'list_item', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 14], align: 'center', gap: 12 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 64 } },
        style: { background: '#ffffff' },
        children: [
          { idBase: 'li_thumb', type: 'rect', name: '缩略图', size: { width: { mode: 'fixed', value: 40 }, height: { mode: 'fixed', value: 40 } }, style: { borderRadius: 8 } },
          {
            idBase: 'li_text', type: 'container', name: '文字区',
            layout: { mode: 'vertical', gap: 2 },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'li_title', type: 'text', name: '标题', text: '列表标题', style: { fontSize: 14, fontWeight: 'bold' } },
              { idBase: 'li_sub', type: 'text', name: '副标题', text: '副标题说明', style: { fontSize: 12, color: '#9ca3af' } },
            ],
          },
          { idBase: 'li_arrow', type: 'text', name: '箭头', text: '›', style: { fontSize: 16, color: '#d1d5db' } },
        ],
      },
      {
        label: '设置行', desc: '名称 + 当前值 + 箭头',
        idBase: 'set_row', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 16], align: 'center' },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 48 } },
        style: { background: '#ffffff' },
        children: [
          { idBase: 'set_label', type: 'text', name: '名称', text: '推送通知', size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: { fontSize: 14 } },
          { idBase: 'set_value', type: 'text', name: '当前值', text: '已开启', style: { fontSize: 13, color: '#9ca3af' } },
          { idBase: 'set_arrow', type: 'text', name: '箭头', text: '›', style: { fontSize: 14, color: '#d1d5db' } },
        ],
      },
      {
        label: '搜索栏', desc: '圆角搜索输入框',
        idBase: 'search_bar', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 12], align: 'center', gap: 8 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 42 } },
        style: { background: '#f3f4f6', borderRadius: 12 },
        children: [
          { idBase: 'search_icon', type: 'text', name: '搜索图标', text: '⌕', style: { fontSize: 16, color: '#9ca3af' } },
          { idBase: 'search_input', type: 'input', name: '搜索输入框', placeholder: '搜索' },
        ],
      },
      {
        label: '主按钮', desc: '整宽大按钮',
        idBase: 'primary_btn', type: 'button',
        name: '主按钮', text: '立即开始',
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 48 } },
        style: { borderRadius: 12, fontSize: 15 },
      },
      {
        label: '卡片', desc: '封面 + 标题 + 描述',
        idBase: 'mcard', type: 'container',
        layout: { mode: 'vertical', gap: 10, padding: 14 },
        size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
        style: { background: '#ffffff', borderRadius: 12, borderWidth: 1, borderColor: '#e5e7eb' },
        children: [
          { idBase: 'mcard_cover', type: 'rect', name: '封面', size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 120 } }, style: { borderRadius: 8 } },
          { idBase: 'mcard_title', type: 'text', name: '标题', text: '卡片标题', style: { fontSize: 15, fontWeight: 'bold' } },
          { idBase: 'mcard_desc', type: 'text', name: '描述', text: '一句话描述内容。', style: { fontSize: 13, color: '#6b7280' } },
        ],
      },
    ],
  },

  desktop: {
    label: '桌面软件',
    icon: '🖥',
    desc: '桌面窗口 1440×900：标题栏、侧边菜单、工具栏、表单',
    canvas: { width: 1440, height: 900, background: '#e2e8f0' },
    rootBackground: '#f8fafc',
    styles: {
      text:   { color: '#1e293b', fontSize: 13 },
      button: { background: '#0369a1', borderRadius: 4, padding: [6, 14, 6, 14], fontSize: 13 },
      input:  { borderColor: '#94a3b8', borderRadius: 4, padding: [5, 10, 5, 10], fontSize: 13 },
      rect:   { background: '#dbeafe', borderRadius: 4 },
      divider:{ background: '#cbd5e1' },
    },
    blocks: [
      {
        label: '窗口标题栏', desc: '标题 + 最小化/最大化/关闭',
        idBase: 'titlebar', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 10], align: 'center', gap: 12 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 36 } },
        style: { background: '#e2e8f0' },
        children: [
          { idBase: 'tb_title', type: 'text', name: '窗口标题', text: '未命名 - 窗口', size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: { fontSize: 12, color: '#475569' } },
          { idBase: 'tb_min', type: 'text', name: '最小化', text: '—', style: { fontSize: 12, color: '#475569' } },
          { idBase: 'tb_max', type: 'text', name: '最大化', text: '□', style: { fontSize: 12, color: '#475569' } },
          { idBase: 'tb_close', type: 'text', name: '关闭', text: '×', style: { fontSize: 13, color: '#475569' } },
        ],
      },
      {
        label: '侧边菜单', desc: '一列导航项（含选中态）',
        idBase: 'sidebar', type: 'container',
        layout: { mode: 'vertical', padding: [10, 8], gap: 2 },
        size: { width: { mode: 'fixed', value: 200 }, height: { mode: 'fill' } },
        style: { background: '#f1f5f9' },
        children: [
          { idBase: 'menu_overview', type: 'text', name: '菜单 总览', text: '总览', style: { padding: [8, 12, 8, 12], background: '#0369a1', color: '#ffffff', borderRadius: 4 } },
          { idBase: 'menu_orders', type: 'text', name: '菜单 订单', text: '订单管理', style: { padding: [8, 12, 8, 12], color: '#334155', borderRadius: 4 } },
          { idBase: 'menu_users', type: 'text', name: '菜单 用户', text: '用户管理', style: { padding: [8, 12, 8, 12], color: '#334155', borderRadius: 4 } },
          { idBase: 'menu_reports', type: 'text', name: '菜单 报表', text: '数据报表', style: { padding: [8, 12, 8, 12], color: '#334155', borderRadius: 4 } },
          { idBase: 'menu_settings', type: 'text', name: '菜单 设置', text: '系统设置', style: { padding: [8, 12, 8, 12], color: '#334155', borderRadius: 4 } },
        ],
      },
      {
        label: '工具栏', desc: '一排紧凑操作按钮',
        idBase: 'toolbar', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 10], align: 'center', gap: 8 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 40 } },
        style: { background: '#ffffff' },
        children: [
          { idBase: 'tb_new', type: 'button', name: '新建按钮', text: '新建' },
          { idBase: 'tb_open', type: 'button', name: '打开按钮', text: '打开', style: { background: '#f1f5f9', color: '#334155', borderWidth: 1, borderColor: '#cbd5e1' } },
          { idBase: 'tb_save', type: 'button', name: '保存按钮', text: '保存', style: { background: '#f1f5f9', color: '#334155', borderWidth: 1, borderColor: '#cbd5e1' } },
        ],
      },
      {
        label: '状态栏', desc: '窗口底部状态信息',
        idBase: 'statusbar', type: 'container',
        layout: { mode: 'horizontal', padding: [0, 12], align: 'center', gap: 12 },
        size: { width: { mode: 'fill' }, height: { mode: 'fixed', value: 26 } },
        style: { background: '#e2e8f0' },
        children: [
          { idBase: 'sb_ready', type: 'text', name: '状态', text: '就绪', size: { width: { mode: 'fill' }, height: { mode: 'auto' } }, style: { fontSize: 11, color: '#64748b' } },
          { idBase: 'sb_page', type: 'text', name: '页码', text: '第 1 页，共 3 页', style: { fontSize: 11, color: '#64748b' } },
          { idBase: 'sb_ver', type: 'text', name: '版本', text: 'v1.0', style: { fontSize: 11, color: '#64748b' } },
        ],
      },
      {
        label: '表单窗口', desc: '标题 + 两行输入 + 按钮区',
        idBase: 'form_win', type: 'container',
        layout: { mode: 'vertical', gap: 12, padding: 18 },
        size: { width: { mode: 'fixed', value: 380 }, height: { mode: 'auto' } },
        style: { background: '#ffffff', borderRadius: 8, borderWidth: 1, borderColor: '#cbd5e1' },
        children: [
          { idBase: 'fw_title', type: 'text', name: '标题', text: '新建用户', style: { fontSize: 16, fontWeight: 'bold' } },
          {
            idBase: 'fw_row1', type: 'container', name: '姓名行',
            layout: { mode: 'horizontal', align: 'center', gap: 10 },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'fw_name_label', type: 'text', name: '姓名标签', text: '姓名', size: { width: { mode: 'fixed', value: 70 }, height: { mode: 'auto' } } },
              { idBase: 'fw_name_input', type: 'input', name: '姓名输入框' },
            ],
          },
          {
            idBase: 'fw_row2', type: 'container', name: '邮箱行',
            layout: { mode: 'horizontal', align: 'center', gap: 10 },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'fw_mail_label', type: 'text', name: '邮箱标签', text: '邮箱', size: { width: { mode: 'fixed', value: 70 }, height: { mode: 'auto' } } },
              { idBase: 'fw_mail_input', type: 'input', name: '邮箱输入框' },
            ],
          },
          {
            idBase: 'fw_actions', type: 'container', name: '按钮区',
            layout: { mode: 'horizontal', justify: 'end', gap: 8 },
            size: { width: { mode: 'fill' }, height: { mode: 'auto' } },
            children: [
              { idBase: 'fw_cancel', type: 'button', name: '取消按钮', text: '取消', style: { background: '#f1f5f9', color: '#334155', borderWidth: 1, borderColor: '#cbd5e1' } },
              { idBase: 'fw_create', type: 'button', name: '创建按钮', text: '创建' },
            ],
          },
        ],
      },
    ],
  },
};

export function modeOf(doc) {
  return UI_MODES[(doc && doc.mode) || DEFAULT_MODE] || UI_MODES.generic;
}
