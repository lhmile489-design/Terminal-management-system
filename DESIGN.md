# DESIGN.md — Mile Console 设计令牌与布局规格

> 本文件是 `mygo/console` 的设计单一来源（SoT）。
> 基准是原版 `../../mile-terminal-management/DESIGN.md` 与 `src/renderer/src/styles/tokens.css`（v2.5.1）。
> **行为与界面一比一对等**：本文件只登记 mygo 版必须偏离的部分（§13），其余照抄。
> 令牌值改动时同步本文件与 `src/renderer/src/styles/tokens.css`，否则视为文档漂移。
>
> 最后同步：2026-11-14（迁移 M0 文档基线）

---

## 1. 风格定位

冷调中性的 Ops 工具界面：便当网格 + 微交互。浅色为石板蓝调（页面浅灰底、磁贴纯白、品牌蓝主按钮），深色靠表面逐级变亮 + 1px 描边建立层次。

约束来自 Ops 场景本身：

- 信息密度高，字号下限 12px，正文 14px。
- 状态色只用于表达「运行 / 警告 / 故障 / 信息」，不参与装饰。
- 全应用不使用渐变底色，品牌标识直接铺 logo 图。
- 深色模式是刚需（长时间盯端口表和终端），但不是设计主战场：先保证不劣于浅色基线。

---

## 2. 主题机制

主题由 `<html data-theme="light|dark">` 驱动，**不跟随 `prefers-color-scheme`**。解析职责在 Go 侧（`mygo.Theme`），页面只认属性值。

| 偏好 | Go 侧解析结果 | 页面属性 |
| --- | --- | --- |
| `light` | 强制浅色 | `data-theme="light"` |
| `dark` | 强制深色 | `data-theme="dark"` |
| `system` | 跟随系统外观 | 按系统解析为 light / dark |

两套主题覆盖**同一组变量名**，切换不重建样式。`color-scheme` 同步声明，滚动条与原生控件跟随。

首帧防闪：`index.html` 内联一段极小的预绘制脚本，在 React 挂载前写入 `data-theme`；窗口 `BackgroundColor` 用 `light-dark(<浅画布>, <深画布>)` 与页面底色对齐。

---

## 3. 色彩令牌

### 3.1 浅色主题（石板蓝调 v1.7）

#### 表面层次

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--surface-canvas` | `#f6f7fb` | 页面底色（NavRail 外全屏底） |
| `--surface-panel` | `#ffffff` | 面板、侧边分栏底 |
| `--surface-card` | `#ffffff` | 磁贴卡片底 |
| `--surface-raised` | `#eef1f6` | 分段控件底、悬停高亮底 |
| `--surface-sunken` | `#f1f3f8` | 磁贴内凹陷块（迷你统计、诊断项） |

#### 描边

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--stroke-base` | `#e3e7ee` | 卡片、分割线默认描边 |
| `--stroke-strong` | `#cbd2dd` | 分段控件选中描边、悬停强化描边 |

#### 文字层次（白底对比度 16 / 12.7 / 7.8 / 5.7）

| 令牌 | 值 | 对比度 | 用途 |
| --- | --- | --- | --- |
| `--text-primary` | `#2b3142` | 16:1 | 正文、标签、表单文字 |
| `--text-strong` | `#1b1f2e` | 12.7:1 | 标题、数字、强调 |
| `--text-muted` | `#4c5265` | 7.8:1 | 次要文字、辅助说明 |
| `--text-faint` | `#5f6678` | 5.7:1 | 占位符、时间戳（最弱一档） |
| `--text-inverse` | `#ffffff` | — | 深色底上的文字 |
| `--text-on-ink` | `#ffffff` | — | `ink-strong` 作底时的前景 |

> **硬规则**：文字色禁止再叠透明度（`text-ink-faint/50` 这类写法一律禁止）。

#### 信号色（白底均 ≥ 5:1）

