# BINDINGS-CONTRACT.md — Go 绑定与前端适配层契约

> 本文件定义 Go 进程与页面之间**唯一允许的通信面**。
> 前端组件只认 `src/lib/mile.ts`，它实现与原版 `window.mile.*` 同形的接口；
> 组件与 store 从原版搬过来时**不改调用点**。
>
> 状态：契约草案（M0 定稿，M1 起随实现校准）。改契约必须同步本文件与 `src/lib/mile.ts`。
> 基准：原版 `src/preload/index.ts`（264 行）+ `src/shared/channels.ts`。

---

## 1. 总则

### 1.1 唯一入口

```
组件 / store  ──►  src/lib/mile.ts  ──►  src/mygo.ts（生成物）  ──►  Go 绑定方法
```

- 组件**禁止**直接 import `src/mygo.ts`，也禁止 import `mygo-runtime` 的 `Channel`。
- `src/lib/mile.ts` 是唯一适配层：负责参数整形、错误翻译、事件订阅的退订函数化。
- 生产构建不引用任何 mock；mock 只放 `src/mocks/`，且不得顶替调不通的真实接口。

### 1.2 命名映射

| 原版（IPC 字符串） | mygo 版 |
| --- | --- |
| `window.mile.entry.list()` | `EntryService.list(ctx)` → 生成 `EntryService.list()` |
| `window.mile.entry.onChange(cb)` | `events.entryChanged.on(cb)` |
| 频道名 `entry:changed` | 事件名 `entryChanged`（纯字母数字，不含冒号） |
| `session:data` 推送 | `SessionService.attach(ctx, id, ch)` 的 `*mygo.Channel[SessionDataEvent]` |

Go 结构体名保持原服务名（`EntryService`、`ScannerService`…），方法名首字母小写化后与 preload 同名：`list`、`add`、`patch`、`remove`、`reorder`。

### 1.3 类型规则

1. 前端可见类型集中在 `internal/contract` 一个包；业务包只依赖它，避免循环引用。
2. 只用可序列化类型。`chan` / `func` / `complex` / `unsafe.Pointer` 会被生成器拒绝。
3. **不用 `any`**：生成器不报错但会产出 `unknown`，字段信息全丢。
4. 联合类型用「判别字段 + 可选字段」：

```go
type EntryRuntime struct {
    Status  string  `json:"status"`            // "idle" | "starting" | "running" | "failed"
    Port    *int    `json:"port,omitempty"`
    Pid     *int    `json:"pid,omitempty"`
    Message string  `json:"message,omitempty"`
}
```

5. 时间统一毫秒时间戳（`int64`），与原版一致；不传 `time.Time`。
6. 大整数 ID 一律字符串（原版条目 id 是 `string`，保持）。
7. **Scripts**（S16，用户 2026-11-15 选定「保序类型」）：`LaunchEntry.scripts`、`NewLaunchEntry.scripts`、`EntryEdit.scripts`、`DetectResult.scripts` 是 `contract.Scripts`，不是 `map[string]string`。原版这里是 JS 对象，键顺序 = `package.json` 里的顺序（数组下标形式的键先按数值升序，其余按插入序，重复键保留首次位置、取最后的值），界面的脚本下拉按这个顺序列出；Go 的 map 无序，所以自定义 `MarshalJSON` / `UnmarshalJSON`。
   - JSON 形状不变：零值写 `null`（等于原版没有这个字段），否则是普通对象 `{"dev":"vite",...}`。
   - 解码严格：不是对象报「脚本表必须是对象」，值不是字符串报「脚本表的值必须是字符串」；读 `config.json` 时走 `internal/config/loose.go` 的宽松分支，丢掉非字符串值，与 S09 的宽松解码口径一致。
   - mygo tsgen 对实现了 `json.Marshaler` 的类型生成 `unknown`。M5 写 `src/lib/mile.ts` 时在适配层把这四个字段断言成 `Record<string, string>`，组件侧类型与原版一致；对象字面量的属性顺序在 JS 里天然保留，页面不用额外处理。

### 1.4 绑定签名规则

```go
func (EntryService) Start(ctx context.Context, id string) (contract.EntryStartResult, error)
```

- 第一个参数 `context.Context`，TS 侧不出现。
- 所有外部命令、HTTP 探测、文件 I/O 从该 ctx 派生，**禁止 `context.Background()`**；后台常驻任务用 App 生命周期 ctx。
- 服务按值绑定（`mygo.Bind(EntryService{})`），结构体不放状态；状态放 `internal/` 包级单例并加锁。
- 返回 `error` 时前端拿到 `CallError`，`message` 直接展示给用户，**不塞文件内容、密钥、完整路径**。

