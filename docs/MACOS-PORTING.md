# macOS 适配方案与工程量评估

> 状态：方案，未开工。基线版本 2.3.0（`CONFIG_VERSION = 12`）。日期 2026-10-30。
> 本文的数字来自当前仓库的实测统计（行数、调用点、harness 依赖），不是经验估计。

---

## 1. 结论

- **可行，工作量中等**：一名熟悉本项目的开发者，有一台 Mac 的前提下，约 **13–20 人日**。
- 平台相关代码全部集中在主进程，渲染层几乎不动。代码里目前**没有任何 `process.platform` 分支**，是纯单平台写法，所以第一步是抽平台适配层。
- **最大的约束是验证**：node-pty 必须在 Mac 上编译，进程采集、进程组终止、PATH 解析只能在真 Mac 上验证。Windows 机器上只能完成第 0 阶段（抽层，行为不变）和 typecheck。
- 四条安全红线在 macOS 上都能成立，其中「命令不经 shell」「按用户归属判定」在 macOS 上比 Windows 更容易做准。需要新增一个决策：PATH 怎么解析（见 §6）。

---

## 2. 现状盘点

### 2.1 代码规模

主进程共 6751 行，其中与平台相关的集中在下面这些文件：

| 文件 | 行数 | 平台相关内容 |
| --- | --- | --- |
| `lib/winProcess.ts` | 157 | `netstat.exe -ano` 取监听端口；PowerShell CIM 取进程元数据与当前用户 PID |
| `lib/powershell.ts` | 42 | PowerShell 调用封装，只给 winProcess 用 |
| `lib/shell.ts` | 18 | 默认 shell 选 pwsh / powershell / cmd |
| `lib/externalTerminal.ts` | 94 | wt / pwsh / powershell / cmd / Git Bash，经 `cmd /d /c start` 拉起 |
| `lib/attribution.ts` | 163 | 启动来源推断，进程名表约 59 处 `.exe` |
| `services/SessionService.ts` | 258 | `kill()` 用 `taskkill /T /F`；PowerShell 会话先发 `chcp 65001` |
| `services/EntryService.ts` | 1910 | 约 74 处平台相关：`npm.cmd`、`mvnw.cmd`、`gradlew.bat`、`cmd.exe /d /s /c` 包装、HBuilderX `cli.exe`、C++ `.exe` 产物 |
| `services/PrecheckService.ts` | 604 | 运行时可执行文件候选名带 `.exe` / `.cmd`；C++ 产物要求 `.exe` |
| `services/ScannerService.ts` | 579 | 只通过 winProcess 与 attribution 间接依赖平台 |
| `index.ts` | 941 | `icon.ico`、`titleBarStyle: 'hidden'`、`setSkipTaskbar`、托盘图标 |

调用关系是单向的：`ScannerService`、`OwnershipService`、`EntryService` 从 `winProcess` 取进程表；`SessionService` 从 `shell` 取默认 shell；`index.ts` 调 `externalTerminal`。没有反向依赖，适合抽成接口。

### 2.2 跨平台、不用改的部分

- 渲染层：React 19、zustand、xterm。界面不依赖 Windows 特性。
- `ConfigStore`（配置目录走 `app.getPath('appData')`，macOS 自动落到 `~/Library/Application Support/mile-terminal`）、`LogService`、`lib/outputText.ts`、`GroupService`、`ConfigTransferService`、`ImageService`、`startOrdered` 依赖分层。
- `OwnershipService` 的判定逻辑：只依赖抽象的 `ProcessTable`（`byPid`、`mine`、`startedAt`），换数据源即可。
- node-pty 1.1.0、pidusage 4.0.1 都支持 macOS。ConPTY 的绝对光标定位、代码页 936 问题在 macOS 上不存在，`LogService` 现有的兼容处理在 macOS 上无害。

### 2.3 渲染层需要动的地方

14 个文件里有 Windows 特有的写法，主要是三类：

- 快捷键：`Ctrl+1–5`、`Ctrl+K`、`Ctrl+↑↓`、`Ctrl+Tab`，Mac 习惯用 `Cmd`（`App.tsx`、`CommandPalette.tsx`、`NavRail.tsx`、`TerminalView.tsx` 等）。
- 自绘窗口控件：`components/TitleBar.tsx` 的最小化 / 最大化 / 关闭按钮在 macOS 上要隐藏，左侧让出红绿灯位置。
- 文案与选项：设置页的外部终端选项、`.exe` 相关的启动方式提示（`AddEntryDialog`、`EntryConfigForm`、`entryMeta`）、字体栈（`tokens.css`）。

---

## 3. 逐项改造方案

