# Mile Terminal 功能升级文档

> 版本：草案 v0.2（2026-11-06）
> 基线：应用 2.3.1，`CONFIG_VERSION = 13`
> 权威来源仍是 `../docs/PRD.md`。本文只提出升级候选，某项进入开发时，把定稿内容回写 PRD 对应章节。
> 每个提案都已对照四条安全红线、PRD §15 非目标和 `CLAUDE.md` 的 UI 约定。已实现的功能不再重复提出。
> v0.2 变更：经独立核对（重复性、红线、可行性、遗漏四路）修正了 P0-1 的探测目标选取、P0-2 的退出流程误判、P1-2 的精度说明、P1-5 的定位，并把 P1-1 并入 U1。

---

## 1. 现有功能盘点

### 1.1 页面与入口

| 页面 | 已有能力 |
| --- | --- |
| 总览 | 整机 CPU / 内存 KPI 卡片与趋势（`store/scanner.ts` 的 `cpuHistory` / `memHistory`），监听端口表（右键菜单、复制），关注进程（`watchedKeywords` 按进程名与命令行匹配，最多 20 个关键词），待办条 |
| 服务 | 按工作组分段的条目列表；右侧分栏详情（概览 / 输出 / 诊断 / 构建 / 配置）；添加服务与添加任务两个入口；文件夹批量导入；重复目录提示；整组启动走 `startOrdered`，按 `startAfter` 分层 |
| 终端 | node-pty 内置终端、条目目录终端、外部终端（wt / Git Bash 等，只开在已登记目录）、终端内搜索 |
| 设置 | 通知开关（崩溃通知、仅后台时通知）、全局快捷键 `Ctrl+Alt+M`、退出时终止自有进程、外部终端选择、配置导入 / 导出 |
| 关于 | 版本信息、`PROJECT_LINKS` 白名单外链 |

### 1.2 横切能力

- 命令面板 `Ctrl+K`：启动、停止、重启条目，运行脚本（`runScript`），切页。
- 托盘菜单：启停只调 `EntryService.start / stop`，生产环境与沙箱 Spring Boot 启动要弹确认。
- 工作组环境 `dev / sandbox / prod`：沙箱黄条加确认，生产红条加确认。
- 启动前预检（`PrecheckService`）：只读检查，缺 `node_modules` 报 fail，再由用户显式创建安装会话。
- 崩溃留尾：会话退出时在内存留最后 30 行可见输出和最后一个错误行，规则来自 `lib/outputText.ts`。
- 手动重启：`EntryService.restart(id)`。
- 日志中心：跨会话聚合、分级、筛选，只在内存的环形缓冲。
- 配置：原子写、`.bak` 轮转、坏文件另存 `config.json.corrupt`、导入前另存 `config.before-import-<时间>.json`。
- 窗口状态与上次页面：分别存 `window-state.json` 和渲染层 localStorage。

### 1.3 数据现状（与升级相关）

| 现有字段 / 能力 | 位置 | 缺什么 |
| --- | --- | --- |
| `startedAt`；端口捕获时刻 | `EntryRuntime.startedAt`；`EntryService.absorb()` 从会话**输出文本**解析端口（`capturePort`），命中即转 running | 捕获时刻没有记下来，算不出启动耗时；`lastRunMs` 记的是运行时长，不是启动耗时 |
| 逐进程 CPU / 内存 | `ScannerService.attachMetrics()` 给每个监听行填 `cpu` / `memory`，快照已带 `entryId` | 数据已经在推送里，缺的是按条目汇总与历史缓冲；渲染层只有整机历史 |
| `watchedKeywords` | 设置项，匹配**进程名与命令行** | 没有按**会话输出内容**匹配的告警 |
| 崩溃通知 | `notifyOnCrash`，`crashed` 事件 | 崩溃后只通知，不会自动恢复 |
| 监听表 | `platform/*/process.ts` 解析出 `ListenRow { port, pid }` | 不记绑定的地址族：`parseNetstat` 按 `${pid}:${port}` 去重，同一进程的 IPv4 / IPv6 两行被合并；也不知道服务能否响应 |
| `startAfter` | 条目字段，`assertStartAfter` 拒绝自指、不存在的 id 与成环 | 只用于启动排序，没有可视化 |

