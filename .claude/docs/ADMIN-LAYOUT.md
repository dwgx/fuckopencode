# 管理面板布局改造设计规范（opencode 风格）

契约文档：给实现 agent 的布局改造依据。用户反馈「**不要一直往下滑，这样太
麻烦了**」——账号详情页纵向堆了 9 个区块，要求「人性化设置，要跟 OpenCode 一样」。

来源与证据见文末 §6。三条核心结论（都有实测/源码证据）：

1. **opencode 自己也不用「长页面 + 连续滚动」组织详情**：新版控制台
   （console.opencode.ai）的 Settings 是**子 tab 分组**，Members/Keys 是
   **双栏**（表 + 附属配置卡），长页只有 Billing（8 区块，滚动容器内部滚）。
   旧版（opencode.ai/workspace/{id}，源码）是左侧 240px 导航 + 纵向 section。
2. **opencode 没有折叠面板（accordion）**，也没有进度条/徽标组件——
   低频配置项全部用「**值 + Edit 按钮 → 内联表单 → 提交自动收起**」。
3. **new-api 处理长列表**：表格定高表内滚动、分页钉在页脚，整页不滚；
   长表单用抽屉 + 左侧分区锚点导航。

---

## 1. 布局原则：消灭「一直下滑」

按优先级列出手段，每条 = 形态 + 适用场景 + 反例（什么时候不要用）。

### 1.1 区块级子 tab 分组（本改造的主手段）

- **形态**：一个长详情页拆成 4-6 个互斥的短子页，子 tab 条在页面顶部。
- **适用**：一个实体（账号）含多个信息域，每个域内容 ≤2 屏。
- **上限**：tab 数 ≤6。>6 说明该分页而不是分 tab。
- **反例**：域之间有依赖、需要对照着看的内容（如「余额」与「自动充值」）——
  拆开反而别扭的，宁可合并成一个 tab 内两栏。
- **证据**：console.opencode.ai Settings 子页（General/Account/Security）；
  new-api 用「钻取」导航替代多级菜单堆叠。

### 1.2 首屏摘要 + 下钻

- **形态**：每页第一屏给出「核心答案」（余额多少、健康不健康、有没有 key），
  明细在下方或另页。
- **适用**：监控型信息（用户进来就是想知道「现在怎么样」）。
- **证据**：console.opencode.ai My Activity 页首屏 = 3 个大数字统计卡
  （Cost/Requests/Tokens）+ 图表卡 + 请求日志，一屏（746px）放下不滚动。

### 1.3 表格内滚（定高表体 + sticky 表头）

- **形态**：长列表放进 `max-height` 容器，表头 sticky，表体自己滚；
  分页/计数放在表格外（页脚或标题行）。
- **适用**：明细类数据（用量按日、请求日志、ledger），行数无上限、
  用户只关心最近若干条。
- **反例**：需要全文对比/跨行操作的表不要内滚（改成翻页）。
- **证据**：new-api DataTablePage `fixedHeight`（表占满剩余高度、表头
  sticky、表体内部滚动，整页不滚）+ 分页钉页脚；console Usage 页同样
  在内部滚动容器里。

### 1.4 「值 + Edit」行内编辑（代替折叠卡片）

- **形态**：一行 = 当前值 + Edit 按钮；点 Edit 就地展开表单，提交成功自动收起。
- **适用**：低频配置项（自动充值、月限额、budget、组织名）。
- **反例**：字段 ≥4 个的编辑（用 §1.5 两栏或弹层）；需要反复对比的表单。
- **证据**：console 源码**没有任何 details/accordion**；Settings 页
  Organization 区块、Billing 页 Auto-recharge 区块都是「Off + Edit」。

### 1.5 两栏：主内容 + 附属配置卡

- **形态**：主表/主内容占宽，右侧固定宽（~280px）卡放附属信息。
- **适用**：主表 + 少量相关配置（成员表 + 预算卡）。
- **证据**：console.opencode.ai Members/Keys 页 = 左表 + 右 Budget limits 卡；
  new-api 长表单抽屉 = 内容区 + 左侧分区锚点导航。