### 3.1 进程采集（`readListenPorts` / `readProcessMeta`）

| 数据 | Windows 现状 | macOS 方案 |
| --- | --- | --- |
| 监听端口 | `netstat.exe -ano`，约 55ms | `lsof -nP -iTCP -sTCP:LISTEN -Fpn`，按 `p<pid>` / `n<addr>` 字段解析 |
| 进程元数据 | PowerShell CIM，约 3.5s | `ps -axo pid=,ppid=,uid=,lstart=,comm=,args=`，设 `LC_ALL=C` 固定日期格式 |
| 当前用户 PID 集合 `mine` | 登录会话关联 | `uid === process.getuid()` |
| 进程创建时间 `startedAt` | `CreationDate`，毫秒 | `lstart`，秒精度。PID 复用判断只比较同一来源的两次读数，秒精度够用 |

需要注意的差异：

- **非 root 时 `lsof` 看不到其他用户的监听**（系统守护进程、别的账户）。Windows 的 netstat 能看到全部。这类端口在监听表里会缺失，端口冲突检测要靠 `portScanner.findFreePort` 的绑定探测兜底，预检文案要能表达「端口被占用，但看不到是谁」。
- 慢层（元数据）在 macOS 上预计远快于 3.5s，`ScannerService` 里为 CIM 慢查询设计的「未知 PID 才刷新」逻辑可以保留，不必改。
- IPv4 / IPv6 双绑在 macOS 上是否同样成立要实测。`verify-m11-dual` 本身先验前提，正好用来确认。

### 3.2 停止进程（`SessionService.kill`）—— 红线 2 相关，单独审查

现状：先写 `\x03`，3 秒后 `taskkill.exe /PID <pid> /T /F`，失败退回 `pty.kill`。

macOS 方案：

1. 先写 `\x03`（node-pty 在 Unix 上把它转成 SIGINT 给前台进程组）。
2. 3 秒后对进程组发 SIGTERM：`process.kill(-pgid, 'SIGTERM')`。node-pty 在 Unix 上用 `setsid` 起子进程，子进程是会话首进程，`pgid === pid`。
3. 再等一个短窗口后 SIGKILL 进程组。
4. 兜底：有些工具（`concurrently`、部分 watch 工具）会让子进程另起进程组。按 `ps` 的 `ppid` 链找后代，逐个经 `OwnershipService.assertKillable` 校验后再杀。

不变的约束：

- kill 前重新验证归属，第三个参数 `sessionId` 照传。
- PID 复用防护改用 `lstart`。
- `disposeAll()` 在退出流程里仍要等每个进程组真正结束（现有 6 秒上限保留）。

这一块的 harness 必须先跑红：在 macOS 上造一个「另起进程组的孙进程」夹具，确认旧逻辑漏杀、新逻辑杀干净且不碰外部进程。

### 3.3 命令构造（`EntryService`，红线 3 相关）

Windows 上 `npm.cmd`、`mvnw.cmd` 是批处理，必须经 `cmd.exe /d /s /c` 转发，所以有约 8 处包装。macOS 上全部直接 `spawn(file, argsArray)`，不经任何 shell，比现在更贴合红线 3。

| 生态 | Windows | macOS |
| --- | --- | --- |
| npm / pnpm / yarn / bun | `cmd /d /s /c npm.cmd run <脚本>` | `spawn(<解析出的 npm 绝对路径>, ['run', script])` |
| Spring Boot（wrapper） | `mvnw.cmd`、`gradlew.bat` | `./mvnw`、`./gradlew`，要求文件有执行位，没有就预检报 fail，不替用户 chmod |
| Spring Boot（系统） | `mvn.cmd`、`gradle.cmd` | `mvn`、`gradle` |
| Python | `.venv\Scripts\python.exe` | `.venv/bin/python` |
| Go / Rust | `go.exe`、`cargo.exe` | `go`、`cargo` |
| C++ 可执行文件 | 产物须以 `.exe` 结尾 | 去掉后缀要求，改为检查文件存在且有执行位 |
| HBuilderX | 固定路径找 `cli.exe` | `/Applications/HBuilderX.app/Contents/MacOS/cli`，见 §6 决策 4 |

`SAFE_SCRIPT` 白名单和「脚本必须在 `package.json` 的 `scripts` 里」两条校验保持不变。

建议把「可执行文件候选名」与「是否需要 cmd 包装」收进平台层的一张表，`EntryService` 与 `PrecheckService` 共用，消掉现在两边各写一份候选列表的重复。

### 3.4 PATH 解析（新问题，红线 1 相关）

