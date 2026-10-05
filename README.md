# 界面工坊 UIForge

本地运行的可视化 UI 布局编辑器：主人在画布上设计界面，编辑器把设计保存为**明确、版本化的布局规则**（UIDoc 文档）；agent 通过命令行读取同一份文件，即可知道每个组件的用途、位置和窗口变化时的排列方式，并能安全地修改。

> 第一版目标：**主人能自由设计界面，agent 能准确读取设计，并通过实际预览检查布局是否符合要求。**

- 技术形态：零依赖原生 ES 模块（浏览器与 Node 共用同一套渲染/校验代码），本地 HTTP 服务只监听 `127.0.0.1:8520`
- 位置：`D:\UIForge`，数据（项目、导出、依赖）全部留在 D 盘

---

## 快速开始

| 入口 | 说明 |
|---|---|
| 双击桌面快捷方式「界面工坊 UIForge」 | 静默启动本地服务（无黑窗口）并自动打开浏览器 |
| 双击 `启动编辑器.vbs` | 同上（快捷方式即指向它）；日志写入 `server.log` |
| `启动编辑器.cmd` | 控制台调试启动：能看到服务日志，关窗口即退出 |
| `停止编辑器.cmd` | 停止后台编辑器（只结束监听 8520 端口的进程） |
| 浏览器访问 `http://127.0.0.1:8520` | 编辑器界面 |
| 命令行 `cli.cmd <命令>` | agent 读写入口（见下文） |

```
D:\UIForge\
├─ 启动编辑器.vbs        静默启动（无窗口）：起服务、等就绪、开浏览器
├─ 启动编辑器.cmd        控制台调试启动
├─ 停止编辑器.cmd        停止后台服务
├─ make-shortcut.ps1     重新生成桌面快捷方式
├─ server.log            最近一次静默启动的服务日志
├─ cli.cmd               agent 命令行入口
├─ server\server.js      本地服务（静态托管 + 项目 API + SSE + 导出落盘）
├─ shared\               协议核心（浏览器/Node 共用）
│   ├─ protocol.js       组件类型、布局模式、尺寸模式、默认值工厂
│   ├─ renderer.js       布局规则 → DOM/CSS（画布、预览、导出三处共用）
│   ├─ validate.js       静态校验 + agent 操作(ops)执行器
│   ├─ measure.js        基于实测快照的布局体检
│   ├─ resolve.js        v3 变体解析器（presentation+style+overrides → v2 形状）
│   ├─ runtime.js        v3 交互运行时（toggle/open/close、Esc、遮罩；运行态不入文件）
│   └─ export-html.js    自包含预览页生成（独立页 / iframe 内嵌 / 无头渲染）
├─ app\                  编辑器前端
├─ cli\cli.js            agent 命令行实现
├─ projects\             *.uidoc.json 设计文件
├─ exports\              导出包（设计 + 快照 + 报告 + 预览页 + 截图）
└─ vendor\html2canvas.min.js  截图用（导出时可选）
```

---

## UIDoc 布局协议（v2 现行，兼容读取 v1）

设计文件是单个 JSON（`projects\<名称>.uidoc.json`），人机共用：

```jsonc
{
  "format": "uidoc", "version": 1,
  "revision": 12,                  // 每次保存自增；agent 提交需带 baseRevision 防覆盖
  "name": "示例页面",
  "mode": "web",                   // 场景模式（可选）：generic|web|game|mobile|desktop；缺省按 generic
  "canvas": { "width": 1280, "height": 800, "background": "#e5e7eb" },
  "resources": { "logo_svg": { "kind": "image", "name": "logo.svg", "dataUrl": "data:..." } },
  "components": { "root": { "...": "..." } }   // 组件表，key 即稳定 ID
}
```

### 场景模式（doc.mode）