---

## 2. 痛点与缺口

1. **「在监听」不等于「能用」。** 端口捕获后条目就显示 running，但后端可能还在初始化，或者已经卡死只剩端口没释放。用户得自己开浏览器确认。
2. **崩溃要人盯。** 夜间或切走窗口时 dev 服务崩了，通知弹过就没了，回来才发现服务一直是停的。
3. **输出里的关键信号淹没在滚动里。** `OutOfMemoryError`、`EADDRINUSE`、`Failed to compile` 这类行出现时没有提醒，日志中心要手动筛。
4. **不知道哪个服务在吃资源。** 总览只有整机曲线，看不出是哪个条目的进程树在涨内存。
5. **启动慢没有量化。** 改了配置后启动变慢了多少，没有数字可比。
6. **端口变化无从回溯。** 某个端口刚才被谁占过、什么时候释放的，监听表只显示当前时刻。
7. **多服务启动顺序靠记忆。** `startAfter` 写在各条目配置里，看不到整体关系。

---

## 3. 升级功能（按优先级）

每项统一列出：价值、入口、主进程改动、渲染层改动、IPC 与校形、红线核对、验证 harness、是否需要配置迁移。

### P0-1 本机 HTTP 健康检查

- **价值**：把条目状态从「端口在监听」细化为「端口在监听且 HTTP 有响应」，解决痛点 1。
- **入口**：服务详情「配置」页新增「健康检查」小节，只有一个输入框（路径，例如 `/actuator/health`、`/`）和一个开关；服务行状态胶囊旁加一个小图标（健康 / 无响应 / 未启用）。
- **前置改动：监听行带上地址族。** 现有数据选不出探测目标（见 1.3），所以先改平台层：
  - `ListenRow` 增加 `family: 4 | 6`；win32 与 darwin 两套 `parseNetstat` / lsof 解析都按本地地址列判定族，去重键改为 `${pid}:${port}:${family}`。
  - `ListenerSnapshot` 同步带出 `family`。
  - 这会让同一进程双栈监听时多出一行。所有按 `pid:port` 计数或 `.find()` 的下游都要排查一遍（`CLAUDE.md` 平台细节已经要求 `filter` 后排掉自己），并重跑 `verify-darwin-parse`、`verify-m11-dual`、`verify-review-listenrow`。
- **主进程**：
  - 新增 `HealthService`，构造函数注入 `EntryService` 与 `ScannerService`。
  - **探测目标只取本条目自己的监听行**：在最新快照里，按 `EntryService.ownListenPids(entryId)` 筛出 PID 属于本条目、端口等于运行态端口的行。有 IPv4 行就探 `127.0.0.1`，只有 IPv6 行就探 `::1`。找不到自己的行时状态记为 `unknown`，不发请求。原因：同一端口可以被两个进程分别占住 IPv4 与 IPv6，按端口去探可能探到别人的服务。
  - 用 Node `http.request({ host, port, path, method: 'GET' })` 直接发请求，不经 shell。只支持 `http`，不探 `https`（不引入证书校验这条路径）。3xx 不跟随，直接按已响应处理。超时 2 秒；响应体按字节计数，到 4KB 后调用 `req.destroy()` 关掉 socket。
  - 间隔固定 15 秒，窗口不可见时降到 60 秒（读 `ScannerService` 的可见性标记，不跟 `scanIntervalMs` 走）。理由：采集间隔是用户为本机开销选的，探测间隔影响的是被探服务的日志与负载，两者不该绑在一起。
  - 结果只在内存：`{ state: 'ok' | 'fail' | 'unknown' | 'off', statusCode?, latencyMs?, checkedAt }`。2xx / 3xx 算 ok。
