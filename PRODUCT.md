# PRODUCT.md — Mile Console 产品文档

> 面向新成员、AI 协作者与项目评审的产品全景。
> 权威来源：`../../docs/PRD.md`（原版需求、决策理由、实测数据）与 `../../mile-terminal-management/`（原版实现）。
> 本文件讲「产品是什么」；「在这个目录里怎么干活」见 `CLAUDE.md`，「长什么样」见 `DESIGN.md`。
>
> 版本：1.0.0 | 平台：Windows 11 | 最后更新：2026-11-15

---

## 一、产品定位

**Mile Console** 是 Mile Terminal 的 mygo 重写版：同一个产品，换一套运行时（Go 后端 + 系统 WebView2 页面），产品行为、界面与布局与原版一比一对等。

核心价值主张不变：把「本机现在跑着什么」和「我常跑的那几个项目」收口进一个桌面应用——查监听端口、集中启停服务与批处理任务、跨会话聚合日志、启动前诊断。

**定位边界**：

- 个人自用，不做多用户、不做远程、不做公网面板
- 只管理本机本用户可操控的进程
- 不替代终端，增强对项目进程的感知与控制

**为什么重写**：Electron 版把 node-pty、pidusage、nativeImage 等原生能力压在 Node 侧，安装包与内存占用偏大；mygo 用 Go 承担业务与原生能力、页面只做展示，运行时分得更干净，也顺手把平台适配层从 TypeScript 收敛到 Go 一处。

---

## 二、目标用户

在 Windows 上同时维护多个本地 Web 项目（前端开发服务器、Node / Python / Spring Boot 后端、批处理任务）的全栈开发者或前端工程师：

- 每天频繁启动、停止、切换多个本地服务
- 需要快速定位是哪个进程占了某个端口
- 需要在不打开多个终端窗口的情况下查看各服务输出
- 希望设置依赖顺序、在启动前做完整性检查

---

## 三、六个页面

导航轨 6 项，`Ctrl+1–6` 直接切换。

| 页面 | 核心功能 |
| --- | --- |
| **总览** | 统计磁贴、最近 5 个服务快速启停、顶部待办条（端口冲突 / 预检失败 / 异常退出）、每 2 秒刷新的监听端口表 |
| **服务** | 按工作组分段管理前端服务、后端服务与批处理任务；右侧分栏详情（概览 / 输出 / 诊断 / 构建 / 配置）；依赖启动顺序；整组启停 |
| **进度** | 每个工作组一块看板磁贴，点开是「任务 / 日程 / 概况」三标签；任务支持待办 / 进行中 / 已完成；日程支持重复规则、提前通知、关联服务；错过的提醒下次启动汇总 |
| **终端** | 自建 PowerShell 会话与服务会话；「全部输出」跨会话聚合日志（内存，最多 5000 行） |
| **设置** | 采集周期、外观、终端、退出行为、通知、全局快捷键（`Ctrl+Alt+M`）、配置导入导出 |
| **关于** | 版本、教程、快捷键一览（`?` 触发浮层）、项目仓库与 Issue 入口 |

实时动态（启停事件、预检告警、健康检查）收在标题栏抽屉里，不打断主视图。

---

## 四、四条设计原则

来自原版需求原文，不可协商，贯穿所有功能。

### 1. 不安装依赖、不执行项目代码

- 识别框架只读文件（`package.json` / 锁文件 / 标记文件），不跑任何命令（连 `node -v`、`go list`、`pip show` 都不跑）
- 缺少 `node_modules` 时报预检 fail + 给用户「创建安装会话」入口，绝不自动 `npm install`
- 原因：`npm install` 会执行 `postinstall` 脚本 = 执行任意代码

### 2. 不因端口相同就杀外部进程

- 能否终止只认 **运行 token + 进程组 + 当前用户** 三重凭据
- kill 前用 ≤3 秒新鲜的进程表重新验证归属（防 PID 复用）
- 启动来源、分组名、进程名只用于展示，**绝不参与 kill 授权**

### 3. 命令只走 `exec.Command(file, args...)` 数组形式

- 永不把用户输入拼进 shell 字符串
- 脚本名必须来自目标项目 `package.json` 的 `scripts` 键，且启动前重读磁盘确认
- 工作目录必须是已注册条目的路径或其子路径

### 4. 日志只在内存，不落盘

- 会话输出、崩溃现场、诊断信息全部只留内存（环形缓冲）
- 配置保存在 `%APPDATA%\mile-console\config.json`，不含任何日志内容
- 环境变量的**值**不出 Go 进程（返回给页面的 `env` 只有键名）

---

## 五、架构概览

```
Go 进程（main.go）
  │
  ├── 绑定服务（mygo.Bind，按值绑定）
  │     EntryService       条目 CRUD、启动/停止、运行态、构建
  │     GroupService       工作组 CRUD 与排序
  │     PlannerService     看板与日程提醒
  │     SessionService     ConPTY 会话，16ms 合并刷新
  │     ScannerService     每 2s 采集端口 / CPU / 内存 / 时长
  │     OwnershipService   运行 token + 进程组 + 用户三重判定
  │     DetectService      识别框架 / 包管理器 / 脚本（只读文件）
  │     PrecheckService    启动前静态检查（只读，不写不安装）
  │     LogService         跨会话日志聚合，只在内存
  │     ConfigStore        配置读写、版本迁移、原子写
  │     Settings / Theme / Dialog / Shell / Clipboard / Window / App
  │
  ├── 事件（mygo.NewEvent，就绪握手后才投递）
  │     entryChanged / entryRuntimeChanged / entryHealth / entryAlert
  │     scannerDiff / sessionExit / plannerChanged / plannerReminder
  │     settingsChanged / themeChanged / windowMaximizeChanged
  │
  └── 原生能力（mygo）
        窗口（TitleBarHidden）、托盘、通知、全局快捷键、深浅外观

页面（WebView2，React 19 + zustand + Tailwind 4）
  只做展示与交互：不构造命令、不拿运行 token、不读环境变量的值
  唯一后端入口是 src/lib/mile.ts（与原版 window.mile.* 同形）
```