从 Dock 或 Finder 启动的 GUI 应用不继承 shell 里配置的 PATH，nvm、Homebrew（`/opt/homebrew/bin`）、Volta、fnm 装的 node 都会找不到，表现是预检报「npm 不可用」。Windows 没有这个问题。

可选方案见 §6 决策 2。无论选哪种，解析结果只在主进程里使用，注入会话环境，不发给渲染层。

### 3.5 终端

- 默认 shell：`process.env.SHELL`，回退 `/bin/zsh`，参数 `-l`。不需要 `chcp`。
- 外部终端：`TerminalKind` 在 macOS 上换成 `terminal`（系统终端）/ `iterm` 两项，用 `open -a <应用> <目录>` 拉起，目录作为参数数组的一项传入，不拼字符串。`Settings.externalTerminal` 的取值按平台校验，旧值在 macOS 上回落到 `terminal`。

### 3.6 启动来源推断（`attribution.ts`）

进程名表换成 macOS 名称，例如 `Code Helper` / `Electron`（VS Code）、`Terminal`、`iTerm2`、`Cursor`、`WebStorm`。只用于展示，不参与 kill 授权（红线 2 不变）。

### 3.7 窗口外壳与交互

- 标题栏：`titleBarStyle: 'hiddenInset'`，隐藏自绘窗口控件，标题栏左侧留出红绿灯宽度（约 72px）。
- 生命周期：macOS 关掉最后一个窗口不退出应用，`activate` 时重建窗口。这和现有「关闭到托盘」设置要合并考虑。
- 托盘：用单色模板图（`iconTemplate.png`），菜单内容不变。
- 「隐藏任务栏图标」对应 `app.dock.hide()`。
- 快捷键：渲染层统一用「主修饰键」判断（macOS 为 `metaKey`，Windows 为 `ctrlKey`），快捷键一览按平台显示 `Cmd` / `Ctrl`。全局快捷键改为 `Cmd+Alt+M`。
- 字体：正文 `PingFang SC`，等宽 `SF Mono` / `Menlo`，作为回退栈加在现有 Segoe UI、雅黑、Cascadia 之后。
- 单实例锁、窗口状态记忆逻辑不用改。

### 3.8 路径比较

`normalizePath`（EntryService）、`entryKey`（ConfigTransferService）、`normDir`（渲染层）都用 `toLowerCase()`。macOS 默认 APFS 卷不区分大小写，但用户可以有区分大小写的卷。

建议：macOS 上先 `fs.realpathSync.native` 取规范路径再比较，不做小写化。渲染层的 `normDir` 只用于「已登记」提示，误差可以接受，保持现状。

### 3.9 打包

- `package.json` 的 `build` 增加 `mac` 目标：`dmg`、`build/icon.icns`、`extraResources` 加模板托盘图。
- 新增脚本 `build:mac`。
- node-pty 在 Mac 上用 `electron-rebuild` 编译。arm64 与 x64 分开出包，或出 universal 包，见 §6 决策 3。
- 签名：自用可以 ad-hoc 签名或右键打开绕过 Gatekeeper；对外分发需要 Apple 开发者账号签名并公证。系统通知在未签名应用上可能不显示，要实测。

---

## 4. 实施阶段与工程量

| 阶段 | 内容 | 在哪做 | 人日 |
| --- | --- | --- | --- |
| 0 抽平台层 | 定义 `src/main/platform/` 接口，把现有 Windows 代码原样搬进 `platform/win32/`，各服务改为依赖接口。行为不变 | Windows | 2–3 |
| 1 macOS 主进程 | §3.1–3.6、§3.8：进程采集、进程组终止、命令构造、PATH、终端、来源推断、路径比较 | Mac | 4–6 |
| 2 外壳与交互 | §3.7：标题栏、生命周期、托盘、Dock、快捷键、字体、设置页选项 | Mac | 2–3 |
| 3 打包 | §3.9：dmg、icns、node-pty 编译、签名 | Mac | 1–2 |
| 4 验证 | harness 平台化与新增 macOS 专项（见 §5） | Mac + Windows 回归 | 3–5 |
| 5 文档 | PRD、README、CLAUDE.md、使用指南补 macOS 说明 | 任意 | 1 |
| 合计 | | | **13–20** |

估算前提：开发者熟悉本项目的验证纪律与红线；Mac 为 Apple Silicon，系统版本 macOS 13 以上。不含对外分发的公证流程（首次配置约 0.5–1 天）。

阶段 0 的平台层接口建议如下：

