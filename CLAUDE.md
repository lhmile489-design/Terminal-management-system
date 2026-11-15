# CLAUDE.md

本目录是 Mile Terminal（Ops 指挥台）的 **mygo 重写版**：把 `../../mile-terminal-management`（Electron 43 + React 19 + node-pty）迁移到 egoist/mygo（Go 后端 + WebView2 页面）。产品行为、界面、布局与原版一比一对等，只换运行时。

本文件讲「在这个目录里怎么干活」。产品是什么见 `PRODUCT.md`，长什么样见 `DESIGN.md`，怎么一步步迁见 `docs/MIGRATION-PLAN.md`，前后端怎么通信见 `docs/BINDINGS-CONTRACT.md`。

---

## 1. 权威顺序

1. 用户当次指令
2. **原项目源码**（`../../mile-terminal-management/src/`）—— 行为与界面的唯一基准。文档与原代码冲突时以原代码为准，并回来修文档。
3. `../../docs/PRD.md`（原版需求、决策理由、实测数据）
4. 本目录 `PRODUCT.md` / `DESIGN.md` / `docs/*.md`
5. mygo skills（`../.claude/skills/`）与 mygo v0.8.3 源码（`<GOPATH>/pkg/mod/github.com/egoist/mygo@v0.8.3/`，文档与源码冲突信源码）

## 2. 边界

- **只在 `mygo/console/` 内读写。** 原项目 `mile-terminal-management/` 只读，作为对照基准，不改、不提交、不 `npm install`。
- 原项目的 `scripts/verify-*.cjs` 可以读来抄断言口径，不在本目录运行。
- 同一台机器上原版 Electron 可能还在跑：开发验证时不要动它的进程、不要写它的 `%APPDATA%\mile-terminal\`（见 §5 数据目录）。

## 3. 命令

```bash
bun install              # 安装前端依赖（本目录自己的，不是原项目的）
bun run dev              # mygo dev：起 Vite + 开窗口，监听 Go 变化重编
bun run generate         # 改过绑定方法/结构体/事件后重新生成 src/mygo.ts
bun run typecheck        # tsc --noEmit
bun run build            # mygo build：NSIS 安装包 + exe
go test ./...            # Go 纯逻辑单测（见 §9）
go vet ./...