模式决定**新建项目**时的画布预设、编辑器里"新组件"的默认样式，以及左侧"预设块"清单（一键插入成套结构，如导航栏/血条/列表项）。模式只影响编辑器的新建行为，**不会**改动已有组件——agent 提交时显式给出 `style/size` 即完全不受默认值影响；未定义的 mode 值仅产生警告并按 generic 处理。

| mode | 画布 | 风格 | 预设块举例 |
|---|---|---|---|
| `generic` 通用 | 1280×800 | 浅色 | 页面标题、按钮组、信息卡片、表单行 |
| `web` 网站 UI | 1280×800 | 浅色靛蓝 | 顶部导航栏、英雄区、内容卡片、三列卡片区、登录卡片、页脚 |
| `game` 游戏 UI | 1920×1080 | 深色金强调 | 血条 HUD、技能栏、对话栏、任务列表、资源栏、小地图 |
| `mobile` 移动应用 | 390×844 | 浅色青绿 | 顶部导航栏、底部标签栏、列表项、设置行、搜索栏、主按钮、卡片 |
| `desktop` 桌面软件 | 1440×900 | 浅色紧凑 | 窗口标题栏、侧边菜单、工具栏、状态栏、表单窗口 |

预设块定义在 `shared/modes.js`（纯数据，人与 agent 可共用）；实例化逻辑在 `shared/blocks.js`。

### 组件

```jsonc
{
  "id": "save_button",             // 稳定标识：字母/数字/下划线，改名字换位置不变
  "type": "button",                // container | text | button | input | image | rect | divider
  "name": "保存按钮",               // 显示名（中文）
  "purpose": "表单主操作：保存用户设置",  // 用途说明——给 agent 看的语义信息
  "parent": "footer",
  "size": { "width": { "mode": "auto" }, "height": { "mode": "auto" } },
  "style": { "background": "#2563eb", "color": "#ffffff", "fontSize": 14, "borderRadius": 6, "padding": [8,16,8,16] },
  "text": "保存",
  "flags": { "allowOverflow": false, "noOverlap": false }
}
```

**容器**（`container`）多一个 `layout` 决定子元素排列，四种模式可任意嵌套：

| 模式 | layout 字段 | 子元素字段 | 适用 |
|---|---|---|---|
| `vertical` 纵向排列 | `gap` `padding` `justify` `align` | 顺序 = children 数组顺序 | 表单、设置页、列表 |
| `horizontal` 横向排列 | 同上 | 同上 | 工具栏、按钮组、导航 |
| `grid` 网格布局 | `tracks:{columns:[{mode:fixed\|fill,value}],rows:[...]}` `columnGap` `rowGap` `padding` | `area:{col,row,colSpan,rowSpan}`（1 起） | 仪表盘、卡片区、分栏 |
| `free` 自由布局 | （无对齐概念） | `position:{left,top}`（相对父容器内容区） | 固定面板、悬浮元素、精确构图 |

UIDoc v2 组件可选 `placement:{mode:'absolute'|'flow'}`。`absolute` 可放在任意容器内，使用相对父内容区的 `position:{left,top}`，从 flex/grid 排列与网格占位中退出；必须提供 position，尺寸不能用 `fill`。编辑器第一次把排列组件拖成独立摆放时，会按实际显示宽高固化为固定尺寸，保留原位置和大小。`flow` 明确参加父布局；省略 placement 时完全沿用旧 v1/v2 父布局语义。v1 文档若含 placement 会被拒绝，不会被静默忽略。

**尺寸模式**（`size.width/height.mode`）：
- `fixed` 固定像素（`value`）
- `fill` 填满剩余（排列方向 = flex-grow，交叉轴 = 拉伸；网格中占满格子；自由布局或 absolute 独立摆放中非法）
- `auto` 自动（由内容决定）
- `percent` 百分比（`value` 0-100，相对父容器内容区）