```ts
// src/main/platform/types.ts
export interface Platform {
  readListenPorts(timeoutMs?: number): Promise<ListenRow[]>
  readProcessMeta(timeoutMs?: number): Promise<ProcessMeta>
  /** 终止会话进程树，resolve 时已确认结束 */
  killTree(rootPid: number): Promise<void>
  /** 包管理器、运行时的可执行文件候选名，以及是否需要经 shell 包装 */
  resolveBinary(name: BinaryName, cwd: string): Promise<ResolvedBinary | null>
  wrapCommand(file: string, args: string[]): { file: string; args: string[] }
  defaultShell(): { file: string; args: string[] }
  openExternalTerminal(kind: string, cwd: string): void
  launchSourceNames: ReadonlyMap<string, LaunchSource>
  /** 会话环境补丁：Windows 关 npm 转轮；macOS 补 PATH */
  sessionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv
}
```

阶段 0 完成标准：Windows 上全套 53 个 Electron harness 与 `verify-review-ownership` 全绿，`git diff` 里没有行为变化，只有搬移和依赖方向调整。

---

## 5. 验证计划

现有 56 个脚本（53 个 Electron harness、`verify-review-ownership`、两个已停用脚本）按平台依赖分三类：

**A. 直接调用了平台命令，要平台化或分两套（17 个）**

`m5`、`m6-palette`、`m8`、`m9`、`m10`、`m11-dual`、`m12-port-config`、`m13-icon`、`m16-langs`、`springboot`、`review-ipc`、`review-quit`、`review-scanner`、`review-todo`、`review-cwdterm`、`review-extterm`、`review-transfer`

其中依赖最深的是：

- `m11-dual`：先用 `netstat.exe` 验前提，要改成按平台调用 `lsof`。
- `review-quit`：用 `tasklist` / CIM 确认进程树已终止，要改成 `ps`。
- `review-extterm`：拦截 spawn 量 Windows 终端的命令行，macOS 要另写一组期望值。
- `springboot`：夹具是 `mvnw.cmd`，macOS 要补一个带执行位的 `mvnw`。
- 其余多为断言里写死了 `.exe` 名或 `taskkill`，改动量小。

**B. 只依赖界面与 IPC，预计可以直接在 macOS 上跑（36 个）**

`ui`、`shell`、`services`、`m4-ui`、`m6-sort`、`m6-settings`、`m7-visual`、`m9-readonly`、`m9-recover`、`m11-add`、`m11-port`、`m12-press`、`m14-categories`、`m14-favicon`、`m15-uniapp`、`m17-image`，以及其余 `review-*`。

「预计」是因为部分脚本起真实服务进程，依赖 PATH 能找到 node，要在阶段 1 的 PATH 方案落地后才能确认。`m12-press` 量的是按压动画，要注意快捷键改为 `Cmd` 后有没有断言写死了 `ctrlKey`。

**C. 不起 Electron（1 个）**：`verify-review-ownership`，喂合成进程表，两个平台通用。

**新增 macOS 专项**（每个先在未实现时跑红）：

1. `verify-darwin-proctable`：`lsof` / `ps` 解析，`mine` 只含当前 uid，`startedAt` 稳定。
2. `verify-darwin-killgroup`：另起进程组的孙进程能被找到并终止；外部同端口进程不受影响。
3. `verify-darwin-path`：从无 PATH 的环境启动主进程，预检仍能找到 nvm / Homebrew 的 node。
4. `verify-darwin-shell`：标题栏没有自绘窗口控件、红绿灯区域不被遮挡、`Cmd+K` 打开命令面板。

每次改动后 Windows 回归照常跑全套，确认平台层没有把 Windows 行为带偏。

---

## 6. 需要先定的决策

1. **和 `local-ops-main/` 的关系**。工作区已经有一个 macOS 实现（Python 标准库后端 + 原生前端）。选项：
   - A. Electron 版成为双平台主力，`local-ops-main` 冻结或归档。
   - B. 两套并存，各自维护（长期成本最高）。
   - C. 不移植 Electron 版，继续用 `local-ops-main`。
2. **PATH 解析方式**：
   - A. 只探测固定目录（`/opt/homebrew/bin`、`/usr/local/bin`、`~/.nvm/versions/node/*/bin`、`~/.volta/bin`、`~/.local/share/fnm`）。不执行任何东西，最贴合红线 1，但可能漏掉自定义安装位置。
   - B. 启动时执行一次 `$SHELL -ilc 'printf %s "$PATH"'`。会执行用户自己的 `.zshrc`，不是项目代码，但它是「执行用户环境脚本」，需要在 PRD 里明确接受。
   - C. A 为默认，设置里提供「从登录 shell 读取 PATH」开关，默认关。（推荐）