- **渲染层**：服务行图标、详情概览页显示最近一次状态码与延迟。图标用 Phosphor 的 `HeartbeatIcon` / `HeartBreakIcon`（`Heartbeat` / `HeartBreak` 是已弃用别名），登记到 `lib/icons.ts`，尺寸 16，纯图标需 `aria-label`。状态色只染图标，不染行底。
- **IPC 与校形**：
  - 复用 `entry:edit`，在 `sanitizeEdit` 里新增 `healthCheck` 字段：`{ path: string, enabled: boolean } | null`。
  - `path` 校形：必须以 `/` 开头、不能以 `//` 开头、长度 1–256、只允许 `[A-Za-z0-9\-._~/?=&%]`，不含空白、`@`、`#`、`\`。非法则抛错且不落盘。
  - 结果推送走 `sendToRenderer('entry:health', ...)`，新频道写进 `src/shared/channels.ts`。
  - **不接受主机名、协议、端口作为入参**，渲染层只能给路径。
- **红线核对**：
  - 这是主进程自主发起的周期性出站请求，和用户点击触发的 `shell:openLocalhost` 性质不同，单独论证：目标只能是回环地址，端口与地址族都来自本条目自己的监听行，路径经白名单校形；每个条目默认关闭，用户显式开启。
  - 红线 1：只向用户自己已经启动的服务发 GET，不执行项目文件、不安装任何东西。
  - 外链约束：不新增任意 URL 通道。
  - 健康检查结果**只用于展示和 P1-2 的就绪时刻**，不参与任何 kill 授权，也不触发 P0-2 的自动重启。
- **验证**：`verify-health.cjs`。夹具起一个本地 HTTP 服务，断言 ok / 状态码 / 延迟；夹具改为返回 500 后断言变 fail；校形断言拒绝 `//evil`、`http://x`、含空白的路径且磁盘配置不变；夹具持续输出超过 4KB 的响应体时断言 socket 被关闭；双绑场景先用真实 `netstat.exe -ano` 确认两个 PID 都在，再断言探到的是本条目自己的进程（夹具在响应体里回写自己的 PID）。
- **迁移**：需要，条目新增可选 `healthCheck`，v14 不回填。

### P0-2 dev 环境崩溃自动重启

- **价值**：解决痛点 2，dev 服务意外退出后按退避自动拉起，并有次数上限防止循环崩溃。
- **入口**：服务详情「配置」页新增开关「意外退出时自动重启」；只有所属工作组环境为 `dev`（或未分组）时可用，`sandbox` / `prod` 下开关禁用并写明原因。只对服务类条目开放，任务（`kind: 'task'`）不开放。
- **主进程**：
  - **触发条件**在 `EntryService.onSessionExit` 里判断，全部满足才排重启：条目状态判为 `crashed`（已排除 `stoppedByUser`）；应用不在退出流程中；条目开启了 `autoRestart`；**排程时**读 `config.get().groups` 确认所属环境为 dev。环境在排程时读，用户把工作组环境改成 sandbox / prod 后也立即生效，不依赖 `edit()` 的联动。
  - **退出流程要先打标记。** 现在 `before-quit` 走 `sessions.disposeAll()` → `kill()`，不会设置 `stoppedByUser`，被退出流程杀掉的会话会被判成 `crashed`。因此新增 `EntryService.beginQuit()`：在 `before-quit` 里、调用 `disposeAll()` **之前**执行，置 `quitting = true` 并清掉所有待执行的重启计时器；`quitting` 为真时 `onSessionExit` 不排重启，`start()` 直接拒绝。
  - **健康检查失败不算崩溃**，不触发重启。自动重启只看会话退出。
  - 退避 2 秒、8 秒、30 秒。次数上限按滑动窗口算：最近 10 分钟内的重启时间戳达到 3 个就停止重试，标记 `autoRestartGaveUp`，并按现有通知开关发一条通知。服务稳定运行超过 10 分钟后，旧时间戳自然滑出窗口。
  - 每次重启都走 `start()`：预检、`assertScriptDeclared`、命令构造全部照旧。
  - 用户手动停止、编辑条目、取消自动重启时清掉该条目的计时器。
  - 重试计数只在内存，应用重启后清零。
