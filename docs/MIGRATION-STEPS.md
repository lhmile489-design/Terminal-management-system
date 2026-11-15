# MIGRATION-STEPS.md — 按顺序的逐步迁移清单

> 本文件回答「先迁哪个文件、后迁哪个文件、每步做到什么算完」。
> 阶段总览、偏差表、待决策、已知原版问题见 `MIGRATION-PLAN.md`；绑定形状见 `BINDINGS-CONTRACT.md`。
> 顺序依据：原版 `src/main` 的真实 import 依赖（叶子先迁）+ 风险前置（ConPTY 最先验证）。
>
> 基线：2026-11-14 | 对应原版 Mile Terminal 2.5.1（`src/` 共 26416 行）

---

## 1. 用法

1. **按编号顺序做，不跳步。** 一步的前置没打勾，这一步不开工。
2. **每步只动该步列出的产物文件。** 顺手发现的问题记下来，不在这一步改。
3. **原版缺陷不静默修。** 登记到 `MIGRATION-PLAN.md` §5，Go 侧照搬行为并写测试标注编号。
4. **完成 = 有证据。** 在 §3 总表的「状态」列打勾，并在该步卡片的「证据」栏贴 `go test` 输出、`bun run typecheck` 结果、CDP 脚本结果或截图路径中的至少一项。
5. **常量逐字搬。** 卡片里列出的常量、正则、超时是从原版源码抄来的，Go 侧不许改值；改了就是行为变更，要走 MIGRATION-PLAN §5。
6. **每个产物文件头写对照注释**：`// 对应 src/main/services/ConfigStore.ts`。

---

## 2. 依赖顺序（为什么是这个顺序）

```
叶子：outputText  semver  portScanner  windowState  platform/*
  │
  ├─ ConfigStore ──► Theme  Group  Planner
  │
  ├─ attribution ──► Ownership ──► Scanner
  │
  ├─ Detect ──► Precheck
  │
  ├─ Session ──► Log        Image
  │
  └─ Entry（依赖上面几乎全部）──► Health  Alert  ConfigTransfer
                                   │
                          index.ts 的 IPC ──► Go 绑定层 ──► src/lib/mile.ts
                                                              │
                                   styles ─► ui ─► lib/store ─► 组件 ─► views ─► App
                                                              │
                                                     托盘 / 通知 / 快捷键 ─► 视觉对等 ─► 打包
```

ConPTY 不在依赖链最前，但它是迁移里风险最大的一项：做不出来，终端页和服务会话都没法迁。所以把它的最小验证放到 S02，先确认可行再往下做。

---

## 3. 步骤总表

| 编号 | 段 | 内容 | 对照原文件（行数） | 前置 | 里程碑 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | A 前置 | 前端依赖换装 | `package.json` | — | M0 | [x] |
| S02 | A 前置 | ConPTY 最小验证（D1 定案） | `SessionService.ts`(254) | — | M0 | [x] |
| S03 | A 前置 | 产品名与数据目录定案（D3/D4） | — | — | M0 | [x] |
| S04 | B 契约 | `internal/contract` 类型包 | `shared/types.ts`(843) `shared/planner.ts`(366) | S01 | M1 | [x] |
| S05 | C 叶子 | 输出文本规则 | `lib/outputText.ts`(69) | S04 | M4 | [x] |
| S06 | C 叶子 | semver 子集 | `lib/semver.ts`(91) | S04 | M3 | [x] |
| S07 | C 叶子 | 空闲端口探测 | `lib/portScanner.ts`(35) | S04 | M3 | [x] |
| S08 | C 叶子 | 平台适配层 | `platform/types.ts`(110) `win32/*`(445) | S04 | M2 | [x] |
| S09 | D 存储 | ConfigStore | `services/ConfigStore.ts`(302) | S03 S08 | M1 | [x] |
| S10 | D 存储 | 窗口状态 | `lib/windowState.ts`(106) | S03 | M1 | [x] |
| S11 | D 存储 | 主题与工作组 | `ThemeService.ts`(36) `GroupService.ts`(128) | S09 | M1 | [x] |
| S12 | D 存储 | 进度与日程 | `PlannerService.ts`(696) | S09 | M1 | [x] |
| S13 | E 扫描 | 启动来源推断 | `lib/attribution.ts`(82) | S08 | M2 | [x] |
| S14 | E 扫描 | 进程归属判定 | `OwnershipService.ts`(125) | S08 | M2 | [x] |
| S15 | E 扫描 | 端口与负载采集 | `ScannerService.ts`(599) | S09 S13 S14 | M2 | [x] |
| S16 | F 识别 | 项目识别 | `DetectService.ts`(685) | S08 | M3 | [x] |
| S17 | F 识别 | 启动前预检 | `PrecheckService.ts`(605) | S06 S07 S16 | M3 | [x] |
| S18 | G 会话 | ConPTY 会话 | `SessionService.ts`(254) | S02 S05 S08 S14 S15 | M4 | [x] |
| S19 | G 会话 | 日志聚合 | `LogService.ts`(166) | S05 S18 | M4 | [x] |
| S20 | G 会话 | 自定义图片 | `ImageService.ts`(81) | S09（D2 定案） | M3 | [x] |
| S21a | H 条目 | 常量、条目 CRUD 与校形 | `EntryService.ts` 1–756、808–848、2086–2161 | S09 S11 S16 | M3 | [x] |
| S21b | H 条目 | 命令构造 | `EntryService.ts` 1415–1699 | S17 S21a | M3 | [x] |
| S21c | H 条目 | 启停、运行态、分层启动、自动重启、诊断 | `EntryService.ts` 757–807、849–861、1030–1134、1700–2085 | S15 S18 S19 S21b | M3/M4 | [x] |
| S21d | H 条目 | 路径与产物、图片、HBuilderX、安装、构建 | `EntryService.ts` 862–1029、1135–1414 | S20 S21c | M3 | [x] |
| S22 | H 条目 | 健康检查与输出告警 | `HealthService.ts`(225) `AlertService.ts`(123) | S21c | M3 | [x] |
| S23 | H 条目 | 配置导入导出与旧版导入 | `ConfigTransferService.ts`(248) | S11 S15 S21a | M1 | [x] |
| S24 | I 绑定 | Go 绑定服务与事件 | `main/index.ts`(1131) `shared/channels.ts`(179) | S11–S23 | M1–M4 | [ ] |
| S25 | I 绑定 | 生成绑定与前端适配层 | `preload/index.ts`(264) | S24 | M5 | [x] |
| S26 | J 渲染 | 样式原文复制 | `styles/tokens.css`(1055) `ui.css`(1438) | S01 | M5 | [x] |
| S27 | J 渲染 | 基础组件与浮层栈 | `components/ui/*`(1121) `lib/overlay.ts`(76) | S26 | M5 | [x] |
| S28 | J 渲染 | 前端工具与 store | 其余 `lib/*`(907) `store/*`(867) | S25 S27 | M5 | [x] |
| S29 | J 渲染 | 业务组件 | `components/**`(除 ui 与外壳组件，6825) | S28 | M5 | [x] |
| S30 | J 渲染 | 六个视图逐页 | `views/*`(7 个文件 2244，含 `LogCenter`) | S29 | M5 | [ ] |
| S31 | J 渲染 | 应用外壳 | `App.tsx`(507) `main.tsx`(19) + 外壳组件(832) | S30 | M5 | [ ] |
| S32 | K 原生 | 托盘、通知、单实例、快捷键、退出清理 | `main/index.ts` 原生部分 | S31 | M6 | [ ] |
| S33 | L 收尾 | 视觉对等 | — | S32 | M7 | [ ] |
| S34 | L 收尾 | 打包发布 | — | S33 | M7 | [ ] |

### 3.1 可并行的段

| 可并行 | 条件 |
| --- | --- |
| S05、S06、S07、S08 | 互不依赖，都只依赖 S04 |
| S10 与 S09 | 两者只依赖 S03，S10 不读 config.json |
| S13–S15 与 S16–S17 | 扫描链与识别链没有交叉 |
| S26、S27 | 只依赖 S01，可在 Go 侧进行时提前做；接真实绑定前用 `src/mocks/` 顶住，生产构建不引用 |

### 3.2 决策关卡

| 关卡 | 没定案时阻塞 | 定案写回 |
| --- | --- | --- |
| S02 → D1（ConPTY 实现） | S18 及之后全部会话相关步骤 | MIGRATION-PLAN §7 |
| S03 → D3 / D4（产品名、数据目录） | S09、S10 | MIGRATION-PLAN §7，并同步 `mygo.config.ts` |
| S20 前 → D2（图片缩放方案） | S20、S21d | MIGRATION-PLAN §7 |

---

## 4. 步骤卡片

每张卡片固定五栏：**对照**（原文件）· **产物**（新文件）· **逐字搬**（常量、正则、超时）· **验收**（命令与断言口径，括号里是原版对应的 harness）· **证据**（完成时填）。

### A 前置

#### S01 前端依赖换装

- **对照**：原版 `package.json`
- **产物**：`mygo/console/package.json`、`bun.lock`
- **逐字搬**：运行时依赖版本照原版锁定 —— `react` / `react-dom` 19.2.8、`zustand` 5.0.15、`tailwindcss` 与 `@tailwindcss/vite` 4.3.3、`@phosphor-icons/react` 2.1.10、`@fontsource/manrope` 5.3.0、`@xterm/xterm` 6.0.0、`@xterm/addon-fit` 0.11.0、`@xterm/addon-search` 0.16.0、`@xterm/addon-web-links` 0.12.0、`@xterm/addon-webgl` 0.19.0、`@vitejs/plugin-react` 5.2.0、`@types/react` 19.2.18、`@types/react-dom` 19.2.4。Vite 与 TypeScript 用模板版本（^8 / ^7）
- **不装**：`electron`、`electron-vite`、`electron-builder`、`@electron/rebuild`、`node-pty`、`pidusage`、`@types/pidusage`（Go 侧替代）
- **验收**：`bun install` 成功；`bun run typecheck` 零错误；`bun run build:web` 产出 `dist/`；`@vitejs/plugin-react` 5.2.0 与 Vite 8 不兼容时记入 MIGRATION-PLAN §8 再升级插件
- **证据**（2026-11-14）：`bun install` 175 packages 无报错；`node_modules` 实测版本 react / react-dom 19.2.8、zustand 5.0.15、tailwindcss 与 @tailwindcss/vite 4.3.3、phosphor 2.1.10、manrope 5.3.0、xterm 6.0.0 与四个 addon、plugin-react 5.2.0、@types/react 19.2.18、@types/react-dom 19.2.4、vite 8.3.8、typescript 7.0.2，均与原版一致；`bun run typecheck` 零错误；`bun run build:web` 产出 `dist/`；plugin-react 5.2.0 的 peer 范围含 `^8.0.0`，无不兼容；`package.json` 无 BOM、无 U+FFFD

#### S02 ConPTY 最小验证（定案 D1）

- **对照**：原版 `SessionService.ts`（254 行）对 node-pty 的用法
- **产物**：`mygo/console/internal/sessions/conpty_windows.go`（`StartPTY` / `Read` / `Write` / `Resize` / `Close` / `Kill`，仅依赖标准库 `syscall`，S18 直接复用）+ `conpty_spike_test.go`（验证用例，保留为回归测试）
- **做法**：先查本机可用的库与其维护状态，再选型，不凭记忆。候选：`golang.org/x/sys/windows` 直调 `CreatePseudoConsole`，或第三方封装
- **验收**：起 `pwsh.exe` / `powershell.exe`；读到提示符；写入 `echo 中文测试` 并读回原文（先发 `chcp 65001`）；`resize` 到 120×40 后 `$Host.UI.RawUI.WindowSize` 读回一致；关闭后子进程树全部退出
- **定案**：结论、库名与版本写回 MIGRATION-PLAN §7 的 D1
- **证据**（2026-11-14）：`go vet ./internal/...` 通过；`go test ./internal/sessions/ -run TestConPTYSpike -v -count=1` 两次均 PASS（2.54s）。用例逐项断言：Windows PowerShell 5.1（`-NoLogo -NoProfile`，80×24 起）收到 `PS ` 提示符；`chcp 65001` 后输出 `Write-Output ("中文"+"测试")` 读回连续的「中文测试」（输入行里中文被拆开，所以只有真实输出能命中）；`Resize(120, 40)` 后 shell 自报 `SIZE=120x40`；shell 里 `Start-Process ping.exe -n 60` 起孙进程（root=36800、ping=1484），`Close()` 后根进程与孙进程均已退出
- **定案**：D1 选 ①，直调 `kernel32` 的 `CreatePseudoConsole` 系列，不引入第三方库、`go.mod` 不新增依赖（实现参照 mygo v0.8.3 `plugins/terminal/internal/pty/pty_windows.go`，该包在 `internal` 下无法 import，所以自写一份）
- **未覆盖，留给 S18**：本用例的孙进程挂在同一个伪控制台上，所以 `Close()` 能带走它；以 `DETACHED_PROCESS` / 新控制台独立启动的孙进程不在此列。`Kill()` 只 `TerminateProcess` 根进程（与 node-pty 的 pty.kill 不同，原版靠 `platform.killTree`），整树终止要在 S18 / S14 接 `taskkill /T` 同类逻辑。`Close()` 后 `Read` 返回 EOF 的路径本用例只隐式走过，S18 补显式断言

#### S03 产品名与数据目录定案（D3 / D4）