**技术栈**：

| 层次 | 技术 |
| --- | --- |
| 桌面框架 | egoist/mygo v0.8.3（Go + WebView2） |
| 后端语言 | Go 1.27.3 |
| 前端框架 | React 19 + zustand 5 |
| 样式 | Tailwind 4 + CSS 变量设计令牌 |
| 终端 | Go ConPTY（后端）+ xterm.js 6（页面） |
| 构建 | Vite 8 + TypeScript 7（页面）、`mygo build`（安装包） |
| 打包 | NSIS（`mygo build`） |

---

## 六、数据存储

新版数据目录与原版**分开**，不写 `%APPDATA%\mile-terminal\`。

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 条目、工作组、偏好 | `%APPDATA%\mile-console\config.json` | `CONFIG_VERSION = 16`，`.bak` 轮转，字段与原版一致 |
| 进度数据 | `%APPDATA%\mile-console\planner.json` | `PLANNER_VERSION = 1`，独立于 config |
| 窗口状态 | `%APPDATA%\mile-console\window-state.json` | 写坏了不影响条目配置 |
| 自定义图片 | `%APPDATA%\mile-console\images\` | 压缩后按哈希命名 |
| 日志 / 崩溃现场 | 内存（环形缓冲） | 不落盘，重启后消失 |

首次启动提供「从 Mile Terminal 导入」：只读旧目录的 `config.json` / `planner.json`，导入前另存备份，不修改旧文件。导出文件格式 `mile-terminal-export` v1 与原版互通。

---

## 七、安全模型

| 边界 | 约束 |
| --- | --- |
| 外链 | 只有两条：`OpenLocalhost(port)`（只收整数端口）、`OpenProjectLink(key)`（只收固定键名，URL 写死） |
| 顶层导航 | WebView 离开当前页一律拦截（`OnWillNavigate` + `PreventDefault`） |
| 路径开放 | `OpenPath` 只放行白名单：最近快照里监听进程的 cwd，或条目 cwd / 合法 outputDir |
| 环境变量 | 值只在 Go 进程，返回页面时经 `redactEntry` 只留键名 |
| 进程终止 | 必须通过归属三重判定，kill 前重验 PID 归属 |
| 绑定入参 | 全部经 `sanitize*` 校形，白名单外的键静默丢弃，非法值抛错且不落盘 |
| 导入导出 | 文件路径只能来自 `mygo.Dialog` 刚返回的结果，不接受页面传入 |
| 单实例 | 打包后启用，第二实例直接退出并把第一个窗口带回前台 |

---

## 八、验证体系

原版没有单元测试框架；新版按两层拆：

| 层 | 方式 | 覆盖 |
| --- | --- | --- |
| Go 纯逻辑 | `go test ./...` | 归属判定、semver 子集、ANSI / `\r` 切行、端口捕获正则、planner 触发计算、各 `sanitize*`、配置迁移链、原子写与 `.bak` 恢复 |
| 真实窗口 | `scripts/cdp-*.mjs`（CDP over WebView2） | 布局与令牌、交互、按压动画、视图切换、终端、浮层 |

- Go 单测的期望值由原版代码生成，做对拍，不凭印象写。
- 界面断言读 `getComputedStyle` / `getBoundingClientRect`，不靠截图。
- 按压动画必须走真实输入（CDP `Input.dispatchMouseEvent`），`element.click()` 触发不了 `:active`。
- 关窗取消、退出清理、PID 复用防护用日志证据。
- 托盘、单实例、全局快捷键、通知点击、深浅切换在真窗口人工过一遍。

```bash
go test ./...
bun run typecheck
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" bun run dev
bun run scripts/cdp-verify.mjs
```

---

## 九、开发命令速查

```bash
bun install              # 安装页面依赖
bun run dev              # mygo dev：Vite + 窗口 + Go 热重编
bun run generate         # 改过绑定后重新生成 src/mygo.ts
bun run typecheck        # tsc --noEmit
bun run build            # mygo build：NSIS 安装包 + exe
go test ./...            # Go 纯逻辑单测
go vet ./...
```

---

## 十、迁移进度与相关文档

| 阶段 | 状态 |
| --- | --- |
| M0 脚手架与文档基线 | 进行中 |
| M1 配置存储与条目 CRUD | 未开始 |
| M2 扫描与进程归属 | 未开始 |
| M3 会话与终端 | 未开始 |
| M4 前端渲染层搬迁 | 未开始 |
| M5 原生集成（托盘 / 通知 / 快捷键） | 未开始 |

详细里程碑、验收口径、待决策项与已接受偏差见 `docs/MIGRATION-PLAN.md`。

| 文档 | 位置 | 说明 |
| --- | --- | --- |
| 原版 PRD（需求与决策权威） | `../../docs/PRD.md` | 功能决策、约束、实测记录 |
| 原版实现 | `../../mile-terminal-management/` | 行为与界面的唯一基准 |
| 开发约定 | `CLAUDE.md`（本目录） | 命令、安全红线、迁移纪律、验证纪律 |
| 设计令牌与布局 | `DESIGN.md`（本目录） | 色彩、字体、动效、页面规格 |
| 绑定契约 | `docs/BINDINGS-CONTRACT.md` | Go 绑定、事件、Channel 与前端适配层 |
| 迁移计划 | `docs/MIGRATION-PLAN.md` | 里程碑、验收、待决策、已知问题 |