- **渲染层**：服务行在等待重启时显示「将在 N 秒后重启（第 k / 3 次）」，提供「取消」。放弃后显示「已停止自动重启」，并附崩溃留尾。
- **IPC 与校形**：
  - `sanitizeEdit` 新增 `autoRestart: boolean`；`edit()` 里若条目属于 sandbox / prod 组则拒绝开启（界面提示用，权威判断仍在排程时）。
  - 新增 `entry:cancelAutoRestart`，只收 `entryId`，走 `ipc.handle` 包装器与 `sanitize*` 校形。
  - 倒计时状态挂在 `EntryRuntime` 的新字段 `autoRestart?: { nextAt, attempt, max } | null` 上，随现有运行态推送下发，不新增推送频道。
- **红线核对**：
  - 不新增命令通道，重启与手动启动是同一条路径。
  - 沙箱与生产不开放：这两个环境每次启动都要人确认，无人值守时无法确认，所以直接不支持，而不是绕过确认。
  - 不涉及外部进程：只重启本应用自己启动并持有 runToken 的条目。
  - 托盘菜单不新增入口，托盘仍只负责启停；取消自动重启只在服务页与命令面板提供。
- **验证**：`verify-autorestart.cjs`。夹具脚本启动后 1 秒 `process.exit(1)`；断言按退避重启 3 次后放弃；对照组：用户手动停止不触发重启、退出码 0 不触发、prod 组条目 `edit` 开启被拒且磁盘不变、已开启的条目所在组改为 prod 后崩溃不重启；退出流程对照：条目运行中走一次 `app.quit()`，断言退出期间没有新会话被拉起（参照 `verify-review-quit.cjs`）。修改夹具 `package.json` 时按 `verify-m10.cjs` 的补丁-还原写法。
- **迁移**：需要，条目新增可选 `autoRestart`，v14 迁移默认 false。

### P1-1 输出关键词告警

- **价值**：解决痛点 3，指定的错误文本一出现就提醒，不用盯输出。
- **入口**：服务详情「配置」页「输出告警」小节，关键词列表输入；另提供一个开关「同时对通用错误行告警」，复用 `outputText.ts` 的 `ERROR_RE`。
- **主进程**：
  - 在 `LogService` 已经切好、去掉 ANSI 的可见行上做匹配，不另写正则（`CLAUDE.md`：文本规则只在 `outputText.ts` 一处）。
  - 关键词按**纯子串**匹配，不区分大小写，不接受正则，避免 ReDoS。
  - 同一条目的同一关键词 60 秒内只告警一次。
  - 命中记录只在内存，每个条目最多 50 条。
  - **与崩溃通知去重**：命中后系统通知延迟 3 秒发出；这 3 秒内该条目触发了 `crashed`，就取消告警通知，只发崩溃通知。命中记录照常保留。最初定的是 1 秒，实测命中行到 `crashed` 事件约 1170 ms（`cmd → npm → node` 链条收尾加 ConPTY 退出事件），1 秒不够。
- **渲染层**：服务行出现告警角标，点开跳到输出页并定位命中行；实时动态抽屉里用独立的告警样式，与普通 warning 区分。
- **IPC 与校形**：
  - `sanitizeEdit` 新增 `alertKeywords: string[]` 与 `alertOnErrors: boolean`。关键词最多 10 个，每个 1–64 字符，去重、去首尾空白，空数组等于关闭。
  - 新增推送频道 `entry:alert`，载荷 `{ entryId, keyword, line, sessionId, at }`。现有 `entry:warning` 只传纯文本，带不出定位命中行需要的数据，所以不复用。