| 令牌 | 值 | 语义 |
| --- | --- | --- |
| `--signal-live` | `#15803d` | 运行中 |
| `--signal-warn` | `#92400e` | 警告 |
| `--signal-fault` | `#b91c1c` | 错误 / 故障 |
| `--signal-info` | `#1d4ed8` | 信息 |
| `--signal-idle` | `#6b7280` | 空闲 / 停止 |
| `--signal-live-soft` | `#dcfce7` | 运行中柔和底 |
| `--signal-warn-soft` | `#fef3c7` | 警告柔和底 |
| `--signal-fault-soft` | `#fee2e2` | 错误柔和底 |
| `--signal-info-soft` | `#dbeafe` | 信息柔和底 |

#### Accent 与主按钮

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--signal-accent` | `#2563eb` | 区块标签、端口号、选中态、链接 |
| `--signal-accent-soft` | `#e3ecff` | Accent 柔和底 |
| `--signal-on-accent` | `#ffffff` | Accent 底上的文字 |
| `--btn-primary-bg` | `#2563eb` | 主按钮底 |
| `--btn-primary-bg-hover` | `#1d4ed8` | 悬停（往深走） |
| `--btn-primary-bg-active` | `#1e40af` | 按下再深一档 |
| `--btn-primary-fg` | `#ffffff` | 主按钮文字（5.2:1） |
| `--btn-primary-border` | `transparent` | 主按钮描边 |

#### 阴影三档

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--shadow-lift` | `0 4px 14px rgb(20 28 48 / 0.07)` | 卡片静止态 |
| `--shadow-lift-lg` | `0 8px 22px rgb(20 28 48 / 0.12)` | 卡片悬停态 |
| `--shadow-float-raw` | `0 16px 40px rgb(20 28 48 / 0.16)` | 浮层（命令面板、对话框） |

### 3.2 深色主题

层次靠表面逐级变亮 + 1px 描边，前两档阴影置空。

| 令牌 | 值 |
| --- | --- |
| `--surface-canvas` | `#0f1219` |
| `--surface-panel` | `#151a23` |
| `--surface-card` | `#1b212c` |
| `--surface-raised` | `#232a37` |
| `--surface-sunken` | `#171c26` |
| `--stroke-base` | `#2a3240` |
| `--stroke-strong` | `#3a4556` |
| `--text-primary` | `#e4e8f0` |
| `--text-strong` | `#f1f4f9` |
| `--text-muted` | `#a3acbc` |
| `--text-faint` | `#9aa4b5` |
| `--text-inverse` | `#0f1219` |
| `--text-on-ink` | `#0f1219` |
| `--signal-live` | `#4ade80` |
| `--signal-warn` | `#fbbf24` |
| `--signal-fault` | `#f87171` |
| `--signal-info` | `#7aa7ff` |
| `--signal-idle` | `#8a94a6` |
| `--signal-accent` | `#7aa7ff` |
| `--signal-on-accent` | `#0f1219` |
| `--shadow-lift` | `0 0 0 transparent` |
| `--shadow-lift-lg` | `0 0 0 transparent` |
| `--shadow-float-raw` | `0 16px 40px rgb(0 0 0 / 0.45)` |

深色 soft 底用 `color-mix(in srgb, <base> 15%, #1b212c)` 混成不透明色，避免叠在不同底上颜色不一。主按钮两套主题同为品牌蓝底白字；悬停往深走不往亮走（`#3b74f0` 上白字只有 4.25:1，实测踩过）。

---

## 4. 字体与字阶

| 令牌 | 字体栈 | 用途 |
| --- | --- | --- |
| `--font-sans` | `'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', -apple-system, 'PingFang SC', system-ui, sans-serif` | 正文、表单、标签（默认） |
| `--font-display` | `'Manrope', 'Segoe UI Variable Display', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif` | 标题、数字、品牌 |
| `--font-mono` | `'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', Menlo, ui-monospace, monospace` | 端口号、路径、终端输出、代码 |