### 1.6 危险/低频操作收进「设置」子页

- **形态**：删除账号、清 cookie 这类操作放在最不常点的子页底部，红色标注，
  不与日常信息混排。
- **证据**：console Settings → Security 子页（SSO、敏感配置集中）。
- **反例**：高频操作（创建 key）不藏。

### 1.7 页面内锚点导航 —— 不用

旧版控制台、new-api 抽屉用锚点导航是因为页面真的长；本面板改造后每个子页
≤2 屏，不需要锚点。**实现 agent 不要为「分区导航」加锚点组件**——子 tab
就是导航。

---

## 2. opencode 风格形态规范（可直接照抄的值）

面板现有 CSS 令牌已与 opencode dark 完全一致（`--bg:#0c0c0e`、`--surface:
#161618`、`--elevated:#1c1c1f`、`--border:#38383a`、`--border-muted:
#2c2c2e`、`--text-muted:#a1a1a6`、`--accent:#007aff`、`--radius:3px`、
等宽字体栈），**不改令牌**，以下只定新增/调整的形态。

### 2.1 导航 tab 规范

| 层级 | 样式 | 依据 |
|---|---|---|
| 页面级顶 tab（总览/账号/用量/**Keys**/设置） | **现状不动**：sticky + accent 下划线 | 已有用户认知；旧版控制台移动端同款底部 2px 横条。**2026-08-14 核对：实际是 5 个**（admin.ts:1579-1583，含分发密钥页 sec-tokens）；与账号详情内「Keys 子 tab」（本地池/远程 SA/legacy）是两回事 |
| 详情内子 tab（新） | 纯文字 13px 无图标；非 active `--text-muted`，active `--text` + `font-weight:700`；容器 `overflow-x:auto` 隐藏滚动条（窄屏横滑） | 新版控制台 tab 条：active 仅文字变白、字重 530-700，无下划线无背景；tab 条横向滚动不收起 |
| 侧栏子导航（sidebar） | 现状不动 | 新版控制台 Settings 左竖排子导航同款语义 |

子 tab 条位置：面包屑下方、内容上方，**不 sticky**（新版控制台 tab 条不
sticky，滚动容器是内容区）。

### 2.2 区块标题与间距

- 区块标题：h2，`font-size:15px; font-weight:600; letter-spacing:-0.5px`；
  副标题 p：13px `--text-muted`，行高 1.5。**不用 uppercase**（uppercase
  只用于页面级页头 banner）。
- 区块间距：相邻区块 `gap:64px`，`border-bottom:1px solid var(--border-muted)`
  分隔，末区块无分隔。
- 现有 `dBlock()` 生成 `h1 + .sub`——改造后详情内子页用同样的结构即可，
  标题语义 h2（HTML 上不强制改标签，样式对齐 15px/600 + 字距即可）。
- 卡片：`1px solid var(--border)` + `3px` 圆角 + `16px` padding（现有
  `.card`/`.balance-card` 已对齐，新卡片照抄）。
- 空态：`border:1px dashed var(--border)` + 居中 + `padding: 64px 24px`，
  灰字一句。
- 页面宽度：内容区 `max-width:1024px`（现有 main 宽度对齐 64rem 即 1024px）。

### 2.3 表格密度

- th：13px uppercase `--text-muted`，左对齐，`font-weight:400`，
  padding `12px 16px`，表头下 `1px solid var(--border)`。
- td：13px，等宽（面板全局 mono 已满足），padding `12px 16px`，
  行分隔 `1px solid var(--border-muted)`，末行无分隔。
- 无斑马纹、无整行 hover 高亮；行内操作按钮默认 `opacity:0`，
  hover 行时出现（现有 key-row 已是此风格，新表照抄）。
- 数字列右对齐或保持等宽对齐（tabular-nums 已全局开启）。

### 2.4 表单密度

- label 在上：13px/500 `--text-muted`；input 在下：13px，
  `padding:8px 12px`，`1px solid var(--border)`，3px 圆角，
  focus = 边框变 `--accent` + `box-shadow:0 0 0 3px rgba(0,122,255,.15)`。