- **与已有功能的区别**：`watchedKeywords` 匹配进程名与命令行，用于关注进程视图；本项匹配会话输出内容。两者字段分开，不复用。
- **红线核对**：只读会话输出，不落盘（日志不落盘红线），不显示环境变量值。
- **验证**：`verify-alert.cjs`。夹具输出含关键词的行，断言实时动态出现提示、60 秒内重复输出只提示一次；含 ANSI 颜色码、`\r` 重绘的行也能命中；65 字符的关键词被拒；夹具输出关键词后立即 `exit(1)`，断言只发出一条系统通知（用 `verify-m10.cjs` 开头的 `Notification` 拦截写法计数）。
- **迁移**：需要，条目新增可选 `alertKeywords` / `alertOnErrors`，并入 v14。

### P1-2 启动耗时统计

- **价值**：解决痛点 5，给每次启动一个可比的数字。
- **现状**：`startedAt` 已有；端口捕获发生在 `absorb()`，输出里出现端口那一刻就转 running，不经过 netstat 采集周期。缺的只是把这一刻记下来。
- **主进程**：
  - 在 `absorb()` 转 running 的分支里记 `readyAt`。开启了健康检查的条目，改取首次 ok 的时刻（更接近真正可用）。
  - 走 60 秒捕获超时转 running（`portUnknown`）的条目没有可信的就绪时刻，不记耗时，界面显示「未捕获到端口」。
  - 每个条目保留最近 10 次 `readyAt - startedAt`，放在 EntryService 按条目的内存 Map 里（与 `lastRunMs` 同一类），停止、崩溃后仍保留，应用重启后清空。
- **精度说明**：取端口捕获时刻时，数字等于「输出打印出端口」的时刻，框架打印地址时可能还没完成初始化，所以界面标注来源（端口 / 健康检查）。不从输出文本里另猜「启动完成」，各框架的文案不同，猜错会给出错误的数字。
- **渲染层**：详情概览页显示「上次启动 N 秒（来源：端口）」和最近 10 次的 `Sparkline`（已有组件）。
- **IPC**：`EntryRuntime` 增加 `readyMs?` 与 `readyHistory?`，随现有运行态推送带出，不新增频道。
- **验证**：`verify-readytime.cjs`。夹具延迟 3 秒才打印监听地址，断言耗时在 3–5 秒且来源为 port；开启健康检查后来源为 health；夹具不打印端口时断言没有耗时记录。
- **迁移**：不需要。

### P1-3 按条目的 CPU / 内存趋势

- **价值**：解决痛点 4。
- **现状**：`ScannerService.attachMetrics()` 已经给每个监听行填了 `cpu` / `memory`，快照也已带 `entryId`，数据已经在推送里。
- **实现**：只改渲染层。在 `store/scanner.ts` 里每收到一次快照，按 `entryId` 把同一条目的各行求和（同一 PID 的多行只算一次，P0-1 加入地址族后尤其要注意），仿照整机 `cpuHistory` 维护每条目 60 点环形缓冲。详情概览页加两条趋势。条目停止后清空它的缓冲。原计划服务行也加迷你曲线，实现时发现行网格（状态点、图标、名称、端口、启停、菜单六列）已满，放进去会挤压名称列，改为只放详情页。
- **限制**：只覆盖有监听行的进程。不监听端口的子进程（例如构建 watcher）不在快照里，界面上注明「只统计监听端口的进程」。要覆盖整棵进程树需要新增采集，本期不做。
- **IPC**：不新增。
- **红线核对**：只展示，不参与 kill 授权。
- **验证**：`verify-entrytrend.cjs`。夹具监听端口后分配约 200MB 内存并保持，断言该条目的内存趋势上升且其他条目不受影响；条目停止后缓冲清空。
- **迁移**：不需要。

### P1-4 端口占用历史