**样式字段**（`style`，严格白名单）：`background` `color` `fontSize` `fontWeight(normal|medium|bold)` `textAlign` `borderRadius` `borderWidth` `borderColor` `opacity` `padding`（仅 text/button/input）`overflow`（仅 container）。未知字段会被校验器**拒绝**，这是刻意设计——保证 agent 不会写入无效属性。

**类型专属字段**：text/button → `text`；input → `placeholder` `value`；image → `resourceId`（指向 resources，图片以 dataURL 随文件保存）`fit(cover|contain|fill)`；divider → `orientation` `thickness`（粗细所在轴的尺寸由它决定）。

---

## 版本与迁移（UIDoc v1 / v2）

自 2026-10-04 自由设计改造起，协议版本升至 **UIDoc v2**；v1 文档继续可读。

**支持版本清单**：新版程序（编辑器、服务端、CLI）读取并校验 `version: 1` 与 `version: 2`；更高的版本号不支持——明确报错（`E_VERSION_UNSUPPORTED`），文件保持原样，不自动降级、不丢弃字段。

**打开（读）**：v1 文档原样读盘，在内存中补齐 v2 语义后使用，读取本身不写盘、不改文件字节。

**保存（写）**：v1 项目第一次被新版覆盖保存前，服务端/CLI 自动把原 v1 字节完整备份到
`projects\.v1-backups\<名称>_rev<修订号>_<时间戳>.uidoc.v1.json`（备份失败则放弃写入以保护原文件），随后才写入 v2。备份文件名不以 `.uidoc.json` 结尾，不会出现在项目列表中。

**v1 → v2 映射**：迁移是纯语义保持操作——只把 `version` 改为 2；组件 ID、父子关系、children 顺序、resources、canvas、布局语义、修订号全部原样保留。v2 的新能力（见后续版本的更新说明）由校验器与渲染器按默认语义解释，不依赖迁移批量补写字段。