### 1.5 三种通道

| 通道 | 用途 | 本项目使用 |
| --- | --- | --- |
| 调用（返回值 → Promise） | 请求 / 响应 | 绝大多数方法 |
| `*mygo.Channel[T]` | 一次调用内的连续数据 | 终端输出（`SessionService.attach`） |
| `mygo.NewEvent[T]` | Go 主动、与某次调用无关 | 条目变更、运行态、扫描 diff、提醒 |

选错的典型：用 Event 推终端输出 —— 会失去保序与「页面离开即取消」。

---

## 2. 就绪握手

Go 在页面加载前或导航中 `Emit` 的事件，在业务上等于丢失（页面还没订阅）。

```
页面挂载 → 订阅全部事件 → Desktop.Ready()
Go：未就绪期间事件进队列（只保留最近一次同类意图）→ Ready 后按序投递
导航开始（OnWillNavigate）→ 置未就绪 → 队列重新开始收集
```

- 队列容量与合并策略在 `internal/events` 一处实现，不散落在各服务。
- 关窗期间 `Emit` 返回错误表示窗口已关，发送循环应退出。
- 事件名以字母开头、只含字母数字，不得以 `mygo:` 开头。

---

## 3. 绑定服务清单

> 「TS」列是 `src/lib/mile.ts` 对外暴露的形状，与原版 `window.mile.*` 对齐。
> 「校形」列是 Go 侧必须执行的入参校验（对应原版 `sanitize*`）。

### 3.1 AppService

| Go 方法 | TS | 说明 |
| --- | --- | --- |
| `Info(ctx) contract.AppInfo` | `mile.app.info()` | `{ version, name }`，版本来自 `mygo.config.ts` |
| `Ready(ctx) error` | `mile.app.ready()` | 就绪握手，页面订阅完成后调用 |

### 3.2 WindowService

| Go 方法 | TS | 说明 |
| --- | --- | --- |
| `Minimize(ctx)` | `mile.window.minimize()` | |
| `ToggleMaximize(ctx)` | `mile.window.toggleMaximize()` | |
| `Close(ctx)` | `mile.window.close()` | 走正常关窗流程（可能被托盘拦截） |
| `IsMaximized(ctx) bool` | `mile.window.isMaximized()` | 页面初始化时拉一次 |

事件：`windowMaximizeChanged(bool)` → `mile.window.onMaximizeChange(cb)`。

### 3.3 ThemeService

| Go 方法 | TS | 说明 |
| --- | --- | --- |
| `Get(ctx) contract.ThemeState` | `mile.theme.get()` | `{ preference, resolved }` |
| `Set(ctx, pref string) contract.ThemeState` | `mile.theme.set(pref)` | `pref ∈ light / dark / system`；校形白名单 |

事件：`themeChanged(ThemeState)`。页面据 `resolved` 写 `<html data-theme>`。

### 3.4 SettingsService

| Go 方法 | TS | 说明 |
| --- | --- | --- |
| `Get(ctx) contract.Settings` | `mile.settings.get()` | |
| `Patch(ctx, patch contract.SettingsPatch) contract.Settings` | `mile.settings.patch(patch)` | 只覆盖出现的字段；非法值抛错不落盘 |

事件：`settingsChanged(Settings)`。

### 3.5 EntryService