- **价值**：解决痛点 6。
- **实现**：只改渲染层。`ScanDiff` 每次已经带 `added` / `removedPids`，渲染层据此记事件：`added` 记「端口 P 被 PID x（进程名）开始监听」；`removedPids` 只给 PID，所以要用上一份监听表查出它的端口与进程名再记「停止监听」。最多 200 条，只在内存，应用重启后清空。总览监听端口表增加「历史」页签，用 `Segmented` 切换。
- **红线核对**：只展示。进程名是进程自己能写的，表格里不据此给出任何「可以结束」之类的操作。
- **验证**：`verify-porthistory.cjs`。夹具起一个监听、再关掉，轮询到两条事件出现后断言顺序、端口号与 PID（新 PID 进监听表实测约 12 秒，必须轮询，不能固定 sleep）。
- **迁移**：不需要。

### P1-5 启动顺序视图

- **价值**：解决痛点 7，把散在各条目里的 `startAfter` 画成一张图。
- **定位**：这是 `startAfter` 启动顺序的可视化，**不是** `../docs/PRD-workspace-environment.md` §3.3 的依赖拓扑。§3.3 的连线是运行期数据流依赖（API 依赖、DB 依赖），要在工作组编辑里手动声明，还包含 MySQL 这类外部节点；那需要新的持久化字段与编辑界面，仍按 §3.3 另行排期，本项不覆盖。
- **实现**：服务页工作组段落上方加一个可折叠面板。节点只有已登记条目，连线来自 `startAfter`，按 `startOrdered` 的分层从左到右排列，节点状态色只染描边。数据全部来自现有条目列表与运行态，不新增持久化字段。
- **约束**：图形用 SVG 自绘，不引入新依赖。节点数超过 30 时默认折叠。键盘可在节点间移动焦点，Enter 打开详情。
- **验证**：`verify-topology.cjs`。三个条目 A ← B ← C，断言 2 条连线、节点计数 3/3、分层 3 列；修改 `startAfter` 后连线随广播更新。
- **迁移**：不需要。

### P2-1 `.env` 键名只读展示

- 诊断页新增「项目 .env 文件」小节：主进程只读条目目录下的 `.env`、`.env.local`、`.env.development`，解析出键名后只把键名发给渲染层，并标出哪些键与条目配置里的 `env` 重名。值不出主进程，与现有「诊断只显示键名」一致。
- 目录必须用 `terminalCwd` 同一套校验得出（`resolveCwd` 后 `assertInsideEntry`），越界直接拒读。读文件前对文件做 `realpath`，结果不在条目路径内（符号链接指出去）就跳过。
- 只读文件，不执行任何东西，符合红线 1。每个文件单独判断大小，超过 64KB 的跳过并说明原因。
- harness：`verify-dotenv.cjs`，断言渲染层拿到的数据里不含任何夹具中的值；指向条目目录外的符号链接被跳过。

### P2-2 环境变量配置组

- 一个条目可以保存多组 env（例如「本地」「联调」），启动前在详情页选当前组。值只在主进程和 config.json，渲染层只见组名与键名。编辑沿用 `EntryEdit.env` 的合并补丁语义，按组提交。
- 需要配置迁移（v15 或并入 v14）。`ConfigTransferService` 两侧都要改：导出按组只留键名；导入兼容单组与多组两种形态，`envToRefill` 带上组名，逐组列出要重填的变量。

### P2-3 命令面板「最近操作」

- 命令面板空输入时在顶部显示最近 5 条执行过的命令，存渲染层 localStorage（`mile.palette.recent`），不经主进程。只记命令标识与条目 id，不记参数文本。

### P2-4 日志中心复制筛选结果

- 日志中心在当前筛选条件下提供「复制可见行」，复制去掉 ANSI 后的文本。行内容取自渲染层已经拿到的查询结果，用 `navigator.clipboard.writeText` 写剪贴板（`ListenerTable`、`EntryDetail` 已有同样用法），不新增 IPC，不经主进程。不提供另存为文件（日志不落盘红线）。