3. **芯片架构**：只出 arm64，还是同时出 x64 / universal。universal 包体积约翻倍，node-pty 需要两种架构都编译。
4. **范围**：HBuilderX、C++ 可执行文件这两种启动方式在 macOS 上是否首版就支持。不支持的话，首版对这两类条目只登记、标「仅登记」。
5. **分发方式**：只自用（ad-hoc 签名即可），还是要发给别人（需要开发者账号与公证）。

---

## 7. 风险

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 进程组终止漏杀或误杀 | 触及红线 2 | §3.2 的兜底链路每一步都过 `assertKillable`；专项 harness 先红后绿 |
| `lsof` 看不到其他用户的监听 | 冲突提示缺占用者 | 绑定探测兜底，预检文案说明「看不到占用者」 |
| PATH 方案选 B 后执行了用户 rc | 红线 1 的边界变化 | 默认关闭，PRD 记录决策 |
| 未签名应用的通知、全局快捷键行为不同 | 部分功能不可用 | 打包后专门实测，必要时 ad-hoc 签名 |
| 两套 macOS 实现并存 | 维护成本翻倍 | 先定 §6 决策 1 |
| 无 Mac 时无法验证 | 只能交付阶段 0 | 阶段 1 起必须在真 Mac 上开发和验证 |

---

## 8. 建议的下一步

1. 先定 §6 的决策 1 和 2。
2. 不论决策如何，阶段 0（抽平台层）都可以先在 Windows 上做：它不改变行为，能用现有 53 个 harness 证明没有回归，做完后 Windows 代码本身也更清晰。
3. 拿到 Mac 后按阶段 1 → 4 推进，每个阶段结束时跑一次两个平台的全套验证。

---

## 9. 执行记录（2026-10-30）

§6 的决策已定：Electron 版成为双平台主力；PATH 用固定目录探测加默认关闭的「从登录 shell 读取 PATH」开关；只出 arm64、自用 ad-hoc 签名；HBuilderX 与 C++ 可执行文件首版只登记。

本次在 Windows 机器上完成的范围：阶段 0 全部，阶段 1–3 的代码。§2 的盘点保留为改造前的记录。

**已完成**

- 平台层 `src/main/platform/`：`types.ts` 定义 `Platform` 接口；`win32/` 收进原 `lib/winProcess.ts`、`lib/powershell.ts`、`lib/externalTerminal.ts`、`lib/shell.ts` 与各服务里的可执行文件表、进程名表、`taskkill`、`cmd /d /s /c` 包装，取值逐字不变；`darwin/` 是 macOS 实现。
- 服务层改为依赖接口：Scanner、Ownership、Session、Entry、Precheck、Detect、`index.ts`、`attribution.ts`。
- macOS 主进程：`lsof` / `ps` 采集，进程组 SIGTERM → SIGKILL，命令直接 spawn 不经 shell，wrapper 要求执行位，PATH 补全，`open -a Terminal|iTerm`，路径比较保留大小写并取真实路径。
- 设置项 `loginShellPath`（默认关），配置版本 12 → 13；外部终端旧值不属于当前平台时回落到平台默认。
- 外壳：macOS 用 `hiddenInset` 红绿灯、标题栏不画窗口控件；Dock 隐藏；模板托盘图；主修饰键按平台切换（Cmd / Ctrl），全局快捷键 `Command+Alt+M`；字体回退加 PingFang SC、SF Mono、Menlo。
- 打包：`build:mac`、`mac` 目标（dmg、arm64、ad-hoc 签名）。

**验证**

- Windows：全套 53 个 Electron harness 与 `verify-review-ownership`，见 README 版本记录。
- `verify-darwin-parse`（纯逻辑，不起 Electron）：喂合成的 `lsof -Fpn` 与 `ps` 输出，15/0。只证明解析器按文档格式工作，不证明真实输出就是这个格式。

**未完成，必须在真 Mac 上做**

1. §5 的 4 个专项 harness：`verify-darwin-proctable`、`verify-darwin-killgroup`、`verify-darwin-path`、`verify-darwin-shell`，各自先跑红。
2. §3.2 第 4 点：另起进程组的后代按 ppid 链补杀（`darwin/index.ts` 的 `killTree` 里标了缺口）。
3. §5 A 类 17 个 harness 平台化（`netstat.exe`、`taskkill`、`.exe` 名、`mvnw.cmd` 的写死断言）。
4. `build/icon.icns`：现在 `mac.icon` 指向 1024px PNG 由 electron-builder 转换，要在 Mac 上确认效果。
5. node-pty 在 Mac 上 `npm run rebuild`，`npm run build:mac` 出包并实测签名、通知、Gatekeeper。