| Go 方法 | TS | 校形 |
| --- | --- | --- |
| `List(ctx) []contract.LaunchEntry` | `mile.entry.list()` | — |
| `Add(ctx, in contract.NewLaunchEntry) contract.LaunchEntry` | `mile.entry.add(in)` | `sanitizeEdit` |
| `Edit(ctx, id string, patch contract.EntryEdit) contract.LaunchEntry` | `mile.entry.edit(id, patch)` | `sanitizeEdit`；运行中禁改身份字段 |
| `Remove(ctx, id string)` | `mile.entry.remove(id)` | id 存在 |
| `Reorder(ctx, ids []string) []contract.LaunchEntry` | `mile.entry.reorder(ids)` | id 全存在、无重复 |
| `Detect(ctx, path string) contract.DetectResult` | `mile.entry.detect(path)` | 路径存在且为目录；**只读文件** |
| `Precheck(ctx, id string) contract.PrecheckResult` | `mile.entry.precheck(id)` | id 存在 |
| `Start(ctx, id string) contract.EntryStartResult` | `mile.entry.start(id)` | id 存在；脚本名过 `SAFE_SCRIPT` 且重读磁盘确认 |
| `StartOrdered(ctx, ids []string) []contract.OrderedStartResult` | `mile.entry.startOrdered(ids)` | `startAfter` 成环 / 自指拒绝 |
| `Stop(ctx, id string) contract.EntryRuntime` | `mile.entry.stop(id)` | 归属三重判定 |
| `Restart(ctx, id string) contract.EntryStartResult` | `mile.entry.restart(id)` | 同上 |
| `Install(ctx, id string) contract.EntryRuntime` | `mile.entry.install(id)` | 用户显式触发，命令形状固定 |
| `MavenRun(ctx, id string, goal string) contract.EntryRuntime` | `mile.entry.mavenRun(id, goal)` | goal 枚举白名单 |
| `PackageWithProfile(ctx, id string, profile string) contract.EntryRuntime` | `mile.entry.packageWithProfile(id, profile)` | profile 过 `SAFE_PROFILE`（字母数字下划线连字符） |
| `DetectProfiles(ctx, id string) []string` | `mile.entry.detectProfiles(id)` | 只读目录 |
| `ListJars(ctx, id string) []string` | `mile.entry.listJars(id)` | 只读目录，过滤 `-sources` / `-javadoc` |
| `SwitchPort(ctx, id string, port int) error` | `mile.entry.switchPort(id, port)` | 1024–65535 |
| `RunScript(ctx, id string, script string) contract.EntryRuntime` | `mile.entry.runScript(id, script)` | 脚本必须在磁盘 `package.json` 的 `scripts` 里 |
| `Diagnose(ctx, id string) contract.EntryDiagnosis` | `mile.entry.diagnose(id)` | 只显示环境变量**键名** |
| `OutputDir(ctx, id string) *string` | `mile.entry.outputDir(id)` | 相对路径、不含 `..` |
| `RevealOutput(ctx, id string) bool` | `mile.entry.revealOutput(id)` | 路径由 Go 构造 |
| `OpenPackageJSON(ctx, id string) bool` | `mile.entry.openPackageJson(id)` | |
| `OpenInHBuilderX(ctx, id string) bool` | `mile.entry.openInHBuilderX(id)` | 仅 uniapp；已知原版问题 I1 |
| `Favicon(ctx, id string) *string` | `mile.entry.favicon(id)` | base64 data URL，只读不联网 |
| `SetImage(ctx, id string, bytes []byte) string` | `mile.entry.setImage(id, bytes)` | 大小上限；压缩后落盘 |
| `ClearImage(ctx, id string) contract.LaunchEntry` | `mile.entry.clearImage(id)` | |
| `Image(ctx, id string) *string` | `mile.entry.image(id)` | data URL |
| `Runtimes(ctx) []contract.EntryRuntime` | `mile.entry.runtimes()` | |
| `OpenExternalTerminal(ctx, id string) error` | `mile.entry.openExternalTerminal(id)` | 只收 id，目录由 Go 解析 |
| `RevealLastJar(ctx, id string) bool` | `mile.entry.revealLastJar(id)` | |
| `HealthList(ctx) []contract.EntryHealth` | `mile.entry.healthList()` | 只在内存 |
| `CancelAutoRestart(ctx, id string) *contract.EntryRuntime` | `mile.entry.cancelAutoRestart(id)` | 只撤排队中的重启 |

事件：

| 事件 | 负载 | TS |
| --- | --- | --- |
| `entryChanged` | `[]LaunchEntry` | `mile.entry.onChange(cb)` |
| `entryRuntimeChanged` | `EntryRuntime` | `mile.entry.onRuntime(cb)` |
| `entryWarning` | `string` | `mile.entry.onWarning(cb)` |
| `entryHealth` | `EntryHealth` | `mile.entry.onHealth(cb)` |
| `entryAlert` | `OutputAlert` | `mile.entry.onAlert(cb)` |

> `entryChanged` 比 `add()` 的回执先到。**任何乐观更新都必须按 id 幂等**（原版实测：无条件 push 会出现两张一样的卡片）。

### 3.6 GroupService

| Go 方法 | TS |
| --- | --- |
| `List(ctx) []contract.ProjectGroup` | `mile.group.list()` |
| `Add(ctx, in contract.NewProjectGroup) contract.ProjectGroup` | `mile.group.add(in)` |
| `Patch(ctx, id string, patch contract.GroupPatch) contract.ProjectGroup` | `mile.group.patch(id, patch)` |
| `Remove(ctx, id string)` | `mile.group.remove(id)` |
| `Reorder(ctx, ids []string)` | `mile.group.reorder(ids)` |

事件：`groupChanged([]ProjectGroup)`。

### 3.7 PlannerService