- 多字段并排：flex 行，每列 `flex:1`，≤40rem 折行成列。
- 按钮：`padding:12px 16px`，13px/500，1px 边框 3px 圆角；
  primary = accent 底白字；hover 边框变 accent；`active { transform:
  translateY(1px) }`。

### 2.5 折叠面板形态 —— 不引入

**不用 `<details>`/chevron/accordion**。低频配置项一律「值 + Edit」行内
编辑：显示行（值 + `button.ghost` Edit）→ 点击后同一位置展开内联表单
（含取消）→ 提交成功收起并刷新值。给实现 agent 新增一个 CSS 类
`.d-inline-edit`（容器）+ 现有 `.form` 内联即可，不需要状态机组件。

### 2.6 进度条 / 徽标 / 状态

- 进度条：**保留**现有 meter（面板自有增强，用户已有认知），但按
  opencode 习惯在下方补文本行：「`$X used in <Month>`」式的一句话
  （`--text-muted` 13px）。
- 状态徽标：**保留**现有（第十二轮用户明确要求过友好文案徽标），
  徽标旁给文本解释已是现状，不动。
- 大数字：余额 24px/600（现有 `.balance-card .v` 已对齐）；
  限额类可 30px/500。
- 状态一律文本 + 加粗 `<b>` 的兜底形态（新版控制台 reload enabled/
  disabled 即此形态）。

---

## 3. 账号详情页改造方案（核心交付）

### 3.1 总体结构

```
面包屑（返回 + 账号名，现状不动）
[子 tab 条]：概览 | 余额 | Keys | 成员 | 提供方 | 设置    ← 6 个，新样式 §2.1
└─ 每个子 tab 一个容器（id=dt-overview / dt-balance / dt-keys / dt-members / dt-providers / dt-settings）
```

- 现有 `detail-*` 9 个挂载点（billing/usage/autorecharge/budgets/members/
  sa/providers/legacy/cookie）重组进 6 个 tab 容器，**不新建数据端点**，
  纯前端重组。
- 数据加载改**按 tab 懒加载**：切到某 tab 才拉对应端点；概览 tab 在
  2s 轮询里刷新，其他 tab 切回时用 `detailState` 缓存 + 前台时补拉一次
  （现状是进详情一次全拉 7 个端点，改造后减少无效请求）。
- 子 tab 状态存 `detailState.tab`，切换只重渲染对应容器，不重建整页。

### 3.2 各 tab 内容（每 tab 目标 ≤1 屏，例外 ≤1.5 屏）

**概览 Overview**（= 首屏摘要，§1.2）
1. 连接状态条：现有 cookie-warn 收敛成单行状态（`[!] cookie missing →
   import from browser`），不再是大块警告卡片。
2. 基本信息卡：名称 / 类型 / workspaceId / legacyWorkspaceId——**只读值 +
   Edit 进设置 tab**（保持短）。
3. 三个统计卡并排：余额（大数字）/ 月限额（含 meter 进度条 + "$X used
   in <Month>" 文本）/ 本月用量（requests + cost）。
4. 上游用量明细：现有 byDay 表 + 24h/7d range 按钮，表体 `max-height:240px`
   内滚（§1.3），表上方标题行放 range 按钮（现有结构平移）。
5. 本地代理流量摘要：一行小字（总请求/失败/令牌，现有 overview 数据）。

**余额 Balance**（= 钱的配置，§1.4/§1.5）
1. 自动充值卡：「Off/On + Edit」行内编辑（现有 configure-ar 表单平移到
   内联形态）。
2. 预算卡：org budget / user budget 两行值 + set 按钮（现有 budgets
   数据）。
3. 订阅与支付卡：plan / payment methods last4 / ledger 最近 5 条
   （现有 billing 块的卡片与 ledger 列表；ledger 全量进内滚容器）。
4. 手动刷新按钮放本 tab 标题行右侧。

**Keys**
1. 本地池 keys 表（现有 key-row：健康点/指纹/昵称/inFlight，昵称内联改名）。
2. 远程 service accounts 表（现有 detail-sa：名称/掩码/最后使用 + 创建按钮）。
3. legacy keys 表（现有 detail-legacy：创建/删除）。
4. 三表各 ≤8 行，超出内滚；创建按钮放各自表标题行。