- Manrope 只随包携带 latin 子集（`@fontsource/manrope` 600/700/800），无中文字形，自然回落雅黑。
- **字号下限 12px**（源码扫描强制）。正文 14px / 行高 1.6。
- 页面标题 `clamp(22px, 2.4vw, 30px)`，行高 1.15，字重 700，`--font-display`。
- eyebrow 标签 12px / 13px（`--eyebrow-tight`），字重 600，字距 0.14em，大写。

---

## 5. 圆角、间距、模糊

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--radius-card` | `16px` | 磁贴、服务卡片、对话框 |
| `--radius-control` | `10px` | 按钮、输入框、小控件 |
| `--radius-pill` | `999px` | 胶囊标签、状态徽标 |

> 不用任意值圆角（`rounded-[Npx]`）。图片按自身尺寸算比例圆角时写在 inline style。

间距走 4px 格栅，可用值：4 / 8 / 12 / 16 / 24 / 32 / 48 / 64。不使用格栅外的 13px、7px 这类值。

高斯模糊**只允许固定 / 粘性层**（z-50 遮罩、命令面板、浮层），绝不用于滚动容器。

| 类名 | 参数 | 用途 |
| --- | --- | --- |
| `.scrim-frosted` | `blur(8px) saturate(160%)` | 命令面板全屏遮罩 |
| `.surface-frosted` | `blur(20px) saturate(180%)` | 命令面板 / 浮层卡片容器 |

---

## 6. 动效

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹起、slide-in、松手回弹（轻微过冲） |
| `--ease-out` | `cubic-bezier(0.32, 0.72, 0.32, 1)` | 颜色、边框、透明度渐变 |

| 场景 | 曲线 | 时长 |
| --- | --- | --- |
| 按下瞬动（`:active`） | `cubic-bezier(0.55, 0, 1, 0.45)` | 70ms（`scale(0.96)`） |
| 颜色 / 透明度 | `--ease-out` | 150–200ms |
| 弹起 / slide-in | `--ease-spring` | 200–400ms |
| 卡片 hover lift | `--ease-spring` | 400ms |
| 命令面板入场 | `--ease-spring` | 260ms |
| 视图切换 `.view-enter` | `--ease-spring` | 260ms |
| 列表项 `.item-enter` | `--ease-spring` | 220ms |

规则：

- 按下永远用快速曲线（`transform` 70ms），松手回 spring。`:active` 的 `transition` 简写里必须把 `background-color / border-color / color / box-shadow / transform` 写全。
- `tokens.css` 与 `ui.css` **都没有 `@layer`**，transition 简写会盖过 Tailwind 的 `transition-colors`。
- `:active` 写在 `:hover` 之后；`prefers-reduced-motion` 覆盖块排在所有 `:active` 之后，选择器同样长。
- 动效只用 `transform` 与 `opacity`，不动 `top/left/width/height`。

---

## 7. 窗口与布局骨架

### 7.1 窗口

| 项 | 值 |
| --- | --- |
| 默认尺寸 | 1440 × 900 |
| 最小尺寸 | 1180 × 760 |
| 标题栏高度 | 40px |
| 窗口控件 | 3 个，每个 46 × 40 |
| 背景色 | `light-dark(#f6f7fb, #0f1219)`，与画布令牌一致 |

窗口位置与尺寸记在 `%APPDATA%\mile-console\window-state.json`；坐标不在任何屏幕工作区内时丢弃并居中。保存时与上次值差 8px 以内视为没变（缩放不是 100% 时同尺寸会漂移几像素）。

### 7.2 整页骨架

```
┌──────────────────────────────────────────────────────────┐
│ TitleBar 40px   品牌 · 搜索入口 · 实时动态 · 窗口控件      │
├──────────┬───────────────────────────────────────────────┤
│ NavRail  │ ViewHeader  标题 + 说明 + 页内操作             │
│ 184/56px ├───────────────────────────────────────────────┤
│          │ 视图内容（唯一滚动区）                         │
└──────────┴───────────────────────────────────────────────┘
```

- 主体 `display:flex; height:100dvh`，每一层 `min-height:0`；**整窗不出现滚动条**，滚动只发生在视图自己的滚动区。
- NavRail 展开 184px、折叠 56px；折叠状态记在 localStorage。
- 标题栏整条是拖拽区（`--app-region: drag`），可点元素逐个 `no-drag`。
- 不做顶部视图切换器；页内口径切换用 `Segmented`。

### 7.3 标题栏

从左到右：品牌（logo 22px、圆角 6px + 名称 13px `--font-display` 600）· 搜索触发器（`margin: 0 auto`，带 `Ctrl K` 键帽）· 实时动态按钮（带未读角标，失败类变红）· 窗口控件。

窗口控件：最小化 / 最大化（还原）/ 关闭。**贴窗口边缘的面只换底色，不做缩放位移。**

### 7.4 导航轨

6 项一级导航，`Ctrl+1–6` 直接切换：

| 序号 | 标签 | 图标（Phosphor） |
| --- | --- | --- |
| 1 | 总览 | `Monitor` |
| 2 | 服务 | 自绘方块组 |
| 3 | 进度 | 看板 |
| 4 | 终端 | 终端窗口 |
| 5 | 设置 | 齿轮 |
| 6 | 关于 | 信息圆 |

指示线滑入用 `.tooltip-enter` 同款 spring 220ms；折叠态只留图标，悬停出 tooltip（必须带 `aria-label`）。

---

## 8. 页面规格

### 8.1 总览

| 区块 | 规格 |
| --- | --- |
| KPI 概览卡 | 6 张，`grid-template-columns: repeat(4, minmax(0,1fr))`，间距 16px；首张「我的服务」`grid-column: span 2`；窄容器 2 列、更窄 1 列（容器查询 34rem） |
| 待办条 | 端口冲突 / 预检失败 / 异常退出，胶囊行；无待办时不占位 |
| 最近服务 | 5 张卡片，快速启停；卡片 2×1 磁贴 |
| 监听端口表 | 每 2s 刷新；列：端口 / 进程 / PID / 地址 / 归属 / 操作 |
| 底部 | 空状态：说明文字 + 「添加服务」主按钮 |

### 8.2 服务

| 区块 | 规格 |
| --- | --- |
| 工具栏 | 搜索框 + 分组筛选 `Segmented` + 两个入口（添加服务 / 添加任务） |
| 列表 | 按工作组纵向分段；组头可折叠（chevron 旋转 200ms spring），带组级启停与排序 |
| 行 | 图标 28px · 名称 · 框架徽章 · 端口 · 状态胶囊 · 行内操作 |
| 右侧分栏 | 选中行后打开；列表宽默认 360px、可拖 300–560px，详情占剩余；标签：概览 / 输出 / 诊断 / 构建 / 配置 |
| 空状态 | 工作组内无条目：虚线卡片 + 两个添加入口 |

分栏用 `SplitPane`：拖拽命中带宽 16px，中间一条 2px 竖线（悬停 / 拖拽时显形）；详情最大化时改为绝对定位覆盖列表。

### 8.3 终端

| 区块 | 规格 |
| --- | --- |
| 左侧会话列表 | 自建 PowerShell 会话 + 服务会话；当前会话高亮；停止按钮 |
| 主区 | xterm.js 6，`--font-mono` 13px / 行高 1.5（字号跟随设置项 `terminalFontSize`） |
| 全部输出 | 跨会话聚合，环形缓冲 5000 行；筛选：级别 / 会话 / 关键词 |
| 空状态 | 「新建会话」主按钮 + 说明 |

xterm 主题取 §11 的调色板，随 `data-theme` 切换时重建主题对象（不改 DOM 结构）。

### 8.4 进度

每个工作组一块看板磁贴；选中后打开详情，按「任务 / 日程 / 概况」三个标签组织，**不是三列看板**。

| 区块 | 规格 |
| --- | --- |
| 看板网格 | `repeat(2, minmax(0,1fr))`，间距 16px；容器宽 < 56rem 或详情打开时塌成一列 |
| 看板磁贴 | 组名 + 进度条（只动 `scaleX`）+ 今日到期 / 过期 / 提醒计数 + 任务计数胶囊；选中态 `0 0 0 2px --btn-primary-bg` 外环 |
| 详情标签 | 任务 / 日程 / 概况（`Tabs`，任务标签带未完成数角标） |
| 任务列表 | `Segmented` 筛选：全部 / 待办+进行中 / 已完成；行高 44px，状态标签「进行中」用 info 色 |
| 日程 | 日程列表 + 重复规则 + 提前通知；到点由 Go 侧推送提醒 |
| 错过的提醒 | 顶部汇总条，可逐条忽略或一键清空 |
| 拖拽 | 同列表内重排，插入位置用 `before` / `after` 指示线；拖拽中行底 `--surface-sunken` |

### 8.5 设置

分组磁贴两列网格（`repeat(2, minmax(0,1fr))`，间距 16px，容器宽 < 44rem 塌成一列）：

| 分组 | 内容 |
| --- | --- |
| 采集 | 采集周期（2s / 5s / 10s） |
| 外观 | 主题（浅色 / 深色 / 跟随系统）、导航轨折叠 |
| 终端 | 默认 shell、外部终端、字号 |
| 退出 | 退出时结束自有进程、关闭询问 |
| 通知 | 崩溃通知、仅后台时通知、日程提醒与声音 |
| 快捷键 | 全局快捷键开关（`Ctrl+Alt+M`） |
| 配置 | 导出 / 导入，显示上次导入备份文件名 |

行内边距 12px 0，左标签右控件，分隔线 `--stroke-base`；磁贴标题 15px `--font-display` 700。

### 8.6 关于

| 区块 | 规格 |
| --- | --- |
| 品牌区 | logo 56px（圆角 14px）+ 名称 22px / 800 + 版本（`--font-mono`） |
| 教程 | 三条起步说明 + 快捷键一览入口（`?`） |
| 外链 | 项目仓库 / Issue，只有这两个键 |

---

## 9. 组件规范

### 9.1 按钮 `.ui-btn`

| 变体 | 底 | 文字 | 悬停 |
| --- | --- | --- | --- |
| `primary` | `--btn-primary-bg` | `--btn-primary-fg` | `--btn-primary-bg-hover` |
| `secondary` | `--surface-card` + `--stroke-base` | `--text-primary` | `--surface-raised` |
| `ghost` | 透明 | `--text-muted` | `--surface-raised` |
| `danger` | `--ui-danger-bg` | `#fff` | 深一档 |

- 高度：默认 32px，`data-size="sm"` 28px；圆角 `--radius-control`，内边距 0 12px，字号 13px / 600。
- 主操作必须「图标 + 文字」；纯图标按钮用 `.ui-iconbtn`（32×32）并带 `aria-label`。
- 按下缩到 0.96（70ms），松开 spring 回弹，**不下沉**。
- 禁用态不压 `opacity`：弱化底色 + 可见描边，保证文字可读。

### 9.2 磁贴 `.ui-tile` / 卡片

- 圆角 `--radius-card`，底 `--surface-card`，描边 `--stroke-base`，静止 `--shadow-lift`。
- 仅 `data-interactive="true"` 的卡片有悬停：`translateY(-1px)` + `--shadow-lift-lg`。
- **卡片不叠 border + shadow 两套装饰**：浅色用阴影，深色用描边（阴影已置空）。
- 状态色只染描边、图标块和胶囊，不染卡片底。

### 9.3 分段控件 `.ui-segmented`

容器 `--surface-raised`、内边距 3px、间距 2px、圆角 `--radius-control`；按钮高 28px、内边距 0 12px、圆角 8px、13px / 600；选中项 `--surface-card` + `--stroke-strong` 描边 + `--shadow-lift`；按下 `scale(0.96)` 70ms。

### 9.4 胶囊 `.ui-pill`

`--radius-pill`，高 22px，内边距 0 9px，字号 12px / 600。状态胶囊：底色由信号色混入 28% 表面色，文字 `color-mix(<信号色> 72%, --text-strong)`，同色 1px 描边 —— 深浅两套主题都 ≥ 5:1。

### 9.5 输入与表单

高 32px，内边距 0 10px，字号 13px，圆角 `--radius-control`，底 `--surface-card`，描边 `--stroke-strong`；聚焦描边 `--signal-accent` + 3px `--signal-accent-soft` 环。错误态描边 `--signal-fault`，说明文字 12px。

### 9.6 表格（监听端口）

行内边距 10px 16px，行间 1px 分隔线（不用斑马纹底色）；表头 12px `--font-mono` 600、大写、字距 0.12em、`--text-faint`；端口与 PID 用 `--font-mono`；数字列右对齐。

### 9.7 空状态

居中，图标 32px muted + 标题 16px + 说明 13px muted + 主按钮。**禁止用插图占位。**

---

## 10. 浮层与键盘

| 浮层 | 规格 |
| --- | --- |
| 命令面板 | 宽 560px、最大高 64vh、距顶 12vh；`.cmd-scrim` 淡入 180ms，`.cmd-dialog` spring 落下 260ms（`translateY(-10px) scale(0.97)` → 原位） |
| 对话框 | `.surface-frosted`，圆角 `--radius-card`，`--shadow-float-raw` |
| 抽屉（实时动态） | 右侧，默认宽 360px，顶部从 40px 起；220ms `--ease-out` 滑入；底为画布色 88% + `blur(18px)` |
| Toast | 右下角 16px，宽 340px，堆叠间距 8px，圆角 14px，200ms spring 入场，4s 自动消失 |

浮层统一走一个栈：`Esc` 只关最上层，焦点陷阱，关闭后焦点回到打开它的元素。危险操作用应用内 `confirm()`，**不用 `window.confirm`**。

键盘：

| 键 | 行为 |
| --- | --- |
| `Ctrl+1–6` | 切页 |
| `Ctrl+K` | 命令面板 |
| `?` | 快捷键一览 |
| `Ctrl+Alt+M` | 全局唤回 + 打开命令面板（Go 侧注册） |
| 方向键 / `Enter` / `Space` | 服务列表导航与启停 |
| `Ctrl+↑↓` | 列表内重排 |
| `Ctrl+Tab` | 服务间切换 |

焦点在输入框或终端里时，单键快捷键不生效。

---

## 11. 终端主题（xterm.js）

xterm 只接受 `#RRGGBB`，这些值**不能**用 CSS 变量，随主题切换时重建主题对象。

| 键 | 浅色 | 深色 |
| --- | --- | --- |
| background | `#ffffff` | `#0f1419` |
| foreground | `#3d4653` | `#c9d3e0` |
| cursor | `#161b22` | `#f0f4f9` |
| selectionBackground | `#d8e6f7` | `#264166` |
| black | `#3d4653` | `#484f58` |
| red | `#c93c37` | `#f85149` |
| green | `#1a7f37` | `#3fb950` |
| yellow | `#8a6100` | `#d29922` |
| blue | `#0a5aa8` | `#58a6ff` |
| magenta | `#8250df` | `#bc8cff` |
| cyan | `#1b7c83` | `#39c5cf` |
| white | `#6b7684` | `#b1bac4` |
| brightBlack | `#9aa4b2` | `#6e7b8c` |

搜索命中高亮：

| 键 | 浅色 | 深色 |
| --- | --- | --- |
| matchBackground | `#fff1b8` | `#4d3d0f` |
| matchOverviewRuler | `#d4a72c` | `#d29922` |
| activeMatchBackground | `#ffc94d` | `#8a6a12` |
| activeMatchColorOverviewRuler | `#b07800` | `#f0c040` |

容器底与内边距用 `--terminal-bg`（浅 `#ffffff` / 深 `#0f1419`），滚动条滑块 `--scroll-thumb`（浅 `#c1c8d2` / 深 `#303c4d`）。

---

## 12. 图标

图标库：**Phosphor Icons**（`@phosphor-icons/react`），另加原项目自绘 SVG（导航轨、品牌）。

- 只有 16px 与 20px 两档（`size={16}` / `size={20}`）。
- 含义 → 图标对照在 `src/renderer/src/lib/icons.ts`。
- 主操作按钮必须「图标 + 文字」；纯图标按钮必须有 `aria-label`。
- **禁止 emoji 充当图标**（源码扫描强制）。

---

## 13. mygo 版必须偏离的地方

| 项 | 原版（Electron） | mygo 版 | 理由 |
| --- | --- | --- | --- |
| 拖拽区 | `-webkit-app-region: drag` | `--app-region: drag` / `no-drag` | WebView2 不认 Electron 私有属性 |
| 窗口控件 | 自绘 + IPC | 自绘 + `currentWindow.minimize/toggleMaximize/close` | 保留原视觉，只换调用 |
| 标题栏 | `titleBarStyle: 'hidden'` | `TitleBarStyle: TitleBarHidden` + `HideWindowButtons: true` + `TitleBarHeight: 40` | mygo 无同名选项 |
| 主题 | `nativeTheme.themeSource` | `mygo.Theme.SetSource`，页面仍由 `data-theme` 驱动 | 渲染契约不变 |
| 窗口背景 | `#F6F7F9 / #0B0F14`（与画布有漂移） | `light-dark(#f6f7fb, #0f1219)`，与画布令牌对齐 | 顺手修掉漂移 |
| 终端 | node-pty + xterm | Go ConPTY + xterm（页面内不变） | mygo 终端插件只支持原生 UI |
| 通知 / 托盘 / 快捷键 | Electron API | `mygo.NewNotification` / `NewTray` / `GlobalShortcut` | 样式可能有细微差异，登记为已接受偏差 |

**视觉对等的验收口径**：同一页面、1440×900、同一主题下与原版截图并排比对，差异要么修掉，要么写进 `docs/MIGRATION-PLAN.md` 的「已接受偏差」表。

---

## 14. 可访问性底线

- 正文对比度 ≥ 4.5:1，深浅两套主题分别校验；按钮启用 / 禁用两态都要过。
- 键盘 focus 可见（`*:focus-visible` 3px 品牌蓝环，offset 2px）。
- 状态不能只靠颜色：胶囊带文字，图标带形状差异。
- `prefers-reduced-motion` 下移除位移与缩放，只保留透明度变化。
- 浮层焦点陷阱 + `Esc` 逐层关闭 + 关闭后还焦点。

---

## 15. 反模式（一票否决）

1. 文字色叠透明度、字号低于 12px、任意值圆角。
2. 卡片同时叠 border 与 shadow（浅色二选一，深色只用描边）。
3. 状态色染整块卡片底。
4. 渐变底色（含品牌标识）。
5. 滚动容器上挂 `backdrop-filter`。
6. emoji 充当图标。
7. 整窗出现滚动条，或给滚动区套 `overflow: hidden` 后指望内部 sticky 生效。
8. 用 `window.confirm` / `window.alert`。
9. 硬编码颜色或间距魔法值（一律取令牌）。
10. 在渲染层拼命令、拿运行 token、读环境变量的值。
