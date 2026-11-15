# MIGRATION-PLAN.md — Electron 版到 mygo 版的迁移计划

> 目标：把 `../../mile-terminal-management`（Electron 43 + React 19 + node-pty）一比一迁到 `mygo/console`（Go + WebView2）。
> 行为与界面以原版源码为唯一基准；本文件登记**怎么做、做到哪、哪些地方做不到一致**。
>
> 版本：2026-11-14 基线 | 对应原版：Mile Terminal 2.5.1

---

## 1. 迁移原则

1. **一比一对照。** 每个 Go 文件、每个前端模块在文件头注释写明对应的原文件。常量、正则、超时、上限从原代码逐字搬。
2. **不顺手改产品行为。** 原版缺陷记到 §5「已知原版问题」，等用户决定，不在迁移里静默修。
3. **偏差必须登记。** mygo 与 Electron 能力不同导致做不到一致的地方，写进 §6「已接受偏差」，写明原因与用户可见差异。
4. **数据目录分开。** 新版写 `%APPDATA%\mile-console\`，不碰原版的 `%APPDATA%\mile-terminal\`。
5. **每步有证据。** `go test` 输出、`bun run typecheck`、CDP 脚本结果、并排截图，至少一项。

---

## 2. 目标结构

```
mygo/console/
├── main.go                     App 装配：绑定、窗口、托盘、快捷键、生命周期
├── internal/
│   ├── contract/               前端可见的类型（唯一契约包，业务包只依赖它）
│   ├── config/                 ConfigStore：读写、迁移链、原子写、.bak 轮转
│   ├── planner/                planner.json 存储与触发计算
│   ├── detect/                 框架 / 包管理器 / 脚本识别（只读文件）
│   ├── precheck/               启动前静态检查
│   ├── entries/                EntryService：CRUD、启动停止、运行态、构建
│   ├── groups/                 工作组
│   ├── scanner/                端口 / CPU / 内存采集
│   ├── ownership/              运行 token + 进程组 + 用户三重判定
│   ├── sessions/               ConPTY 会话
│   ├── logs/                   环形缓冲与查询
│   ├── platform/               平台适配：win32 实现 + types 接口
│   ├── dialog/ shell/ clipboard/ theme/ settings/ window/ app/   薄绑定层
│   └── events/                 事件定义与就绪握手队列
├── src/
│   ├── mygo.ts                 mygo generate 生成物
│   ├── lib/mile.ts             前端唯一后端入口（与原版 window.mile.* 同形）
│   ├── renderer/               从原版 src/renderer/src/ 搬来的 React 应用
│   └── styles/                 tokens.css / ui.css 原文复制
├── scripts/cdp-*.mjs           真实窗口验收
└── docs/                       本目录文档
```

---

## 3. 里程碑

> 逐步执行顺序见 `MIGRATION-STEPS.md`（S01–S34）。本节只讲阶段范围与验收；每个里程碑表里的「步骤」一行对应那份文件的编号。S24（Go 绑定层）横跨 M1–M4，随各阶段的服务逐个补齐。

### M0 · 脚手架与文档基线

| 项 | 内容 |
| --- | --- |
| 步骤 | S01–S03 |
| 范围 | mygo 模板跑通；`CLAUDE.md` / `PRODUCT.md` / `DESIGN.md` / `docs/*` 落地；依赖版本锁定 |
| 产物 | 模板 `mygo dev` 弹窗；`cdp-verify.mjs` 6/6 通过；四份文档 |
| 验收 | `go vet ./...`、`bun run typecheck`、`bun run build:web` 通过；真实窗口 CDP 全绿 |
| 状态 | 完成（S01–S03，2026-11-14；证据见 MIGRATION-STEPS.md 各卡片） |

### M1 · 契约与配置存储

| 项 | 内容 |
| --- | --- |
| 步骤 | S04、S09–S12、S23 |
| 范围 | `internal/contract` 类型；`ConfigStore`（CONFIG_VERSION 16 全迁移链、原子写、`.bak`、`.corrupt`、只读保护）；`planner.json`（PLANNER_VERSION 1）；`window-state.json`；从旧目录导入 |
| 对照 | `src/main/services/ConfigStore.ts`、`PlannerService.ts`、`src/main/lib/windowState.ts`、`ConfigTransferService.ts` |
| 验收 | `go test` 覆盖：v1→v16 每一步迁移、坏文件恢复、`.bak` 不被坏文件覆盖、只读模式下不落盘、原子写中断后 `.tmp` 清理、导入备份文件生成 |
| 状态 | 进行中（2026-11-14：S04、S09、S10、S11、S12 完成；S23 未开始） |

### M2 · 扫描与进程归属

| 项 | 内容 |
| --- | --- |
| 步骤 | S08、S13–S15 |
| 范围 | 端口表采集（`netstat -ano` 解析 + 监听进程 cwd）、CPU / 内存 / 运行时长采样、2s 周期与不可见降频、`tick()` 互斥、未知 PID 的 CIM 刷新、三重凭据判定与 kill 前重验 |
| 对照 | `ScannerService.ts`、`OwnershipService.ts`、`platform/win32/process.ts`、`lib/portScanner.ts` |
| 验收 | `go test`：netstat 解析（同端口双 PID、IPv4/IPv6 两行不合并）、归属判定矩阵、PID 复用拒绝、`sanitize` 入参；CDP：端口表每 2s 刷新且不闪 |
| 状态 | Go 侧完成（S08、S13、S14、S15，2026-11-14）；CDP 一项「端口表每 2s 刷新且不闪」随 S30 Dashboard 验收 |

### M3 · 条目、识别、预检与构建

| 项 | 内容 |
| --- | --- |
| 步骤 | S06、S07、S16、S17、S20、S21a、S21b、S21d、S22（S21c 的启停部分在这里先做，会话相关部分随 M4） |
| 范围 | 条目 CRUD 与校形；框架 / 包管理器 / 脚本识别（只读）；预检项与修复入口；启动命令构造（数组形式、`SAFE_SCRIPT`、启动前重读 `package.json`）；`startAfter` 分层启动；Maven / Gradle 构建、profile、jar 列举；外部终端与 HBuilderX |
| 对照 | `EntryService.ts`（90KB，最大一块）、`DetectService.ts`、`PrecheckService.ts`、`platform/win32/terminal.ts` |
| 验收 | `go test`：命令构造快照（每条生态一组期望 argv）、`startAfter` 成环与自指拒绝、预检各分支、`sanitizeEdit` 合并补丁语义；CDP：启动 / 停止 / 整组启动 |
| 状态 | 未开始 |

### M4 · 会话与终端

| 项 | 内容 |
| --- | --- |
| 步骤 | S05、S18、S19、S21c |
| 范围 | ConPTY 会话（创建 / 写入 / 调整尺寸 / 停止 / 历史）、16ms 合并刷新、`chcp 65001`、`npm_config_progress=false`、退出前 `disposeAll` 与 6 秒上限、ANSI 与 `\r` 重绘切行、最后 30 行与最后错误行 |
| 对照 | `SessionService.ts`、`LogService.ts`、`lib/outputText.ts` |
| 验收 | `go test`：ANSI 去除、`\r` 重绘取末段、`ERROR_RE` 判定、环形缓冲上限；CDP：终端输入输出、搜索、停止；日志证据：关窗后子进程树全部退出 |
| 状态 | 未开始 |

### M5 · 前端渲染层搬迁

| 项 | 内容 |
| --- | --- |
| 步骤 | S25–S31 |
| 范围 | `src/renderer/src/` 整体搬迁；`src/lib/mile.ts` 适配层；zustand store；六个视图与全部组件；`tokens.css` / `ui.css` 原文复制；Manrope 字体随包 |
| 对照 | 原版 `src/renderer/` 全部 |
| 验收 | `bun run typecheck` 零错误；CDP 断言：导航 6 项、`Ctrl+1–6`、命令面板、浮层栈、滚动条为 0、令牌取值与原版一致 |
| 状态 | 未开始 |

### M6 · 原生集成

| 项 | 内容 |
| --- | --- |
| 步骤 | S32 |
| 范围 | 托盘菜单、通知与点击定位、单实例锁、全局快捷键 `Ctrl+Alt+M`、电源恢复 / 解锁、多屏窗口状态、深浅外观、任务栏进度（如有） |
| 对照 | 原版 `src/main/index.ts`（托盘 / 通知 / 快捷键部分） |
| 验收 | 真窗口人工过一遍；快捷键冲突不抛错只提示；第二实例退出且第一个窗口回前台 |
| 状态 | 未开始 |

### M7 · 视觉对等与发布

| 项 | 内容 |
| --- | --- |
| 步骤 | S33–S34 |
| 范围 | 1440×900 同主题并排比对六个页面；按压动画真实输入；深色模式；最小窗口 1180×760 布局；`mygo build` 安装包；版本号与图标 |
| 验收 | 差异清单归零或全部登记为已接受偏差；安装包可安装、可启动、可卸载；`go test` / `typecheck` / `cdp` 全绿 |
| 状态 | 未开始 |

---

## 4. 阶段依赖

```
M0 ──► M1 ──► M3 ──► M4
        │       ▲
        └──► M2 ┘
                 └──► M5 ──► M6 ──► M7
```

- M1 的契约包是其余全部阶段的前置。
- M2 与 M3 可并行（扫描不依赖条目，归属判定只依赖契约）。
- M4 依赖 M1（会话元数据）与 M3（服务会话的启动规格）。
- M5 可以在 M1–M4 期间先搬静态部分（组件、样式、纯前端 store），接真实绑定时再替换 transport。

---

## 5. 已知原版问题（不修，等用户决定）

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| C2 | 只读模式下写入被静默丢弃。配置与备份都解析失败但文件存在时置 `readOnly`，`persist()` 直接 return，界面上的编辑看起来成功，重启后消失 | `ConfigStore.ts` 的 `boot()` / `persist()` | 用户会误以为改动已保存 |
| I1 | HBuilderX 的绝对路径经 `cmd.exe /d /s /c` 转发。路径含空格（如 `C:\Program Files\HBuilderX\cli.exe`）时 cmd 重新解析会拆断 | `EntryService.openInHBuilderX` + `platform/win32` 的 `wrapBatch` | 安装在 Program Files 下的 HBuilderX 打不开 |
| I2 | `findFreePort` 只在 `127.0.0.1` 上试绑，端口被 `[::]:P` 独占时仍报告空闲 | `lib/portScanner.ts` 的 `isPortFree` | 建议端口可能不可用 |
| I4 | 编辑日程时补丁不带 `title` 就把标题清成空串。`sanitizeScheduleInput` 把结果初始化成 `{ title: '' }`，`editSchedule` 判断 `clean.title !== undefined` 恒为真。页面上「暂停 / 恢复」开关只发 `{ paused }`，提醒卡片的「稍后提醒」只发 `{ snoozeUntil }`，两者都会触发。S12 对拍实测：`editSchedule(b, s, { time: '11:00' })` 返回 `title: ""` | `PlannerService.ts` 的 `sanitizeScheduleInput` / `editSchedule` | 关联了任务的日程列表里还能看到任务名，没关联任务的日程暂停一次或稍后提醒一次标题就没了，之后的提醒通知标题为空 |
| I6 | 每天重复（或工作日）的日程选「提前 1 天」时只隔天弹一次。上一次的触发时刻 `lastFiredAt` 恰好等于下一次的提醒时刻（触发时刻减 1440 分钟），`tick()` 的窗口从 `lastFiredAt + 1` 开始，把它挡在外面；之后每次都要再等一天才追上。2026-11-14 用原版实测：一周每小时 tick 一次，提前 0 / 60 分钟各弹 5 次，提前 1440 分钟只弹 3 次（11-16、11-18、11-20），也不进 missed | `PlannerService.ts` 的 `tick()`（`const from = next.lastFiredAt !== undefined ? next.lastFiredAt + 1 : 0`）配合 `shared/planner.ts` 的 `pendingFires` | 用户设了每天提前一天提醒，实际一半的提醒没有出现，也不在「错过的提醒」里 |
| I5 | 新建日程不查「重复日程的结束日期早于开始日期」，只有编辑时查（`addSchedule` 没调 `assertScheduleRange`） | `PlannerService.ts` 的 `addSchedule` | 页面表单在客户端已拦（`badUntil`），正常使用碰不到；绕过页面直接调用时能建出永远不会触发的日程 |
| I7 | 只在关注列表里、不在监听表里的进程 CPU 永远显示「—」。`attachMetrics` 给关注进程记了 CPU 基线，紧接着 `publish()` 的清理只保留 `this.previous`（监听表）里的 PID，把关注进程的基线删掉；下一轮又是「首轮无基线」。S15 对拍实测：场景 `watched` 里 pid 20（redis-server，只命中关注关键字）连续两轮都是 `cpu: null`，内存正常 | `ScannerService.ts` 的 `publish()`（`for (const pid of this.cpuBaseline.keys()) if (!this.previous.has(pid)) this.cpuBaseline.delete(pid)`） | 关注面板的 CPU 列对大多数进程（数据库、后台服务这类不监听端口或端口被别的进程占的）永远是空的；内存列不受影响 |
| I3 | PowerShell 5.1 与 `netstat.exe` 的管道输出按控制台代码页编码（中文系统 936 / GBK），原版 `execFile` 按 UTF-8 解码。CIM 返回的命令行、可执行路径里的非 ASCII 字符变成 U+FFFD；netstat 只有表头是中文，被 `LISTENING` 过滤掉，不影响解析。本机未装 PowerShell 7，`runPowerShell` 落到 5.1。2026-11-14 实测：本机 497 个进程里 7 行的命令行或路径含 U+FFFD | `platform/win32/powershell.ts` 的 `runPowerShell`、`process.ts` 的 `readListenPorts` | 中文路径下的服务：进程表里的 cwd 推断、启动来源的命令行匹配、诊断里的命令行显示可能不对 |
| I8 | `package.json` 的内容是字面量 `null` 时预检整体抛错。`JSON.parse` 成功得 `null`，「可解析」项已记 pass，紧接着读 `pkg.scripts` 抛 `TypeError: Cannot read properties of null (reading 'scripts')`，`run()` reject，界面拿不到任何预检项 | `PrecheckService.ts` 的 `run()` 第 2、3 项之间 | 极少见；用户看到的是启动失败的报错，而不是「package.json 内容不对」的提示。Go 侧 `Run` 返回同文案的 `ErrNullPackageJSON`，专项测试 `TestKnownIssueI8NullPackageJSON`，对拍场景 `pkg-null` 也钉住 |

迁移时的处理：

- 全部按原样搬，**不静默修**。I4 / I5 / I6 有专项测试 `TestKnownIssueI4EditScheduleWipesTitle`、`TestKnownIssueI5AddScheduleSkipsRange`、`TestKnownIssueI6DailyLead1440EveryOtherDay`（`internal/planner/service_extra_test.go`），I6 另有对拍场景 `tick-known-issue-i6`。I6 的修法要动触发窗口（窗口改按提醒时刻算，或去重只看 `at` 不看窗口起点），会改变对拍数据，等用户决定。I4 的修法：`sanitizeScheduleInput` 只在补丁带 `title` 时才写 `out.title`，改动一行，但对拍数据要一起重新生成。I3 的 Go 侧用 `jsDecodeUTF8` 逐字节复现 `Buffer.toString('utf8')` 的替换规则。修法有两种：Go 侧按代码页解码（要引入 `golang.org/x/text`，新增依赖），或在 `META_SCRIPT` 开头加 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`（改了逐字照搬的脚本）。两种都改变行为，等用户选。
- I7 有专项测试 `TestKnownIssueI7WatchedCPUAlwaysNull`（`internal/scanner/scanner_extra_test.go`），对拍场景 `watched` 也钉住了它。修法：清理时把本轮关注进程的 PID 一起保留（改一行），对拍数据要重新生成。**用户 2026-11-14 决定：不修，保持原版行为。**
- I8 有专项测试 `TestKnownIssueI8NullPackageJSON`（`internal/precheck/unit_test.go`），对拍场景 `pkg-null` 也钉住了它。修法：`JSON.parse` 结果不是对象时按「package.json 存在且能解析」fail 处理
- Go 侧把行为写成测试并标注 `// 已知原版问题 C2 / I1 / I2 / I3，见 docs/MIGRATION-PLAN.md`，修的时候测试一起改。
- 用户决定修之后，同步回写本节状态与对应测试。

---

## 6. 已接受偏差

| 项 | 原版 | mygo 版 | 原因 | 用户可见差异 |
| --- | --- | --- | --- | --- |
| 窗口控件 | Electron 自绘 + IPC | mygo `TitleBarHidden` + 自绘控件调 `currentWindow` | 运行时不同 | 无（尺寸与视觉一致） |
| 通知样式 | Electron `Notification` | `mygo.NewNotification` | 系统通知由 WebView2 / WinRT 实现 | 图标与按钮布局可能有细微差别 |
| 托盘菜单 | Electron `Tray` + `Menu` | `mygo.NewTray` | 同上 | 菜单项字体随系统，分隔线样式可能不同 |
| 全局快捷键 | Electron `globalShortcut` | `mygo.GlobalShortcut` | 同上 | 无 |
| 窗口背景 | `#F6F7F9 / #0B0F14`（与画布有漂移） | `light-dark(#f6f7fb, #0f1219)` | 顺手对齐设计令牌 | 启动瞬间底色更一致（这是改进） |
| 标题栏拖拽 | `-webkit-app-region` | `--app-region` | WebView2 不认 Electron 私有属性 | 无 |
| macOS | 有 darwin 实现（未在真机验证） | 首版只做 Windows | 迁移聚焦当前使用平台 | macOS 用户继续用原版 |
| config.json 的未知键与怪类型（S09，用户 2026-11-14 选定） | `JSON.parse` 后整个铺进缓存，未知键、类型不对的值原样写回 | 按 `contract.AppConfig` 结构体宽松解码（`internal/config/loose.go`）：未知键下次写盘时丢掉；类型不对的字段单独回落（顶层与 settings 取默认值，条目内取零值），不把整份文件判坏；数组里不是对象的元素丢掉；键名区分大小写 | Go 用固定结构体读写，保留原始 JSON 树会让 S11–S23 每个改配置的服务都背着原始字段 | 手改出来的多余键升级后消失；手改坏的单个设置项回到默认值（原版会带着坏值运行）。正常使用写出的配置没有差异 |
| config.json 的字段顺序与转义 | `JSON.stringify(cache, null, 2)`，键顺序随原文件 | 键顺序按结构体字段；`U+2028` / `U+2029` 写成 `\u2028` / `\u2029` 转义 | `encoding/json` 的固定行为 | 无（解析后相同；原版能读新版写的文件） |

| planner 入参里值为 `undefined` 的键（S12） | IPC 结构化克隆保留 `{ title: undefined }` 这种键，`'title' in p` 为真，按「带了这个键」校形（例如 `editTask(b, t, { title: undefined })` 抛「任务标题必须是字符串」） | 绑定入参是 JSON，`undefined` 的键在序列化时就没了，按「没带这个键」处理 | JSON 表达不了 undefined | 无：原版页面从不发值为 undefined 的键（`TaskList`、`ScheduleList`、`BoardDetail` 发的都是具体值或 `null`） |
| planner 的 `snoozeUntil` 小数（S12） | 接受任意有限数，原样存小数毫秒 | 向上取整成整数毫秒再存 | `contract.PlannerSchedule.SnoozeUntil` 是 `*int64` | 无：tick 比较 `snoozeUntil <= now`，`now` 是整数，向上取整不改变哪一轮重弹；只有 `planner.json` 里的数值不同。页面发的是 `Date.now() + n * 60000`，本来就是整数 |
| `MILE_PLANNER_NOW` 的日期解析（S12，只在开发构建生效） | `Number(v) \|\| Date.parse(v)`，V8 的 `Date.parse` 还认 `Nov 14 2026`、空格分隔、小写 `t` / `z`、`+0800` 等非标准写法 | `Number` 部分逐条对齐；`Date.parse` 只实现 ECMA-262 §21.4.3.2 规定的 ISO 8601 格式（含 V8 实测的细节：只查日在 1–31、小数秒取前三位、`-000000` 年非法、`24:00` 只接受整点），非标准写法当解析失败，回落到真实时钟 | 非标准部分是 V8 实现定义行为，没有规范可照抄 | 只影响开发期测试钩子，打包后两边都不读这个变量。`TestDevOverridesMatchOriginal` 用 53 组输入逐条比对，非标准写法单独标注 |
| 进程 CPU / 内存采样（S15） | `pidusage` 4.0.1。Windows 上它探测 wmic 用 `spawn('wmic', cb)`，参数类型不对同步抛错，实际每轮都起 PowerShell 跑 `Get-WmiObject Win32_Process`；分母是整秒的 `os.uptime()` | Windows API 直取（`OpenProcess` + `GetProcessTimes` + `K32GetProcessMemoryInfo`），不起子进程；算法相同（相对上次采样的单核百分比、首次为 0、60 秒未问到的 PID 忘掉、全取不到报 `No matching pid found`），分母用毫秒墙钟；另按创建时间识别 PID 复用并丢掉旧基线 | 不起子进程，每轮省一次 PowerShell 启动 | CPU 读数更平滑（原版整秒分母在 2 秒周期下会有 ±50% 的跳动）；数值口径相同 |
| 系统 CPU 的 irq（S15） | `os.cpus()` 的 times 求和含 `irq` | `GetSystemTimes` 的 kernel + user，不另加 irq | libuv 的 irq 取 InterruptTime，它本已含在 kernel 里，原版重复计入 | 系统 CPU 占比略低于原版（中断多的机器差 1 个百分点以内） |
| 系统内存为 0（S15） | `totalmem()` 为 0 时占比是 NaN，JSON 里是 `null` | 取 0 | `encoding/json` 写不出 NaN；`contract.SystemLoad.Memory` 是 `float64` | 无：totalmem 不会是 0 |
| `SystemLoad.Memory` 类型（S15） | 小数百分比（如 `66.7`） | 契约字段从 `int64` 改为 `float64` | S04 写契约时按整数写错了，对拍发现 | 无（改正后与原版一致） |
| 关注进程超过 50 个命中时取哪 50 个（S15） | 按 CIM 返回顺序（`table.mine` 这个 Set 的插入顺序）取前 50，再按 pid 排序 | 按 pid 升序取最小的 50 个 | Go 的 map 无序，平台层不保留 CIM 顺序 | 只在一个关键字命中 50 个以上进程时出现（如关键字 `e`）：显示的 50 个不同。不超过 50 个时完全相同 |
| 扫描器字符串截断的孤立代理（S15） | `truncate` / 关键字 `slice(0, 64)` 切在代理对中间时留下孤立高位代理 | 丢掉那半个字符 | Go 字符串是 UTF-8，装不下孤立代理 | 命令行第 160 个码元正好是 emoji 前半时，原版末尾显示一个替换符，新版不显示 |
| 扫描器方法的同步性与错误（S15） | `ignore` / `setGroup` / `setWatchedKeywords` 落盘失败时同步抛错；`table()` 是 Promise；`setWatchedKeywords(unknown)` | 返回 `error`；`SetWatchedKeywords` 收 `json.RawMessage`，同样判「不是数组」与跳过非字符串；`void this.tick()` 换成 `Options.Go`（默认起协程）；App ctx 取消后不再采集也不再排定时器 | Go 没有异常与 Promise；绑定入参是 JSON | 无：错误文案相同，绑定层把 error 原样转给页面 |
| 系统 CPU 基线的作用域（S15） | 模块级变量 `prevTicks` | `Service` 实例字段 | 全应用只有一个扫描器，等价；放实例上测试才能隔离 | 无 |
| planner JSON 里的孤立代理项（S12） | `"\ud800"` 原样保留，`length` 计 1 | `encoding/json` 解码成 U+FFFD，长度同样计 1 | Go 字符串是 UTF-8 | 无：长度上限的判定结果相同；只有这种手工构造的输入会碰到 |
| scanChildren 目录排序（S16，用户 2026-11-15 选定 x/text/collate） | `names.sort((a, b) => a.localeCompare(b))`，本机 node 默认区域 zh-CN，走 ICU 的 zh 规则 | `golang.org/x/text/collate` 的 zh 表，主权重重映射把汉字块挪回数字与拉丁字母之间（`internal/detect/collate.go`） | x/text 没实现 CLDR 的脚本重排，两边 CLDR 版本也不同 | 只影响「批量导入」列表的显示顺序。BMP 内的拉丁、汉字、标点、数字混排与 node 逐个一致；增补平面汉字、假名 / 谚文 / 注音之间的相对位置、部首与带圈汉字、少数生僻字的拼音先后可能不同 |
| `scripts` 字段的类型（S16） | JS 对象，键序随 `package.json` | `contract.Scripts` 保序类型，JSON 形状不变；TS 生成为 `unknown`，`src/lib/mile.ts` 断言成 `Record<string, string>`（BINDINGS-CONTRACT §1.3 第 7 条） | Go 的 map 无序，`map[string]string` 会让脚本下拉的顺序变成字母序 | 无 |
| 读 package.json 失败的提示（S16） | 警告里拼 node 的 `err.message`（如 `ENOENT: no such file or directory, open '...'`） | 路径是目录时照搬 `EISDIR: illegal operation on a directory, read`；其余错误用 Go 的 `err.Error()` | Go 的 I/O 错误文案与 libuv 不同；目录这一种对拍场景里出现过，逐字对上 | 极少见：权限不足之类的读失败，警告文字是 Go 的英文错误描述 |
| package.json 里转义出的孤立代理（S16） | `"\ud800"` 解析成长度 1 的孤立代理字符串 | 解码成 U+FFFD | Go 字符串是 UTF-8 | 只有项目名或脚本命令里写了这种转义才会看到，显示为替换符 |
| 识别方法的同步性（S16） | `detect` / `readFavicon` / `detectSpringBootProfiles` / `scanChildren` 返回 Promise | Go 同步方法，绑定层自然是异步调用 | Go 侧不需要 Promise | 无 |
| `lockfileFor` 没找到锁文件（S16） | 返回 `null` | `LockfileFor(path) (contract.PackageManager, bool)` | Go 惯用写法；绑定层若需要再转成可空 | 无 |
| `readFavicon` 的返回值（S16） | `{ mime, base64 } \| null` 对象字面量 | `*detect.Favicon`，JSON 字段同名 | Go 需要具名类型 | 无 |
| 预检的「当前 Node 版本」（S17，用户 2026-11-15 选定） | `process.versions.node`，即 Electron 43 内置的 Node，与用户机器上实际跑项目的 Node 无关 | 在 PATH 里定位第一个 `node.exe`（只 stat，同 whichAny 口径），读它的 PE 版本资源（`VS_FIXEDFILEINFO` 的 FileVersion 前三段），不执行它。找不到或读不出时显示「当前 未知」：未声明 engines.node 时照常 pass，声明了时走原版「无法解析范围」的 pass 分支，不出 warn | Go 应用没有内置 Node；读版本资源是只读文件，守住红线 1 | engines.node 的比对对象换成了真正会跑项目的 Node，提示更准；没装 Node 时文案里的版本号是「未知」 |
| 预检的磁盘余量（S17） | `statfs(cwd)` 的 `bsize * bavail`（libuv 在 Windows 上用 GetDiskFreeSpaceW 的簇大小乘可用簇数） | `GetDiskFreeSpaceExW` 的 FreeBytesAvailable | 两者都是调用者可用字节数；本机实测与 node 的 `statfsSync` 逐字节一致 | 无 |
| 预检方法的形状（S17） | `run()` 返回 Promise，异常时 reject | `Run(ctx, ...) (contract.PrecheckResult, error)`，只有 I8 一条路径返回错误 | Go 惯用写法 | 无 |
| 非法的 packageManager 值（S17） | `PM_BINARIES[pm]` 为 undefined，PATH 非空时 `whichAny` 遍历 undefined 抛 TypeError，预检整体 reject | 候选为空，报「PATH 中找不到 X」的 fail | 条目经 `sanitizeEdit` 校形，配置里只会是四个合法值之一，正常路径走不到 | 无（只有手改 config.json 写进非法值才会不同） |
| 会话输出的推送方式（S18） | `SessionService` 发 `data` 事件，主进程广播 `session:data`，页面另调 `history(id)` 取回放 | `Attach(ctx, id, *mygo.Channel[SessionDataEvent])`：先按 64 KiB 分块回放 buffer，再推后续输出，会话退出且发完、页面关 Channel 或 ctx 取消即结束；快照与订阅在同一把锁里做，不重不漏。`OnData` / `OnExit` 仍保留给日志与条目服务 | CLAUDE.md §6.7：连续数据走 Channel，保序、有背压、页面离开即取消 | 无：页面看到的字节流相同 |
| PTY 字节流解码（S18） | node-pty 的 socket 设了 utf8 编码，由 node `StringDecoder` 解码 | 自己按 UTF-8 解：被读块切断的多字节字符留到下一块拼接；非法字节逐个换成 U+FFFD；流结束时残留的半个字符出一个 U+FFFD（与 `StringDecoder.end()` 一致） | Go 侧没有 node 解码器 | 合法 UTF-8 输出完全一致；只有程序写出非法字节序列时，替换符的个数可能与 node 不同 |
| 会话缓冲与标题截断的代理对（S18） | `slice(-400000)` / `slice(0, 80)` 切在代理对中间时留下孤立代理 | 少留那半个字符（截尾时从后一个字符开始，截头时止于前一个字符） | Go 字符串是 UTF-8，装不下孤立代理 | 缓冲恰好从 emoji 中间截断时，回放开头少一个替换符；标题第 80 个码元正好是 emoji 前半时少半个字符 |
| 会话 id 的序号作用域（S18） | 模块级 `let seq = 0` | `Service` 实例字段 | 全应用只有一个会话服务，等价；放实例上测试才能隔离 | 无 |
| 会话环境变量合并（S18） | `{ ...process.env, ...input.env, 固定键 }`，JS 对象键区分大小写 | 按 Windows 规则不区分大小写去重，后写的覆盖、位置保留第一次出现处；`input.env` 按键名排序后合入 | Windows 环境块键名不区分大小写，`Path` 与 `PATH` 同时写进去时哪个生效不确定 | 无：只有 `input.env` 与系统环境大小写不同的同名键才会不同，新版结果确定 |
| `at` 的空串（S18） | `at?.cwd ?? homedir()`、`at?.title ?? title`，空串原样采用 | 空串当作没给：cwd 落到 `Homedir`，标题用 shell 默认或 input 标题；`create` 的 cwd 为空同样落到 `Homedir` | `ShellAt` 是值类型，区分不了空串与未给；`at` 只由 S21d 传入且必为非空 | 无：正常路径走不到空串 |
| 方法的错误形状（S18） | `createShell` 非 shell 时抛 `自由终端只允许 shell`；`write` 把 pty 的异常抛给调用方；`sessionIdByPid` 没找到返回 `null`；`kill` / `disposeAll` 返回 Promise | `CreateShell` 返回 `ErrShellOnly`（同文案）；`Write` 返回 error；`SessionIDByPid` 返回 `("", false)`；`Kill` / `DisposeAll` 同步返回，返回时进程树已处理完 | Go 惯用写法 | 无：绑定层把 error 原样转给页面 |
| 首条命令写入失败（S18） | `create` 里 `pty.write(init)` 抛错会让 `create` 整体抛出，而会话已登记、进程已起 | 忽略这次写入错误，照常返回会话 | 刚起的 ConPTY 写入只会在进程立刻退出时失败，那时退出流程会接手；抛错反而留下一个调用方拿不到 id 的会话 | 极少见：shell 起来就退出时，新版界面能看到这个已结束的会话 |
| 退出码取不到（S18） | node-pty 总给出 exitCode | `GetExitCodeProcess` 失败时记 -1（会话标为 crashed）；退出事件不带 `signal` | Windows 没有信号；node-pty 在 Windows 上 signal 恒为 0 | 无 |
| `list()` 返回值（S18） | 返回内部 `meta` 对象的引用 | 返回拷贝 | 防止调用方改动内部状态，并发下也安全 | 无：原版调用方都只读 |
| `resize` 的非整数参数（S18） | `Number.isInteger` 过滤 | 参数是 `int`，绑定层 JSON 解码时就拒掉小数 | 类型系统已保证 | 页面传小数时原版静默忽略，新版绑定调用返回解码错误；原版页面只传 xterm 算出的整数 |
| `query` 的 limit 形状（S19） | `clampLimit` 收 `Number(v)`：`undefined` 兜底 300，`null` 变 0 再收到 1，小数被 `Math.trunc` 截断 | 入参是 `*int`：没给（含 JSON `null`）当 300，小数在 JSON 解码时就报错 | 绑定入参是 JSON，`null` 与「没给」在 Go 里都是 nil 指针 | 页面走 S24 的 `sanitizeLogQuery` 复刻原版（`limit: Number(x)`），拿到的一定是整数，实际路径无差异；只有绕过绑定层直接调 Go 服务、且传 `null` 或小数时才不同（原版 1 / 截断，新版 300 / 报错） |
| 关键字搜索的大小写折叠（S19） | `text.toLowerCase()` 是 Unicode 全量映射：`İ`（U+0130）折叠成 `i` 加组合点两个码元 | `strings.ToLower` 是简单映射：`İ` 折成单个 `i` | Go 的字符串 API 只做简单映射，全量映射要逐字符查 SpecialCasing 表 | 只在搜索框里输入带组合点这类极端字符时，命中与否可能不同；普通英文与中文完全相同 |
| 自定义图片的 imageId（S20） | `nativeImage`（Skia）解码、缩放、编码 PNG，再取字节 SHA-256 前 12 位 | 标准库 `image/png` + `image/jpeg` 解码，自写双线性缩放，`png.Encode` 编码，同样取 SHA-256 前 12 位 | D2 定案（纯 Go，无 cgo、无第三方依赖）：Skia 的缩放核与 PNG 编码都和标准库不同 | 同一张原图在新版得到另一个 imageId，但显示效果一致（长边 ≤128、只缩不放、等比）。`imageId` 在原版导出配置时就在 `DROP_ON_EXPORT` 里，导入不会带过来，所以互不影响 |
| `sanitizeEdit` 的隐式类型转换（S21a） | `String(value)` / `Number(value)` 会把 `name: 123`、`expectedPort: '3000'`、`pinned: 'true'` 之类强转后再校验；不是对象的 `env` / `scripts` 报「必须是对象」 | 入参是 `contract.EntryEdit` 具体类型，类型不对在 JSON 解码时就失败；`env` / `scripts` 为 null 与「没给」同义 | 绑定入参是 JSON，Go 用结构体解码，不做隐式转换 | 页面永远按 `EntryEdit` 的类型发值，正常路径无差异；只有绕过页面传入错类型时，原版给的是一句中文校验错误，新版是解码错误 |
| 多字段同时非法时取哪条错误（S21a） | 按页面传来的键顺序逐字段校验，先撞到哪条报哪条（`{kind:'task', expectedPort:3000}` 报「任务不设置端口」，反过来则先设端口再被清理） | 按 `contract.EntryEdit` 的固定字段顺序（`kind` 先于 `icon` / `expectedPort`），等价于「`kind` 先处理」 | Go 的结构体没有键顺序 | 只有一次提交里同时改多个非法字段时，弹出的错误文案可能不同；单字段非法时完全一致 |
| `env: null` 的含义（S21a） | `env` 是 null 时报「环境变量必须是对象」 | JSON `null` 与「没带这个键」都解成 nil 映射，按「没提」处理（保留原 env） | Go 的 map 字段分不出 null 与缺省 | 只有绕开页面显式传 `env: null` 才会不同；页面发的是对象 |
| `healthCheck` 缺 `enabled`（S21a） | `typeof enabled !== 'boolean'` 报「健康检查开关必须是布尔值」 | `contract.HealthCheckConfig.Enabled` 是 bool，缺省即 false，不报错 | 契约里的结构体没有三态布尔 | 只有绕开页面只传 `{path}` 时才不同；页面总是两个字段一起发 |

> 新增偏差必须写进本表并说明用户可见差异；「看起来一样」不算理由。

---

## 7. 待决策

| 编号 | 事项 | 选项 | 当前倾向 | 阻塞阶段 |
| --- | --- | --- | --- | --- |
| D1 | ConPTY 实现 | ① 直接调 `kernel32` 的 `CreatePseudoConsole` ② 第三方 conpty 包装库 ③ 子进程 + 管道（无真终端语义） | **已定 ①（2026-11-14，S02）**：标准库 `syscall` 直调，无第三方依赖，代码在 `internal/sessions/conpty_windows.go`。`go test` 实测通过：PowerShell 5.1 提示符、`chcp 65001` 中文往返、resize 120×40、`Close` 后进程树退出。`Kill` 仅结束根进程，整树终止留给 S18 | M4 |
| D2 | 图片缩放 | ① 纯 Go `image/png` + `image/jpeg` + 双线性 ② 调用系统 WIC ③ 页面 Canvas 预缩放后上传 | **已定 ①（2026-11-15，S20）**：标准库 `image/png` / `image/jpeg` 解码，自写双线性缩放（采样走非预乘 NRGBA，半透明边缘不发黑），`png.Encode` 编码，无 cgo、无第三方依赖，代码在 `internal/images/images.go`。同一张原图得到的 PNG 字节与原版 Skia 不同，imageId 因此不同（见 §6） | M3 |
| D3 | 产品名与标识 | `Mile Console` / `Mile Terminal`；`identifier` 用 `com.example.mileconsole` 还是正式域名 | **已定（2026-11-14，S03，用户确认沿用当前值）**：产品名 `Mile Console`，`identifier` 为 `com.example.mileconsole`。`mygo.config.ts`、`main.go` 窗口标题、`index.html`、`package.json` 已是这些值。正式域名等发布前（S34）再换，换时同步 `mygo.config.ts` | M0 收尾 |
| D4 | 数据目录 | `%APPDATA%\mile-console\`（当前） | **已定（2026-11-14，S03）**：`%APPDATA%\mile-console\`，与原版 `%APPDATA%\mile-terminal\` 分开 | M1 |
| D5 | 是否保留 macOS | 首版只 Windows / 同步做 darwin | 只 Windows，darwin 后续评估 | M2 |
| D6 | 旧配置导入的触发方式 | 首次启动弹窗 / 设置页手动入口 / 两者都有 | 两者都有，首次启动弹窗可「以后再说」 | M1 |

> 决策落地后写进本表并标注日期，不要只留在对话里。

---

## 8. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| ConPTY 选型不稳 | 终端是核心功能，做不出来整个迁移失去意义 | M0 阶段就做最小验证（起一个 shell、收到输出、能输入），不等到 M4 |
| mygo 0.8.3 的原生能力缺项（如任务栏进度、屏幕枚举细节） | 个别功能降级 | 先查本机源码确认 API 是否存在，缺项登记为已接受偏差 |
| 前端搬迁量巨大（原版 renderer 共 55 个 `.tsx`：45 个组件 + 7 个视图 + 入口） | M5 拖长 | 先搬样式与纯展示组件，绑定用 mock 顶住；mock 只用于开发期，生产构建不引用 |
| 绑定契约与原 `window.mile.*` 有形状差异 | 组件调用点要改，违背「搬过来就能用」 | `src/lib/mile.ts` 必须做到同形；每加一个方法先对照 preload 的签名 |
| 原版行为细节散落在 55 个 harness 里 | 漏掉断言口径 | 读原 harness 抄断言，不重新发明 |
| 两个版本同时运行抢端口 / 抢数据目录 | 验证互相干扰 | 数据目录分开；验证前确认原版是否在跑，不动它的进程 |

---

## 9. 每阶段的汇报口径

```text
任务：M<n> <名称>
状态：完成 / 部分完成 / 阻塞
完成内容：
- [文件、关键函数、做了什么]
验证证据：
- [go test 输出 / typecheck / CDP 结果 / 截图路径]
未完成 / 阻塞：
- [原因 + 需要谁配合]
新发现：
- [原版问题、偏差、待决策，只记录不擅自修]
```