**成员 Members**
1. 成员表（现有 detail-members：邮箱/角色/joined/用量/限额）。

**提供方 Providers**
1. 提供方表（现有 detail-providers）。

**设置 Settings**（= §1.6 低频/危险区）
1. 连接配置卡：cookie 粘贴导入（现有 detail-cookie-paste 表单）。
2. 标识编辑卡：name / kind / workspaceId / legacyWorkspaceId（值 + Edit
   内联，现有 PATCH 端点）。
3. 危险区（底部，红色分隔）：删除账号（现有 confirm 弹层）。

### 3.3 命名与测试

- 新增容器 id 与现有 `detail-*` 平级（`dt-*` 前缀避免与旧挂载点混淆，
  旧挂载点删除）。
- `test/dashboard.test.ts` 有挂载点/词条键断言——新增 `dt-*` 挂载点、
  子 tab i18n 键（概览/余额/Keys/成员/提供方/设置 中英）后**必须同步
  更新该测试**，词条键集合对齐断言会红。

---

## 4. 设置页改造方案

现状 3 块（语言/模型映射/关于）纵向排，模型映射表 + 添加表单较长。
**2026-08-14 补充现状**：设置页还有 Admin account（登录凭据）区块，且
「当前生效密码 == 默认值（13141516）」时显示 `adminPassIsDefault` 强提示徽章
（实心红底 oc-chip-danger，密码 label 旁 + 输入框下 oc-hint-err 双提示）——
服务端 handleGetSettings 返回**顶层字段** `adminPassIsDefault`（server.ts:929/1005，
精确判定 `cfg.adminPass === DEFAULT_ADMIN_PASS`，不是 source==='env' 近似），
前端 settingsCache.def 驱动（admin.ts:3933-3954）。

改造（复用现有 sidebar 子导航机制，对应新版控制台 Settings 子页模式）：

| sidebar 子导航（现有） | 内容 |
|---|---|
| 语言 | 语言下拉（现状平移，现有 sec-settings-lang） |
| 模型映射 | 表（`max-height:300px` 内滚 + 行操作）+ 添加表单两栏 grid（现状平移） |
| 关于 | 现状平移 |

- 模型映射表内滚 + 表上方标题行放「添加映射」折叠区（点开是现有
  添加表单，`<details>` 语义换成「+ 添加映射」按钮 → 内联展开，§2.5）。
- 设置页子导航 active 态复用 sidebar 现有 `snav.active`。

---

## 5. 移动端适配（≤48rem / ≤40rem / ≤30rem）

- **≤48rem**：sidebar 收成顶部横滚 tab（现有行为，保持）；详情子 tab 条
  横向滚动（`overflow-x:auto` + 隐藏滚动条，参照新版控制台 tab 条，
  **不收起、不汉堡**）。
- **≤40rem**：表格 padding `12px 16px → 8px 12px`、字号 12px；低优先列
  隐藏（现有 `.lent` 3 列先例：usage 隐藏 Model 列、keys 隐藏某列）；
  内滚表高度 `240px → 160px`；详情子 tab 条字号 12px。
- **≤30rem**：区块间距 `64px → 32px`；统计卡保持并排不堆叠
  （新版控制台 375px 下 3 卡并排 101px 宽）——若卡数 >3 才 wrap；
  顶栏用户菜单压缩（现状已有）。
- 表格在移动端**不做横向滚动**：隐藏列优先于横滚（new-api 640px 断点
  换卡片列表是更大成本方案，本面板先隐藏列）。

---

## 6. 来源与证据

**新版控制台实测**（2026-08-12，共享浏览器只读观察，登录 dwgx1337@outlook.com，
org org_01KZPQ6GSTS0H24ARVQCD8ZNBM）：
- 导航双层：sticky 顶层 44px（logo/组织切换/Docs/用户菜单）+ 非 sticky
  48px tab 条（横滚容器）；tabs = My Activity/Usage/Leaderboard/Models/
  Billing/Members/Keys/Settings；active 仅文字变色（近白 vs 灰 #808080）。