| Go 方法 | TS |
| --- | --- |
| `Get(ctx) contract.PlannerSnapshot` | `mile.planner.get()` |
| `AddBoard / EditBoard / ReassignBoard / RemoveBoard / ReorderBoards` | 同名 |
| `AddTask / EditTask / RemoveTask / ReorderTasks` | 同名 |
| `AddSchedule / EditSchedule / RemoveSchedule` | 同名 |
| `CompleteTask(ctx, boardId, scheduleId string)` | `mile.planner.completeTask(...)` |
| `DismissMissed(ctx, boardId, scheduleId string, at int64)` | `mile.planner.dismissMissed(...)`；`at=0` 表示清掉该日程全部 |
| `ClearMissed(ctx)` | `mile.planner.clearMissed()` |

事件：`plannerChanged(PlannerSnapshot)`、`plannerReminder(ReminderFire)`、`plannerFocus(PlannerFocusRequest)`。

> 渲染层只发意图；id、时间戳、`doneAt` 全由 Go 生成。

### 3.8 SessionService

| Go 方法 | TS | 说明 |
| --- | --- | --- |
| `List(ctx) []contract.SessionMeta` | `mile.session.list()` | |
| `CreateShell(ctx, in contract.CreateShellSessionInput) contract.SessionMeta` | `mile.session.create(in)` | **只认 `kind:'shell'` 与标题**；可执行文件与参数由 Go 定 |
| `History(ctx, id string) string` | `mile.session.history(id)` | 环形缓冲内的历史 |
| `Stop(ctx, id string) error` | `mile.session.stop(id)` | |
| `Write(ctx, id string, data string) error` | `mile.session.write(id, data)` | 高频；Go 侧合并 |
| `Resize(ctx, id string, cols, rows int) error` | `mile.session.resize(id, cols, rows)` | |
| `Attach(ctx, id string, ch *mygo.Channel[contract.SessionDataEvent]) error` | `mile.session.attach(id, cb)` | 流式输出，见 §4 |

事件：`sessionExit(SessionExitEvent)` → `mile.session.onExit(cb)`。

### 3.9 LogService

| Go 方法 | TS |
| --- | --- |
| `Query(ctx, q contract.LogQuery) contract.LogResult` | `mile.log.query(q)` |
| `Clear(ctx)` | `mile.log.clear()` |

筛选在 Go 侧做，页面只拿要显示的那一屏。

### 3.10 ScannerService

| Go 方法 | TS |
| --- | --- |
| `Snapshot(ctx) *contract.ScanSnapshot` | `mile.scanner.snapshot()` |
| `Refresh(ctx)` | `mile.scanner.refresh()` |
| `SetVisible(ctx, visible bool)` | `mile.scanner.setVisible(v)` |
| `Ignore(ctx, processName string, port int)` | `mile.scanner.ignore(name, port)` |
| `HideOnce(ctx, pid, port int)` | `mile.scanner.hideOnce(pid, port)` |
| `SetGroup(ctx, processName string, group *string)` | `mile.scanner.setGroup(name, group)` |
| `WatchedKeywords(ctx) []string` | `mile.scanner.watchedKeywords()` |
| `SetWatchedKeywords(ctx, keywords []string) []string` | `mile.scanner.setWatchedKeywords(kw)` |

事件：`scannerDiff(ScanDiff)`。

### 3.11 DialogService / ShellService / ClipboardService / ConfigService

| Go 方法 | TS | 约束 |
| --- | --- | --- |
| `PickDirectory(ctx) *string` | `mile.dialog.pickDirectory()` | 返回值即唯一可信路径来源 |
| `PickImportRoot(ctx) *contract.ImportRoot` | `mile.dialog.pickImportRoot()` | Go 扫描一层子目录 |
| `OpenLocalhost(ctx, port int)` | `mile.shell.openLocalhost(port)` | 只收 1–65535 |
| `OpenPath(ctx, target string)` | `mile.shell.openPath(t)` | 白名单：监听进程 cwd、条目 cwd、合法 outputDir |
| `OpenProjectLink(ctx, key string)` | `mile.shell.openProjectLink(key)` | 只收固定键名，URL 写死 |
| `WriteText(ctx, text string) bool` | `mile.clipboard.writeText(t)` | 只写不读 |
| `Export(ctx) *contract.ConfigExportResult` | `mile.config.export()` | 文件由系统对话框选 |
| `Import(ctx) *contract.ConfigImportResult` | `mile.config.import()` | 导入前另存备份 |

### 3.12 应用级事件