# 真实窗口验收（一个终端起窗口，另一个跑脚本）
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" bun run dev
bun run scripts/cdp-verify.mjs
```

bash 里找不到 `go` 时：`export PATH="/c/Program Files/Go/bin:/c/Users/LHmile/go/bin:$PATH"`。

## 4. 安全红线（来自原版需求原文，不可协商）

1. **不安装依赖、不执行项目代码。** 识别项目只读 `package.json` / 锁文件 / 标记文件；连 `node -v`、`go list`、`pip show` 都不跑。PATH 定位只 `stat` 候选文件，不执行。缺 `node_modules` 时预检报 fail，并给「创建安装会话」入口，绝不自动装。
2. **不因端口相同就杀外部进程。** 能否终止只由「运行 token + 进程组 + 当前用户」三重凭据决定（原 `OwnershipService.assertKillable`）。kill 前用 ≤3 秒新鲜的进程表重验归属，防 PID 复用。启动来源、分组名、进程名只用于展示，**绝不参与 kill 授权**。
3. **命令只用 `exec.Command(file, args...)` 数组形式。** 永不把用户输入拼进 shell 字符串。`.cmd` / `.bat` 经 `cmd.exe /d /s /c <file> <args...>` 包装时参数仍是数组。脚本名必须过 `SAFE_SCRIPT` 并且在启动前**重读磁盘** `package.json` 确认存在于 `scripts`。
4. **工作目录必须是已注册条目的路径或其子路径**（`filepath.Rel` 不含 `..`、非绝对、目录真实存在，不回退）。

配套规则：

- 运行 token（`MILE_RUN_TOKEN`）只注入 PTY 环境，**永不出现在绑定返回值、事件、日志里**。
- 环境变量的**值**不出 Go 进程：所有返回给页面的 `LaunchEntry` 都过 `redactEntry`，`env` 只留键名。
- 日志、崩溃现场、诊断只留内存（环形缓冲），不落盘。
- 外链只有两条：`OpenLocalhost(port)`（只收整数端口）和 `OpenProjectLink(key)`（只收 `PROJECT_LINKS` 键名，URL 写死）。WebView 顶层导航离开当前页一律拦截（`OnWillNavigate` + `PreventDefault`）。
- `OpenPath` 只放行白名单：最近一次快照里监听进程的 cwd，或条目 cwd / 合法 outputDir。
- 导入导出的文件路径只能来自 `mygo.Dialog` 刚返回的结果，不接受页面传入的路径。
- 推不出 `<包管理器> run <脚本>` 形状的生态（Hugo、Jekyll、docker-compose 等）只登记名字并标 `registerOnly`，不硬猜命令。

## 5. 迁移纪律

1. **一比一对照。** 每个 Go 文件、每个前端模块在文件头注释写明对应的原文件（如 `// 对应 src/main/services/OwnershipService.ts`）。常量、正则、超时、上限数值从原代码逐字搬，不凭印象写。
2. **不顺手改产品行为。** 发现原版缺陷先记到 `docs/MIGRATION-PLAN.md` 的「已知原版问题」表，等用户决定，不在迁移里静默修。审查报告里的 C2（只读模式静默丢写入）、I1（HBuilderX 路径拼进 cmd）、I2（findFreePort 只测 IPv4）就属于这类。
3. **偏差必须登记。** 因为 mygo 与 Electron 能力不同而做不到完全一致的地方（窗口控件、通知样式、托盘菜单），写进迁移计划的「已接受偏差」表，写明原因和用户可见的差异。
4. **数据目录分开。** 新版用 `%APPDATA%\mile-console\`（`config.json`、`planner.json`、`window-state.json`、`images/`），不写原版的 `%APPDATA%\mile-terminal\`。首次启动提供「从 Mile Terminal 导入」，只读旧文件（CONFIG_VERSION 16 / PLANNER_VERSION 1）。产品名与数据目录最终以用户决定为准，见迁移计划「待决策」。
5. **配置格式兼容。** `config.json` / `planner.json` 字段名、版本号、迁移链与原版保持一致，导出文件格式 `mile-terminal-export` v1 互通。

## 6. mygo 约定

1. 版本锁定 `github.com/egoist/mygo v0.8.3`、`mygo-cli` / `mygo-runtime` `^0.8.3`。三处一起升，否则不升。
2. `src/mygo.ts` 是 `mygo generate` 生成物，不手改；改绑定后重新生成并 `git diff` 核对。
3. 绑定方法第一个参数放 `context.Context`；所有外部命令、HTTP 探测、文件 I/O 从它派生，**禁止 `context.Background()`**（后台常驻任务用 App 生命周期 ctx）。
4. 绑定按值绑定（`mygo.Bind(EntryService{})`），服务结构体不放状态，状态放 `internal/` 包级单例并加锁。
5. 入参出参只用可序列化的具体类型。不用 `any`；联合类型用 `Type string` + `omitempty` 可选字段。
6. 事件名纯字母数字（`entryChanged`，不是 `entry:changed`）。Go 主动推送的事件必须走**就绪握手**：页面订阅完调 `Desktop.Ready()`，导航开始时置未就绪，未就绪期间的命令进队列（见 `../.claude/skills/mygo-web-app/references/` 原生桌面集成 §1）。
7. 一次调用内的连续数据（终端输出）用 `*mygo.Channel[T]`：保序、有背压、页面离开即取消。
8. 前端组件**不直接 import `src/mygo.ts`**。唯一入口是 `src/lib/mile.ts`，它实现与原版 `window.mile.*` 同形的接口，让搬过来的组件和 store 不用改调用点。

## 7. 前端约定

1. 渲染层整体从原项目 `src/renderer/src/` 搬过来：React 19 + zustand 5 + Tailwind 4 + `@phosphor-icons/react` + `@xterm/xterm` 6。版本以原项目 `package.json` 为准，Vite / TypeScript 用本模板的版本（Vite 8、TS 7），兼容性在 M0 实测。
2. `styles/tokens.css` 与 `styles/ui.css` **原文复制**，只改 §8 列出的平台相关处。改令牌值同步 `DESIGN.md`。
3. 不引 CDN，字体（Manrope 600/700/800 latin）随 `@fontsource/manrope` 打包。
4. 禁止 emoji（代码、注释、文案、Toast、占位符）。图标只用 Phosphor 或原项目的自绘 SVG。
5. 中文文案逐字照搬原版，不润色。
6. 整窗不出现滚动条：主体 `flex min-h-0`，滚动只发生在各视图自己的滚动区。

## 8. 与 Electron 不同、必须改的地方

| 原版 | mygo 版 |
| --- | --- |
| `window.mile.*`（preload contextBridge） | `src/lib/mile.ts` 适配层，内部调 `src/mygo.ts` |
| `-webkit-app-region: drag` | `--app-region: drag` / `no-drag`（`.drag-region`、`.no-drag` 两个类改定义即可） |
| `titleBarStyle: 'hidden'` + 自绘控件 | `TitleBarStyle: mygo.TitleBarHidden` + `HideWindowButtons: true` + `TitleBarHeight: 40`，页面自绘 46×40 三个控件，调 `currentWindow.minimize/toggleMaximize/close` |
| `ipcMain.handle` + `isTrustedSender` | mygo 绑定只对本应用页面开放；仍保留入参校形（`sanitize*`） |
| node-pty（ConPTY） | Go 侧 ConPTY 实现（选型见迁移计划「待决策」） |
| `pidusage` | Windows API（`GetProcessTimes` / `GetProcessMemoryInfo`）或 CIM 采样 |
| `nativeImage` 缩放 | Go `image/png` + `image/jpeg` 解码，缩放方案见迁移计划 |
| `Notification` / `Tray` / `globalShortcut` / `powerMonitor` / `screen` | `mygo.NewNotification` / `mygo.NewTray` / `mygo.GlobalShortcut` / `mygo.Power.OnResume/OnUnlockScreen` / `mygo.Screen.Displays` |
| `nativeTheme.themeSource` | `mygo.Theme.SetSource`，页面仍由 `<html data-theme>` 驱动 |
| `BrowserWindow.backgroundColor`（#F6F7F9/#0B0F14，与画布色有漂移） | `BackgroundColor: "light-dark(#f6f7fb, #0f1219)"`，与 `--surface-canvas` 对齐 |

## 9. 验证纪律

没有证据不算完成。每一步至少给一项：`go test` 输出、`bun run typecheck`、CDP 脚本结果、截图。

- **Go 纯逻辑写 `go test`**：归属判定、semver 子集、ANSI / `\r` 重绘切行、端口捕获正则、planner `pendingFires`、各 `sanitize*`、配置迁移链、原子写与 `.bak` 恢复。原版这些逻辑没有单测，迁移时用原版代码生成期望值做对拍（见 `go-service-engineering` §9）。
- **界面与交互用 CDP 脚本**（`scripts/cdp-*.mjs`）：启动真实窗口，`Runtime.evaluate` 读 `getComputedStyle` / `getBoundingClientRect`，断言口径照抄原版 `verify-ui.cjs`、`verify-m7-visual.cjs`、`verify-m12-press.cjs` 等。
- **视觉对等**：同一页面、同一窗口尺寸（1440×900）、同一主题下，与原版截图并排比对；差异要么修掉，要么登记为已接受偏差。
- 按压动画必须用真实输入（CDP `Input.dispatchMouseEvent`），不能 `element.click()`。
- 关窗取消、退出清理、PID 复用防护这类行为要用日志证据，截图证明不了。
- 托盘、单实例、全局快捷键、通知点击、深浅色切换要在真窗口里人工过一遍。

## 10. 环境

- Windows 11，Git Bash。Unix 语法：`/dev/null`、正斜杠、`;` 串命令、`curl.exe`。
- 所有文本 UTF-8 无 BOM，中文直接写，不用 `\uXXXX`；写完回读校验没有 U+FFFD。
- Go 1.27.3，Bun，WebView2 Runtime。
- `mygo dev` 会打开真实窗口并阻塞，关窗即退出。端口 5173 被占时换端口，不结束不是自己起的进程。