- `console.opencode.ai/org/{org}` My Activity：副标题 + range 选择器 +
  CLI 引导卡 + 3 统计卡（21px）+ Hourly Cost 图表卡 + Request Log 表；
  一屏 746px 内不滚。Usage 页需滚（scrollHeight 1224）。Billing 页最长
  （OVERVIEW 三卡 CURRENT PLAN/RENEWS/TOTAL ORG CREDIT 大数字 + Add people
  20px/600 + Payment methods + Auto-recharge「Off+Edit」+ Add credit + 三个
  空态列表）。Members/Keys 双栏（左表 + 右 Budget limits 卡）。Settings
  子 tab（General/Account/Security，active=背景层+细边框）。
- 移动 375px：顶层 NAV 高 28px；tab 条横滑不收起；统计卡 3 列并排不堆叠。
- 滚动容器是内部 `.scroll-view__viewport`，window 不滚。

**旧版控制台源码**（GitHub anomalyco/opencode，dev 分支，
`packages/console/app/src/`）：
- `routes/workspace/[id].tsx`：nav 7 tabs（Zen/Go/Usage/Keys/Members/
  Billing/Settings）纯文字无图标；active = 700 字重 + 桌面左缘 2px 竖条/
  移动底部 2px 横条，无彩色 accent。
- 布局：workspace-container flex + 左侧导航 240px 贴右缘 + 内容区
  max-width 64rem，滚动容器 `calc(100vh - 73px)`。
- `billing/index.tsx` 6 sections（Black/Billing/Redeem/Reload/MonthlyLimit/
  Payment）；section 标题 h2 15px/600 + 描述行 muted；sections gap 64px +
  border-bottom 分隔。
- 卡片 `1px border + 3px radius + 16px padding`；表格 th uppercase 13px
  muted / td 13px mono / padding 12×16 / border-muted 行分隔 / 无斑马纹；
  表单 label 上 13px/500 muted、input 8×12 padding、focus accent ring 3px；
  按钮 12×16 padding 13px/500、primary accent 白字、active 下移 1px。
- **无 details/accordion**：展开项 = store.show 条件渲染的内联表单，
  提交后收起；无进度条、无 badge，状态 = 文本 + `<b>`；月限额为文本行
  `$X used in <Month>.`；空态 dashed border 居中；断点 48/40/30rem，
  ≤48rem 侧栏变顶部横滚 tab 条（两套 nav DOM）。
- 设计令牌（dark）：bg #0c0c0e / surface #161618 / elevated #1c1c1f /
  text #fff / secondary #c7c7cc / muted #a1a1a6 / border #38383a /
  border-muted #2c2c2e / accent #007aff / danger #ff453a / success #30d158
  —— 与面板现有 `:root` 令牌逐项一致（admin.ts:796-817）。

**new-api**（GitHub QuantumNous/new-api，TanStack Router + Tailwind +
shadcn/ui）：DataTablePage 默认 20 行/页 + `fixedHeight` 表内滚动表头
sticky + 分页 PageFooterPortal 钉页脚；筛选 toolbar 状态进 URL；长表单
= 全宽抽屉 + 左侧 6 分区锚点导航（未配置/完成/错误状态灯可点跳转）；
<640px 表格换卡片列表。路径：`web/src/components/data-table/layout/
data-table-page.tsx`、`features/channels/components/drawers/
channel-mutate-drawer.tsx`。

**one-api**：每页 10 行无限加载；default 主题渠道编辑为整页长表单无分组
（反面教材，佐证长表单必须分组）。

## 7. 不做的事

- 不引入锚点分区导航组件（§1.7）。
- 不引入 `<details>`/accordion/chevron 折叠（§2.5）。
- 不改 CSS 令牌（已与 opencode 一致）。
- 不新建数据端点（纯前端重组）。
- 不做移动端卡片列表重排（先隐藏列，§5）。
- 不把 iframe 嵌进控制台页面（CONSOLE-PORT.md §5.4 已否决）。