| 事件 | 负载 | TS | 触发 |
| --- | --- | --- | --- |
| `appFocusEntry` | `FocusEntryRequest` | `mile.app.onFocusEntry(cb)` | 通知被点击，定位到某服务的输出 / 诊断 |
| `appOpenPalette` | 无 | `mile.app.onOpenPalette(cb)` | 全局快捷键唤回窗口后打开命令面板 |

---

## 4. 终端流式契约

原版用 `session:data` 推送全量会话输出。mygo 版改为**按会话 attach**（S18 实现见 `internal/sessions/channel.go`；下面是示意，字段名以 `contract.SessionDataEvent` 的 `ID` / `Chunk`，JSON `id` / `chunk` 为准）：

```go
func (SessionService) Attach(ctx context.Context, id string,
    ch *mygo.Channel[contract.SessionDataEvent]) error {
    sess := registry.get(id)          // 不存在 → 返回 error
    defer registry.detach(id)
    return sess.stream(ctx, func(chunk []byte) error {
        return ch.Send(contract.SessionDataEvent{ID: id, Chunk: string(chunk)})
    })
}
```

前端：

```ts
const channel = new Channel<SessionDataEvent>()
const done = SessionService.attach(id, channel)
done.catch(() => { /* 立即挂 catch，避免 unhandled rejection */ })
for await (const frame of channel) term.write(frame.chunk)
```

必须遵守：

1. `done` 在 `for await` 期间就可能 reject，创建后立刻挂 `.then/.catch`。
2. 离开终端页时 `channel.close()`，Go 侧 ctx 取消，PTY 读取循环退出（但**会话本身不停止**）。
3. 重新进入页面重新 attach，先写 `history()` 再续流，避免丢历史。
4. 16ms 合并刷新在 Go 侧做；`Send` 返回错误说明页面不再读，立即返回。

---

## 5. 安全不变量（契约层强制）

| 不变量 | 实现位置 | 验证 |
| --- | --- | --- |
| 运行 token 不出现在任何绑定返回值、事件、日志 | `contract.LaunchEntry` 无该字段；注入只进 PTY 环境 | 序列化后全文搜索 `MILE_RUN_TOKEN` 值 |
| 环境变量的值不出 Go 进程 | 所有返回条目的路径经 `redactEntry` | `go test`：`env` 只剩键名 |
| 命令不由页面构造 | 页面只传 id / 枚举 / 白名单字符串 | `go test`：命令构造快照 |
| 路径不来自页面 | 目录来自 `Dialog` 返回值或条目登记信息 | 越界 / 不存在一律拒绝，不回退 |
| 外链只有两条 | `OpenLocalhost` / `OpenProjectLink` | 不存在接受任意 URL 的方法 |
| 顶层导航不离开本页 | `OnWillNavigate` + `PreventDefault` | CDP：`location.href = 'https://example.com'` 被拦 |

---

## 6. 错误模型

```go
return contract.EntryStartResult{}, fmt.Errorf("脚本 %q 不在 package.json 的 scripts 里", script)
```

- 错误文本面向用户：说清原因与下一步，不出现堆栈、绝对路径、文件内容。
- 前端用 `isCallError(e)` 区分「Go 返回的业务错误」与「传输类错误」，分别映射文案。
- 绑定方法**不 panic**：可预期失败一律 `error`；不可恢复的内部状态用日志 + 明确 error。
- 鉴权类概念不存在（本地单用户），因此没有「错误码登出」这类分流。

---

## 7. 契约变更流程

1. 改 `internal/contract` 或绑定方法签名。
2. `bun run generate` 重新生成 `src/mygo.ts`。
3. `git diff src/mygo.ts` 核对生成结果符合预期。
4. 同步 `src/lib/mile.ts` 与本文档。
5. 跑 `go test ./...`、`bun run typecheck`、相关 CDP 脚本。

> `src/mygo.ts` 是生成物，**永不手改**。`generate` 报 `no required module provides package github.com/egoist/mygo` 时先 `go mod tidy`。

---

## 8. 契约自检清单

- [ ] 每个方法第一个参数是 `context.Context`，外部 I/O 全部从它派生
- [ ] 没有 `any`；联合类型是判别字段 + 可选字段
- [ ] 事件名纯字母数字，全部走就绪握手
- [ ] 终端输出走 Channel，不用 Event
- [ ] 每个入参都有对应 `sanitize*`，白名单外静默丢弃、非法值抛错
- [ ] 返回值里没有运行 token、没有环境变量值
- [ ] 前端只有 `src/lib/mile.ts` 一个入口，组件不 import 生成物
- [ ] `src/mygo.ts` 由 `mygo generate` 产出且已 `git diff` 核对