**回退**：需要退回旧版源码时，源码与数据分别处理——从 `D:\UIForge_备份\` 恢复旧源码**不要**覆盖 `projects\`；若某项目已写成 v2 而旧源码读不了，用 `projects\.v1-backups\` 里对应的 v1 备份替换该项目文件。

**自动检查**：`npm test`（Node 自带测试器）覆盖迁移语义保持、版本拒绝、ops 原子性、v1 备份、修订号并发防覆盖。

---

## UIDoc v3（功能 / 风格 / 呈现 / 变体）

v3 在 v2 之上加了一层「多方案」模型，用于**同一套界面的多种呈现与风格组合**（如游戏 UI 的六套方案 = 两呈现 × 三风格）。v2 项目可长期保持原样，不自动升级；v3 文档由编辑器/CLI 明确创建与维护。

```jsonc
{
  "format": "uidoc", "version": 3,
  "canvas": { "...": "与 v2 相同" },
  "features":      { "bag": { "label": "背包", "data": { "slots": 20 } } },  // 共享数据源（组件用 featureId/bind 引用）
  "styles":        { "dark": { "label": "暗色", "tokens": { "color.panel": "#111827" } } },  // 令牌包
  "presentations": { "hud":  { "label": "常驻式", "components": { "root": { "...": "v2 同构组件树" } } } },
  "variants":      [ { "id": "A1", "label": "常驻·暗色", "presentation": "hud", "style": "dark", "overrides": { "tokens": {}, "components": {} } } ],
  "activeVariant": "A1"     // 唯一可保存的「当前状态」；预览运行态永不入文件
}
```

要点（完整冻结决策见 `D:\UIForge_P0\商业级路线图.md` §4）：

- **令牌引用**：组件 style 值写 `"$color.panel"`，渲染时替换为该变体所用风格的令牌值；布局字段（尺寸/位置）不允许 `$`。`overrides.tokens` 只允许微调基础风格已有的令牌键。
- **功能绑定**：组件可选 `featureId`（指向 features）；text/button 可用 `bind.text: "feature:bag.items[0]"` 在渲染期直取功能数据做文案。
- **交互**：button 可声明 `actions.click`（`toggle|open|close` + 目标面板）；container 可设 `initiallyOpen:false`（初始收起，作为动作目标）。预览与导出页内置交互运行时：点击开/关面板、Esc 全关并回焦点、点遮罩关闭；**运行状态只存在于内存/DOM，绝不写进设计文件**。
- **校验**：每个 presentation 内每个 feature 至少被一个组件引用（`E_FEATURE_UNREACHABLE`）；顶层出现 `components` 拒绝（组件树只存在于 presentation 内）。
- **ops 语义**：CLI/agent 的 `update/add/move/remove` 作用于 `activeVariant` 指向的 presentation 树；features/styles/presentations/variants/activeVariant 五段对 ops **只读**（`E_V3_SECTION_READONLY`）——这些段用编辑器维护。

**编辑器（v3 项目）**：画布按 `activeVariant` 解析渲染（令牌替换+变体补丁已生效）；顶栏「变体」下拉切换显示（可撤销）；左栏「功能风格」标签页维护变体/功能/风格/呈现（含「复制为新呈现」）；「＋ 新建变体（向导）」分步完成 选呈现 → 选风格 → 命名生成并激活，一步可撤销。画布上的位置/样式编辑写入**当前呈现方案**（对该呈现的所有变体生效）；变体间的差异用风格令牌与 `overrides` 表达（覆盖补丁当前经 CLI/JSON 维护，面板会在被遮蔽时提示）。

**CLI 导出指定变体**：`export <项目> --variant B2` 按该变体渲染离线页（省略时用 `activeVariant`）；v2 项目带 `--variant` 报 `E_VARIANT_FLAG_ON_V2`，未知变体列出可用项。导出包的 `preview.html` 对 v3 内嵌解析器与交互运行时，离线打开与编辑器预览行为一致。

---

## agent 使用（cli.cmd）

```bat
D:\UIForge\cli.cmd catalog                                  :: 支持的组件/属性/布局模式
D:\UIForge\cli.cmd inspect 示例页面                          :: 组件树 + 每个组件的布局规则
D:\UIForge\cli.cmd inspect 示例页面 save_button --json       :: 指定组件完整定义
D:\UIForge\cli.cmd apply 示例页面 --ops ops.json             :: 批量原子修改
D:\UIForge\cli.cmd validate 示例页面 [--snapshot 快照.json]   :: 结构检查（+实测检查）
D:\UIForge\cli.cmd export 示例页面                           :: 导出包
D:\UIForge\cli.cmd export 示例页面 --variant B2              :: v3 项目按指定变体导出
```

> **agent 注意**：`cli.cmd` 经 Git Bash 调用会挂起——脚本环境请直接 `node cli/cli.js <命令>`。

`apply` 的 ops 文件（全部成功才落盘；任何一步非法则**整体拒绝**，原文件不动）：

```json
{ "ops": [
  { "action": "update", "id": "save_button", "fields": { "text": "保存更改", "style": { "background": "#16a34a" } } },
  { "action": "updateDocument", "fields": { "canvas": { "width": 1440, "height": 900, "background": "#f1f5f9" }, "mode": "web", "name": "新名字" } },
  { "action": "add",    "component": { "type": "button", "text": "重置", "name": "重置按钮" }, "parent": "footer", "index": 0 },
  { "action": "move",   "id": "cancel_btn", "parent": "footer", "index": 0 },
  { "action": "remove", "id": "old_panel" }
], "baseRevision": 12 }
```

- **baseRevision 必填**：声明"我基于哪个修订号修改"。缺省报 `E_BASE_REVISION_REQUIRED`；与当前修订号不符报 `E_REVISION_STALE`——防止 agent 覆盖主人刚保存的修改。先 `inspect` 拿到最新修订号再提交。
- 服务端保存与 CLI apply 共用**同一把项目文件锁**：读修订号 → 比较 → 校验 → 写入是一个事务，并发提交时必有一个成功、另一个收到冲突（不会互相覆盖）。
- add 的 component 字段是严格白名单，未知字段直接拒绝（不会静默丢弃）。
- 错误都带 `code` / `componentId` / `field` / `opIndex`，可精确定位。
- 编辑器开着时，CLI 直写文件后服务端轮询（1.5s）感知并自动刷新编辑器；主人的未保存修改不会被静默覆盖（会弹窗询问）。

### 布局检查的三层语义

1. **结构检查**（无需浏览器）：ID/键名与 id 一致/父子关系/环引用/字段白名单/取值范围（颜色、内边距严格格式）/网格越界与占格重叠/自由布局缺 position 或用 fill 等；损坏组件返回结构化错误而不是抛异常。
2. **快照有效性门禁**（`validate --snapshot` 的前置条件）：修订号必须与文档一致（过期 → `E_REVISION_STALE`）、必须覆盖文档全部组件（缺测 → `E_INCOMPLETE_SNAPSHOT`）、坐标必须是有限数值（非法 → `E_SNAPSHOT_INVALID`）。**门禁不过就不存在"验证通过"的结论**。
3. **实测检查**（基于指定视口的渲染快照）：
   - **规则 vs 实测对照**：固定尺寸实测值必须等于设计值（`E_SIZE_MISMATCH`）；自由布局子元素实测位置必须等于"父容器内容区原点 + position"（`E_POSITION_MISMATCH`）；
   - 边界与重叠：溢出父容器（可被 `flags.allowOverflow` 豁免）、大部分超出页面（`E_OFFSCREEN`）、自由布局兄弟重叠（`flags.noOverlap` 声明后升为错误）、根容器大于视口（提示改"填满剩余"）。

快照记录"修订号 + 视口 + 每个组件实测 x/y/w/h"，与设计要求分开存放——agent 可以区分**规则**与**某尺寸下的实际结果**，并要求两者一致。

### 渲染语义（实现与规则的约定）

- 排列布局中 **fixed/percent 的主轴尺寸不参与 flex 收缩**：设计写多少就是多少；空间不足时保持原值并溢出，由布局检查报告，而不是静默压缩。
- 分割线：粗细所在轴恒为 `thickness`；另一轴尊重尺寸模式（auto/缺省回退占满）。
- 自由布局与 `placement.mode:'absolute'`：`position` 相对**父容器内容区**（计入父边框与 `layout.padding` 偏移）；实测与检查都按同一原点换算。独立摆放可溢出父容器，编辑器可用“画布外”开关查看；预览与导出继续遵循容器 `style.overflow`。

### 导出包

编辑器"导出"或 `cli.cmd export` 产出到 `exports\<名称>_rev<修订号>_<时间>\`：
`design.uidoc.json`（设计）、`snapshot.json`（实测快照，编辑器导出）、`report.json`（检查报告）、`preview.html`（**自包含**预览页，双击即开，内置视口切换/测量布局/下载快照/截图按钮）、`screenshot.png`（编辑器导出时）。

---

## 编辑器操作

- **四区布局**：左侧预设块＋基础组件＋层级树（拖动节点到容器上改父级）；中间画布（缩放、拖动、参考线吸附、间距提示）；右侧属性面板（全中文）；顶部常用操作。
- **拖入画布**：组件库/预设块可直接**拖到画布上想放的位置**松手——悬停高亮目标容器；排列布局显示橙色插入线（落到谁前面一目了然）；网格显示目标格（占用时自动落到空闲格）；自由布局显示与实际尺寸一致的幽灵占位，落点即组件中心。点击加入仍是原方式（加进选中容器）。落点**不再截断为非负**：可以把组件放到画布边缘之外（负坐标），配合「画布外」开关随时查看。
- **场景模式**：新建项目时选择模式（通用/网站/游戏/移动/桌面），决定画布预设与新组件默认样式；左侧"预设块"按当前模式变化，一键插入成套结构。顶栏徽章显示当前模式。
- **起步方式**：新建项目可选「自由摆放（推荐）」或「自动排列」起步；新项目根容器默认**跟随画布尺寸**（画布改尺寸自动伸缩），旧项目固定根保持原语义，画布设置里有明确的跟随/固定切换。
- **预设块全库浏览**：左侧预设块顶部可切换场景来源（跟随项目或任一模式），借用其他模式的块不会改动当前设计的任何已有内容。
- **画布设置**：点击画布空白处（未选中组件时），右侧属性面板可直接修改画布宽/高（1–20000）与背景色。
- **快编辑**：**双击**画布上的文本/按钮就地改字（Enter 提交、Esc 取消）；**右键**呼出菜单（编辑文字/复制/副本/粘贴进容器/上移下移/删除）。
- **拖拽语义**：默认开启「自由移动」。拖动横向/纵向/网格中的组件，会将该组件独立摆放并按当前实测宽高固化尺寸；关闭开关后，横向/纵向拖动改顺序，网格拖动改占格。自由布局拖动改位置，并吸附父容器/兄弟边缘与中心，显示参考线。普通排列尺寸拖后，「填满剩余」转为固定值；横向/纵向排列里的「百分比」按新比例重算，其他布局转为固定值。每次切换或拖动均可撤销。
- **吸附开关**：画布右下角「吸附」按钮可完全关闭参考线吸附；拖动中按住 **Alt** 可临时绕过。
- **缩放范围**：5%–800%（`Ctrl+滚轮` 以光标为中心；±按钮与「适应」共用同一边界）。
- **画布外内容**：画布右下角「画布外」开关控制设计视图是否显示画布外内容；预览与导出始终按视口裁剪（最终裁剪由设计规则决定）。
- **布局切换保外形**：把排列/网格容器切换为「自由布局」时，子元素按转换瞬间的**真实位置与尺寸**落位（含边框换算），不会重置成 160×48 堆在角落；被旧布局拉伸的宽度会固化并保持外观；一次转换 = 一步撤销。
- **复制=快照**：`Ctrl+C` 复制完整子树与依赖图片资源；之后修改或删除原件、甚至切换项目再 `Ctrl+V`，粘贴的都是复制那一刻的内容（跨项目自动去重/重映射资源 ID）。
- **删除即撤可回**：删除不再弹确认框，删除后 toast 提示，`Ctrl+Z` 找回。
- **快捷键**：`Ctrl+S` 保存，`Ctrl+Z/Y` 撤销重做（外部修改也可撤销找回），`Ctrl+C/V/D` 复制/粘贴/副本，`Delete` 删除，方向键微调（`Shift` ×10），`Ctrl+滚轮` 缩放，`Esc` 取消选择。
- **数值边界**：字号 1–400、圆角 0–2000、边框 0–100、分割线粗细 1–100、百分比尺寸 0–1000（允许有意大于父容器做出血/超大装饰）；边界集中定义在 `shared/protocol.js` 的 `LIMITS`，校验、面板、手柄、CLI 同源，不会出现"面板放宽了、CLI 还拦着"。
- **预览**：切换 1920×1080 / 1440×900 / 1280×800 / 1024×768 / 768×1024 / 390×844 / 375×667 / 自定义视口，"检查布局"在该视口下实测并给出错误/警告清单（可点击"定位"跳转到组件）。

## 已知边界（P1 方向）

- 响应式断点、多选与成组、结构化扩展样式（渐变/阴影/字体）、素材面板与自定义预设 → S2/S3。
- 溢出检查基于单视口实测；大部分超出画布的内容会在"检查布局"中报 `E_OFFSCREEN`（有意出血暂以 `flags.allowOverflow` 记录溢出豁免，S2 将完善意图表达）。
- 编辑器最小化/后台时 html2canvas 截图可能超时（有 12s 兜底，导出包其余内容不受影响）。