### P2-5 开机自启（待决策）

- 按 `../docs/PRD-AUTORUN-CONTROL.md` 只考虑方案 B（HKCU `StartupApproved`，不提权）。该文档已排除方案 A。是否做由用户决定，本文不排期。

---

## 4. 明确不做

以下来自 PRD §15 的非目标继续有效，本次升级一律不碰：

- 终止外部进程（端口相同、进程名相同都不行）。
- 自动安装依赖、自动切换 Node 版本。
- 多用户、云同步。
- 远程 SSH、Docker 管理。
- macOS / Linux 真机验证（darwin 适配层仍只过 typecheck 与合成解析）。
- Git 集成、依赖版本检查、代码编辑。
- 日志落盘。
- 自动更新。

本文新增的边界：

- 健康检查不接受任意 URL、主机名或协议，只接受路径；不探 https。
- 自动重启不支持 sandbox / prod 环境，也不提供「跳过确认」的选项；健康检查失败不触发重启。
- 输出告警不支持正则。
- 启动耗时不从输出文本猜测就绪时刻。
- 端口历史、告警记录、启动耗时都不持久化。
- `.env` 只展示键名，不读出值，也不提供写回。
- 启动顺序视图不含外部节点与数据流依赖，那是 §3.3 的范围。

---

## 5. 里程碑

当前可运行的 harness 共 57 个（`scripts/` 下 59 个 `verify-*.cjs`，去掉已停用的 `verify-package-ui.cjs` / `verify-package-ui2.cjs`；`CLAUDE.md` 里的「55 个」已过时，届时一并更新）。

| 里程碑 | 内容 | 配置版本 | 新增 harness | 完成标准 |
| --- | --- | --- | --- | --- |
| U1 | 监听行地址族改造、P0-1 健康检查、P0-2 自动重启、P1-1 输出告警、v14 迁移 | 13 → 14 | `verify-health`、`verify-autorestart`、`verify-alert` | 新 harness 全绿；全套 57 个 harness 无回归，`verify-darwin-parse`、`verify-m11-dual`、`verify-review-listenrow`、`verify-review-quit` 必须重跑；m9-readonly / m9-recover 在 v13 配置上验证迁移与备份恢复 |
| U2 | P1-2 启动耗时、P1-3 条目资源趋势 | 14 | `verify-readytime`、`verify-entrytrend` | 同上；`verify-ui` 三条硬规则基线不升 |
| U3 | P1-4 端口历史、P1-5 启动顺序视图 | 14 | `verify-porthistory`、`verify-topology` | 同上；面板对比度 ≥ 4.5:1、键盘可达 |
| U4 | P2-1 至 P2-4，按用户选择排入；P2-5 待决策后另行排期 | 视 P2-2 是否做 | 各项对应 harness | 同上 |

P1-1 放进 U1 的原因：它的字段要进 v14，如果留到 U2，U1 发出去的 v14 里会有一个没有代码读写的字段；把功能一起做掉，也省掉一次迁移。

每个里程碑的通用要求：

- 新字段同时改 `src/shared/types.ts`、`sanitizeEdit`、`redactEntry`（如涉及值）、`ConfigStore` 迁移分支、`ConfigTransferService` 导出与导入规则。
- 迁移写显式版本分支，不用 `{...DEFAULTS, ...raw}` 铺开；harness 从 `src/shared/types.ts` 读版本号，不写死。
- 新 harness 在 `require` 主进程包之前设置沙箱 `appData`；集合断言带计数门槛；改判定逻辑后做一次反向对照，做完还原源码并重新构建。
- 新 IPC 一律走 `ipc.handle` / `ipc.on` 包装器并写 `sanitize*`；推送一律用 `sendToRenderer`。
- 产品行为定稿后回写 `../docs/PRD.md`，并在 `README.md` 版本记录里登记。