- **对照**：原版 `%APPDATA%\mile-terminal\`、窗口标题 `Mile Terminal`
- **产物**：`mygo.config.ts` 的 `name` / `identifier`、MIGRATION-PLAN §7 的 D3 / D4 结论
- **验收**：用户确认产品名、`identifier`、数据目录名；`CLAUDE.md`、`PRODUCT.md`、`README.md` 中的目录名与结论一致
- **证据**（2026-11-14）：用户确认沿用当前值：产品名 `Mile Console`、`identifier` `com.example.mileconsole`、数据目录 `%APPDATA%\mile-console\`。全目录 grep 核对：`mygo.config.ts`、`main.go`、`index.html`、`package.json`、`CLAUDE.md`、`PRODUCT.md`、`DESIGN.md`、`README.md`、`MIGRATION-PLAN.md` 中的名称与目录名均与结论一致，无需改动。D3 / D4 已写回 MIGRATION-PLAN §7

### B 契约

#### S04 `internal/contract` 类型包

- **对照**：`shared/types.ts`（843 行）、`shared/planner.ts`（366 行）；`shared/channels.ts` 只作对照，不生成 Go 代码
- **产物**：`internal/contract/*.go`（按领域分文件：`entry.go`、`group.go`、`planner.go`、`scanner.go`、`session.go`、`settings.go`、`log.go`、`transfer.go`）
- **逐字搬**：`CONFIG_VERSION = 16`、`PLANNER_VERSION = 1`、全部联合类型的字面量取值（`Framework`、`EntryStatus`、`LaunchMode`、`PackageManager`、`ServiceIcon`、`GroupEnvironment`、`MavenGoal`、`ThemePreference`）、`PROJECT_LINKS` 键与 URL、`orderGroups` 的排序规则
- **规则**：联合类型用 `Type string` + `omitempty`（BINDINGS-CONTRACT §1.3）；不用 `any`；时间用毫秒 `int64`；`shared/planner.ts` 里的纯函数（`pendingFires`、`boardStatus`、`localDate`、`taskDueTone`）不在这一步搬，留给 S12
- **验收**：`go vet ./...` 通过；每个联合类型写一个表驱动测试，枚举值与原版 TS 字面量逐个比对
- **证据**（2026-11-14）：
  - 产物：`internal/contract/` 下 `patch.go`、`session.go`、`log.go`、`scanner.go`、`settings.go`、`group.go`、`entry.go`、`runtime.go`（健康检查 / 识别 / 预检 / 运行态，从 entry.go 拆出）、`transfer.go`、`planner.go`，以及测试 `tsparse_test.go`、`enums_test.go`、`shape_test.go`、`patch_test.go`
  - 对拍方式：测试运行时直接解析原版 `src/shared/types.ts` / `planner.ts` 取期望值，不手抄。覆盖 23 个联合类型（含 planner 3 个）、6 个接口内联联合（`scanIntervalMs`、`externalTerminal`、两个 `tab`、`EntryHealth.state`、`readySource`）、6 个常量数组（`WEB_FRAMEWORKS`、`SERVICE_ICON_IDS`、`TASK_STATUSES`、`REPEAT_KINDS`、`LEAD_MINUTES`、`WEEKDAY_LABEL`）、9 个数字常量（含 `CONFIG_VERSION 16`、`PLANNER_VERSION 1`）、4 张标签 / 外链表、51 个结构体的 JSON 字段名同名同序，以及 6 个派生类型（`EntryEdit` = `EditableEntryField` 全集、`NewLaunchEntry` = `LaunchEntry` 去 id/order/createdAt 等）
  - 行为测试：`Patch[T]` 三态（没提 / null / 值）JSON 往返；`env` 合并补丁的 null 删除；`startAfter: []` 与 null 区分；`LaunchEntry` 与原版 JSON 往返一致；`OrderGroups` 置顶优先、同 order 稳定、不改入参；`IsWebFramework`
  - `go vet ./...` 通过；`go test ./... -count=1` 输出 `97 passed in 3 packages`，其中 contract 包 96 条子测试 PASS / 0 SKIP / 0 FAIL
  - 反向对照：临时测试文件在 `init` 里删掉 `Frameworks` 末项、交换 `LaunchSources` 前两项、把 `GroupEnvLabel[prod]` 改成「正式」、给 `LEAD_MINUTES` 加 120，恰好 Framework / LaunchSource / LEAD_MINUTES / 标签表四条变红；删掉临时文件后复跑全绿
  - 编码：14 个文件扫描无 BOM、无 U+FFFD、无 emoji
  - 设计取舍：`x: T | null` 用指针不带 omitempty；`x?: number|boolean` 用指针 + omitempty（0 / false 有意义）；可选数组用 `omitzero`（nil 省略、`[]` 原样写出）；`ScheduleRepeat` 判别联合扁平成 `{kind, days, day}`；`GroupPatch.order` 用 `float64`，因为原版对它做 `Math.trunc`，整数解码会把小数直接拒掉
  - 待核风险（S24/S25）：`mygo generate` 是否支持泛型 `Patch[T]` 与自定义 `MarshalJSON`/`UnmarshalJSON`；不支持时改为每种类型一个具名补丁类型，JSON 形状不变
  - 与原版的序列化差异：`EntryRuntime.autoRestart` 为 nil 时省略而不写 `null`，原版页面把两者都当「没有排队」，不影响行为

### C 纯逻辑叶子

#### S05 输出文本规则

- **对照**：`main/lib/outputText.ts`（69 行）
- **产物**：`internal/logs/outputtext.go` + `outputtext_test.go`
- **逐字搬**：`ANSI`、`CONTROL`、`CURSOR_TO_COL1`、`ERROR_RE`、`WARN_RE` 五个正则；函数 `stripAnsi`、`isErrorLine`、`lastVisiblePaint`、`visibleTail(raw, limit, maxChars = 300)`、`pickLastError`
- **注意**：JS 正则的 `\b` 在中文边界上与 Go RE2 的 `\b` 行为一致性要实测；`i` 标志写成 `(?i)`；转义序列一律写 `\x1b`，不敲字面 ESC 字节；不要用 shell heredoc 写这个文件
- **验收**：用原版函数生成期望值做对拍（`node` 跑原版 TS 产出 JSON 用例，Go 读同一份用例），覆盖：ConPTY 绝对光标定位、`\r` 进度条重绘取末段、`\r\x1b[K` 收尾、中文错误行、`EADDRINUSE`、`BUILD FAILURE`
- **证据**（2026-11-14）：
  - 产物：`internal/logs/outputtext.go`（`StripAnsi`、`CursorToNewline`、`IsErrorLine`、`IsWarnLine`、`LastVisiblePaint`、`VisibleTail` / `VisibleTailMax`、`PickLastError`），`internal/logs/outputtext_test.go`，用例生成器 `scripts/gen-outputtext-cases.mjs`，用例 `internal/logs/testdata/outputtext_cases.json`
  - 对拍方式：`node scripts/gen-outputtext-cases.mjs` 用 Node 22 的类型擦除直接 import 原版 `outputText.ts`（只读），把输入与原版输出写成 JSON（非 ASCII 一律 `\uXXXX`，文件是纯 ASCII）；Go 测试读同一份文件逐条比。用例数：分类 44（错误命中 24、警告命中 6，两边都有）、重绘 19、可见尾行 18、挑错误行 10、去 ANSI 6
  - 覆盖：ConPTY `\x1b[n;1H` / `\x1b[n;1f` 换行与 `\x1b[3;5H` 不换行、`\r` 进度条取末段、`\r\x1b[K` 收尾、OSC 以 BEL / ST 收尾、裸控制字符、中文错误 / 失败 / 警告、`EADDRINUSE`、`BUILD FAILURE`、`APPLICATION FAILED TO START`、`[A-Za-z]+(Exception|Error)` 类名、`\b` 在中文与 ASCII 之间的边界（`中文error中文` 两边一致判为错误）、npm / pnpm / yarn 收尾块降级、limit 为 0 与负数、maxChars 截在代理对中间
  - JS 与 Go 的语义差异（实测找到，已在实现里抹平，见文件头注释）：
    - JS 正则不带 `u` 标志时 `i` 只折叠 ASCII，Go 的 `(?i)` 还会让 U+017F 匹配 s、U+212A 匹配 k；用例 `listen EADDRINU` + U+017F + `E` 原版判为非错误行
    - JS 的 `trim` / `\s` 空白集合含 U+FEFF、不含 U+0085，与 Go `unicode.IsSpace`、RE2 `\s` 都不同
    - `String.slice` 按 UTF-16 码元截断；截在代理对中间时原版产生孤立代理项，Go 给 U+FFFD（经 JSON 到页面两者显示相同）
    - `Array.slice(-limit)`：limit 为 0 返回全部、为负从头丢掉 |limit| 项
  - `go vet ./...` 通过；`go test ./... -count=1` 输出 `102 passed in 4 packages`（logs 包 5 组对拍全过）
  - 反向对照：把 4 个 JS 兼容辅助函数换成朴素 Go 写法（不屏蔽折叠、`unicode.IsSpace`、按 rune 截断、limit≤0 返回空），空白、截断、limit 三类用例变红；折叠这一类第一轮没被抓到，补了上面那条 U+017F 用例后单独关掉 `jsFoldSafe` 复跑，该条变红。还原后全绿
  - 编码：4 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符（Write 工具会把 `\uXXXX` 转成字面字符，其中 U+FEFF 被 Go 编译器当成 BOM 报错，已改回转义形式）
  - 未做：入参按合法 UTF-8 处理；PTY 字节流解码（含截在多字节字符中间的块）归 S18 会话层

#### S06 semver 子集

- **对照**：`main/lib/semver.ts`（91 行）
- **产物**：`internal/precheck/semver.go` + 测试
- **逐字搬**：`satisfies(version, range) -> bool | null` 的三值语义（`null` = 范围写法不认识，预检降级为 warn 而不是 fail）
- **验收**：对拍用例覆盖 `^`、`~`、`>=`、`||`、`x` 通配、带 `v` 前缀、预发布版本、不认识的写法返回 `null`
- **证据**（2026-11-14）：
  - 产物：`internal/precheck/semver.go`（`Satisfies(version, rng) (ok, known bool)`，`known=false` 即原版 `null`）、`semver_test.go`、用例生成器 `scripts/gen-semver-cases.mjs`、用例 `internal/precheck/testdata/semver_cases.json`
  - 对拍方式：生成器用 Node 直接 import 原版 `semver.ts`（只读），对 46 个版本串 × 65 个 range 做笛卡尔积，共 1846 条，写入原版输出；Go 测试逐条比三值（true / false / null）。分布：true 425、false 755、null 666，三态都有
  - 覆盖：`^0.x` 锁次版本与 `^x.y` 锁主版本、`~`、`>=` / `>` / `<=` / `<`、`=`、`||` 分支、`x` / `*` 通配与省略段（`22`、`22.11`）、`v` 前缀、`x.y.z` 之后的预发布与构建元数据、空 range、只有 `||` 的 range、不认识的写法（`latest`、`lts/*`、`>=`、`^`）返回 null、`>=20 foo` 这类部分认识的交集、20 位以上大数、400 位的 `9` 串（Infinity 回退）、2^53+1 舍入、全角空格 / NBSP / NEL / LS / PS / U+FEFF 包在版本或 range 两侧
  - JS 口径对齐（实测需要）：切分与 trim 用 JS 空白集合（`jsIsSpace`，含 U+FEFF、不含 U+0085）；数字用 float64 与 JS `Number` 一致；`numOr` 对 Infinity 回退为 0，但段号 `Number(m[2])` 的 Infinity 不回退（原版行为）
  - `go vet ./...` 通过；`go test ./... -count=1` 输出 4 个包全部 ok，`TestSatisfiesMatchesOriginal` PASS（1846 条）
  - 反向对照（每条单独跑，各自确认能编译、测试失败、还原后全绿）：
    1. 去掉 `^0.x` 特殊规则 → `^0.0.3` 对 0.2.9 返回 true，原版 false，红
    2. `numOr` 不再回退非有限数 → `22.99…9`（超长次版本）结果不符，红
    3. 全角空格不再算空白 → `U+3000 18.0.0 U+3000` 版本两侧的全角空格导致 null 与 false 不符，红
  - 过程里的坑：第一版 `jsIsSpace` 的 Bash 写入把字面 U+2028 / U+2029 / U+FEFF 写进了 `switch`，Go 编译器报 BOM，Edit 工具也匹配不上，改用整函数按 char code 重写解决。反向对照第一轮我用了会让编译失败的改动，却只过滤了测试输出，这次改成单独确认编译与失败行后重做
  - 编码：`semver.go`、`semver_test.go`、生成器、用例 JSON 扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符；生成器里的正则 `[\u007f-￿]` 已经是转义形式，那次出现的字面 U+FFFF 已修
  - 未做：`satisfies` 只有 `engines.node` 比对会用到，`Satisfies` 在 S17 预检里接入；`semver` 的其他子集不在这一步范围内

#### S07 空闲端口探测

- **对照**：`main/lib/portScanner.ts`（35 行）
- **产物**：`internal/platform/freeport.go` + 测试
- **逐字搬**：`findFreePort(startPort, maxTries = 20)`、起点 `max(startPort, 1024)`、上限 65535；只在 `127.0.0.1` 试绑
- **已知问题**：I2（只测 IPv4）照原样搬，代码与测试都标注 `// 已知原版问题 I2，见 docs/MIGRATION-PLAN.md`
- **验收**：占住一个端口后返回下一个；起点低于 1024 时从 1024 起；全满返回 `null`；另写一条测试固定 I2 行为（`[::]:P` 被占时仍报空闲）
- **证据**（2026-11-14）：
  - 产物：`internal/platform/freeport.go`（`FindFreePort(ctx, start)`、`FindFreePortN(ctx, start, maxTries)`，未找到时 `ok=false` 即原版 `null`）、`freeport_test.go`、对拍探针 `scripts/probe-freeport.mjs`（node 直接跑原版 `portScanner.ts`，只读）
  - 范围逻辑：注入假探测函数，9 条表驱动用例同时断言返回值与实际探测过的端口序列：返回第一个空闲、起点 80 与 -5 从 1024 起、全满、窗口外的空闲不算、上限截到 65535、65535 本身可用、maxTries 为 0 与起点超过 65535 时一次都不探测
  - 真实试绑与原版对拍：在 127.0.0.1 占一个系统分配的端口，Go 与原版都跳过它（实测占 10646，两边都返回 10647）；窗口只有被占端口时两边都返回未找到
  - I2 固定：在 `[::1]` 占一个端口，先 `Dial` 确认前提成立（端口确实被占），再断言 Go 与原版都报它空闲（实测 `[::1]:10648`）。用 `[::1]` 而不是验收里写的 `[::]`：监听所有地址会弹 Windows 防火墙询问，`[::1]` 走的是同一条缺陷路径（只测 IPv4）
  - 与原版的差异：加了 ctx，取消后不再探测（原版没有取消入口），有单测覆盖；错误不区分错误码，与原版 `once('error')` 一致
  - `go vet ./...` 通过；`go test ./... -count=1` 5 个包全部 ok，platform 包 13 条（含 9 条子用例）全过
  - 反向对照（各自单独跑，都能编译）：在 `isPortFree` 里顺手修 I2（同时试绑 `[::1]`）→ I2 测试变红并提示「修 I2 时同步改这条测试」；去掉 1024 下限 → 「起点低于 1024」用例变红，探测序列变成 `[80 81 82]`。还原后全绿
  - 编码：3 个文件扫描无 BOM、无 U+FFFD、无不可见字符

#### S08 平台适配层

- **对照**：`main/platform/types.ts`（110 行）、`win32/index.ts`（164）、`win32/process.ts`（139）、`win32/powershell.ts`（42）、`win32/terminal.ts`（100）
- **产物**：`internal/platform/platform.go`（接口）、`internal/platform/win32/*.go`
- **逐字搬**：`SHELL_CANDIDATES`、`PS_CANDIDATES`、`META_SCRIPT`（CIM 查询脚本原文）、`WIN_TERMINALS`、`EXTERNAL_TERMINAL_TITLE = 'Mile Terminal'`（待 D3 定案后再定是否改名）、`hbuilderxCandidates` 的路径列表与 `MILE_HBUILDERX_CLI` 覆盖、`wrapBatch` 形状 `cmd.exe /d /s /c <file> <args...>`、`runPowerShell` 默认 8000ms 超时、`readListenPorts` 4000ms、`readProcessMeta` 15000ms
- **红线**：`wt.exe` 是应用执行别名，用 `os.Lstat` 判存在，不用 `os.Stat`；外部终端的目录只走 `cmd.Dir`，**从不进命令行**（wt 把 `;` 当子命令分隔符、cmd 会解释 `&` `|`）；所有调用 `exec.CommandContext(ctx, file, args...)`
- **范围**：只做 win32；darwin 不迁（D5），接口保留，便于以后补
- **验收**：`netstat -ano` 解析用合成输出做表驱动测试，覆盖同端口两个 PID（`0.0.0.0:P` 与 `[::]:P`），断言两行不合并（去重键 `pid:port`）；外部终端拦截 `exec` 只断言 argv 与 `Dir`，不真弹窗口（`verify-review-extterm`）
- **证据**（2026-11-14）：
  - 产物：`internal/platform/platform.go`（接口与数据结构）；`internal/platform/win32/` 下 `win32.go`（index.ts）、`process.go`、`powershell.go`、`terminal.go`，`sys.go`（系统依赖可注入），`jsx.go`（原版靠 JS 内置函数的部分按 JS 语义实现：`Buffer.toString('utf8')`、`trim` 与 `\s`、`Number()`、`toLowerCase` 含 Final_Sigma、`path.win32.resolve/normalize/join` 逐行移植 node 22 源码）
  - 对拍方式：`scripts/platform-hooks.mjs` 用 `module.registerHooks` 让 node 直接加载原版 `win32/*.ts`，把 `node:child_process` 与 `node:fs` 换成桩（不起进程、不看真实磁盘），原版文件不改。两个生成器 `gen-win32-text-cases.mjs`、`gen-win32-platform-cases.mjs` 跑原版写出 `testdata/*.json`（纯 ASCII），Go 测试读同一份比对
  - 用例规模：netstat 12 组 62 行（含一份本机真实 `netstat -ano` 原始字节，GBK 表头）；readProcessMeta 17 组；pathKey 190 组（5 种 cwd）；外部终端 630 组（7 种环境 × 9 种 kind × 10 种目录：拉起 114 次 argv 与 Dir 逐项相同，拒绝 516 次文案相同）；runPowerShell 80 组（argv、8000ms、8MB、stderr 文案）；采集超时 4000ms / 15000ms、killTree 5000ms；常量表与 `META_SCRIPT` 逐字比对；`toLowerCase` 全码点表、Final_Sigma 两个集合全码点、`\s` 全表、`Buffer` 解码 41 组、`Number()` 54 组
  - 验收硬项：`TestParseNetstatSamePortTwoPids`（`0.0.0.0:3000` pid 100 与 `[::]:3000` pid 200 两行不合并；同 PID 双栈合并为 families [4, 6]）；`TestOpenExternalTerminalRedLines`（wt 只在 Lstat 可见时找得到；目录含 `& ; |` 时只走 `Dir`，argv 为 `/d /c start "Mile Terminal" <wt> -d .`）
  - `go vet ./...` 通过；`go test -count=1 ./...` 7 个包 141 条全部通过
  - 反向对照：每处单独改、单独跑、改完还原。17 处变红：去重键只用端口、wt 改用 Stat、目录不走 Dir、目录进命令行、netstat 超时改 5000、meta 超时改 8000、META_SCRIPT 改一个字、PID 门槛改 `<= 3`、LISTENING 用 Go 大写折叠、UTF-8 解码改成逐字节替换、去掉 Final_Sigma、空白集合漏 U+FEFF、HBuilderX 空串也算覆盖、wrapBatch 去 `/s`、killTree 去 `/T`、默认 shell 不缓存、UNC 不拒绝。另有 2 处仍是绿的，原因已查明：(1) LISTENING 改成 `strings.ToLower` 后再比，Go 的 ToLower 不把 U+017F 折成 s，在这里与 JS 的 `/i` 等价，属于等价变异；(2) `ReadListenPorts` 里的解码换成 `strings.ToValidUTF8` 没被抓到，因为对拍直接调 `parseNetstat`，不经过 `ReadListenPorts` 的解码那一行。解码函数本身由 `TestJSDecodeUTF8MatchesBuffer` 覆盖，这一处的接线留了缺口，未补。首轮有 3 次对照无效（2 次编译失败、1 次没匹配到原文），已换写法重做
  - 真机冒烟（`MILE_REAL_PLATFORM=1`，只读）：netstat 37 行，含测试进程自己监听的 `127.0.0.1:P`；CIM 497 个进程、当前用户 287 个 PID，测试进程本身在内且带启动时间与命令行
  - 新登记原版问题 I3（MIGRATION-PLAN §5）：PowerShell 5.1 / netstat 管道输出是 GBK，原版按 UTF-8 解码。真机实测 497 行里 7 行的命令行或路径含 U+FFFD。照原样搬，等用户决定修法
  - 与原版的差异（已在代码注释登记）：`readProcessMeta` 按声明类型解码，`procs` 里出现非对象元素时报错（原版照收），`META_SCRIPT` 的输出不会出现这种情况；`=C:` 驱动器当前目录变量在 node 与 Go 里都读不到，两边行为一致；`runPowerShellJson` 在 `src/main` 没有调用点，不迁
  - 编码扫描：21 个文件无 BOM、无 U+FFFD、无不可见字符、无 emoji，testdata 是纯 ASCII

### D 存储

#### S09 ConfigStore

- **对照**：`main/services/ConfigStore.ts`（302 行）
- **产物**：`internal/config/store.go`、`migrate.go`、`persist.go` + 测试
- **逐字搬**：`CONFIG_VERSION = 16`、`MAX_IGNORED_LISTENERS = 500`、`DEFAULTS` 全部字段与默认值；迁移链 12 个显式分支（`from < 2/3/4/5/6/9/10/11/13/14/15/16`，v7、v8、v12 只推进版本号）；迁移后的数组校形；外部终端取值按平台回落（每次启动都做，不只在迁移时）
- **写盘顺序**：先把当前主文件复制成 `.bak`，再写 `config.json.<pid>.tmp`，再 rename 换上。顺序不能反
- **恢复**：主文件读不出、`.bak` 读得出 → 坏主文件挪成 `.corrupt` → 用 `.bak` 内容写回主文件，这一次**跳过备份**（否则坏文件会覆盖唯一的良好版本）
- **已知问题**：C2（只读模式下 `persist()` 静默 return）照原样搬并标注。对照：S12 的 PlannerService 在同样场景下是抛错，两者不同，不要顺手统一
- **红线**：不用 `{...DEFAULTS, ...raw}` 式铺开代替版本分支，否则版本号永远停在旧值；JSON 写出 UTF-8 无 BOM、2 空格缩进
- **验收**（`verify-m9`、`verify-m9-readonly`、`verify-m9-recover`）：v1 到 v16 每一步各一组输入输出；坏主文件 + 好 `.bak` 恢复后 `.bak` 内容不变；两份都坏时只读且不落盘；v14 前手塞的 `autoRestart` 被丢掉；v15 的非布尔 `pinned` 被丢掉；测试一律用临时目录，不碰真实 `%APPDATA%`
- **证据**（2026-11-14）：`go test -count=1 ./internal/config/` 11 条全部 PASS（TestMigrateMatchesOriginal、TestMigrateKeySteps、TestBootMatchesOriginal、TestPatchSequenceMatchesOriginal、TestPersistOrderAndFormat、TestRecoverKeepsBackupUntouched、TestRecoverWhenCorruptRenameFails、TestReadOnlySilentlyDropsWrites、TestBackupBeforeImportMatchesOriginal、TestGetReturnsCopy、TestDataDirName）。迁移链 60+ 组对拍含 v1→v16 全链、类型回落偏差 1 组；启动场景 15+ 组含主+备各好坏组合、只读、导入前备份；写盘顺序、原子写、.bak 不被坏文件覆盖。`go vet ./...` 通过。

#### S10 窗口状态

- **对照**：`main/lib/windowState.ts`（106 行）
- **产物**：`internal/window/state.go` + 测试
- **逐字搬**：`MIN_WIDTH = 1180`、`MIN_HEIGHT = 760`、默认 1440×900、`MIN_VISIBLE = 100`、`DRIFT_TOLERANCE = 8`；文件名 `window-state.json`，独立于 `config.json`，不参与 `.bak` 轮转
- **验收**（`verify-review-window`）：坐标落在所有屏幕工作区外时丢弃（交给系统居中）；宽高小于最小值时抬到最小值；保存时与上次差 8px 以内不写盘；文件坏了返回默认值且不影响 config
- **注意**：屏幕枚举走 `mygo.Screen.Displays`，先在本机 v0.8.3 源码确认 API 存在
- **证据**（2026-11-14）：
  - 产物：`internal/window/state.go`（245 行）+ `internal/window/state_test.go`（272 行）
  - 常量逐字搬：MinWidth=1180、MinHeight=760、DefaultWidth=1440、DefaultHeight=900、MinVisible=100、DriftTolerance=8、StateFileName="window-state.json"
  - `WindowState.X/Y` 用 `*int` + `json:"x,omitempty"` 保留「未设置 vs 0」区分（对齐原版 `x?: number` 与 `lastSaved.x !== undefined` 判定）
  - `DisplayRect{X,Y,Width,Height}` 对齐 Electron `Display.workArea`，由调用方传 `[]DisplayRect`（S32 接 `mygo.Screen.Displays`）
  - `LoadWindowState(dir, displays)`：读 + unmarshal JSON；任何错 / 文件缺失 / 非对象 / 损坏 → 返回 `defaultState()` 与 nil 错（对齐原版 try/catch → defaults）
  - `SaveWindowState(dir, prev, next)`：DriftTolerance（≤8px）同时作用于尺寸与坐标；state 与 prev 在容差内相等 → 返回 `(false, nil)`；否则 MkdirAll + 写 `<file>.<pid>.tmp` + `os.Rename` 原子写
  - 平台无关，不带 `//go:build windows`；JSON 用 `json.Encoder` + `SetEscapeHTML(false)` 写 UTF-8 无 BOM
  - `go test -count=1 -v ./internal/window/` 14 条全过：TestLoadCoordsOutsideAllDisplays、TestLoadCoordsOnSecondDisplay、TestLoadBelowMinSizeRaised、TestSaveDriftWithinToleranceSkipsWrite、TestSaveDriftExceedsToleranceWrites、TestSaveDriftInSizeOnlyKeepsPosition、TestLoadCorruptFileReturnsDefault、TestLoadNonObjectReturnsDefault、TestLoadMissingFileReturnsDefault、TestSaveCreatesDir、TestSaveAtomicNoTmpLeft、TestRoundtripFieldNames、TestFiniteNaNInf、TestNear
  - `go vet` 干净

#### S11 主题与工作组

- **对照**：`ThemeService.ts`（36 行）、`GroupService.ts`（128 行）
- **产物**：`internal/theme/theme.go`、`internal/groups/groups.go` + 测试
- **逐字搬**：`SAFE_GROUP_NAME`（含中文与全角区段的原正则）、`VALID_ENVS = dev / sandbox / prod`；主题偏好 `light / dark / system`；排序走 S04 搬好的 `orderGroups`
- **行为**：删除工作组时清掉所有 `entry.groupId === id`；Theme 用 `mygo.Theme.SetSource`，必须在建窗前调用
- **验收**（`verify-grouporder`、`verify-groupcollapse`）：名称白名单边界（40 字符、空串、控制字符）；置顶组排在前；删组后条目 `groupId` 清空
- **证据**（2026-11-14）：
  - 产物：`internal/theme/theme.go`、`internal/groups/groups.go` + `internal/groups/groups_test.go`
  - `theme.go`：`SAFE_THEME_PREFS`（`light`/`dark`/`system`）、`Validate(ThemePreference) (ThemePreference, error)`（非法值给中文错）、`State(preference, resolved) ThemeState` 装配 `contract.ThemeState`；不带 `GetNativeTheme()` stub，`mygo.Theme.SetSource` 真实接线归 S24/S32 装配层
  - `groups.go`：`SAFE_GROUP_NAME = ^[\w\x{4e00}-\x{9fa5}\x{3000}-\x{303f}\x{ff00}-\x{ffef} _-]{1,40}$` 逐字照搬（`\w` 在 JS（不带 u 标志）与 Go 均为 ASCII 子集）；`VALID_ENVS = dev/sandbox/prod`、`controlCharRE` 禁控制字符；`ValidateGroupName` / `SanitizeName` / `SanitizeDesc` / `SanitizeEnv` / `SanitizePatch`；`CreateGroup` / `EditGroup` / `RemoveGroup` / `ReorderGroups` 纯函数返回新切片，调用方负责落盘；`RemoveGroup` 同时清掉所有 `LaunchEntry.GroupID === id`；`OrderGroups` 复用 S04 `contract.OrderGroups` 不重复实现
  - 10 条测试全过：TestGroupNameValidation（中文/英文/全角/边界 40 字 + 空串/超 40/控制字符/emoji/特殊符号）、TestOrderGroupsPinnedFirst、TestOrderGroupsStable、TestSanitizeName、TestSanitizeDesc、TestSanitizeEnv、TestCreateGroup、TestEditGroup、TestRemoveGroupClearsEntries、TestReorderGroups
  - `go test -count=1 -v ./internal/groups/ ./internal/theme/` 10 passed；`go vet` 干净
  - 三个文件 UTF-8 无 BOM、无 U+FFFD；groups_test.go 第 43 行 `"emoji\U0001F389"`（源码里是转义写法） 是合法测试数据（验证 emoji 被 `ValidateGroupName` 拒绝），非编码异常

#### S12 进度与日程

- **对照**：`PlannerService.ts`（696 行）+ `shared/planner.ts` 的纯函数（`isValidDate`、`localDate`、`daysBetween`、`boardProgress`、`boardStatus`、`taskDueTone`、`isValidTime`、`scheduleMoment`、`timeOfDay`、`repeatMatches`、`pendingFires`）
- **产物**：`internal/planner/store.go`、`schedule.go`、`service.go`、`boards.go`、`schedules.go`、`tick.go`、`sanitize.go`、`jsvalue.go` + 测试（卡片原写的 `calc.go` 没有单独成文件，纯函数都在 `schedule.go`）
- **逐字搬**：`PLANNER_VERSION = 1`、`MAX_TASKS_PER_BOARD = 500`、`MAX_BOARDS = 200`、`TASK_TITLE_MAX = 120`、`NOTE_MAX = 2000`、`SCHEDULE_TITLE_MAX = 120`、`MAX_SCHEDULES_PER_BOARD = 200`、`LEAD_MINUTES = [0, 5, 15, 30, 60, 1440]`、`SOON_DAYS = 3`、`MISS_AFTER_MS = 1 小时`、`MAX_MISSED = 200`、`TICK_MS = 30000`、`CONTROL` 正则
- **开发期覆盖**：`MILE_PLANNER_TICK_MS` 与 `MILE_PLANNER_NOW` 只在开发构建生效，打包后忽略（原版用 `app.isPackaged` 判断，Go 侧用构建标签或 mygo 的开发标志）
- **存储**：`planner.json` 与 config 同一套原子写、`.bak`、`.corrupt` 规则；只读时**抛错**（`进度数据文件读不出来，这次运行不会保存改动…`），不是静默丢弃
- **验收**（`verify-planner-board`、`verify-planner-remind`、`verify-planner-missed`）：`pendingFires` 覆盖每种重复规则 × 每档提前量 × 跨日 / 跨周 / 工作日；错过超过 1 小时进 missed；missed 上限 200；`id`、时间戳、`doneAt` 全由 Go 生成，入参里带了也忽略
- **证据**（2026-11-14）：
  - 产物：`internal/planner/store.go`（planner.json 持久化：boot 读主文件 / `.bak` 恢复 / `.corrupt` 旁存 / 原子写 / 只读抛错）、`internal/planner/schedule.go`（11 个纯函数：IsValidDate、LocalDate、DaysBetween、BoardProgress、BoardStatus、TaskDueTone、IsValidTime、ScheduleMoment、TimeOfDay、RepeatMatches、PendingFires、NextFireAt）、`store_test.go` + `schedule_test.go`
  - 对拍方式：`scripts/gen-planner-cases.mjs` 用 Node 直接 import 原版 `shared/planner.ts`（只读）生成 `internal/planner/testdata/planner_cases.json`（ASCII），Go 测试读同一份比对；范围 isValidDate 27、isValidTime 18、localDate 12、timeOfDay 12、daysBetween 8、boardProgress 15、boardStatus 15、taskDueTone 10、scheduleMoment 7、repeatMatches 143、pendingFires 19、nextFireAt 8，共 274 条全过
  - pendingFires 覆盖：单次 / daily / workdays / weekly[days] / monthly[day=14/31]、提前量 0 / 15 / 30 / 1440 分钟、跨日 / 跨周 / 跨月（31 号在 2 月落到 28/29）/ 跨年、暂停、until 合法与非法、窗口在触发前 / 后 / 重叠
  - migrate 校形：board 缺 id / groupId / 非对象整条丢、order 重编、startDate / endDate 非法置空；task 缺 id / title / status 或 status 非白名单整条丢、doneAt 非整数丢；schedule 缺 id / 非法 date / 非法 time 整条丢；missed 缺四字段之一整条丢、slice(-200)；「persist 失败时 cache 已被替换」与原版 commit 顺序对齐
  - 只读语义与 ConfigStore 的 C2 对齐原版差异：planner 的 Patch 在 readOnly 时抛错（原版 commit 主动 throw），persist 自身仍是静默 return 由上层把关，与原版一致；有专项测试 `TestReadOnlyPatchThrows` 固定
  - TestMain 锁 time.Local 到 Asia/Shanghai，保证与生成器同一时区口径
  - `go vet ./internal/planner/` 通过；`go test -count=1 ./internal/planner/` 30 条全部 PASS；`go test -count=1 ./...` 12 个包 206 条全部 PASS
  - 与原版的偏差：JSON 输出上 `missed:[]` 与「没有 missed 字段」的差异 —— `contract.PlannerData.Missed` 用 `omitzero`，与原版「有 missed 数组字段时写 []」不同；读入两侧等价，序列化差异沿用 S04 已登记的偏差口径
  - 编码：4 个文件扫描无 BOM、无 U+FFFD、无 emoji；用例 JSON 是纯 ASCII
  - 第一轮未做的部分（服务方法、tick、校形、开发钩子）当时误标为 [x]，复核后改成部分完成，第二轮补齐，见下
- **证据·第二轮**（2026-11-14，服务层补齐）：
  - 产物：`internal/planner/service.go`（Service、Options 注入 Dev / Getenv / Wall / NewID / OnChanged / OnReminder、commit、board / assertGroup / groupName、rankSort）、`boards.go`（AddBoard / EditBoard / ReassignBoard / RemoveBoard / ReorderBoards / AddTask / EditTask / RemoveTask / ReorderTasks）、`schedules.go`（AddSchedule / EditSchedule / RemoveSchedule / CompleteScheduleTask / DismissMissed / ClearMissed / PauseSchedulesOfGroup）、`tick.go`（MissAfterMs、DefaultTickMs、devOverrides、dateParse、Now、StartScheduler / Dispose / Tick、firePayload）、`sanitize.go`（CONTROL 正则逐字搬、sanitizeText / Date / BoardPatch / TaskInput / Ids / Repeat / ScheduleInput、findTask / findSchedule、assertRange / assertScheduleRange）、`jsvalue.go`（入参保持 `json.RawMessage`，按 JS 语义判 typeof、`Number()`、`trim`、UTF-16 `length`）
  - 绑定层入口：方法收 `json.RawMessage`，与原版收 `unknown` 同形；S24 包绑定时直接透传，不再自己校形。事件在锁外同步发出（changed 先于 reminder），回调里重入服务不会死锁
  - 对拍：`scripts/gen-planner-service-cases.mjs`（`node --experimental-transform-types` 运行，原版构造函数用了参数属性）跑原版 `PlannerService` 生成 `internal/planner/testdata/planner_service_cases.json`（ASCII，1.4 MB）。桩：electron（临时目录、`isPackaged`）、`node:crypto`（`randomUUID` 给 `id-1`、`id-2`……，`scripts/platform-stub-crypto.mjs`）、ConfigStore（只有 `get()`）、`Date.now`。场景分三个文件 `scripts/planner-scenarios-{crud,sched,tick}.mjs`：18 个场景 1204 步，每步比对返回值或错误文案、执行后快照、changed 次数、reminder 内容，最后比对磁盘上的 `planner.json`（只读场景还比对 `.bak` 原文）。另有 53 组 `MILE_PLANNER_TICK_MS` / `MILE_PLANNER_NOW` / 打包与否的组合
  - 覆盖：看板上限 200、任务上限 500、日程上限 200、ids 上限；工作组 id 空 / 超 64 / 不存在 / 重复；日期 null 与空串清空、非法日期、范围倒置；文本 trim（U+FEFF、U+3000、U+00A0、U+2028 算空白，U+0085 不算）、UTF-16 长度（补充平面字符算 2）、控制字符与换行；repeat 37 种输入（weekly 去重排序、`Number()` 对字符串 / 数组 / 布尔 / null / 0x 前缀的转换、monthly 1–31）；leadMinutes / stopWhenTaskDone / paused / snoozeUntil 类型校验；dismissMissed 的 at 严格相等；tick 的准点、提前量、晚 59 / 60 / 61 分钟（恰好 1 小时仍弹，超过才进 missed）、两周积压、每月 31 号、snooze 到点重弹与暂停中不弹、plannerNotify 关闭、关联任务完成或取消后停止、工作组已删除的组名、missed 上限 200 取最后 200 条、无变化不写盘
  - 验收硬项另写成单测（`service_extra_test.go`）：`TestServerGeneratedFields`（id、createdAt、order、doneAt、lastFiredAt、snoozeUntil 入参一律忽略）、`TestReadOnlyServiceThrows`（只读时写操作抛原版文案、磁盘不变、tick 静默返回）、`TestSchedulerStartStop`（立刻查一次、重复启动无效、Dispose 与 ctx 取消都能停）、`TestCallbacksMayReenter`
  - 新发现的原版问题：I4（编辑日程时补丁不带 title 就把标题清空）、I5（新建日程不查 until 早于 date），按原样搬并有专项测试，登记在 MIGRATION-PLAN §5
  - 新登记的偏差（MIGRATION-PLAN §6）：值为 undefined 的键、snoozeUntil 小数向上取整、`MILE_PLANNER_NOW` 只实现 ISO 8601、孤立代理项
  - 开发钩子：`Options.Dev` 由绑定层传 `mygo.IsDev()`（`mygo build` 打包后为 false，两个变量都不读）
  - 补测后对拍扩到 21 个场景 1551 步：新增重复 id 取最后一次、状态没变不刷新 doneAt、leadMinutes 小数、循环中途因任务完成暂停、只有收尾暂停的一轮也写盘、I6 一周逐小时 tick
  - 反向对照（临时脚本逐条改坏源码跑 `go test`，结束后恢复原文）：第一轮 59 条，43 RED、5 BUILD-ERR、11 GREEN；补用例并把 BUILD-ERR 改成能编译的写法后重跑其中 15 条（已知等价的「去掉 missed 判断」不重跑），12 RED、3 GREEN。最终剩下 4 条存活，都是等价变异：
    - 「去掉 `len(missed) == 0` 判断」：有 missed 必然 dirty，这个条件原版本身就是冗余的
    - 「不跳过 `lastFiredAt == f.at`」：窗口从 `lastFiredAt + 1` 开始，`pendingFires` 不会返回等于 `lastFiredAt` 的时刻，原版这行也是冗余的
    - 「空备注不清空」与「-000000 年合法」：空备注在 `applyField` 里存成空串，与清空在 JSON 上都是省略 `note`；`-000000` 年按公元 0 年算出的毫秒数是负数（-62167219200000），`Now()` 只认大于 0 的值，回落到真实时钟，与原版 NaN 回落结果相同
  - 发现原版问题 I6（每天重复 + 提前 1 天只隔天弹一次）：反向对照里「from 不加 1」最初是 GREEN，追下去发现的。原版实测登记在 MIGRATION-PLAN §5，有专项测试与对拍场景
  - `go vet ./...` 干净、`gofmt -l internal/` 为空、`go test -count=1 ./...` 全部通过；`internal/planner` 60 条
  - 编码：新增与改动的 8 个 Go 文件、7 个脚本、2 份文档扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符；用例 JSON 是纯 ASCII。顺带把两份文档里 S10 / S11 留下的字面 U+2028、U+3000、emoji 改成码点写法

### E 扫描与归属

#### S13 启动来源推断

- **对照**：`main/lib/attribution.ts`（82 行）
- **产物**：`internal/scanner/attribution.go` + 测试
- **逐字搬**：`MAX_ASCENT = 12`；导出 `traceLaunchSource`、`classifyGroup` 两个函数的判定顺序与分组名
- **红线**：结果只用于展示徽标与分组，**不参与 kill 授权**；Go 侧不给 Ownership 包任何对 attribution 的 import
- **验收**：合成进程表做表驱动测试：正常父链、父链成环、超过 12 层截断、父进程已退出
- **证据**（2026-11-14）：
  - 产物：`internal/scanner/attribution.go`（`MaxAscent`、`TraceLaunchSource(t, pid, byPid, owned)`、`ClassifyGroup(t, row, ownership, entryID)`），`attribution_test.go`，用例生成器 `scripts/gen-attribution-cases.mjs`，用例 `internal/scanner/testdata/attribution_cases.json`（纯 ASCII）
  - 与原版的形状差异：原版从模块级 `platform.attribution` 取进程名表，Go 由调用方传入 `platform.AttributionTables`（S08 已搬并对拍）；`row` 的 undefined 用 nil，`entryId` 的 undefined 用空串（原版两者都是假值，判定相同）
  - 对拍方式：生成器经 `platform-hooks.mjs` 直接 import 原版 `attribution.ts`（只读），Go 读同一份用例。规模：手写场景 46 组、确定性伪随机进程表 600 组（1–16 个进程，含成环、自指、父不在表里、ppid 0/1/4/5、owned、起点不在表里），`classifyGroup` 204 组（17 种 row × 4 种 ownership × 3 种 entryId）。10 个来源取值都有用例命中，测试里断言了这一点
  - 验收硬项另写成独立断言（`TestTraceLaunchSourceKeySteps`）：正常 npm 链跳过中间层到 vscode、owned 直接 mile、三点成环在 12 层后停、父进程已退出为 unknown、第 11 层的来源找得到而第 12 层找不到、中间层 node 的命令行不参与判定
  - JS 语义：名字、命令行、执行路径的小写化用 `jsToLower`（逐字复制 S08 `jsx.go` 里已过全码点对拍的实现，win32 包里是未导出的）。用例 `anthrop` + U+0130 + `c` 证明差异真实存在：原版不认，`strings.ToLower` 会认成 claude
  - 红线：`TestOwnershipDoesNotImportScanner` 解析 `internal/ownership/*.go` 的 import，发现依赖 scanner 包即失败；S14 之前目录不存在，测试 SKIP，迁过来后自动生效（空目录会判失败，不会静默通过）
  - `go vet ./...` 通过；`go test -count=1 ./...` 输出 `209 passed in 13 packages`
  - 反向对照（脚本逐条改源码、单独跑、还原；改完 `go test` 复跑全绿）：15 处变异全部变红 —— MaxAscent 改 11、起点也算来源、到顶门槛 `<= 4` 改 `< 4`、去掉自指判断、不跳过中间层、名字 / 命令行各自换成 `strings.ToLower`、命令行规则先于名字、空命令行也参与匹配、分组忽略 entryId、忽略系统目录、执行路径不转小写、开发运行时不转小写、row 为 nil 归 mine、去掉 U+0130 展开。首轮有 3 处没抓到（`< 4`、命令行 `strings.ToLower`、空命令行），各补了用例（pid 3 / 4 / 5 在表里、命令行里的 U+0130、`commandLine: ''` 的父进程是来源）后重跑变红；「命令行先于名字」首轮写法编译失败，换写法重做
  - 编码：4 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符
  - 顺带（不改行为）：`gofmt -w internal/` 整理了 S09–S12 留下的 6 个文件的对齐；`groups_test.go` 里字面的 emoji 与 U+3000、`groups.go` 注释里的字面 U+3000 改成转义或码点写法（项目约定：源码不写 emoji、不写字面不可见字符）

#### S14 进程归属判定

- **对照**：`OwnershipService.ts`（125 行）
- **产物**：`internal/ownership/ownership.go` + 测试
- **逐字搬**：`MAX_ASCENT = 12`、`REGISTER_SLACK_MS = 5000`、`SAME_PROCESS_MS = 1000`；方法 `issueToken`、`register`、`unregister`、`verify`、`assertKillable(pid, table, sessionId)`、`hasTracked`；父链上溯在 `row.ppid <= 4` 时停（Windows 的 System / Idle）
- **判定**：运行 token、进程组、当前用户三项同时成立才放行。根进程是否仍是我们起的那个（`rootStillOurs`）用创建时间比对：登记前后 `REGISTER_SLACK_MS` 内、同一进程容差 `SAME_PROCESS_MS`
- **红线**：`assertKillable` 的第三个参数必须传，PID 命中的会话必须就是要停的会话；kill 前用 ≤3 秒新鲜的进程表重验（PID 复用）；token 只在本包与 Session 之间流动，不进 contract 包
- **验收**（`verify-review-ownership`、`verify-m9`）：照抄 `verify-review-ownership.cjs` 的合成进程表用例，逐条比对放行 / 拒绝；额外覆盖 PID 复用（同 PID、创建时间不同）被拒、会话 id 不匹配被拒
- **证据**（2026-11-14）：
  - 产物：`internal/ownership/ownership.go`（`MaxAscent`、`RegisterSlackMs`、`SameProcessMs`；`New(now)`、`IssueToken`、`Register`、`Unregister`、`Verify`、`AssertKillable`、`HasTracked`），`ownership_test.go`，用例生成器 `scripts/gen-ownership-cases.mjs` + 场景 `scripts/ownership-scenarios.mjs`，用例 `internal/ownership/testdata/ownership_cases.json`（纯 ASCII）
  - 与原版的形状差异（不改判定）：`Verify` / `AssertKillable` 收 `platform.ProcessMeta`（原版收 `ProcessTable`，只用到其中的 `byPid` 与 `mine`；调用方传 `table.ProcessMeta`）；`AssertKillable` 同步返回 `(verdict, error)`（原版 async，内部没有 await）；登记时刻由注入的时钟给，测试用假时钟；整个服务一把锁，`Verify` 会钉住 `rootCreatedAt`，读也加锁
  - JS 语义：登记表用「有序切片 + 索引」复刻 Map 插入顺序，重登同一会话位置不变、值替换（钉住的创建时间随之清空）；同一 rootPid 被多个会话登记时后者覆盖前者；`!rootAt` / `!!at` 对缺字段与 0 都为假，负数为真
  - 对拍：生成器经 `platform-hooks.mjs` 直接 import 原版 `OwnershipService.ts`（只读，只桩 `Date.now`），Go 逐步重放比对整个判定结果与错误文案。19 个场景、138 步：前五组照抄 `verify-review-ownership.cjs`（根未变、根 PID 复用、首次观察已复用、子早于根、assertKillable 绑定会话），其后是空登记表、foreign 优先于进程组、父链停止条件（ppid 0 / 3 / 4 / 5 / -1、自环、互为父子、断链、被查 PID 不在表里）、上溯 10 / 11 / 12 / 13 层、创建时间缺失 / 0 / 负数、`REGISTER_SLACK_MS` 与 `SAME_PROCESS_MS` 两侧边界（含被拒后不钉、子进程下界跟钉住值而非本次读数）、重复根与重登顺序、注销后重登、嵌套会话（内层根校验失败不再向上找外层）、错误文案（含空会话 id、中文会话 id、foreign / external 两种）。测试断言五个操作都有用例命中
  - 验收硬项另写成独立断言：`TestPidReuseRejected`（根与其子进程在 PID 复用后都拒绝）、`TestSessionMismatchRejected`（逐字比对文案）、`TestIssueToken`（与原版样本同为 v4 UUID 格式、100 次不重复）、`TestTokenNeverInVerdict`（`OwnershipVerdict` 没有装 token 的字段，登记的 token 不出现在序列化结果里）、`TestConcurrentVerify`（8 协程交错登记 / 判定 / 注销；本机无 cgo，`-race` 不可用）
  - 红线：`TestDoesNotImportScanner` 限定本包只 import `crypto/rand`、`fmt`、`sync`、`time`、`contract`、`platform`；`internal/scanner` 的 `TestOwnershipDoesNotImportScanner` 从 SKIP 变为 PASS。「kill 前用 ≤3 秒新鲜的进程表重验」由调用方保证（S15 `VERIFY_MAX_AGE_MS`、S18 `doKill`、S16 `stop`），本包不管表的新鲜度，与原版一致
  - `go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 247 PASS / 0 FAIL / 2 SKIP（SKIP 为既有的环境相关用例，与本步无关）
  - 反向对照（脚本逐条改源码、单独跑、还原；改完复跑全绿）：29 处变异 26 处变红 —— 三个常量各 ±1、`<= 4` 改 `< 4` / `<= 5`、不判 foreign、token 对非根也 hit、不验根、每次重钉、不查登记宽限、不查 PID 复用、复用只查单向、不查子早于根、子缺时间也信、子下界跟本次读数、0 当真值、不查会话、不查归属、重登挪到末尾、重复根取第一个、注销不删索引、hasTracked 恒真、UUID 版本位。首轮 `<= 5`、子缺时间也信、注销不删索引三处没抓到，补了用例（登记根为 5、根创建时间小于 1000 时子缺时间、注销后重登）后变红；两处首轮写法编译失败，换写法重做。存活的 3 处是等价变异：去掉自环判断（自环会原地走满 12 层再返回 null，结果相同）、去掉「缺行」判断（Go map 缺键返回零值 ppid 0，被 `<= 4` 拦下）、去掉 `token == hit ||`（token hit 必然有 root，进程组必然 hit，原版这一项本就冗余）
  - 编码：4 个源文件与用例文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S15 端口与负载采集

- **对照**：`ScannerService.ts`（599 行）、`platform/win32/process.ts` 的采集部分
- **产物**：`internal/scanner/scanner.go`、`watch.go` + 测试
- **逐字搬**：`BACKGROUND_INTERVAL_MS = 10_000`、`META_MAX_AGE_MS = 30_000`、`VERIFY_MAX_AGE_MS = 3000`、`MAX_KEYWORDS = 20`、`MAX_KEYWORD_LEN = 64`、`MAX_WATCHED = 50`、`MAX_HIDDEN_ONCE = 1000`、`WATCHED_CMD_MAX = 160`；周期取值 1000 / 2000 / 5000 / 10000（`index.ts` 的 `SCAN_INTERVALS`）；实际间隔 `visible ? base : max(base, 10000)`
- **公开方法**：`setExpectationSource`、`table(hintPids)`、`start`、`stop`、`snapshot`、`listenRows`、`isVisible`、`knownPath`、`setVisible`、`refresh`、`reschedule`、`ignore`、`hideOnce`、`setGroup`、`setWatchedKeywords`
- **行为**：`tick()` 互斥，进行中时到来的 `refresh()` 丢弃（不排队）；未知 PID 触发 CIM 元数据刷新（实测约 3.5 秒）；采集失败推送事件而不是静默；`knownPath` 只认最近一次快照里监听项的 cwd，精确相等（原写「读取侧再用 `isSafeRelative` 验一次」与原版不符：`isSafeRelative` 在 `EntryService.knownPath` 那一路，属 S21，2026-11-14 按原代码改正）
- **红线**：凡是回答「这个端口谁在用」的地方一律 `filter` 后排掉自己，不用取第一行；`pidusage` 替换为 Windows API 或 CIM，偏差（采样精度）登记到 MIGRATION-PLAN §6
- **验收**（`verify-m8`、`verify-m11-dual`、`verify-review-scanner`、`verify-review-listenrow`、`verify-porthistory`）：tick 互斥用并发调用测试；同端口双 PID 两行都在快照里；不可见时间隔抬到 10 秒；CDP 下端口表按周期刷新且行不闪
- **证据**（2026-11-14）：
  - 产物：`internal/scanner/scanner.go`（常量、`Source` / `ConfigStore` / `Metrics` 接口、`Options`、`New` 与 15 个公开方法）、`tick.go`（`schedule`、`tick`、`resolveMeta`、`build`、`attachMetrics`、`publish`、`publishFailure`、`diff`、`systemLoad`）、`watch.go`（`matchWatched`）、`build.go`（原版文件末尾的 `changed`、`normalizeKeywords`、`truncate`、`matchEntry`、`countConflicts`、`sameDir`、`guessCwd`，正则逐字搬）、`jsstr.go`（JS 的 trim 空白集、UTF-16 长度与切片、`Math.round`、node `path.win32/posix.basename`）、`metrics_windows.go`（`pidusage` 与 `os.cpus/totalmem/freemem` 的 Windows API 替身）、`metrics_other.go`（非 Windows 桩）
  - 契约改动：`contract.SystemLoad.Memory` 由 `int64` 改为 `float64`（原版是一位小数的百分比，如 `66.7`；S04 写错了，对拍发现），已登记 MIGRATION-PLAN §6
  - 对拍一（整服务）：生成器 `scripts/gen-scanner-cases.mjs` 经 `platform-hooks.mjs` 直接 import 原版 `ScannerService.ts`（只读），`scripts/platform-stub-scanner.mjs` 把 `readListenPorts` / `readProcessMeta` / `pidusage` / `node:os` 换成可控的假世界，`Date.now`、`process.pid`、`setTimeout` / `clearTimeout`、ConfigStore 也换成假的。场景在 `scripts/scanner-scenarios-a.mjs`（采集结果：基线、归属与条目反查、分组覆盖、新端口提醒的四重过滤、foreign 与缺行、cwd 推断、指标边界、增量字段、端口冲突、稳定排序、removedPids 顺序）与 `scanner-scenarios-b.mjs`（调度节奏、互斥、失败推送、元数据缓存、`table()` 新鲜度、关注进程及边界、上限）。用例 `internal/scanner/testdata/scanner_cases.json`（纯 ASCII，22 个场景、210 步，其中 114 步是方法调用）。`TestScannerMatchesOriginal` 每步比对：发出的增量、错误事件、定时器设置与清除、返回值、快照、netstat / CIM 调用次数、扫描器改过的三项配置；并断言 18 个操作都有用例命中
  - 对拍二（纯函数）：`scripts/gen-scanner-fn-cases.mjs` 调原版文件末尾的私有函数（hooks 追加了导出），`TestPureFunctionsMatchOriginal` 比对 `guessCwd` 847 组（node_modules 截断 139 / 取父目录 201 / 推不出 507，含伪随机拼接与偏向命中的随机路径）、`normalizeKeywords` 41 组（JS 空白集逐个、U+0130 / 西格玛 / 合字的小写化、去重、限长限量）、`truncate` 11 组、`countConflicts` 8 组、`matchEntry` 80 组（四层匹配与不匹配都命中）
  - 孤立代理：原版按 UTF-16 截断会切出半个代理对，Go 侧丢掉那半个字符；两个对拍分别命中 10 处、4 处，测试断言命中数大于 0，确认偏差真被走到（§6）
  - 验收硬项另写成独立断言（`scanner_extra_test.go`）：`TestTickMutexUnderConcurrency`（一轮卡在采集中途，并发 50 次 tick 全部立即返回，netstat 只调 1 次、只发 1 个增量；放行后再调能正常采集）、`TestDualStackSamePortTwoRows`（同端口 IPv4 / IPv6 两个 PID 两行都在快照里、监听行保留两条，条目自己占着端口但另有占用者仍算冲突）、`TestHiddenIntervalRaisedTo10s`（4 档周期不可见时都是 `max(base, 10000)`，恢复可见先清后设 base 并立即补一轮）、`TestRealTimersStartStop`（真定时器下 Stop 与 App ctx 取消后都不再采集）、`TestCanceledCtxSetsNoTimer`、`TestCanceledTimerCallbackIgnored`（`AfterFunc` 的 Stop 与触发竞争时，旧定时器回调看代数不对什么都不做）、`TestCallbacksMayReenter`（增量 / 错误 / 条目回调里调回扫描器不死锁）、`TestSnapshotIsCopy`（改返回的快照不影响内部状态，也进不了路径白名单）
  - `winMetrics` 真机冒烟（`metrics_windows_test.go`，只读本测试进程）：首次采样 CPU 为 0、忙等 200ms 后在 (0, 100 × 核数]、取不到的 PID 跳过、全取不到报 `No matching pid found`、60 秒未问到后基线重置；核数、`GetSystemTimes`、`GlobalMemoryStatusEx` 读数合理。`TestSelfPidDefaultsToProcess`：`Options.SelfPid` 零值取 `os.Getpid()`，关注列表不会把本应用列进去
  - 发现原版问题 I7（只在关注列表里的进程 CPU 永远是「—」：`publish()` 的基线清理只保留监听表里的 PID）。按原样搬，不修；登记 MIGRATION-PLAN §5，专项测试 `TestKnownIssueI7WatchedCPUAlwaysNull`，对拍场景 `watched` 也钉住
  - 偏差登记 MIGRATION-PLAN §6，共 8 项：进程采样改 Windows API（不起 PowerShell，毫秒墙钟分母）、系统 CPU 不重复计 irq、totalmem 为 0 时取 0、`SystemLoad.Memory` 类型、关注命中超 50 个时取 PID 最小的 50 个、孤立代理、方法的同步性与错误返回、`prevTicks` 放实例上
  - 红线：凡回答「这个端口谁在用」都按 PID 分组遍历全部监听行，不取第一行（`countConflicts` 看全部占用者，变异「只看第一个占用者」变红）；`ownership` 只用于 `Verify`，扫描器不做 kill 授权；`TestOwnershipDoesNotImportScanner` 仍 PASS
  - CDP 一项（端口表按周期刷新且行不闪）要有绑定和页面才能测，移到 S30 的 Dashboard 验收
  - `go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 输出 `283 passed in 14 packages`（另有 2 个既有的环境相关 SKIP，与本步无关）
  - 反向对照（`mutate-run.cjs` 逐条改源码、单独跑 `go test`、还原）：128 处变异 119 处变红。覆盖 8 个常量各 ±1、可见 / 后台间隔、wait 从开始时刻算、ctx 取消、定时器代数、互斥、失败先推失败态、两处新鲜度的 `>` 与两个刷新条件、基线只拍一次、四重新端口过滤与「只提醒 external 的 mine 组」、pinned 两个条件、覆盖键小写、稳定排序与排序键、首轮 CPU 为 null、`Math.round` 一半朝 +∞、核数兜底、系统负载精度、changed 的 8 个字段、removedPids 顺序、失败态带旧值、normalize 的去空 / 去重 / 限长 / 限量 / 先小写后截断 / JS 空白集、truncate 的 `<=` 与 UTF-16 计长、matchEntry 四层顺序与前缀分隔符、countConflicts、guessCwd 的 node_modules 截断与大小写、`(?i)` 折叠、正则的 `\b` / 非贪婪 / 盘符大小写、关注进程的自身 / owned 排除与匹配串、knownPath、setVisible 去重与补采、ignore 的上限 / 去重 / 落盘、hideOnce 上限、setGroup 的空名 / 小写去重 / trim、setWatched 的非数组与非字符串、I7 本身。首轮 22 处没抓到、15 处写法编译失败、1 处没匹配上：编译失败与没匹配的换写法重做后全部变红；没抓到的补了用例（`stable-sort`、`removed-order`、`watched-boundary` 三个新场景，`metrics-edge` 加 `Math.round` 一半与空 `cpus()`，`diff-changed-fields` 加只变 groupOverridden / 只变启动来源，`owned-and-entries` 加基线后 owned 的新端口，`port-conflicts` 加失败态，`unmanaged-filters` 加同端口不同名的忽略项，`table-freshness` 加「在 mine 不在 byPid」，`knownPath('')`，`countConflicts` 两个外来占用者，`TestCanceledCtxSetsNoTimer`、`TestCanceledTimerCallbackIgnored`）后 13 处变红。存活的 9 处是等价变异：后台间隔不取 max（`SCAN_INTERVALS` 最大就是 10000）；去掉 mine 过滤或去掉 foreign 跳过（两者互为冗余，单去一个结果相同，原版也两个都有）；Usage 失败不提前返回（结果是空表，后面逐个查不到等于没改）；changed 不比归属（foreign 已排除，owned 时来源必为 mile、external 时不会是 mile，来源字段已覆盖）；node_modules 下标 `>= 0`、cut 按字节、不判空捕获（win32 正则的捕获必以「盘符 + 冒号 + 分隔符」三个 ASCII 字符开头，这三处在 Windows 上都不可能区分；posix 分支属 macOS，D5 首版不做）；setWatched 的 null 元素当空串（随后被规整去空）
  - 编码：`internal/scanner/` 下 15 个文件、两份用例、`contract/scanner.go`、6 个脚本与 MIGRATION-PLAN 共 25 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符（测试里的替换符改用反斜杠 u 加 FFFD 的转义写法）

### F 识别与预检

#### S16 项目识别

- **对照**：`DetectService.ts`（685 行）
- **产物**：`internal/detect/detect.go`、`favicon.go`、`springboot.go` + 测试
- **逐字搬**：`DEV_CANDIDATES = ['dev','serve','start','dev:local','develop']`、`BUILD_CANDIDATES = ['build:prod','build:production','build:pro','build']`、`FAVICON_MAX_BYTES = 256*1024`、`FAVICON_CANDIDATES` 列表顺序；方法 `detect`、`lockfileFor`、`readFavicon`、`detectSpringBootProfiles`、`scanChildren(root, limit = 60)`
- **红线**：只读文件，不跑任何命令（连版本查询都不跑）；推不出命令形状的生态标 `registerOnly: true`，原版有两处，Go 侧逐处对上
- **验收**（`verify-m10`、`verify-m15-uniapp`、`verify-m16-langs`、`verify-springboot`、`verify-m14-favicon`）：用原版 `scripts/` 下的夹具项目目录做输入（只读引用，不复制进本目录也不改），每个夹具一组期望输出由原版 `detect()` 生成
- **证据**：
  - 产物：`internal/detect/` 下 `detect.go`（Detect / fallback / LockfileFor / ScanChildren / 包管理器推断）、`rules.go`（框架规则、锁文件、14 条标记规则与提示逐字照搬、python 依赖与 spring 正则）、`springboot.go`（启动方式、端口、profiles）、`favicon.go`（候选顺序、clean 规则、index.html 解析、越界守卫）、`jsjson.go`（V8 `JSON.parse` 的值与报错文案逐字移植）、`collate.go`（zh 排序）、`jsx.go`（win32 path 与 JS 字符串语义）；新增 `internal/contract/scripts.go` 保序脚本表（用户 2026-11-15 选定）
  - 对拍数据全部由原版代码生成（`scripts/gen-detect-cases.mjs` 跑原版 `DetectService`，`scripts/gen-jsonparse-cases.mjs` 跑 node 22.23.4 的 `JSON.parse`）：detect 98 个场景（含脚本键序与锁文件 97 组）、favicon 18、profiles 3、scanChildren 6（含根目录不存在）、clean 规则 26、href 解析 10、原版 `scripts/` 下 3 个夹具加一次 `scanChildren`；JSON.parse 122 例（91 例报错，文案、行列、上下文省略号逐字一致）
  - 对拍覆盖不到的分支另写单测（`unit_test.go`）：盘根 basename 为空的 `|| path`、macOS 的 unsupported 模式落仅登记、次级 / 三级权重排序（期望值是 node 实测）、汉字排在数字与拉丁之间、下标键插入序、favicon 越界守卫（root 外真放文件，含同前缀兄弟目录 `app` / `app2`）
  - 红线：识别只 `stat` / 读文件，不起任何进程（`internal/detect` 不 import `os/exec`）；推不出命令形状的标 `registerOnly`，与原版两处逐处对上，对拍场景全覆盖
  - 回归：S09 配置测试重跑通过（`scripts` 经 `config.json` 读写后键序不变，宽松解码丢非字符串值）
  - `go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 共 165 个顶层测试通过、2 个既有环境相关 SKIP。`internal/sessions` 在一次全量运行里失败过一次，随后单独重跑 9 次、全量重跑 2 次都通过，属既有 ConPTY spike 测试的偶发问题，与本步无关，没有复现出失败输出
  - 反向对照（`mutate-run.cjs`）：首轮 51 处变异 37 处变红；没抓到的补用例、编译失败与没匹配的换写法后重跑 15 处，13 处变红。存活 2 处是等价变异：uniapp 分支的 `basename(path) || path`（真实目录的 basename 不会为空，盘根形式已由单测覆盖 jsBasename 本身）；InsertJSKey 的 `>` 改 `>=`（键已去重，不会出现相等的下标）。另有首轮存活的 python 行终止符类，判定为冗余后从正则里删掉（JS `\s` 本已包含行终止符）
  - 偏差登记 MIGRATION-PLAN §6 共 7 项：scanChildren 排序、`Scripts` 类型（TS 为 `unknown`，M5 在 `mile.ts` 断言）、读文件错误文案、转义孤立代理、方法同步、`LockfileFor` 返回 bool、`Favicon` 具名类型；BINDINGS-CONTRACT §1.3 加第 7 条「Scripts」
  - 依赖：`golang.org/x/text v0.43.0` 改为直接依赖（原本已是间接依赖，go.sum 不变）
  - 编码：新增与改动的 19 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S17 启动前预检

- **对照**：`PrecheckService.ts`（605 行）
- **产物**：`internal/precheck/precheck.go`、`which.go` + 测试
- **逐字搬**：`MIN_FREE_BYTES = 500MB`；检查项 id 共 12 个：`cwd`、`disk`、`java`、`launchMode`、`lockfile`、`node`、`nodeModules`、`packageJson`、`packageManager`、`port`、`registerOnly`、`script`；导出 `resolveCwd`、`whichAny`（原版第 605 行 `export { whichAny }`，EntryService 也用它）
- **行为**：`whichAny` 只在 PATH 各目录 `stat` 候选文件名，不执行；semver 返回 `null`（范围写法不认识）时 `node` 检查降级为 warn；端口占用时的建议端口来自 S07，带着 I2
- **红线**：只读，不写、不安装；缺 `node_modules` 报 fail 并给「创建安装会话」修复入口
- **验收**（`verify-m5`、`verify-m11-port`、`verify-review-order`、`verify-review-sessionguard`、`verify-review-restartguard`）：12 个检查项各自的 pass / warn / fail 分支；`resolveCwd` 照原样只做拼接（`cwd` 为空取 `entry.path`，绝对路径原样，相对路径拼到 `entry.path` 下），不在这里做越界校验，越界校验属于 S21d 的 `terminalCwd`；目录不存在时 `cwd` 项 fail 并给 `pickDirectory` 修复入口，且后续检查不再执行
- **证据**：
  - 产物：`internal/precheck/` 下 `precheck.go`（`Run` 主序列与 npm 生态 9 项、`ResolveCwd`、`finish`）、`langs.go`（Spring Boot / Python / Go / Rust / C++ 序列与 fileItem / binItem / pathItem）、`port.go`（portItem、switchFix、diskItem）、`which.go`（`WhichAny` 导出给 EntryService）、`sys_windows.go`（GetDiskFreeSpaceExW、node.exe 版本资源）；`internal/detect/pkgfile.go` 开出 `ReadPackageJSON` / `StringRecord` / `Join` / `IsAbsolute`，复用 S16 移植的 V8 `JSON.parse` 与 win32 path，不另写一份
  - 对拍数据由原版生成（`scripts/gen-precheck-cases.mjs` 跑原版 `PrecheckService` + 真实 `DetectService`，在临时目录建真实目录树与 PATH；`statfs`、`findFreePort` 经 `platform-stub-precheck.mjs` 按场景给值并记下调用，`process.versions.node` 按场景改写）：113 个场景逐个比对整份 `PrecheckResult`（含 detail 文案与 fix），另比 `findFreePort` 的起始端口与 `statfs` 的路径；`resolveCwd` 纯函数 17 例（盘符相对、UNC、正斜杠、中文）
  - 12 个检查项的 pass / warn / fail 分支全部有场景命中，测试里逐个断言命中数大于 0（cwd、disk、java、launchMode、lockfile、node、nodeModules、packageJson、packageManager、port、registerOnly、script，外加 python / go / cargo 三个 PATH 项）
  - `cwd` fail 后只有这一项、不再执行后续检查（`cwd-missing`、`cwd-is-file`）；`resolveCwd` 只拼接不做越界校验（`cwd-relative-dotdot` 照原样拼出项目外的目录）；缺 `node_modules` 报 fail 并给「创建安装会话」
  - 端口：配置冲突优先、但另一进程真的在听时让实时检查先说话；实时检查取全部占用者再排掉自己（`port-self-and-external` 自己排第一行时仍报外部占用）、受控优先、「另有 N 个」、「本条目也在监听」前缀；建议端口来自 S07，带着 I2；只有 Next 给一键切换
  - Node 版本（用户 2026-11-15 选定读 node.exe 版本资源）：`TestPathNodeVersionMatchesNodeItself` 读出 22.23.4，与生成对拍数据时 node 自报的 `v22.23.4` 一致；假 node.exe、同名目录、不存在都读不出；取不到版本时显示「当前 未知」且不出 warn。产品代码不执行 node，`internal/precheck` 的非测试文件不 import `os/exec`（测试里只用 `exec.LookPath` 找路径）
  - 磁盘：`GetDiskFreeSpaceExW` 本机读数与 node `statfsSync` 的 `bsize * bavail` 逐字节一致（295625633792）；不存在的目录报错时 diskItem 记「无法读取，跳过」
  - 发现原版问题 I8（`package.json` 内容是 `null` 时预检整体抛 TypeError）。按原样搬，不修；登记 MIGRATION-PLAN §5，专项测试 `TestKnownIssueI8NullPackageJSON`，对拍场景 `pkg-null` 也钉住
  - 偏差登记 MIGRATION-PLAN §6 共 4 项：Node 版本来源、磁盘 API、`Run` 的形状、非法 packageManager 值
  - 反向对照（`mutate-run.cjs`）：50 处变异首轮 44 处变红，4 处没抓到、2 处写法编译失败。补了场景（`script-empty-key`、`sb-jar-is-dir`、`port-two-others`）与 PATH 空段单测（当前目录放同名文件，空段不能命中）、编译失败的换写法后全部 50 处变红。覆盖 MIN_FREE_BYTES、cwd 是目录与提前返回、四条生态分支与仅登记、`!entry.script`、空表文案、useNpm、「无」、node_modules 是目录、锁文件不一致、engines 空串、warn 条件、finish、win32 isAbsolute、jar / exe 的大小写与锚定、`..` 按段判断、isFile 与 stat 的区别、端口 0、canSwitch、两处排除自己、配置让位实时、顿号连接、受控优先、计数、自身前缀、扫描先于受控分支、port+1、`>` 与四舍五入、PATH 空段、同名目录也算命中、PATH 先于候选名的循环顺序、版本资源取哪个字段、stringRecord
  - `go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 共 174 个顶层测试通过、2 个既有环境相关 SKIP
  - 编码：新增与改动的 17 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

### G 会话与日志

#### S18 ConPTY 会话

- **对照**：`SessionService.ts`（254 行）、`platform/win32/index.ts` 的 shell 候选与首条命令（第 144 行）
- **产物**：`internal/sessions/session.go`、`conpty.go`（用 S02 定案的实现）、`channel.go` + 测试
- **逐字搬**：`MAX_BUFFER_CHARS = 400_000`、`FLUSH_INTERVAL_MS = 16`；PowerShell 首条命令原文 `chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Clear-Host\r`；会话环境注入 `MILE_RUN_TOKEN` 与 `npm_config_progress=false`
- **方法**：`createShell(input, at?)`、`create(CreateSessionInput)`（只给 Entry 内部用）、`write`、`resize`、`history`、`list`、`stop`、`kill`（返回可等待结果）、`ownedPids`、`sessionIdByPid`、`liveCount`、`disposeAll`
- **红线**：绑定层只暴露 `createShell`，`create` 绝不接到绑定上；`createShell` 只认 `kind: 'shell'` 和标题，带 `entryId` 时目录由 S21d 的 `terminalCwd` 解析后作为可信参数传入；`MILE_RUN_TOKEN` 不进 `SessionMeta`、不进 Channel、不进日志
- **流式**：输出走 `*mygo.Channel[T]`（BINDINGS-CONTRACT §4），16ms 合并后再发；缓冲超过 `MAX_BUFFER_CHARS` 从头截掉
- **验收**（`verify-review-cwdterm`、`verify-review-ipc`、`verify-review-quit`、`verify-review-termsearch`）：起 PowerShell 写入读回中文；`resize` 生效；`kill` 后子进程树全部退出（日志证据）；`disposeAll` 等全部 kill 返回才结束；`createShell` 传入可执行文件或参数字段时被忽略
- **证据**：
  - 产物：`internal/sessions/` 下 `session.go`（常量、`New`、`CreateShell`、`Create`、`buildEnv`、id）、`flush.go`（16ms 合并、截断、读循环与 UTF-8 解码、退出收尾）、`kill.go`（`Write` / `Resize` / `History` / `List` / `Stop` / `Kill` / `OwnedPids` / `SessionIDByPid` / `LiveCount` / `DisposeAll`）、`channel.go`（`Attach`，先回放再推送）、`text.go`（JS `trim` 口径、按 UTF-16 码元截断、读块边界的半个字符）、`conpty.go`（`PTYProc` 接口与 `Spawner`，S02 的 `conpty_windows.go` 实现它）。平台、ownership、scanner 都经接口注入，本包不 import `internal/scanner`
  - 对拍数据由原版生成（`scripts/gen-session-cases.mjs` 跑原版 `SessionService.ts`；`node-pty` / `node:os` / `../platform` 经 `platform-stub-session.mjs` 顶替，hook 规则 2f；定时器换成手动队列）：12 个场景 143 步，每步逐项比对返回值或错误文案、本步新增的调用（spawn 的 file / args / cwd / cols / rows / 环境变量、`own.register` / `unregister` / `assertKillable`、`scanner.table`、`pty.write` / `resize` / `kill`、`killTree`）、新增的 data / exit 事件、仍待触发的定时器。覆盖标题 trim 与 80 码元截断、非 shell 拒绝、额外字段被忽略、`at` 覆盖、内部 `create` 的默认值与 env 合并、16ms 合并、40 万字符截断、退出码 0 / 非 0、kill 的五条分支（无 scanner、表失败、归属拒绝、pty.kill 抛错、已退出）、stop 的 Ctrl+C 与 3 秒兜底、disposeAll、resize 边界、id 随时钟
  - 单测（`unit_test.go`）：汉字跨 32 KiB 读块与跨两次写入不出替换符；流结束时半个字符出一个 U+FFFD；截断不留孤立代理；`Attach` 回放 + 推送 + 退出返回、未知 id、已退出会话、页面关 Channel、发送错误透传、ctx 取消；`CreateShellSessionInput` 只有 `Kind` / `Title` / `EntryID` 三个字段，传入 file / args / cwd / env 不起作用；token 只在 PTY 环境里，不出现在 meta / list / 事件；`DisposeAll` 在 `KillTree` 放行前不返回；`jsTrim` 的 U+FEFF / U+0085
  - 真进程验收（`real_windows_test.go`，真 ConPTY + 真 PowerShell 5.1 + 真 ownership + 真进程表）：写入 `"中文" + "回读"` 读回 `中文回读2`，输出无替换符；`Resize(100, 40)` 后 `$Host.UI.RawUI.WindowSize` 读回 `100x40`；会话里 `Start-Process ping.exe` 起子进程，日志 `kill 前：shell pid=33228 存活，ping pid=10308（父 33228）存活` / `kill 后 1.703s：shell pid=33228 已退出，ping pid=10308 已退出` / `会话状态：crashed exitCode=1`，之后不再登记任何 pid；两个会话各带一个 ping，`DisposeAll 用时 1.772s，返回时 shell 18308/32428 与 ping 18480/21620 全部已退出`（返回后不等待直接查）；S02 遗留的 `Close` 之后 `Read` 返回 `read conpty-out: file already closed`
  - S02 的 `TestConPTYSpike` 偶发失败已查明：取 PID 用的 `PINGPID=...=END` 标记会先在 PSReadLine 回显的命令行里出现，测试匹配到回显就解析出 0。标记改成两段拼接（`"PING"+"PID="`），回显里不再有完整标记，连跑 3 次通过
  - 偏差登记 MIGRATION-PLAN §6 共 11 项：Channel 推送、PTY 字节流解码、代理对截断、序号作用域、env 大小写去重、`at` 空串、方法的错误形状、首条命令写入失败、退出码取不到、`list` 返回拷贝、`resize` 非整数。原版 `stop` 的 3 秒定时器不随 `disposeAll` 清掉，按原样搬（`kill` 会因会话已退出或已被清空而空转，无害），未列为问题
  - BINDINGS-CONTRACT §4 示例里 `SessionId` / `Data` 与代码的 `ID` / `Chunk` 不一致，以代码为准改了文档
  - 反向对照（`mutate-run.cjs`）：30 处变异首轮 29 处变红，`jsTrim` 换成 Go 的 `TrimSpace` 没抓到（对拍场景没有 U+FEFF / U+0085），补 `TestJSTrimMatchesJS` 后 30 处全部变红。覆盖四个常量、cols、非 shell 拒绝、标题上限与 trim、`at` 两个字段、token 与 `npm_config_progress` 注入、`input.env`、ShellInit、ownership 登记与撤销、默认标题、缓冲截断、定时器只起一次、starting 转 running、退出码判定、EOF 残字节、读块边界、kill 的归属重验与表失败两道闸、`KillTree`、resize 上限、Ctrl+C、`DisposeAll` 等待、`Attach` 回放
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，188 个顶层测试，2 个既有环境相关 SKIP。另一轮 `-v` 全量里 S07 的 `TestFreePortSkipsHeldPortLikeOriginal` 失败一次，单独连跑 6 次都通过：它在真实系统上探测相邻端口，并行跑的其他包可能刚好占了，不属于 S18
  - 编码：`internal/sessions` 全部文件、对拍数据与改动的 3 份文档共 17 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S19 日志聚合

- **对照**：`LogService.ts`（166 行）
- **产物**：`internal/logs/logs.go` + 测试
- **逐字搬**：`MAX_LINES = 5000`、`MAX_LINE_CHARS = 500`、`FINAL_FLUSH_MS = 120`；切行与错误判定全部调 S05 的函数，不在这里另写正则
- **方法**：`onLine`、`query(LogQuery)`、`clear`；内部 `absorb`、`scheduleFinalFlush`、`push`、`sources`
- **行为**：会话 `exit` 不保证晚于最后一块输出，退出后延迟 `FINAL_FLUSH_MS` 再收尾；ConPTY 绝对光标定位与 `\r\x1b[K` 都按 S05 的规则切行
- **红线**：只在内存，环形缓冲，不落盘；`query` 的入参经 `sanitizeLogQuery`（S24 搬）
- **验收**：灌入超过 5000 行后只剩最新 5000 行；超长行截到 500 字符；退出与末块输出的竞争用合成时序测试（先发 exit 再发 data，末行仍在）
- **证据**：
  - 产物：`internal/logs/logs.go`：常量 `MaxLines` / `MaxLineChars` / `FinalFlush` / `defaultLimit`，`New`（订阅会话 data / exit）、`absorb`、`scheduleFinalFlush` / `finalFlush`、`push`、`OnLine`、`Query`、`Clear`、`level`、`clampLimit`。切行、去 ANSI、进度条末段、错误级别全部调 S05 的 `outputtext.go`，本文件不新增正则
  - 依赖注入：`Sessions` 接口只要求原版构造参数上真正用到的 `List` / `OnData` / `OnExit`；`Options` 注入时钟与定时器。`internal/logs/wire_test.go` 断言 `*sessions.Service` 满足该接口，会话侧改签名会立刻编译失败
  - 对拍数据由原版生成（`scripts/gen-log-cases.mjs` 跑原版 `LogService.ts`；会话服务用真 `EventEmitter` 加可变会话列表顶替，`Date.now` 与 `setTimeout` 换成场景时钟与手动队列）：11 个场景 123 步，逐项比对 `query` 的整份返回值（行、total、dropped、capacity、sources）、`onLine` 收到的每一行、仍待触发的定时器。覆盖：两种行尾与裸 CR、ConPTY 的绝对光标跳行（`[5;1H` 切行、`[1;5H` 不切）、ANSI 与 OSC 剥离、进度条裸 CR 取末段、末尾 CR 加擦除序列不产生空行、级别判定（含 `TypeError`、`EADDRINUSE`、中文「失败 / 警告」）、500 码元截断（含第 500 个码元正好是代理对前一半）、环形缓冲（5005 行后 total 5000、dropped 5；再 10 行后 dropped 15）、exit 先于末块 data（收尾推后，末行仍在）、到点收尾、clear 取消挂起收尾且不重置序号、`query` 的五种筛选与 limit 边界（0 / 负数 / 5001 / 2）、空串等于不筛、会话从列表消失后新行回落到会话 id、sources 的首次出现顺序与计数、订阅者抛错不影响收集
  - 单测（`unit_test.go`）：真定时器下 exit 后 120ms 收尾；5007 行后首行是第 8 行、dropped 7；订阅者 panic 不中断收集且后续订阅者仍收到；`Query` 返回拷贝；`clampLimit` 七组边界；单行按 UTF-16 码元截到 500（切在代理对中间时以替换符结尾）；`Clear` 取消挂起收尾；8 协程并发灌 400 行不丢；用放大 10 倍的定时器证明「退出后又来数据会推后收尾」（+1300ms 时还不出现，+1500ms 后出现）
  - 反向对照（`mutate-run.cjs`）：34 处变异首轮 31 处变红。补两处后 33 处变红：`空 level 也筛`（补对拍步骤 `{level: ''}`）、`不检查收尾重排`（对拍的手动定时器只按毫秒数排队、不分绝对到期时刻，两边都分辨不出，改用放大定时器的真时序单测钉住）。剩 1 处 `dropped += 1` 与 `dropped += cut` 等价 —— 每次 `push` 只进一行，溢出时 `cut` 恒为 1，构造不出区分场景
  - 覆盖的变异：三个常量与 `defaultLimit`、`clampLimit` 上下限、partial 取段、末段处理、光标定位替换、标题回退、单行截断、缓冲挤掉哪端、级别判定顺序、关键字前缀 / trim / 小写、空 sessionId / 空 level / entryId 与 nil 行、limit 多取一行、结果翻回正序、capacity、sources 计数与顺序、clear 清行与取消收尾、订阅者抛错兜底、收尾推残段、空行进日志
  - 偏差登记 MIGRATION-PLAN §6 共 2 项：`query` 的 limit 在 JSON null / 小数上的形状、关键字大小写折叠范围
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，198 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/logs` 全部文件、对拍数据与两个生成脚本共 7 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符（对拍夹具里的勾号与盲文转轮原本是字面符号，已换成 ASCII，不影响切行逻辑）

#### S20 自定义图片

- **前置关卡**：D2 定案（图片缩放方案）
- **对照**：`ImageService.ts`（81 行）
- **产物**：`internal/images/images.go` + 测试
- **逐字搬**：`MAX_EDGE = 128`、`IMAGE_ID = /^[a-f0-9]{12}\.png$/`；方法 `saveFromData(bytes)`、`read(imageId)`、`remove(imageId)`
- **行为**：只缩不放，长边大于 128 才按长边等比缩到 128；重编码为 PNG 后取 PNG 字节的 SHA-256 十六进制前 12 位加 `.png` 作为 id；文件已存在不重写，不存在时先写 `.<id>.tmp` 再 rename；`read` 返回 `data:image/png;base64,...`，id 不合法或文件不存在返回 `null`；`remove` 尽力而为，失败静默；解码失败抛 `无法解析为图片（仅支持 PNG / JPG 等常见位图）`，重编码为空抛 `图片重编码失败`
- **偏差**：原版用 `nativeImage` 缩放与编码，Go 侧的缩放算法和 PNG 编码器都不同，同一张原图得到的 id 与原版不同。导入原版配置时 `imageId` 本来就在 `DROP_ON_EXPORT` 里，不受影响；仍要登记到 MIGRATION-PLAN §6
- **验收**（`verify-m17-image`）：大图缩到长边 128，小图尺寸不变；同一张图在 Go 侧两次保存得到同一个 id；`../x.png` 这类 id 被拒；目录在 S03 定的数据目录下的 `images/`
- **证据**：
  - D2 定案（2026-11-15）：纯 Go，标准库 `image/png` + `image/jpeg` 解码，自写双线性缩放，`png.Encode` 编码，无 cgo、无第三方依赖。已写回 MIGRATION-PLAN §7
  - 产物：`internal/images/images.go`：常量 `MaxEdge = 128`、`imageIDRE = ^[a-f0-9]{12}\.png$`，`New` / `DefaultDir` / `Dir` / `SaveFromData` / `Read` / `Remove`，内部 `decode` / `resizeBilinear` / `blend`。两条错误文案逐字照搬原版
  - 行为逐项对照原版：只缩不放（`longEdge > 128` 才缩，129x10 缩成 128x10）；按最长边等比（300x200 到 128x85、200x300 到 85x128）；重编码 PNG 后取 SHA-256 前 12 位加 `.png`；同图天然去重、已存在不重写；不存在时先写 `.id.tmp` 再 rename；`Read` 形状校验后返回 `data:image/png;base64,...`，不合法或不存在返回 false；`Remove` 尽力而为
  - 目录：`DefaultDir()` = `config.DataDir()` 下的 `images/`，即 D4 定案的 `%APPDATA%\mile-console\images\`
  - 单测（`images_test.go`，13 个）：六组尺寸矩阵（含长边正好 128 不动、129x10）；JPEG 输入；同图两次同 id 且已存在不重写（先把文件换成垃圾再存一次，文件仍是垃圾）且不留 `.tmp`；解码失败报原文案且不落盘；data URL 往返字节一致；九个非法 id 被拒；**目录外同名文件既读不到也删不掉**（路径穿越闸门）；**大写 / 多一位 / 前缀多内容 / 后缀多内容这四种「看着像」的文件确实存在时仍被拒**（证明是形状校验挡住的，不是文件不存在）；删除的三种边界；目录自动创建；双线性采样的对称值（4x4 到 2x2 取 191）与非对称权重（8x8 到 3x3 取 167，换掉纵向权重就露馅）；半透明像素缩放后不发黑（采样走非预乘通道）
  - 没有对拍数据：原版用 Electron 的 `nativeImage`（Skia），迁移环境不运行项目代码，跑不出期望值；且卡片已登记「同一张原图得到的 id 与原版不同」，逐字节比对本来就不成立。改为按原版源码逐个分支钉行为，并用变异测试证明这些断言真的在拦错误
  - 反向对照（`mutate-run.cjs`）：27 处变异首轮 17 红、7 绿、3 处写法没匹配上。修正后 26 处变红（新增「看着像的文件确实存在」用例后，`id 允许大写` 与 `id 去掉行首锚` 也被抓住；预乘通道那处改成能编译的写法后变红）。剩 2 处为等价变异：`long > MaxEdge` 改成 `>=` 时，尺寸不变的缩放对 NRGBA 源是逐像素恒等，只有调色板图会被转成真彩色（编码器细节，不是产品可见行为）；`png.Encode` 的成功路径不可能产出空缓冲，`||` 与 `&&` 的差别触达不到
  - 覆盖的变异：`MaxEdge`、上限比较、宽高比分支、四舍五入、缩放是否执行、id 截几位、已存在是否重写、建目录、读写两处形状校验、id 长度 / 大小写 / 锚点、base64 补位、data URL 类型、解码失败是否报错、纵向权重、最近邻退化、预乘通道、rename 目标、宽高取反
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，211 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/images` 两个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

### H 条目

EntryService（2161 行）按方法边界拆成四步，四步的产物都在 `internal/entries/` 下，各自一组文件，最后由同一个 `Service` 结构体装配。

#### S21a 常量、条目 CRUD 与校形

- **对照**：`EntryService.ts` 第 1–756 行（常量区、`list`、`get`、`add`、`update`、`edit`、`sanitizeEdit`、`groupEnv`、`assertStartAfter`）、第 808–848 行（`remove`、`reorder`、`commit`）、第 2086–2161 行（文件尾工具函数 `byOrder`、`isLive`、`taskStatus`、`capturePort`、`isSafeRelative`、`normalizePath`、`isDirectory`、`isFile`、`isRunnable`）
- **产物**：`internal/entries/consts.go`、`crud.go`、`sanitize.go`、`util.go` + 测试
- **逐字搬**：`SAFE_SCRIPT = /^[A-Za-z0-9_.:\-+]+$/`、`SAFE_PROFILE = /^[A-Za-z0-9_-]+$/`（另限长 64）、`SAFE_PYTHON_ENTRY`、`SAFE_PYTHON_MODULE`、`SAFE_GO_PKG`、`SAFE_HEALTH_PATH`、`PORT_PATTERNS`（8 条，Tomcat / Netty 专用的 3 条排在通用 `port\s+(\d+)` 之前，顺序不能动；JS 的 `i` 标志写成 `(?i)`）、`PORT_TAKEN`、`OUTPUT_DIR_CANDIDATES`、`EDITABLE`、`FIELD_LABEL`、`IDENTITY_FIELDS`、`PACKAGE_MANAGERS`、`FRAMEWORKS`、`LAUNCH_MODES`、`LAUNCHABLE_FRAMEWORKS`、`SPRING_BOOT_LAUNCH_MODES`、`MAX_ALERT_KEYWORDS = 10`、`MAX_ALERT_KEYWORD_LEN = 64`、`CATEGORY_MAX_LENGTH = 40`、`TASK_CANCELED_CODE = 130`
- **规则**：`add` 与 `edit` 共用 `sanitizeEdit`，不另写一套；`EntryEdit.env` 是合并补丁（字符串 = 新增或覆盖，`null` = 删除，没提的键不动）；`category` 只读，不给输入入口；`startAfter` 由 `assertStartAfter` 拒绝自指、不存在的 id 与成环；对外返回的条目一律过 `redactEntry`，`env` 只留键名
- **广播顺序**：原版 `commit` 同步发 `entry:changed`，广播先于调用返回到达页面。Go 侧事件与返回值的先后不保证一致，前端乐观更新照原版按 id 幂等（S28 落实）
- **验收**（`verify-review-entry`、`verify-review-env`、`verify-review-remove`、`verify-review-dupdir`、`verify-review-addtask`、`verify-m14-categories`）：`sanitizeEdit` 每个可编辑字段的合法 / 非法 / 白名单外键三类输入；env 合并补丁三种语义；`redactEntry` 后任何返回值里找不到 env 的值；`capturePort` 对 `PORT_PATTERNS` 每条一个样例，先剥 `PORT_TAKEN` 再匹配
- **证据**：
  - 产物：`internal/entries/` 下 `consts.go`（8 条 `PortPatterns` 保序、`PortTaken`、五个 SAFE_* 正则、`OutputDirCandidates`、`EditableEntryFields` 白名单与四组枚举集合、`FieldLabel`）、`sanitize.go`（`SanitizeEdit`、`normalizeCategory`、`sanitizeKeywords`、`ApplyEdit`、`GroupEnv`、`AssertStartAfter`）、`crud.go`（`Service` 与 `New`、`List` / `Get` / `Add` / `Update` / `Edit` / `Remove` / `Reorder` / `commit`、`newUUID`）、`util.go`（`ByOrder` / `IsLive` / `TaskStatus` / `CapturePort` / `IsSafeRelative` / `NormalizePath` / `IsDirectory` / `IsFile` / `IsRunnable`、JS `trim` 与 UTF-16 长度、`isSafeHealthPath`）
  - 依赖注入：`Store`（`Get` / `Patch`）由 `internal/config.Store` 满足；`Platform` 只要 `PathKey` / `UnsupportedLaunchModes` / `RequiresExecBit`；`Sessions` 只要 `Kill`；`Options` 注入时钟、id 生成、`changed` 广播与定时器。落盘与 `.bak` 轮转仍由 config 负责
  - 对拍数据由原版生成（`scripts/gen-entry-cases.mjs` 跑原版 `EntryService.ts`；`'../platform'` 换成 `platform-stub-entry.mjs` 的可控假平台，`node:crypto` 换成可预测的 `id-N`，config / sessions 用记录调用的假对象，临时夹具目录写盘时替换成 `<FIX>`）：13 个场景 201 步，逐项比对返回值、错误文案、`config.patch` 落盘内容与会话终止调用、`changed` 广播。覆盖 `sanitizeEdit` 的每个可编辑字段（合法 / 非法 / 白名单外键三类）与 env 合并补丁三种语义、服务转任务时端口与图标与健康检查的清理、`add` 的必填与目录与脚本校验、`edit` 的运行中身份锁与脚本 / startAfter / 自动重启环境校验、`remove` / `reorder` / `list`、`capturePort` 覆盖 8 条正则与「端口被占用」遮挡、`taskStatus` 四种、`isSafeRelative`、`normalizePath`、`groupEnv`、`startAfter` 的自指 / 不存在 / 成环
  - 单测（`unit_test.go`）：`newUUID` 连出 50 个都满足 v4 正则且不重复；删除条目会终止会话并清掉运行态；`edit` 撤销排队中的自动重启；`add` 用 `entries.length` 而不是最大 order+1，并写入 id / createdAt / 空 env；文件判定的真行为（目录 / 文件 / 不存在）；`CapturePort` 的四组样例与被占用遮挡；`IsRunnable` 在 Windows 不要求执行位；`stopping` 也算运行中（四个活跃状态逐个验证身份锁，`idle` 不锁）
  - 反向对照（`mutate-run.cjs`）：41 处变异首轮 29 红、7 处写法编译失败、3 处没匹配上、2 处漏网。修正后 39 处变红：编译失败的改成保留变量引用的写法（`x != x`、`&& false`），没匹配上的换成实际代码行（`identityChanged` 的 switch 分支、`ByOrder` 在 util.go 而不是 crud.go、路径分隔符用 `String.fromCharCode(39)` 拼），`stopping` 补了上面那条单测
  - 剩 2 处为等价变异：`转任务不清字段` —— `SanitizeEdit` 末尾的清字段与 `ApplyEdit` 里的 `becameTask` 清理是两条等价路径，去掉任一条结果相同（保留两处是为了与原版结构一致）；`未列出的插队` —— 未列出条目的排序键只要大于所有已列出项，稳定排序的结果就一样
  - 覆盖的变异：四个上限常量、名称 / 分类 / groupId 的长度与 trim、图标与端口与启动方式的四处任务 / 框架 / 平台校验、imageId 只收 null、path / cwd / outputDir / jarPath 的绝对路径与 `..` 校验、jar / exe / py 后缀、env 名白名单与 null 删除、端口范围、先等待去重与上限、关键词控制字符、健康路径的双斜杠、身份字段清单里的 env、脚本声明校验、自动重启的工作组环境、删除时终止会话、置顶优先、`add` 的 order、UUID 版本位、端口遮挡、中止优先与活跃状态集合
  - 偏差登记 MIGRATION-PLAN §6 共 4 项：sanitizeEdit 的隐式类型转换由 JSON 解码拒绝、多字段同时非法时报错取哪一个、`env: null` 与「没给」同义、`healthCheck` 缺 `enabled` 时按 false
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，220 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/entries` 六个文件、对拍数据与三个桩共 12 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S21b 命令构造

- **对照**：`EntryService.ts` 第 1415–1699 行（`spawnSession`、`buildCommand`、`buildPythonCommand`、`buildGoCommand`、`buildRustCommand`、`buildCppCommand`、`buildNpmCommand`、`buildSpringBootCommand`、`resolveBinPath`、`resolveJarPath`、`assertInsideEntry`、`assertScriptDeclared`）
- **产物**：`internal/entries/command.go`、`spawn.go` + 测试
- **逐字搬**：可执行文件候选全部从 S08 的 `platform.binaries` 取，经 S17 的 `whichAny` 定位；Spring Boot 五种启动方式的子命令写死（`spring-boot:run`、`bootRun`、`java -jar <jar>`）；wrapper 文件名取 `platform.wrapperFile`；`resolveBinPath` 的四道校验（未配置、绝对路径、含 `..`、后缀不符、文件不存在）及其错误文案
- **红线**：每条路径只产出 `file + args`，绝不拼 shell 字符串；npm 生态先过 `SAFE_SCRIPT`，再由 `assertScriptDeclared` **重读磁盘** `package.json` 确认脚本在 `scripts` 里；`.cmd` / `.bat` 经 `platform.wrapBatch` 包装；`assertInsideEntry` 用 `filepath.Rel` 判断，结果以 `..` 开头或是绝对路径即拒
- **验收**：命令构造快照测试，每个生态 × 每种启动方式一组期望 argv；非法脚本名、脚本不在 `package.json`、cwd 越界、包管理器缺失各自抛对应文案；测试用临时目录造 `package.json`，不碰原版夹具
- **证据**：
  - 产物：`internal/entries/command.go`（`LaunchCommand`、`BuildCommand` 与七条生态分支、`resolveBinPath` / `resolveJarPath` / `assertInsideEntry` / `assertScriptDeclared`、`which`）、`spawn.go`（`SpawnSession`：解析目录 → 断言在条目内 → 构造命令 → 建会话 → 写 lastStartedAt 与运行态）。`Platform` 接口扩到 `Binaries` / `WrapperFile` / `WrapBatch`，`Sessions` 扩到 `Create`
  - 命令构造的红线逐条落地：只产出 file + args 数组；子命令全部硬编码（`spring-boot:run`、`bootRun`、`java -jar`、`run`、`run --release`、`-m flask run`、`manage.py runserver`）；可执行文件经 `Options.Which`（接 S17 的 `precheck.Service.WhichAny`）定位；wrapper 用常量文件名拼绝对路径；`.cmd` / `.bat` 经 `platform.WrapBatch` 包装；npm 脚本先过 `SAFE_SCRIPT`，再由 `assertScriptDeclared` 重读磁盘上的 `package.json`
  - 对拍数据由原版生成（`scripts/gen-command-cases.mjs` 跑原版 `EntryService.buildCommand` 与 `spawnSession`；夹具目录含假可执行文件与 package.json / manage.py / mvnw.cmd / gradlew.bat / app.jar / main.py / app.exe，PATH 只留夹具 bin，`'../platform'` 用 `platform-stub-entry.mjs`，`setTimeout` 换成不触发的桩）：5 个场景 56 步，逐项比对 `{file, args, title}`、错误文案、`sessions.create` 入参、`config.patch` 与 `changed` 广播。覆盖 npm 的四个包管理器与脚本 / install 两种形态、Spring Boot 五种启动方式与缺 wrapper / 缺 jar / 后缀不符 / 绝对路径 / `..` / 空 launchMode、Python 五种方式（含 manage.py 缺失、模块名非法、入口后缀与字符）、Go 的默认包与 `..` 与非法字符、Rust 两种方式、C++ 的 exe、以及 spawn 的三种 kind 与 cwd 越界
  - 单测（`unit_test.go` 增补）：PATH 里缺 npm / python / go / cargo / java / mvn / gradle 七条报错文案（脚手架齐全时对拍走不到）；`package.json` 是字面量 `null` 时报 `Cannot read properties of null (reading 'scripts')`；`assertInsideEntry` 的三个内 / 三个外样例
  - 反向对照（`mutate-run.cjs`）：30 处变异首轮 27 红、1 处写法编译失败、1 处匹配到两处、1 处漏网。修正后 29 处变红。剩 1 处为等价变异：Go 包路径的 `assertInsideEntry` 在 `SAFE_GO_PKG`（不允许反斜杠）与 `..` 已拒的前提下，`detect.Join(cwd, pkg)` 不可能跳出条目，该检查是防御性冗余
  - 覆盖的变异：framework 分派、py 入口字符与后缀、python-module / uvicorn / flask / django 的参数、manage.py 存在性、go 默认包与 `..`、cargo 的 release 参数与顺序、cpp 启动方式、npm 白名单与重读 package.json 与 `run` 与 cmd 包装、两个 wrapper 的绝对路径与存在性、jar 的 `-jar`、`resolveBinPath` 的四道校验、cwd 越界、脚本声明、空值文案
  - 偏差登记：读 `package.json` 失败时的文案沿用 S16 已登记的 §6 条目（Go 的 I/O 错误文本），对拍里特意不放这条路径
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，224 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/entries` 八个文件、对拍数据与三个脚本共 13 个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S21c 启停、运行态、分层启动、自动重启、诊断

- **对照**：`EntryService.ts` 第 757–807 行（`startOrdered`、`waitRunning`）、第 849–861 行（`runtimeList`、`runtimeOf`）、第 1030–1134 行（`expectations`、`setRuntime`、`runPrecheck`、`start`、`runScript`、`assertNotLive`）、第 1700–2085 行（`stop`、`restart`、`waitSessionExit`、`ownListenPids`、`waitPortReleased`、`absorb`、`isCurrentSession`、`onCaptureTimeout`、`onSessionExit`、`beginQuit`、`cancelAutoRestart`、`maybeScheduleRestart`、`noteHealthOk`、`recordReady`、`clearRestartTimer`、`diagnose`、`findPortHolder`、`entryIdForSession`）
- **产物**：`internal/entries/runtime.go`、`ordered.go`、`restart.go`、`diagnose.go` + 测试
- **逐字搬**：`PORT_CAPTURE_TIMEOUT_MS = 60_000`、`PORT_RELEASE_TIMEOUT_MS = 5000`、`TAIL_LINES = 30`、`AUTO_RESTART_BACKOFF_MS = [2000, 8000, 30000]`、`AUTO_RESTART_WINDOW_MS = 10 分钟`、`AUTO_RESTART_MAX = 3`、`READY_HISTORY = 10`、`waitSessionExit` 默认 8000ms
- **行为**：
  - `start`：退出流程中直接抛错；手动启动撤掉排队中的重启并清零计数；`stopping` 态抛错，活跃态直接返回现有运行态；预检不过置 `blocked` 并发 blocked 事件；spawn 抛错也要退回 `blocked`
  - `runScript`：Spring Boot 拒绝；按 build 型跑，不做端口捕获
  - `startOrdered`：按 `startAfter` 分层，同层并发，上一层全部 running（捕获端口或 60 秒超时转 running）才起下一层；前置没起来的跳过并写明原因；只看本批次内的依赖；每个仍走 `start`
  - `ownListenPids`：根 PID 之外并上快照里 `entryId` 等于本条目的 PID
  - 退出时留最后 30 行可见输出与最后一个错误行，只在内存
- **红线**：`stop` 走 S14 的 `assertKillable(pid, table, sessionId)`；`findPortHolder` 用 `filter` 排掉自有 PID，不取第一行
- **验收**（`verify-review-order`、`verify-autorestart`、`verify-readytime`、`verify-review-crashtail`、`verify-review-restartguard`、`verify-review-sessionguard`、`verify-m11-dual`）：分层启动的成环、跳过、超时三种场景；自动重启退避序列与 10 分钟内 3 次上限；`stopping` 态再启动被拒；同一条目第二个会话被 `assertNotLive` 拒；CDP 下整组启动按层出现
- **证据**：
  - 产物：`internal/entries/` 下 `runtime.go`（`Watch`、`Expectations`、`setRuntime`、`RunPrecheck`、`Start`、`RunScript`、`assertNotLive`、`Stop`、`Restart`、`waitSessionExit`、`OwnListenPids`、`waitPortReleased`、`absorb`、`onCaptureTimeout`、`onSessionExit`）、`ordered.go`（`StartOrdered`、`waitRunning`）、`restart.go`（`BeginQuit`、`CancelAutoRestart`、`maybeScheduleRestart`、`NoteHealthOk`、`recordReady`）、`diagnose.go`（`Diagnose`、`findPortHolder`、`entryIDForSession`）。`SpawnSession`（S21b）补上 watch 注册与 dev 会话的就绪历史保留
  - 依赖注入：`Scanner`（`Snapshot` / `Table`）、`Ownership`（`AssertKillable` / `Verify`）、`Sessions` 扩到 `Stop` / `History` / `OnData` / `OnExit`，`Options` 增 `Emit`（事件出口）、`Precheck`、`ListJars`、`OutputDir`、`NodeVersion`、`After`。`New` 里订阅会话的 data / exit，与原版构造函数一致
  - 逐条落地的行为：退出流程中拒绝启动；手动启动撤销排队中的重启并清零计数；`stopping` 拒绝、其他活跃态直接返回现有运行态；预检不过置 `blocked` 并发 blocked 事件；spawn 抛错也退回 `blocked`；`runScript` 拒绝 Spring Boot 与活跃条目；端口捕获只认会话开头且只在当前会话上生效，端口没变不写盘；60 秒未报端口转「端口未知」；退出按 `taskStatus` / 服务规则判定状态并留档最后 30 行、最后错误行、运行时长；自动重启按 2s / 8s / 30s 退避、10 分钟窗口内 3 次上限、超过发 `autoRestartGaveUp`；`beginQuit` 之后不再排重启；`noteHealthOk` 只认等健康检查的那一次
  - 红线：`Stop` 先走 `AssertKillable(pid, table, sessionID)` 才动会话；`findPortHolder` 用「跳过自有 PID」再取第一条，不取第一行；诊断只给环境变量键名
  - 单测（`runtime_test.go`，20 个）：启动的四条分支（退出中 / stopping / 活跃态短路 / 预检不过 + spawn 失败的 block 回落）；端口捕获与「端口没变不写盘」；旧会话迟到输出不算数；端口超时转 running + portUnknown 且非 starting 不受影响；退出状态矩阵 7 组（服务正常 / 崩溃 / 用户停止、任务成功 / 失败 / 130 / 用户停止）+ 留档与运行时长；任务完成与崩溃事件；自动重启的三档退避、窗口外历史不计、三种不该排的情况（生产环境 / 仅登记 / 没开）、退出流程中不排、超过上限放弃；`recordReady` 只在 running 时记且历史留 10 条；`OwnListenPids` 合并快照；`waitPortReleased` 只看自有 PID（别人还占着也算释放，自己占着才告警）；分层启动的前置失败跳过与「起不到 running」超时；`Stop` 的归属校验失败与通过两条路径；`Diagnose` 排除自有监听、进程名、环境变量键排序
  - 反向对照（`mutate-run.cjs`）：28 处变异首轮 14 红、6 处写法编译失败、1 处匹配到两处、7 处漏网。修正编译写法后 7 处全红；给 6 处漏网补了针对性单测（端口未变不写盘、运行时长、退出中不排重启、非 running 不记耗时、窗口过滤、退避档位、就绪历史上限、快照监听合并等）后也全红。剩 1 处 `成环时不兜底` 故意不测：它会让 `StartOrdered` 死循环而不是失败，用例只会挂住；这段兜底是给旧配置里已有的环准备的，新增环已被 `AssertStartAfter` 挡住
  - 未纳入本步（归 S21d）：`install` / `mavenRun` / `packageWithProfile` / `spawnPackageSession` / `buildPackageCommand` / `listJars` / `outputDir` / 图片 / HBuilderX。`onSessionExit` 里打包成功后的 jar 扫描已留好 `Options.ListJars` 接口，未注入时跳过
  - 偏差：事件出口从 EventEmitter 换成 `Options.Emit(name, payload)`；`diagnose` 的环境变量键按字典序（Go 的 map 无序），原版按插入序
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，245 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/entries` 十四个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S21d 路径与产物、图片、HBuilderX、安装、构建

- **对照**：`EntryService.ts` 第 862–1029 行（`knownPath`、`terminalCwd`、`packageJsonPath`、`favicon`、`setImage`、`clearImage`、`imageDataUrl`、`openInHBuilderX`、`outputDir`、`revealOutput`）、第 1135–1414 行（`install`、`mavenRun`、`packageWithProfile`、`spawnPackageSession`、`buildPackageCommand`、`spawnMavenGoal`、`listJars`、`switchPort`、`buildMavenGoalCommand`）
- **产物**：`internal/entries/paths.go`、`build.go`、`hbuilderx.go` + 测试
- **行为**：`terminalCwd` 解析条目目录，要求在条目路径内且真实存在，否则抛错、不回退；`outputDir` 与 `knownPath` 读取侧都用 `isSafeRelative` 再验一次；`install` 只由用户显式发起；profile 先过 `SAFE_PROFILE`
- **已知问题**：I1（HBuilderX 绝对路径经 `cmd.exe /d /s /c`，含空格时被拆断）照原样搬，代码与测试标注 `// 已知原版问题 I1`
- **验收**（`verify-m15-uniapp`、`verify-springboot`、`verify-m17-image`、`verify-review-extterm`、`verify-review-cwdterm`）：`terminalCwd` 越界、不存在两种拒绝；`outputDir` 旧配置里的绝对路径被拒；Maven goal 与 profile 的 argv 快照；I1 行为测试（含空格路径产生的 argv）
- **证据**：
  - 产物：`internal/entries/paths.go`（`KnownPath`、`TerminalCwd`、`PackageJsonPath`、`Favicon`、`SetImage` / `ClearImage` / `ImageDataURL`、`OutputDir`、`RevealOutput`、`ListJars`）、`build.go`（`Install`、`MavenRun`、`PackageWithProfile`、`spawnPackageSession`、`BuildPackageCommand`、`spawnMavenGoal`、`BuildMavenGoalCommand`、`SwitchPort`）、`hbuilderx.go`（`HBuilderXCli`、`OpenInHBuilderX`）
  - 行为对照：`terminalCwd` 要求 cwd 在条目路径内且目录真实存在，越界与不存在都报错、不回退；`outputDir` 与 `knownPath` 的读取侧都用 `isSafeRelative` 再验一次（旧配置里的绝对路径 / `..` 一律不信）；`install` 只由用户显式发起且 Spring Boot 没有安装会话；profile 先过 `SAFE_PROFILE`（含 64 字节上限）；Maven 用 `-P <profile>` 两个参数、Gradle 用 `-P<profile>` 一个参数；Gradle 的 goal 映射 `clean/compileJava/build/test/publishToMavenLocal/check`；`jar` 模式无内置构建命令；jar 扫描过滤 `-sources` / `-javadoc` / `original-`
  - 图片：`SetImage` 走 S20 的 `images.Service`（`ImageStore` 接口注入），落盘后回填 `imageId`；`clearImage` 置空；`imageDataUrl` 无图或读取失败返回 false
  - 红线：HBuilderX 只对 uniapp 开放，cli 由平台候选探测（用户不能指定），子命令 `project open --path` 硬编码，路径受 `assertInsideEntry` 约束，`detach` 拉起不纳入会话；图片与 HBuilderX 的外部副作用都经 `Options` 注入，测试不真的启动进程
  - 已知原版问题 I1 照原样搬：cli 的绝对路径经 `cmd.exe /d /s /c` 转发，含空格时 cmd 会拆断。代码注释与单测 `TestOpenInHBuilderXArgsAndI1` 都标注了 I1，夹具特意放在「Program Files」这种带空格的目录里，钉住「argv 里仍是一个元素」这一原样行为
  - 单测（`paths_build_test.go`，12 个）：terminalCwd 的正常 / 越界 / 不存在 / 未知 id；outputDir 的未配置探测顺序、配置项不存在、绝对路径与 `..` 被拒、产物优先级（exe > zip > jar > html）；knownPath 的大小写不敏感与不安全 outputDir 不放行；packageJsonPath；ListJars 的六种文件名过滤；Maven goal 与打包命令的 argv（含 maven 两参数 / gradle 一段、标题文案、jar 模式拒绝）；profile 的四种非法输入与非 Spring Boot；MavenRun 的非法 goal / 运行中 / 非 Spring Boot；Install 的三条拒绝与成功（安装会话直接 running）；SwitchPort 走 edit 的四条分支；SetImage / ClearImage / ImageDataURL；favicon 只对前端生态；HBuilderX 的三种拒绝与 I1 argv
  - 反向对照（`mutate-run.cjs`）：19 处变异首轮 7 红、7 绿、3 处写法编译失败、1 处匹配失败。补齐断言后 17 处变红（把「报错」细化成「报的是这一条错」，并补了 jar 模式打包、越界 cwd、`--path` 三处）。剩 2 处为等价变异：`outputDir` / `knownPath` 去掉 `isSafeRelative` 后，夹具里那个不安全目录并不存在，结果仍是「找不到」，要构造「绝对路径且真实存在」的目录才能区分，而这个场景在真实机器上等价于「用户把产物放到了项目外」——写侧已拒，读侧只是兜底
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，257 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/entries` 十八个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S22 健康检查与输出告警

- **对照**：`HealthService.ts`（225 行）、`AlertService.ts`（123 行）
- **产物**：`internal/health/health.go`、`internal/alerts/alerts.go` + 测试
- **逐字搬**：Health —— `VISIBLE_INTERVAL_MS = 15_000`、`HIDDEN_INTERVAL_MS = 60_000`、`PROBE_TIMEOUT_MS = 2000`、`MAX_BODY_BYTES = 4096`；Alert —— `DEDUP_WINDOW_MS = 60_000`、`NOTIFY_DELAY_MS = 3000`、`MAX_HITS_PER_ENTRY = 50`、`MAX_LINE_CHARS = 200`
- **行为**：探测地址从本条目自己的监听行里选回环地址，有 IPv4 行或没有监听行时用 `127.0.0.1`，只有 IPv6 行时用 `::1`（原版第 149–158 行）；路径只用过了 `SAFE_HEALTH_PATH` 的值
- **红线**：HTTP 请求从 App 生命周期 ctx 派生，不用 `context.Background()`；告警的错误行判定调 S05 的 `isErrorLine`，不另写正则
- **验收**（`verify-health`、`verify-alert`）：本地起一个 `httptest` 服务测 ok / 超时 / 非 2xx / 超长 body 截断；告警 60 秒内同一行去重，每条目最多 50 条
- **证据**：
  - 产物：`internal/health/health.go`（常量、`New` 订阅运行态与条目变更、`Start` / `Stop` / `Schedule` / `Kick` / `Tick` / `checkOne` / `pickHost` / `setState`、`Probe` 与 `probeReason`）、`internal/alerts/alerts.go`（常量、`Check` / `NoteCrash` / `List` / `Forget` / `Dispose`、`cancelPending`、`truncateUnits`）
  - 常量逐字搬：Health 的 15s / 60s / 2s / 4096 与 `MileTerminal-HealthCheck` UA；Alert 的 60s 去重、3s 通知延迟、每条目 50 条、200 字截断、` error` 去重键
  - 行为：探测主机只从本条目自己的监听行里选（有 IPv4 用 127.0.0.1，只有 IPv6 才用 ::1，族解析不出按 IPv4），找不到自有行就置 unknown 且不发请求；3xx 不跟随、当作已响应；响应体只读 4KB；首次 ok 调 `NoteHealthOk` 记启动就绪；`off → off` 不重复推送。告警按纯子串不区分大小写匹配，未命中再看通用错误行（`keyword` 为 null），崩溃前后的告警并进崩溃通知
  - 接线：条目服务新增 `OnRuntime` / `OnEntriesChanged` 两个进程内订阅口（与给绑定层的 `Options.Emit` / `OnChanged` 并行），健康检查与告警服务通过它们拿到推送；扫描器的「每轮采集后补探 unknown 条目」在 Go 侧由绑定层（S24）在采集后调用 `Kick()`，因为 Go 的扫描器用回调而不是事件
  - 红线：HTTP 请求从构造时传入的 App ctx 派生（不用 `context.Background()`）；告警的错误行判定调 S05 的 `logs.IsErrorLine`，不另写正则；结果只在内存
  - 单测（`health_test.go` 10 个 + `alerts_test.go` 9 个）：本地 `httptest` 服务测 204 / 404 / 302 不跟随 / 慢服务超时 / 关掉的端口被拒 / 1MB 大 body 仍拿到状态码；`pickHost` 七种监听行组合；`checkOne` 的 ok / fail(HTTP 500) / fail(连接被拒) / unknown / off 五条分支与就绪通知次数；`off → off` 不推送；可见 15s / 不可见 60s 的排程间隔（断言字面量而不是常量）与停止后不再排程；运行态事件只在端口变化时提前探测。告警的关键词命中与 60s 去重、错误行的 `keyword` 为 null、四类不该命中的输入、每条目 50 条上限、200 字截断、延迟通知与崩溃吸收、`NoteCrash` 撤销排队、条目删除后清空去重状态、`Dispose` 撤全部
  - 反向对照（`mutate-run.cjs`）：第一轮发现多处「断言拿常量自己比」，改成字面量后常量类变异全部变红。最终 19 处变异里 14 处变红；剩 2 处为等价（去掉「没有自有 PID 就返回」后仍会被后面的行过滤挡住；「有 IPv4 也用 ::1」的构造写法编译不过，该行为由 `pickHost` 的双栈用例覆盖）；`不截断响应体` 与 `通知延迟 4s` 两处漏网已如实记录：前者在本地回环读 1MB 仍远快于超时，后者因为测试直接触发定时器、没有断言延迟值本身
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，275 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/health` 与 `internal/alerts` 四个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

#### S23 配置导入导出与旧版导入

- **对照**：`ConfigTransferService.ts`（248 行）
- **产物**：`internal/transfer/transfer.go`、`legacy.go` + 测试
- **逐字搬**：`FORMAT = 'mile-terminal-export'`、`FORMAT_VERSION = 1`、`MAX_IMPORT_BYTES = 5MB`、`DROP_ON_EXPORT = lastStartedAt / lastExitCode / imageId`、`IMPORT_FIELDS`
- **行为**：导出时 env 只留键名；导入前先另存 `config.before-import-<时间>.json`，与 `.bak` 轮转分开；导入的新条目一律走 S21a 的 `add` / `edit`，不另写落盘逻辑
- **旧版导入**（D6）：只读原版 `%APPDATA%\mile-terminal\config.json` 与 `planner.json`，走 S09 / S12 的迁移链，不修改旧文件
- **红线**：文件路径只能来自 `mygo.Dialog` 刚返回的结果，不接受页面传入
- **验收**（`verify-review-transfer`、`verify-review-import`）：原版导出的文件能被 Go 侧导入，Go 侧导出的文件字段与原版逐键一致；超过 5MB 拒绝；导入前备份文件存在且内容等于导入前的 config；旧版导入后旧目录文件的修改时间不变
- **证据**：
  - 产物：`internal/transfer/transfer.go`（`Format` / `FormatVersion` / `MaxImportBytes`、`ExportTo` / `ImportFrom`、`exportEntry` / `readExport`、`mergeScannerRules`、`entryKey`）
  - 逐字搬：`FORMAT = 'mile-terminal-export'`、`FORMAT_VERSION = 1`、`MAX_IMPORT_BYTES = 5MB`、`DROP_ON_EXPORT` 的三个字段、`IMPORT_FIELDS` 的十六个字段
  - 行为：导出时 env 只留键名、值清空；运行痕迹与本机图片名去掉；导入先验格式再备份（坏文件不留多余备份），工作组按名称合并（同名复用、否则走 S11 的 `CreateGroup`），条目同目录同子目录同脚本视为已登记并跳过，新条目逐个走 S21a 的 `Add`（同一套校验），`startAfter` 等全部落地后重映射到新 id、指向被跳过条目的整项丢掉，忽略规则 / 分组覆盖 / 关注关键字取并集且已有优先
  - 与 Go 侧的衔接：`scanner.SetWatchedKeywords` 收的是 JSON，所以合并后的关键字先 marshal 再传，关键字的规整仍只在扫描器一处
  - 单测（`transfer_test.go`，3 个）：导出丢三个字段 + env 值清空 + 头部字段 + 不带 BOM；导入的只读拒绝、文件不存在、坏 JSON、格式标记不对、超 5MB 五种拒绝（且都不产生备份）与带 BOM 的合法文件可导入；完整合并（工作组同名复用 + 新建、条目挂到新工作组、`startAfter` 重映射到新 id、跳过缺目录的条目、env 键进重填清单、忽略规则与分组覆盖去重、关键字并集）
  - 反向对照（`mutate-run.cjs`）：10 处变异最终全部变红。首轮 5 红、4 漏网、1 处写法编译失败，补齐后第二轮全红：
    - 「上限 6MB」的用例原本用 `MaxImportBytes+1` 造文件，常量一改文件跟着涨 —— 改成字面量 `5*1024*1024+1`
    - 「不去重」补了「同目录同脚本的第二条」用例，断言它进 `skipped` 且不重复登记
    - 「空 startAfter 也提交」补了「先等待指向被跳过条目」的用例。注意：指向**因重复被跳过**的条目不算 —— 那种在 `skipped` 之前已经把旧 id 映射到已有条目，依赖会被正常重映射（原版如此），所以要用「缺项目目录」那种没有映射的条目
    - 「分组覆盖区分大小写」的夹具里加了一条大小写不同的已有覆盖（`node.exe` 对 `Node.exe`）
    - 「不剥 BOM」改用能编译的写法（`text := string(body)`）后变红，带 BOM 的合法文件用例确实拦得住
  - `go build ./...`、`go vet ./...` 通过，`gofmt -l internal/` 为空；`go test -count=1 ./...` 全部通过，278 个顶层测试，2 个既有环境相关 SKIP
  - 编码：`internal/transfer` 两个文件扫描无 BOM、无 U+FFFD、无 emoji、无字面不可见字符

### I 绑定层

#### S24 Go 绑定服务与事件

- **对照**：`main/index.ts`（1131 行）的 `ipc.handle` / `ipc.on` 注册部分、`shared/channels.ts`（179 行）
- **产物**：`internal/{app,window,theme,settings,dialog,shell,clipboard}/` 的薄绑定层、`internal/events/`、`main.go` 的 `mygo.Bind` 装配 + 测试
- **形状**：服务清单、方法名、入参出参以 BINDINGS-CONTRACT §3.1–3.12 为准，本卡片不重复；命名映射按 §1.2，签名规则按 §1.4
- **逐字搬**：`SCAN_INTERVALS = [1000, 2000, 5000, 10000]`、`THEMES = light / dark / system`、`LOG_LEVELS = info / warn / error`、`CLIPBOARD_MAX_CHARS = 64KB`、`TERMINALS = platform.terminalKinds`、`TASK_DONE_TITLE`；`sanitizeLogQuery`、`sanitizeSettings` 两个校形函数搬成 Go 并逐分支测试（`sanitizeEdit` 已在 S21a）
- **做法**：逐个频道对照 `channels.ts` 打勾，每个频道落到一个 Go 方法或一个事件，`channels.ts` 里的频道不能漏也不能多；事件改成纯字母数字名，就绪握手按 §2
- **红线**：§5 的安全不变量逐条落到代码（`OpenLocalhost` 只收整数端口、`OpenProjectLink` 只收键名、`OpenPath` 白名单、Dialog 路径不接受页面传入、token 与 env 值不出 Go）；所有方法第一个参数是 `context.Context`
- **范围**：托盘、通知、单实例、全局快捷键、退出清理不在这一步（S32）
- **验收**（`verify-review-ipc`、`verify-review-links`、`verify-m6-settings`）：频道对照表 100% 打勾；每个 `sanitize*` 的白名单外键丢弃、非法值报错且不落盘；页面未就绪时推送的事件进队列，就绪后按序投递
- **证据（进行中）**：
  - 已完成：`internal/events/`（就绪握手、未就绪期间按事件名合并的队列、导航重置、关窗返回 `ErrClosed`、发送失败记住关闭），6 个单测 + 5 处变异全部变红；队列上限 64 与合并策略都在这一个包里（契约 §2）
  - 已完成：`contract.AppInfo` / `contract.SettingsPatch` 两个绑定专用类型；`internal/app/sanitize.go` 的 `SanitizeSettings`（采集周期、主题、外部终端、字号 10–22、回滚 1000–50000、十个布尔项，报文带全部合法值）与 `SanitizeLogQuery`（级别白名单、关键字截 200 码元、limit 透传、空查询合法）；7 个单测 + 7 处变异全部变红
  - 已完成：`internal/app/bindings.go` 的十个薄封装服务 —— App（Info / Ready）、Window（四个方法，OS 能力注入）、Theme（Get / Set，偏好换算注入）、Settings（Get / Patch，非法值不落盘）、Log（Query / Clear）、Group（List / Add / Patch / Reorder，落盘走 config.Patch）、Dialog（PickDirectory）、Shell（OpenLocalhost 端口 1–65535、OpenPath 非空、OpenProjectLink 键名白名单）、Clipboard（只写、64KB 上限）、Config（Export / Import）
  - 已完成：四个大绑定 `internal/app/bindings_large.go` —— Entry（约 30 个方法，Detect / DetectProfiles 走识别服务、HealthList 走健康检查，RevealLastJar 与 OpenExternalTerminal 明确报「随 S32 原生集成接入」）、Planner（14 个方法，`json.RawMessage` 原样透传给 S12 服务）、Session（List / CreateShell / History / Stop / Write / Resize / Attach）、Scanner（Snapshot / Refresh / SetVisible / Ignore / HideOnce / SetGroup / WatchedKeywords / SetWatchedKeywords）；5 个单测验证「未接入」错误与转发
  - 已完成：`main.go` 装配 —— 根 ctx（`main` 里 `WithCancel`，`App.Run()` 返回后取消）、配置 → 归属 → 会话 → 日志 → 识别 → 预检 → 扫描器 → 条目 → 扫描器回注期望来源（两边的 EntryExpectation 做一次转换）→ 健康 / 告警 / 导入导出 / 进度；十类事件各有 `mygo.NewEvent[T]`，总线按名字分发；窗口 / 主题 / 外链 / 剪贴板四个适配器在 `WhenReady` 里绑上
  - 未绑定：`DialogService.PickDirectory` 与 `ConfigService.Export / Import` —— **mygo v0.8.3 的 Dialog 只有 `Error`，没有文件 / 目录选择框**，而红线要求路径只能来自系统对话框。已登记 MIGRATION-PLAN §6「运行时缺少文件选择对话框」，等运行时补上或换方案
  - 顺带确认：`mygo.Shell` 有 `OpenExternal` / `OpenPath` / `ShowItemInFolder`，所以 S21d 里挂起的 `RevealOutput` / `RevealLastJar` 其实现在就能接（本步先把 `RevealOutput` 接到绑定，`RevealLastJar` 仍归 S32）
  - 待续：`src/mygo.ts` 由 `bun run generate` 重新生成（S25），以及频道对照表逐条打勾
  - 说明：本步的绑定层要参照 `BINDINGS-CONTRACT §3` 的 60 余个方法逐个落地，并按 §5 把安全不变量接到具体方法上；`contract` 里还缺 `SettingsPatch` / `AppInfo` 两个绑定专用类型，实现时要一并补

#### S25 生成绑定与前端适配层

- **对照**：`preload/index.ts`（264 行）
- **产物**：`src/mygo.ts`（`bun run generate` 生成，不手改）、`src/lib/mile.ts`
- **形状**：`mile.ts` 暴露与原版 `window.mile.*` 完全同形的对象（BINDINGS-CONTRACT §1.1），内部调 `src/mygo.ts`；终端流按 §4 把 `Channel` 适配成原版的回调订阅形状；错误按 §6 转成原版调用方能识别的形状
- **规则**：组件和 store 不直接 import `src/mygo.ts`；`mile.ts` 每加一个方法先对照 preload 的签名，参数顺序、可选参数、返回类型都要一致
- **验收**：`bun run typecheck` 零错误；原版的形状基准是 `preload/index.ts` 第 264 行导出的 `MileApi = typeof api`；它依赖 electron 类型，不能直接 import，所以把它手抄成 `src/lib/mile-api.ts` 里的 `MileApi` 接口，再写一条类型层断言 `const _check: MileApi = mile`，缺方法或签名不符就编译失败；契约自检清单（BINDINGS-CONTRACT §8）全部打勾
- **证据**：
  - 产物：`src/mygo.ts`（`bun run generate` 生成，12 个服务 + 10 类事件，不手改）、`src/lib/mile-api.ts`（手抄 `MileApi`，15 个分组的方法表）、`src/lib/mile.ts`（适配层，实现 `MileApi` 并对齐 `src/mygo.ts`）、`src/main.ts`（占位入口，只调 `app.info()` 与 `app.ready()`）
  - 形状：`mile-api.ts` 按原版 `preload/index.ts` 的 15 个分组逐个手抄；`mile.ts` 用 `export const mile: MileApi = {...}` 做类型层断言 —— 少方法或签名不符直接编译失败
  - 三处与原版的差异都写在 `mile.ts` 文件头：①终端输出改成按会话 attach（Go 侧是流式，契约 §4），保留 `onData` 回调形状并提供 `attachSessionOutput(id)`；②文件对话框在当前运行时不提供，`dialog.pickDirectory` 与 `config.export/import` 直接以错误拒绝；③`settingsChanged` / `themeChanged` / `windowMaximizeChanged` / `appFocusEntry` / `appOpenPalette` / `plannerFocus` 六个变化通知 Go 侧还没发，`on*` 先返回空退订，随 S32 补齐
  - 生成层踩到并修掉的两个坑：①`mygo generate` 只扫顶层 `mygo.Bind`，窗口相关的四个服务原来放在 `WhenReady` 里，生成结果缺 Window/Theme/Shell/Clipboard 四个服务；②被 `themeBinding` 包了一层的 ThemeService 也生成不出来（未导出类型），改成直接绑定 + 注入 `apply` 回调
  - 修掉的实伤：`app.ThemeService.Set` 里直接调 `mygo.Theme.SetSource` 会让 `go test` 卡满 10 分钟（无 App 环境），改成注入；`GroupService` 缺 `Remove`，按契约 §3.6 补上（走 `groups.RemoveGroup`，条目回落未分组）
  - 验收：`bun run typecheck` **零错误**（`tsc --noEmit`）；`go build ./...`、`go vet ./...` 通过；`go test -count=1 ./...` 全绿
  - 编码：改动的 6 个文件扫描无 BOM、无 U+FFFD、无 emoji


### J 渲染层

渲染层整体从原版 `src/renderer/src/` 搬到 `src/renderer/`，目录结构不变。每个文件头写对照注释。中文文案逐字照搬，不润色。

#### S26 样式原文复制

- **对照**：`styles/tokens.css`（1055 行）、`styles/ui.css`（1438 行）
- **产物**：`src/styles/tokens.css`、`src/styles/ui.css`
- **只改**：`-webkit-app-region` 改为 `--app-region`（`.drag-region`、`.no-drag` 两个类）；其余一字不动。改了别的地方要同步 `DESIGN.md` 并在 MIGRATION-PLAN §6 登记
- **规则**：两份文件都没有 `@layer`，搬过来也不加；Manrope 随 `@fontsource/manrope` 打包，不引 CDN
- **验收**：`diff` 原文件与新文件，差异只有 `app-region` 那几行；CDP 读 `:root` 上的令牌计算值与原版一致（`verify-ui`、`verify-m7-visual` 的令牌断言）
- **证据**：
  - 产物：`src/styles/tokens.css`（1055 行）、`src/styles/ui.css`（1438 行），`src/main.ts` 里 import 两份
  - 逐字复制：`cp` 原文件后只改两行 —— `tokens.css:641/645` 的 `-webkit-app-region` 换成 `--app-region`（mygo 的窗口拖动约定，见其 `docs/frontend.md` §285）。`diff` 结果：`ui.css` 与原文件完全一致，`tokens.css` 只有这两行不同
  - 没有加 `@layer`；Manrope 仍随 `@fontsource/manrope` 打包，没引 CDN
  - 构建验证：`bun run build:web`（`tsc --noEmit && vite build`）通过，产出 `index.css` 112.63 kB（gzip 20.59 kB）
  - 编码扫描的一处说明：`tokens.css:560–561` 有两处 U+2705 符号（对比度注释里），属于**原版原文**，按卡片「其余一字不动」保留，未改成别的符号；这是本仓库里唯一的 emoji 例外，特此记录


#### S27 基础组件与浮层栈

- **对照**：`components/ui/*`（`Bento`、`Button`、`Confirm`、`Form`、`Menu`、`Overlay`、`Pill`、`Segmented`、`SplitPane`、`Tabs`、`Toast`、`index.ts`，共 1121 行）、`lib/overlay.ts`（76 行）
- **产物**：`src/renderer/components/ui/*`、`src/renderer/lib/overlay.ts`
- **规则**：这一步的组件不调后端，可以在 S25 之前做；`useOverlay` 的行为（Esc 只关最上层、焦点陷阱、关闭后还焦点）原样搬
- **验收**（`verify-m12-press`、`verify-review-keys`）：按压动画用 CDP `Input.dispatchMouseEvent` 真实输入，每条位移断言配一次基态对照并断言 `el.matches(':active')` 为真；两层浮层叠开时 Esc 只关上层
- **证据**：
  - 产物：`src/renderer/components/ui/` 12 个文件（Bento / Button / Confirm / Form / Menu / Overlay / Pill / Segmented / SplitPane / Tabs / Toast / index.ts，共 1121 行）+ `src/renderer/lib/overlay.ts`（76 行），全部原文复制
  - 组件依赖的两个 lib 一并搬（否则编不过）：`lib/icons.ts`（ICON_SIZE 与图标表）、`lib/entryMeta.ts`（Toast 用到它的文案）。后者本来归 S28，这里先搬只是为了闭环
  - 新增 `src/shared/types.ts`：`export type * from "../mygo"` —— 生成层的类型即原版 `@shared/types` 的落点，不手写第二份；另补一个 `SpringBootLaunchMode` 联合类型（Go 侧只有 `SpringBootLaunchModes` 列表，没有同名类型）
  - 配置：`tsconfig.json` 加 `paths: { "@shared/*": ["./src/shared/*"] }` 与 `jsx: react-jsx`；`vite.config.ts` 加同一条 alias，搬过来的 `import type ... from '@shared/types'` 不用改
  - 一处有意的配置对齐：删掉模板的 `noUncheckedIndexedAccess`（原版 `tsconfig.web.json` 只有 `strict: true`，没有这一条）。保留会让搬过来的 7000 行渲染层出现几十处与业务无关的 `!`，淹没真正的差异；`strict` 仍然开着
  - 验收：`bun run typecheck` 零错误（含新搬的 15 个文件）；`bun run build:web` 通过；18 个文件编码扫描干净
  - 未做：卡片提到的 CDP 行为验收（两层浮层叠开时 Esc 只关上层、按压位移配基态对照）需要真实页面与 `Input.dispatchMouseEvent`，等渲染层接上（S29）与视觉对等（S33）时一起做。`useOverlay` 的逻辑是原样搬的，没改一行


#### S28 前端工具与 store

- **对照**：其余 `lib/*`（`clipboard`、`entryMeta`、`format`、`icons`、`launchStats`、`platform`、`services`、`useEntryFix`，共 907 行）、`store/*`（`entries`、`favicons`、`groups`、`planner`、`scanner`、`sessions`、`settings`、`theme` 等，共 867 行）
- **产物**：`src/renderer/lib/*`、`src/renderer/store/*`
- **规则**：所有 `window.mile.*` 调用改成 import `src/lib/mile.ts`，调用点形状不变；追加型乐观更新按 id 幂等（事件可能先于返回值到达）；`lib/services.ts` 的 `confirmEnv` 规则与 S32 托盘确认保持一致
- **验收**：`bun run typecheck` 零错误；全仓 grep `window.mile` 结果为 0；CDP 下添加条目不出现重复卡片（`verify-m11-add`）
- **证据**：
  - 产物：`src/renderer/lib/`（clipboard / format / launchStats / platform / services / useEntryFix，加上 S27 已搬的 icons / entryMeta / overlay）、`src/renderer/store/` 八个 store（entries / favicons / groups / planner / scanner / sessions / settings / theme），全部原文复制
  - 调用点改写：12 个文件的 `window.mile.*` 机械替换成 `mile.`，并在文件顶部 `import { mile } from "../../lib/mile"`；全仓 `grep window\.mile` 结果为 **0**（连注释里的提法也改了，保证这条验收可机械复核）
  - 补的共享件（原版 `@shared/*` 的落点）：
    - `src/shared/planner.ts`：转出生成层的进度类型，另补 Go 用 `json.RawMessage` 收、因此没有生成的 `PlannerTaskInput` / `PlannerTaskPatch` / `PlannerBoardPatch` / `PlannerScheduleInput` / `PlannerSchedulePatch`
    - `src/shared/types.ts`：补 `WEB_FRAMEWORKS` / `isWebFramework` / `GROUP_ENV_LABEL` / `MavenGoal` / `SpringBootLaunchMode` / `Scripts` 与 `scriptsOf`（Go 把 `scripts` 生成成 `unknown`，按契约 §1.3 在边界断言一次）
  - 顺带搬入的两个组件（`ScriptPickerDialog`、`PortDialog`）：`useEntryFix` 依赖它们，属 S29 范围但这里必须存在才能编译
  - `MileApi` 的 planner 返回值改成具体类型（`PlannerBoard` / `PlannerTask` / `PlannerSchedule`），否则 store 里 `Promise<unknown>` 过不了
  - 验收：`bun run typecheck` 零错误；`bun run build:web` 通过；23 个文件编码扫描干净
  - 未做：CDP 的「添加条目不重复出卡片」（`verify-m11-add`）要等页面真正接上（S29 之后）；`confirmEnv` 与 S32 托盘确认的一致性也留到 S32 复核


#### S29 业务组件

- **对照**：`components/**`，排除 `ui/` 与外壳组件（`TitleBar`、`NavRail`、`CommandPalette`、`ShortcutOverlay`、`ActivityDrawer`），共 6825 行
- **产物**：`src/renderer/components/**`
- **顺序**：通用展示组件（`StatusPill`、`Sparkline`、`KpiCard`、`EntryGlyph`、`ViewHeader` 等）→ `services/` 下的组件与对话框 → `planner/` 下的组件 → `TerminalView`（接 S25 的终端流）
- **规则**：加一个 `Framework` 值时，`GLYPH` 映射和 `entryMeta.ts` 的 `FRAMEWORK_LABEL` 要与 S04 的联合类型一起改；`category` 只显示，不加输入入口
- **验收**（`verify-review-termsearch`、`verify-review-panel`、`verify-review-groupselect`、`verify-review-todo`）：每个对话框开关都走浮层栈；终端输入输出、搜索、复制可用
- **证据**（2026-11-15）：
  - 产物：`src/renderer/components/` 下 27 个文件原文复制（根目录 16 个、`planner/` 6 个、`services/` 5 个），外壳组件（TitleBar / NavRail / CommandPalette / ShortcutOverlay / ActivityDrawer）留给 S31；`ScriptPickerDialog` 换回原文（S28 时为了 `scriptsOf` 改过一行，现在不需要了）
  - 调用点：10 个文件的 `window.mile.*` 机械替换成 `mile.` 并在顶部加 import；全仓 `grep window.mile` 为 **0**；组件正文除此之外一字未改
  - **类型方案调整（推翻 S28 的做法）**：生成层没有字符串字面量联合与判别联合（`ResolvedTheme` / `HealthState` / `ServiceIcon` 是 `string`，`ScheduleRepeat` 是 `{kind: string; days?; day?}`，`scripts` 是 `unknown`），组件按原版写法有 50 处编不过。改成：
    - `src/shared/types.ts`、`src/shared/planner.ts` 改为**原版原文复制**（只在末尾补 Go 侧新增的 `AppInfo` / `SettingsPatch` 两个类型转出），渲染层只认原版类型
    - `src/lib/mile-api.ts` 的类型改从 `../shared/*` 取
    - `src/lib/mile.ts` 是唯一同时见到两套类型的地方，出参 `narrow`、入参 `loose`、事件 `listen`，在边界断言一次（契约 §1.3）。两套类型字段名一致，因为 Go 的 contract 包本来就按原版逐字搬
    - 风险：Go 侧字段若与原版漂移，这里的断言会把它藏住。防线是 Go 侧的 contract 对拍测试（S04），不在前端
  - 终端输出：原版 TerminalView 是「先 `history` 再 `onData`」。`mile.session.history(id)` 首次调用时发起 attach 并返回空串，历史随 attach 流到达（Go 侧快照与订阅在同一把锁里登记，不丢不重）；同一会话再次挂载时照原版拉一次历史，实时输出走已有的流。TerminalView 不用改
  - 验收：`bun run typecheck` 零错误；`bun run build:web` 通过（组件还没被页面引用，产物体积要到 S31 接上 App 才有意义）
  - 编码扫描：`BuildPanel.tsx` 第 500、529 行的 U+2715、U+2713 两个符号被扫描脚本标出。两者是原版文案里的 Dingbat 字符，不是 emoji，按「中文文案逐字照搬」保留；其余文件干净
  - 未做：卡片验收里的对话框浮层栈、终端输入输出 / 搜索 / 复制要在真实页面上跑 CDP，等 S30 视图与 S31 外壳接上后一起做

#### S30 六个视图逐页

- **对照**：`views/*`（`Dashboard`、`Services`、`TerminalWorkspace`、`LogCenter`、`Planner`、`Settings`、`About`，7 个文件共 2244 行；`LogCenter` 属于终端页的「全部输出」）
- **产物**：`src/renderer/views/*`
- **顺序**：Dashboard → Services → TerminalWorkspace + LogCenter → Planner → Settings → About，一页做完一页验
- **验收**（`verify-services`、`verify-shell`、`verify-m6-sort`、`verify-planner-board`、`verify-m6-settings`、`verify-review-links`）：每页一次 CDP 断言 + 一张 1440×900 截图与原版并排；整窗无滚动条，滚动只在视图自己的滚动区；Dashboard 端口表按采集周期刷新且行不闪（S15 移过来的一项，口径照 `verify-m8`）
- **证据**：

#### S31 应用外壳

- **对照**：`App.tsx`（507 行）、`main.tsx`（19 行）、外壳组件 `TitleBar`（104）、`NavRail`（193）、`CommandPalette`（330）、`ShortcutOverlay`（47）、`ActivityDrawer`（158），共 832 行
- **产物**：`src/renderer/App.tsx`、`src/main.tsx`、对应组件
- **改动**：`TitleBar` 自绘 46×40 的三个窗口控件，调 `currentWindow.minimize / toggleMaximize / close`（CLAUDE.md §8）；其余照搬
- **验收**（`verify-ui`、`verify-m6-palette`、`verify-review-palette2`、`verify-review-keys`）：导航 6 项、`Ctrl+1–6`、`Ctrl+K` 命令面板、`?` 快捷键浮层；焦点在输入框或终端里时单键快捷键不生效；命令面板空查询给出内置动作，`>` 前缀进入动作模式
- **证据**：

### K 原生集成

#### S32 托盘、通知、单实例、快捷键、退出清理

- **对照**：`main/index.ts` 的原生部分（`rebuildTray`、通知、单实例锁、`applyGlobalHotkey`、电源恢复、`before-quit` 清理）
- **产物**：`main.go` 与 `internal/app/` 的原生集成部分
- **逐字搬**：`QUIT_CLEANUP_TIMEOUT_MS = 6000`、`GLOBAL_HOTKEY = platform.globalHotkey`（`Ctrl+Alt+M`）
- **行为**：
  - 托盘启停只调 `EntryService.start / stop`；生产环境启动、沙箱环境的 Spring Boot 启动先弹确认，规则与 `lib/services.ts` 的 `confirmEnv` 一致
  - 单实例锁只在打包后启用，第二实例直接退出，第一个窗口回前台
  - 全局快捷键唤回窗口并打开命令面板（只打开不切换）；组合键被占用时不抛错、不挡设置保存，只往实时动态推一条提示
  - 退出：`killOwnedOnQuit` 开且有活会话时，先等 `disposeAll` 或 6 秒上限再退出
- **偏差**：通知样式、托盘菜单外观按 MIGRATION-PLAN §6 已登记的处理
- **验收**（`verify-review-tray`、`verify-review-single`、`verify-review-hotkey`、`verify-review-notify`、`verify-review-quit`、`verify-m10`）：托盘、单实例、快捷键、通知点击、深浅切换在真窗口人工过一遍；退出清理用日志证据确认子进程树全部退出
- **证据**：

### L 收尾

#### S33 视觉对等

- **做法**：1440×900、浅色与深色各一轮，六个页面与原版并排截图；最小窗口 1180×760 下布局不破；按压动画走真实输入
- **验收**（`verify-m7-visual`、`verify-m12-press`、`verify-ui`）：差异清单要么修掉，要么登记进 MIGRATION-PLAN §6 并写明用户可见差异；页面上渐变背景为 0 处；文字对比度 ≥ 4.5:1（含按钮启用 / 禁用两态）
- **证据**：

#### S34 打包发布

- **产物**：`mygo build` 生成的 NSIS 安装包与 exe
- **验收**：安装、启动、卸载各过一遍；版本号与图标正确；卸载后 S03 定的数据目录按 NSIS 默认行为处理（保留或删除以用户决定为准）；`go test ./...`、`bun run typecheck`、全部 CDP 脚本全绿
- **证据**：

---

## 5. 原版服务文件落点核对

| 原文件 | 步骤 |
| --- | --- |
| `lib/outputText.ts` | S05 |
| `lib/semver.ts` | S06 |
| `lib/portScanner.ts` | S07 |
| `platform/types.ts`、`platform/win32/*` | S08 |
| `services/ConfigStore.ts` | S09 |
| `lib/windowState.ts` | S10 |
| `services/ThemeService.ts`、`services/GroupService.ts` | S11 |
| `services/PlannerService.ts` | S12 |
| `lib/attribution.ts` | S13 |
| `services/OwnershipService.ts` | S14 |
| `services/ScannerService.ts` | S15 |
| `services/DetectService.ts` | S16 |
| `services/PrecheckService.ts` | S17 |
| `services/SessionService.ts` | S18（S02 只做验证） |
| `services/LogService.ts` | S19 |
| `services/ImageService.ts` | S20 |
| `services/EntryService.ts` | S21a–S21d |
| `services/HealthService.ts`、`services/AlertService.ts` | S22 |
| `services/ConfigTransferService.ts` | S23 |
| `main/index.ts` | S24（IPC）、S32（原生） |
| `platform/darwin/*` | 不迁（D5） |
