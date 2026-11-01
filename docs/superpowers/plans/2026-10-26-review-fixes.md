# 2026-10-26 审查问题修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按当前源码逐项修复本次审查中已成立的安全边界、进程生命周期、异步状态、界面闭环、验证资产、官网可访问性与文档漂移问题，并用可复现证据区分已修复与仍需真实环境确认的项目。

**Architecture:** 保持主进程独占特权、preload 白名单和渲染层无特权三层结构。IPC 入参在主进程校形；内部完整条目与渲染层 DTO 分离；条目操作以代次和 sessionId 防串扰；进程终止以 OS 创建时间、进程组、运行 token、当前 UID 和会话 id 共同定界。验证继续加载真实 `out/` 产物并驱动真实渲染层，不引入 Jest、Vitest 或其他单元测试框架。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、electron-vite、Vite 7、Tailwind 4、Zustand 5、node-pty；`website/` 是独立 Vite + React 静态站。

---

## 1. 基线、边界与证据口径

- 工作目录：`E:\WebApp\Mile-Terminal-Management\mile-terminal-management`，Git Bash 使用 Unix 语法。
- 审查基线：`80230519cb6cd0d58e69272901be6a597205905a`。
- 必须保留的在途内容：`AGENTS.md` 的已有修改、未跟踪的 `website/`、以及本计划文件。不得暂存、清理或回滚不属于当前任务的内容。
- 本轮只读审查已运行 `npm run typecheck`，node 与 web 均通过；本轮没有重新运行桌面端 build、官网 build、`build:win` 或 Electron/UI harness。原审查报告里的构建结果不计作本轮独立证据。
- 本计划描述的是后续实施步骤，不代表已经修复。执行 UI harness 前必须取得用户对自动化 UI 测试的明确许可。
- 现有 `scripts/verify-m4.ts`、`scripts/verify-package-ui.cjs`、`scripts/verify-package-ui2.cjs` 在完成 Task 1 前一律不得运行。
- 不安装新依赖，不执行项目安装脚本，不引入单元测试框架，不修改 `local-ops-main/`，不实现 `PRD-AUTORUN-CONTROL.md` 中仍待决策的开机自启。
- 所有文本保持 UTF-8 无 BOM，中文直接书写。编辑前重新核对换行，不沿用任何旧换行清单；写后检查真实 `U+FFFD`、BOM、意外整文件换行变化和 `git diff --check`。
- `GroupService.ts` 当前含真实 NUL/控制字符，专用 Edit/Write 会拒绝。实施 Task 10 时先用保留 UTF-8 与 LF 的 Node 脚本只替换正则字符类中的控制字符，再做普通编辑；不得整文件盲覆盖。
- 每个 Task 先写并运行会失败的断言，再做最小实现，再运行同一断言确认通过。安全与竞态修复另做一次反向对照：临时还原目标实现，确认恰好目标断言变红，随后恢复实现并重新 build。
- 各 Task 的提交步骤只有在用户明确授权提交时才执行；否则跳过提交并保留改动供审查。提交只暂存本 Task 列出的文件，绝不使用 `git add .`。

### 推荐方案，均待用户批准计划后才生效

| 编号 | 推荐取舍 | 明确不采用的擅自决定 |
| --- | --- | --- |
| D1 | 保留“新建 PowerShell”，IPC 只接受固定 shell 请求；内部条目会话仍使用主进程完整命令规格 | 不删除自由终端，不让渲染层传 `file/args/env/cwd` |
| D2 | 环境变量值只留在主进程；渲染层收 `envKeys`，编辑采用覆盖/删除补丁 | 不把完整 `env` 改名后继续下发 |
| D3 | 保留 `killOwnedOnQuit`，让退出流程真正等待异步清理 | 不删除设置，不新增单实例锁 |
| D4 | “我的服务”只保留一个诚实命名的停止按钮，沿用现有 Ctrl+C 后终止语义 | 不新增强制停止 IPC |
| D5 | 工作组诊断复用现有诊断视图；启动被预检拦下时也跳到该条目诊断 | 不新做一套内联诊断面板 |
| D6 | 官网当前只承诺根域部署；子路径与公开 `og:image` 地址等部署目标明确后另改 | 不默认 `base: './'`，不猜公开域名 |
| D7 | 以现行项目 UI 约束为准，hover 阴影也压回不透明度不超过 0.05，并量对比度与几何 | 不把 v1.6 的视觉取舍静默写成新规范 |
| D8 | 三个危险脚本先原地加硬停止标记，不删除文件；后续是否恢复或删除另行决定 | 不在未确认时删除、重命名或运行它们 |
| D9 | 同一条目同时只允许一个受管会话；已有 live 会话时 `start` 保持幂等返回，运行中构建/安装等第二会话操作明确拒绝 | 不在本计划内扩建并行运行态槽位 |

D9 是防数据损坏的保守方案。若产品必须支持“服务运行中同时构建”，应先停止本任务并另写多会话运行态设计，不得在实施中临时选择。

## 2. 审查结论核验矩阵

| 编号 | 当前结论 | 当前证据与边界 | 修复任务 |
| --- | --- | --- | --- |
| C1 | 静态确认 | `src/main/index.ts:139` 把 `CreateSessionInput` 直接交给 `SessionService.create`；`SessionService.ts:40-70` 接受渲染层的 `file/args/cwd/env` | Task 3 |
| I1 | 静态确认 | 完整 `env` 经 list/add/edit 与 `entry:changed` 进入渲染层；`EditEntryDialog.tsx:76-78`、`useEntryFix.tsx:135` 又依赖旧值。诊断接口本身只返回键名 | Task 5 |
| I2 | 静态确认 | `EntryService.ts:305-320` 的 add 未复用 edit 校形；绝对 `outputDir` 可进入 `knownPath`，再与 `index.ts:153-159` 的 openPath 形成危险链 | Task 4 |
| I3 | 部分成立，原表述收窄 | `OwnershipService.ts:31-32` 用登记时刻代替 OS 创建标识；约 60 秒窗口内的快速 PID 复用可能误判，不能推导为所有复用都通过。`assertKillable` 未绑定 sessionId，终止还受缓存与异常注销影响。未构造真实 PID 复用 | Task 6 |
| I4 | 静态确认 | start/remove/stop/restart/build 缺统一代次；若干 await 后不复核；会话退出、捕获和构建回调未全部核对当前 sessionId | Task 7 |
| I5 | 静态确认，影响待动态量化 | `ScannerService` 的 `emit('error')` 可先于 `publishFailure()` 抛出，调度缺少统一 rejection 收口。不能声称“必崩”，也没有本轮“仅警告”的实测 | Task 8 |
| I6 | 静态确认 | BackendConsole 订阅稳定 getter，而不是 getter 内部读取的 runtimes/groups 数据 | Task 11 |
| I7 | 静态确认，闭包推断收窄 | jar 切换未检查 `edit(): Promise<boolean>`，失败仍清错误并启动。`handleStart` 只传 id，主进程会重读条目，不能声称必用旧 jar | Task 11 |
| I8 | 静态确认 | Workgroups 丢弃启动预检和诊断结果，空 `onPin` 截走 EntryCard/EntryRow 的 onLogs 回退 | Task 11 |
| I9 | 静态确认 | AddEntryDialog 没有识别代次、目录一致性复核与提交防重 | Task 12 |
| I10 | 静态确认 | 三个非正式脚本缺 appData 沙箱或含真实配置/进程操作，不能运行。正式 23 个 harness 不因此改计为 25 | Task 1 |
| I11 | 静态确认 | m4-ui 有恒真与丢弃等待结果；m8 接受错误终态；m9 有空集 every 和双向归属断言；springboot 负向用例前提不足；m10 恢复可能跳过 | Task 2 |
| I12 | 解析器缺陷确认，现行误判未证实 | m7 通用数字提取把 `color(srgb 0..1)` 当 `rgb(0..255)`；需先修解析器，再判断当前界面是否真有失败 | Task 2 |
| S1 | 静态确认 | ConfigStore 从良好 `.bak` 恢复后走常规 `persist()`，会先把坏主文件覆盖到 `.bak` | Task 9 |
| S2 | 部分成立 | `disposeAll()` 与 `before-quit` 不等待异步 kill；不能仅凭静态代码断言开关完全无效 | Task 9 |
| S3 | 静态确认 | 重复 id、非有限 order、删除后条目广播缺失，以及源码真实控制字符均需处理 | Task 10 |
| S4 | 静态确认，Diagnose 收窄 | LogCenter、TerminalView、Diagnose 有请求/流顺序缺口；Diagnose 已有 `report.entryId === entry.id` 渲染门槛，不是旧报告必然错挂 | Task 12 |
| S5 | 静态确认 | 普通停止条件恒不可达；“强制关闭”与普通停止调用相同 | Task 13 |
| S6 | 静态确认 | Dashboard 添加缺视图跳转；About 外链被现有 localhost-only 守卫拒绝；ignore 本地过滤只按端口；ScriptPicker 初值可失效 | Task 13 |
| S7 | CSS 规则确认，几何影响待量 | surface-card 注释错误、扫描动画改 top/height、动画终态保留 transform、禁用态和阴影需实测。EntryCard 根节点已有 `relative`，不能报成它已失去定位上下文 | Task 14 |
| S8 | 对比度数值确认；部署为条件项 | `#637083` 在已核对深色底色上的计算值约 3.26–4.01:1；原候选 `#7b8798` 在 `#18202b` 上为 4.4998:1，严格说仍未达 4.5:1。计划改用 `#7d8999`，已抽样底色最低 4.6162:1，但仍需全页面合成验证。根路径资源不等于支持任意子路径 | Task 15 |
| S9 | 静态确认 | PRD 版本/非 npm 能力、README 视图数、工作组导航、AGENTS 历史描述、CONFIG_VERSION 等漂移。`../docs/PRD.md` 本轮实测为 119201 字节，不是根文档所写 872KB | Task 16 |

### 已排除或不得再沿用的结论

- 当前已有 `setWindowOpenHandler`，且只允许 localhost/127.0.0.1；缺的是统一 sender 校验与导航防护，不是“完全没有窗口打开守卫”。
- `parseNetstat` 的去重键是 `pid:port`，不会合并两个不同 PID 的同端口行。
- EntryCard 自身已有 `relative`；Portal 菜单点击时序没有本轮 UI 复现，只能先补探针。
- 没有 Jest/Vitest 不是缺陷。
- 官网是否采用相对 base、是否删除危险脚本、是否新增强制停止、是否删除退出开关，均未获用户批准。
- 本轮没有真实 Windows PID 复用、Scanner 故障、Portal 点击、CSS fixed 几何或退出行进程实测；实施后必须用对应 harness 补齐证据。

## 3. 文件结构

新增验证资产：

- `scripts/verify-harness-contract.cjs`：静态检查危险脚本已有硬停止，不执行这些脚本。
- `scripts/lib/css-color.cjs`、`scripts/verify-css-color.cjs`：统一解析 `rgb()` 与 `color(srgb)`，用已知人工答案校验解析器。
- `scripts/verify-review-ipc.cjs`：固定 shell、sender、entry:add、openPath、env DTO 的真实主进程/渲染层验证。
- `scripts/verify-review-ownership.cjs`：合成进程表负向用例与创建时间绑定检查，不声称真实 PID 复用实测。
- `scripts/verify-review-entry-races.cjs`：启动/删除/重复启动/构建互斥及旧会话事件。
- `scripts/verify-review-scanner.cjs`：受控 PowerShell 失败下的 failed 快照与 rejection 收口。
- `scripts/verify-review-quit.cjs`：父子进程式退出清理验证与夹具清理。
- `scripts/verify-review-groups.cjs`：工作组输入、排序与跨 store 同步。
- `scripts/verify-review-backend-workgroups.cjs`：后端响应式状态、jar 编辑失败、工作组动作闭环。
- `scripts/verify-review-async.cjs`：添加条目、日志、诊断、终端历史/实时顺序。
- `scripts/verify-review-interactions.cjs`：Dashboard、About、ignore、ScriptPicker、停止按钮。
- `scripts/verify-review-visual.cjs`：定位上下文、transform/opacity 动画、Portal 菜单、禁用态。
- `scripts/verify-website.cjs`：官网真实计算样式、可见正文对比度与根域构建。

实现仍落在现有 `src/main/`、`src/preload/`、`src/renderer/`、`src/shared/`，不做目录重构。官网只改 `website/` 内明确列出的文件。

---

### Task 1: 先封禁危险脚本，建立验证资产安全门

**Files:**
- Modify: `scripts/verify-m4.ts`
- Modify: `scripts/verify-package-ui.cjs`
- Modify: `scripts/verify-package-ui2.cjs`
- Create: `scripts/verify-harness-contract.cjs`

- [ ] **Step 1: 写静态失败断言，绝不执行三个危险脚本**

```js
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const MARK = 'DISABLED_UNSAFE_HARNESS'
const files = ['verify-m4.ts', 'verify-package-ui.cjs', 'verify-package-ui2.cjs']
let failed = 0
for (const file of files) {
  const source = readFileSync(join(__dirname, file), 'utf8')
  const guard = source.indexOf(MARK)
  const firstEffect = Math.min(
    ...['new ConfigStore', "require('../out/main/index.js')", 'require(join(ROOT']
      .map((token) => source.indexOf(token)).filter((index) => index >= 0)
  )
  const ok = guard >= 0 && (firstEffect === Infinity || guard < firstEffect)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file} 在真实配置/主进程加载前硬停止`)
  if (!ok) failed++
}
process.exitCode = failed ? 1 : 0
```

- [ ] **Step 2: 运行并确认红**

Run: `node scripts/verify-harness-contract.cjs`

Expected: 三个文件均报 FAIL，因为当前没有 `DISABLED_UNSAFE_HARNESS`；脚本自身不加载 Electron、不读真实配置。

- [ ] **Step 3: 在三个文件的可执行代码前加硬停止**

两个 `.cjs` 文件把下面内容放在任何 `require('../out/main/index.js')`、`require(join(ROOT...` 之前；`verify-m4.ts` 放在 imports 之后、任何 `new ConfigStore()` 之前：

```js
throw new Error(
  'DISABLED_UNSAFE_HARNESS: 该旧脚本可能写真实配置或操作真实进程；不得运行，等待单独恢复或删除决策'
)
```

不要删除旧实现，不要把它们加入正式 harness 清单。

- [ ] **Step 4: 重跑静态安全门并检查差异**

Run: `node scripts/verify-harness-contract.cjs; git diff --check -- scripts/verify-m4.ts scripts/verify-package-ui.cjs scripts/verify-package-ui2.cjs scripts/verify-harness-contract.cjs`

Expected: 三个 PASS，diff check 无输出。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add scripts/verify-m4.ts scripts/verify-package-ui.cjs scripts/verify-package-ui2.cjs scripts/verify-harness-contract.cjs
git commit -m "test: quarantine unsafe legacy probes" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: 修复正式 harness 假绿与颜色解析器

**Files:**
- Create: `scripts/lib/css-color.cjs`
- Create: `scripts/verify-css-color.cjs`
- Modify: `scripts/verify-m4-ui.cjs`
- Modify: `scripts/verify-m7-visual.cjs`
- Modify: `scripts/verify-m8.cjs`
- Modify: `scripts/verify-m9.cjs`
- Modify: `scripts/verify-m10.cjs`
- Modify: `scripts/verify-springboot.cjs`

- [ ] **Step 1: 写颜色人工答案与 harness 反假绿断言**

`css-color.cjs` 先只声明要实现的函数；`verify-css-color.cjs` 使用 Node `assert/strict`：

```js
const assert = require('node:assert/strict')
const { parseCssColor, contrast } = require('./lib/css-color.cjs')
assert.deepEqual(parseCssColor('color(srgb 0.5 0.25 1 / 0.5)'),
  { r: 127.5, g: 63.75, b: 255, a: 0.5 })
assert.deepEqual(parseCssColor('rgb(246, 247, 249)'),
  { r: 246, g: 247, b: 249, a: 1 })
assert.deepEqual(parseCssColor('rgba(0, 0, 0, 0.28)'),
  { r: 0, g: 0, b: 0, a: 0.28 })
assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.0001)
assert.throws(() => parseCssColor('color(display-p3 1 0 0)'), /不支持/)
console.log('PASS 5 组颜色解析与对比度人工答案')
```

同时在 m8 使用长期运行夹具 `hold`，要求停止后状态严格为 `stopped`；m9 所有集合断言先写 `rows.length > 0`；`claimsEditor` 必须 `length > 0 && every(l => l.ownership === 'external')`；m4-ui 必须实际打开 `[role="dialog"][aria-modal="true"]` 后再断言，且所有 `waitUntil` 返回值必须进入 `check`。m10 的夹具恢复断言必须证明中途失败也执行恢复。

- [ ] **Step 2: 运行并确认红**

Run: `node scripts/verify-css-color.cjs; npm run build; npx electron scripts/verify-m4-ui.cjs; npx electron scripts/verify-m8.cjs; npx electron scripts/verify-m9.cjs; npx electron scripts/verify-springboot.cjs`

Expected: 颜色脚本因函数缺失或错误实现失败；m8 的严格 `stopped`、m9 的非空/单向归属、m4-ui 的真实对话框断言至少各有目标 FAIL。若某条意外为绿，先修探针前提，不得直接改产品代码。

- [ ] **Step 3: 实现统一颜色解析并修 harness 本身**

```js
function parseCssColor(input) {
  const value = input.trim()
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) {
      throw new Error(`十六进制颜色非法：${input}`)
    }
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16))
    const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }
  const isSrgb = value.startsWith('color(srgb')
  const isRgb = /^rgba?\(/.test(value)
  if (!isSrgb && !isRgb) throw new Error(`不支持的颜色：${input}`)
  const body = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')'))
  const [channelText, slashAlpha] = body.split('/')
  const channels = channelText.replace(/^srgb\s+/, '').trim().split(/[\s,]+/).filter(Boolean)
  let alphaText = slashAlpha
  if (isRgb && alphaText === undefined && channels.length === 4 && body.includes(',')) {
    alphaText = channels.pop()
  }
  if (channels.length !== 3) throw new Error(`颜色通道不足：${input}`)
  const scale = isSrgb ? 255 : 1
  const [r, g, b] = channels.map((part) => Number(part) * scale)
  const a = alphaText === undefined ? 1 : Number(alphaText)
  if (![r, g, b, a].every(Number.isFinite)) throw new Error(`颜色值非法：${input}`)
  return { r, g, b, a }
}
function luminance({ r, g, b }) {
  const linear = [r, g, b].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}
function contrast(fg, bg) {
  const a = luminance(typeof fg === 'string' ? parseCssColor(fg) : fg)
  const b = luminance(typeof bg === 'string' ? parseCssColor(bg) : bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
module.exports = { parseCssColor, luminance, contrast }
```

m7 用 `parseCssColor.toString()` 注入浏览器探针，替换 RGB、亮度与对比度的通用数字提取；半透明合成仍沿父链计算。浅色背景期望从当前 `--surface-canvas` 读取，不写死旧 `#f6f7f9`。

m8 给 `hold` 脚本使用夹具内的长期 Node 进程，先轮询到 `sessionId` 存在再 stop，最终只接受 `stopped`。m10 把 package 恢复、noisy 清理、沙箱清理拆成独立 `try/finally`，每一步失败都计入退出码。m9 的每条 `.every()` 前必须有实际非空计数。springboot 在非法编辑前轮询到非 live，再断言错误消息包含被测字段，禁止把“运行中锁定”当成字段校验通过。

- [ ] **Step 4: 重跑全部受影响 harness**

Run: `node scripts/verify-css-color.cjs; npm run build; npx electron scripts/verify-m4-ui.cjs; npx electron scripts/verify-m7-visual.cjs; npx electron scripts/verify-m8.cjs; npx electron scripts/verify-m9.cjs; npx electron scripts/verify-m10.cjs; npx electron scripts/verify-springboot.cjs`

Expected: 颜色人工答案 PASS；其余脚本结果均为 0 FAIL，且输出含实际集合数量、等待结果与拒绝原因，不靠空集或固定 sleep 通过。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add scripts/lib/css-color.cjs scripts/verify-css-color.cjs scripts/verify-m4-ui.cjs scripts/verify-m7-visual.cjs scripts/verify-m8.cjs scripts/verify-m9.cjs scripts/verify-m10.cjs scripts/verify-springboot.cjs
git commit -m "test: close false-positive harness gaps" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: 收窄 session:create，并统一可信 sender 与导航守卫

**Files:**
- Modify: `src/shared/types.ts:19-30`
- Modify: `src/main/index.ts:137-159`
- Modify: `src/main/services/SessionService.ts:40-103`
- Modify: `src/preload/index.ts:30-43`
- Modify: `src/renderer/src/store/sessions.ts:4-31`
- Test: `scripts/verify-review-ipc.cjs`

- [ ] **Step 1: 写任意命令与第二窗口 sender 失败用例**

在沙箱中启动真实主进程和渲染层，记录：

```js
const arbitrary = await js(`window.mile.session.create({
  kind: 'shell', file: 'cmd.exe', args: ['/d', '/s', '/c', 'exit 0'],
  cwd: 'C:\\\\', env: { MILE_REVIEW: 'MILE_IPC_MUST_NOT_LEAK' }, title: 'probe'
}).then(m => ({ ok: true, id: m.id, command: m.command, cwd: m.cwd }), e => ({ ok: false, error: String(e) }))`)
const serialized = JSON.stringify(arbitrary)
check('固定 shell 成功，且渲染层提供的 file/args/cwd 被忽略',
  arbitrary.ok && /powershell|pwsh/i.test(arbitrary.command) &&
  String(arbitrary.cwd).toLowerCase() === expectedCwd.toLowerCase() &&
  !/cmd\.exe|\/d\s+\/s\s+\/c|exit 0/i.test(serialized), serialized)
```

`expectedCwd` 由 harness 从 `node:os` 的 `homedir()` 取得。这里必须要求合法请求成功，不能写成“只要拒绝就算安全通过”。再创建一个使用相同 preload 的第二 BrowserWindow，调用 `window.mile.session.create({ kind: 'shell' })`，要求请求被拒绝且错误包含“拒绝非主窗口或非主框架”，排除其他原因造成的假绿。向主窗口返回的固定 PowerShell 写入 `[Console]::WriteLine($env:MILE_REVIEW)`，轮询 history，断言输出不含测试标记 `MILE_IPC_MUST_NOT_LEAK`。最后由 harness 记录主窗口当前 URL 与 `did-navigate`，尝试导航到 `data:text/html,<title>blocked</title>`，要求仍停留原 URL；红运行时若导航已发生，harness 必须从主进程恢复原 URL 再继续，不能让后续断言在 data 页面里空过。探针只执行系统 `cmd /c exit 0`，不创建文件、不执行项目代码。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-ipc.cjs`

Expected: 当前主窗口能返回 `cmd.exe` 命令；第二窗口也能创建会话；导航防护断言失败。记录实际结果，不把进程崩溃当作预期通过。

- [ ] **Step 3: 分离 IPC 自由终端输入与内部完整命令规格**

```ts
export interface CreateShellSessionInput {
  kind: 'shell'
  title?: string
}
export interface SessionSpawnSpec {
  kind: SessionKind
  cwd: string
  projectId?: string | null
  title?: string
  file: string
  args: string[]
  env?: Record<string, string>
}
```

`SessionService.create(input: SessionSpawnSpec)` 不再给 `file/args/cwd` 提供来自 IPC 的回退；新增：

```ts
createShell(input: CreateShellSessionInput): SessionMeta {
  if (!input || input.kind !== 'shell') throw new Error('自由终端只允许 shell')
  const file = defaultShell()
  return this.create({
    kind: 'shell', file, args: shellLaunchArgs(file), cwd: homedir(),
    title: typeof input.title === 'string' ? input.title.slice(0, 80) : 'PowerShell'
  })
}
```

主进程 IPC 必须切到固定 shell 入口，不能只新增方法却留下旧调用：

```ts
handle(Channels.sessionCreate, (_e, input: CreateShellSessionInput) =>
  sessions.createShell(input)
)
```

preload 的 `session.create` 改用 `CreateShellSessionInput`；renderer 的 `openShell()` 删除 cwd 参数，只发送 `{ kind: 'shell', title: 'PowerShell' }`。EntryService 继续调用内部 `create(SessionSpawnSpec)`，命令仍由主进程固定模板构造。

在 index 增加包装器，并把本文件所有 `ipcMain.handle/on` 注册迁到包装器：

```ts
function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.frameId !== 0) {
    throw new Error('拒绝非主窗口或非主框架的 IPC 请求')
  }
}
function handle<A extends unknown[], R>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: A) => R
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return listener(event, ...(args as A))
  })
}
```

`on` 使用同形 `IpcMainEvent` 包装。保留现有 localhost-only `setWindowOpenHandler`，新增 `will-navigate` 阻止顶层离开当前应用 URL；不放宽 GitHub 或任意外链。

- [ ] **Step 4: 重跑 IPC harness 与自由终端回归**

Run: `npm run build; npx electron scripts/verify-review-ipc.cjs; npx electron scripts/verify-m5.cjs`

Expected: 恶意字段不能改变固定 PowerShell 的命令和 cwd；第二 sender 与非主框架被拒绝；合法“新建 PowerShell”仍返回会话；现有 m5 为 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/shared/types.ts src/main/index.ts src/main/services/SessionService.ts src/preload/index.ts src/renderer/src/store/sessions.ts scripts/verify-review-ipc.cjs
git commit -m "fix(security): narrow session creation IPC" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: 让 entry:add 与 edit 同级校形，并封住 openPath 读取侧

**Files:**
- Modify: `src/main/services/EntryService.ts:305-579,616-627,718-729`
- Modify: `src/main/index.ts:153-159,161-165`
- Test: `scripts/verify-review-ipc.cjs`

- [ ] **Step 1: 写 add 非法字段与旧配置 openPath 失败用例**

新增 IPC 用例：

```js
const addBase = {
  kind: 'task', name: 'escape', path: FIXT, framework: 'node',
  packageManager: 'npm', script: 'build', scripts: { build: 'node make.cjs' },
  env: {}, pinned: false, registerOnly: false, outputDir: 'dist'
}
const rejectAdd = (extra) => js(`window.mile.entry.add({
  ...${JSON.stringify(addBase)}, ...${JSON.stringify(extra)}
}).then(() => ({ ok: true }), e => ({ ok: false, error: String(e) }))`)
const badOutput = await rejectAdd({ outputDir: 'C:\\Windows\\Temp\\mile-review-escape' })
const badImage = await rejectAdd({ imageId: '..\\escape' })
check('add 因绝对 outputDir 拒绝', !badOutput.ok && /产物目录/.test(badOutput.error), badOutput.error)
check('add 因字符串 imageId 拒绝', !badImage.ok && /图片/.test(badImage.error), badImage.error)
check('两次失败 add 均不落盘', !readFileSync(CONFIG, 'utf8').includes('mile-review-escape'))
```

两个请求必须分开：否则第一个字段先抛错，第二个字段可能根本没有被验证。在另一个沙箱配置中直接放入旧版绝对 `outputDir`，用 Module `_load` Proxy 只记录 `shell.openPath`，不真正打开。执行 `await js(\`window.mile.shell.openPath(${JSON.stringify(ESCAPE_DIR)})\`)`，要求不调用 shell；再用一个已登记但指向 `.cmd` 文件的路径，要求 `isDirectory` 拒绝。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-ipc.cjs`

Expected: 当前 add 接受危险字段；旧配置的绝对 outputDir 能进入 openPath 记录；文件目标没有目录校验。

- [ ] **Step 3: 复用 sanitizeEdit，并限制 outputDir 的每个读取入口**

将 `add` 改为 async，以只含安全默认值的 draft 调用同一个 `sanitizeEdit`，随后复核必填字段、真实目录和脚本声明；不得先把未校验 input 展开进 entry。`imageId` 单独拒绝，避免 `NewLaunchEntry` 的字符串类型被直接当成 `EntryEdit` 传入：

```ts
if (!input || typeof input !== 'object') throw new Error('条目内容必须是对象')
if (input.imageId !== undefined && input.imageId !== null) {
  throw new Error('图片只能经上传设置')
}
const draft: LaunchEntry = {
  id: 'pending', kind: 'task', name: '', path: '', framework: 'unknown',
  packageManager: 'npm', script: null, scripts: {}, env: {},
  registerOnly: false, pinned: false, order: 0, createdAt: 0
}
const clean = this.sanitizeEdit(draft, { ...input, imageId: null })
const candidate: LaunchEntry = { ...draft, ...clean }
if (!candidate.name || !isAbsolute(candidate.path)) throw new Error('条目名称或项目目录非法')
await this.validateEntryForSave(candidate)
// await 之后再读 entries，避免两个并发 add 取得相同 order 或覆盖彼此
const current = this.config.get().entries
const entry: LaunchEntry = {
  ...candidate, id: randomUUID(), order: current.length, createdAt: Date.now()
}
this.commit([...current, entry])
return entry
```

把 edit 的“目录存在、脚本名白名单、脚本已声明”检查提取为 async `validateEntryForSave(entry)` 并在 add/edit 共用；edit 要先合成完整候选再调用它。`imageId` 在 add 中同样只能缺省或 null，设置图片仍走 `setImage(bytes)`。

新增：

```ts
private configuredOutputDir(entry: LaunchEntry): string | null {
  const dir = entry.outputDir
  if (!dir || isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) return null
  const cwd = resolveCwd(entry)
  const target = join(cwd, dir)
  try {
    this.assertInsideEntry(entry, cwd)
    this.assertInsideEntry(entry, target)
  } catch {
    return null
  }
  return target
}
```

`knownPath` 对 `resolveCwd(entry)` 也先做同样的条目内路径检查，旧配置的绝对/`..` cwd 不得进入白名单；产物路径只使用 `configuredOutputDir`，不再接受绝对值。`outputDir()` 在显式配置了 outputDir 但 helper 返回 null 时直接返回 null，不得回退到默认目录；未配置时才探测默认 candidates，且 cwd 也必须先通过条目内检查。`shell:openPath` 在 knownPath 之外再检查 `statSync(target, { throwIfNoEntry: false })?.isDirectory()`；文件关联打开继续走已有的明确专用 handler。

- [ ] **Step 4: 重跑安全与现有目录回归**

Run: `npm run build; npx electron scripts/verify-review-ipc.cjs; npx electron scripts/verify-m11-add.cjs; npx electron scripts/verify-m12-port-config.cjs`

Expected: add 非法值抛错且不落盘；旧配置不能扩大 openPath 白名单；正常添加、端口修复和合法产物目录打开均为 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/main/services/EntryService.ts src/main/index.ts scripts/verify-review-ipc.cjs
git commit -m "fix(security): validate new entries and output paths" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5: 环境变量改为主进程持有、渲染层只写补丁

**Files:**
- Modify: `src/shared/types.ts:263-274,403-460,542-592`
- Modify: `src/main/services/EntryService.ts`
- Modify: `src/main/services/PrecheckService.ts`（主进程内部条目类型）
- Modify: `src/main/index.ts:161-267`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/EditEntryDialog.tsx`
- Modify: `src/renderer/src/lib/useEntryFix.tsx:120-145`
- Modify: `scripts/verify-m12-port-config.cjs`
- Test: `scripts/verify-review-ipc.cjs`

- [ ] **Step 1: 写所有条目出口不泄露秘密的失败用例**

创建含 `env: { MILE_REVIEW_SECRET: 'never-render-this', KEEP: 'keep' }` 的条目，检查 list/add/edit/reorder/clearImage 返回值和 `entry:changed` 广播：

```js
const cleared = await js(`window.mile.entry.clearImage('${added.id}')`)
const serialized = JSON.stringify({ list, added, edited, reordered, cleared, broadcasts })
check('条目 DTO 不含 env 值', !serialized.includes('never-render-this'), serialized)
check('DTO 只暴露键名',
  Array.isArray(added.envKeys) && added.envKeys.includes('MILE_REVIEW_SECRET') && !('env' in added),
  JSON.stringify(added))
const patched = await js(`window.mile.entry.edit('${added.id}', {
  env: { MILE_REVIEW_SECRET: null, PORT: '43117' }
})`)
const disk = JSON.parse(readFileSync(CONFIG, 'utf8'))
const stored = disk.entries.find((entry) => entry.id === added.id)
check('null 删除、字符串新增/覆盖', !stored.env.MILE_REVIEW_SECRET && stored.env.PORT === '43117')
check('未出现在补丁里的键保持原值', stored.env.KEEP === 'keep', JSON.stringify(stored.env))
check('编辑回执仍不泄露其他值', !JSON.stringify(patched).includes('never-render-this'))
```

再验证端口修复只发送 `{ env: { PORT: String(port) } }`。同步修改 `verify-m12-port-config.cjs` 中三处旧读取：manual 的 `item.env.MILE_TEST_*`、next 的 `item.env.PORT`、vite 的 `vite.env.PORT` 都不能继续访问公开 DTO。持久化改读沙箱 `CONFIG`，公开回执另验 envKeys 与秘密值；使用现有 `SECRET`、`MANUAL_PORT`、`NEXT_PORT`，不要写死新端口：

```js
const readStoredEntry = (id) => JSON.parse(readFileSync(CONFIG, 'utf8'))
  .entries.find((entry) => entry.id === id)

const savedManual = await waitFor('manual environment persistence', async () => {
  const listed = await js(`window.mile.entry.list()`)
  const publicEntry = listed.find((entry) => entry.id === 'manual')
  const stored = readStoredEntry('manual')
  const persisted = stored?.env?.MILE_TEST_PORT === String(MANUAL_PORT) &&
    stored?.env?.MILE_TEST_SECRET === SECRET
  return persisted ? { listed, publicEntry } : null
})
check('edited environment persists on disk', Boolean(savedManual))
check('manual DTO exposes keys but neither env nor secret',
  savedManual && Array.isArray(savedManual.publicEntry.envKeys) &&
  savedManual.publicEntry.envKeys.includes('MILE_TEST_SECRET') &&
  !('env' in savedManual.publicEntry) && !JSON.stringify(savedManual.listed).includes(SECRET),
  JSON.stringify(savedManual))

const nextEntry = await waitFor('Next port fix persistence', async () => {
  const listed = await js(`window.mile.entry.list()`)
  const publicEntry = listed.find((entry) => entry.id === 'next')
  const stored = readStoredEntry('next')
  const persisted = publicEntry?.expectedPort === NEXT_PORT && stored?.env?.PORT === String(NEXT_PORT)
  return persisted ? { listed, publicEntry } : null
})
check('Next repair updates expectedPort and stored PORT together', Boolean(nextEntry))
check('Next DTO exposes PORT key without env values',
  nextEntry && Array.isArray(nextEntry.publicEntry.envKeys) &&
  nextEntry.publicEntry.envKeys.includes('PORT') && !('env' in nextEntry.publicEntry),
  JSON.stringify(nextEntry))

const vite = await js(`window.mile.entry.list().then(entries => entries.find(entry => entry.id === 'vite'))`)
const viteStored = readStoredEntry('vite')
check('manual guidance leaves bookkeeping and stored env unchanged',
  vite.expectedPort === BLOCKER_PORT && viteStored.env.PORT === undefined && !('env' in vite),
  JSON.stringify({ vite, viteStored }))
```

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-ipc.cjs`

Expected: 当前 DTO 含完整 env 和秘密值；null 删除补丁因类型/校形不被正确支持。

- [ ] **Step 3: 引入 StoredLaunchEntry 与 LaunchEntry DTO**

保留当前 LaunchEntry 的展示字段，但把 `env` 改为 `envKeys: string[]`。主进程存储类型、写侧输入和公开 DTO 按下面定义，避免 `EntryEdit` 在公开类型删掉 env 后失去字段来源：

```ts
export interface StoredLaunchEntry extends Omit<LaunchEntry, 'envKeys'> {
  env: Record<string, string>
}
export type NewLaunchEntry = Omit<StoredLaunchEntry, 'id' | 'order' | 'createdAt'> &
  Partial<Pick<StoredLaunchEntry, 'pinned' | 'registerOnly'>>
export type EnvPatch = Record<string, string | null>
export function toPublicEntry(entry: StoredLaunchEntry): LaunchEntry {
  const { env, ...rest } = entry
  return { ...rest, envKeys: Object.keys(env).sort() }
}

export type EntryEdit = Partial<
  Omit<
    Pick<StoredLaunchEntry, EditableEntryField>,
    'expectedPort' | 'outputDir' | 'icon' | 'imageId' | 'category' | 'groupId' |
      'launchMode' | 'jarPath' | 'env'
  >
> & {
  env?: EnvPatch
  expectedPort?: number | null
  outputDir?: string | null
  icon?: ServiceIcon | null
  imageId?: null
  category?: string | null
  groupId?: string | null
  launchMode?: LaunchMode | null
  jarPath?: string | null
}
```

`AppConfig.entries`、EntryService 内部、PrecheckService 的所有条目参数和 NewLaunchEntry 使用 StoredLaunchEntry；Task 4 的 `draft` / `candidate` / `entry`、`configuredOutputDir`、`sanitizeEdit` 的 target/返回值也同步迁移，不能把 StoredLaunchEntry 强塞给仍要求公开 LaunchEntry 的函数。公开 LaunchEntry 只跨 IPC 使用，preload 的条目类型不变。

主进程 index 在所有出口集中映射，EntryService 的 changed 事件仍只携带主进程内部类型：

```ts
handle(Channels.entryList, () => entries.list().map(toPublicEntry))
handle(Channels.entryAdd, async (_e, input: NewLaunchEntry) =>
  toPublicEntry(await entries.add(input))
)
handle(Channels.entryEdit, async (_e, id: string, patch: EntryEdit) =>
  toPublicEntry(await entries.edit(id, patch))
)
handle(Channels.entryReorder, (_e, ids: string[]) => entries.reorder(ids).map(toPublicEntry))
handle(Channels.entryClearImage, (_e, id: unknown) => {
  if (typeof id !== 'string') throw new Error('条目 id 非法')
  return toPublicEntry(entries.clearImage(id))
})
entries.on('changed', (list: StoredLaunchEntry[]) =>
  mainWindow?.webContents.send(Channels.entryChanged, list.map(toPublicEntry))
)
```

这里的 `handle` 是 Task 3 已建立的可信 sender 包装器。不要把映射散落到渲染层，也不要让完整 env 经其他条目回执返回。

`sanitizeEdit` 合并而非回读下发：

```ts
const nextEnv = { ...target.env }
for (const [key, value] of Object.entries(env)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名非法：${key}`)
  if (value === null) delete nextEnv[key]
  else if (typeof value === 'string') nextEnv[key] = value
  else throw new Error(`环境变量 ${key} 的值必须是字符串或 null`)
}
out.env = nextEnv
```

编辑器已有行初始化为 `{ originalKey: key, key, value: '', dirty: false }`，占位符写“保持不变；输入以覆盖”。保存时：删除的 originalKey 发送 null；改名发送旧键 null + 新键值；只有 dirty 或新增行发送值；未编辑行不得发送空串。`nextEnvRowId` 改用 `entry.envKeys.length`。`useEntryFix` 删除 `{ ...entry.env }` 展开，仅发送 PORT 补丁。

- [ ] **Step 4: 重跑 DTO、编辑器与端口修复验证**

Run: `npm run build; npx electron scripts/verify-review-ipc.cjs; npx electron scripts/verify-m8.cjs; npx electron scripts/verify-m11-add.cjs; npx electron scripts/verify-m12-port-config.cjs; npx electron scripts/verify-springboot.cjs`

Expected: 任何条目 IPC/广播序列化结果都不含秘密值；编辑器未触碰的旧值不被清空；删除、覆盖、新增和 PORT 修复均落盘正确；所有 harness 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/shared/types.ts src/main/services/EntryService.ts src/main/services/PrecheckService.ts src/main/index.ts src/preload/index.ts src/renderer/src/components/EditEntryDialog.tsx src/renderer/src/lib/useEntryFix.tsx scripts/verify-review-ipc.cjs scripts/verify-m12-port-config.cjs
git commit -m "fix(security): keep environment values in main process" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 6: 用 OS 创建标识和 sessionId 收口终止授权

**Files:**
- Modify: `src/main/lib/winProcess.ts`
- Modify: `src/main/services/OwnershipService.ts`
- Modify: `src/main/services/ScannerService.ts:86-96`
- Modify: `src/main/services/SessionService.ts:150-221`
- Modify: `src/main/services/EntryService.ts:1424-1439`
- Test: `scripts/verify-review-ownership.cjs`

- [ ] **Step 1: 写合成进程表负向用例**

用项目已有 `typescript` 依赖的 `transpileModule` 在临时目录加载 OwnershipService，不新增测试框架。构造 root=100、child=101：

```js
ownership.register('s1', 100, 'token')
ownership.bindIdentity('s1', 1000)
const table = makeTable([
  { pid: 100, ppid: 4, startedAt: 1000 },
  { pid: 101, ppid: 100, startedAt: 1100 }
])
assert.equal(ownership.verify(101, table).ownership, 'owned')
assert.equal(ownership.verify(101, table).sessionId, 's1')
const reused = makeTable([{ pid: 100, ppid: 4, startedAt: 2000 }])
assert.notEqual(ownership.verify(100, reused).ownership, 'owned')
await assert.rejects(ownership.assertKillable(100, table, 'other-session'), /会话不匹配/)
await assert.rejects(ownership.assertKillable(100, makeTable([]), 's1'), /创建时间|进程不存在/)
```

另加祖先进程用例，证明比较的是命中根 `cursor` 的 CreationDate，同时检查目标 child 不可能早于祖先；不得用真实 PID 复用字样描述这些合成用例。

- [ ] **Step 2: 运行并确认红**

Run: `node scripts/verify-review-ownership.cjs`

Expected: 当前没有 `bindIdentity`，sessionId 参数也不存在； reused/missing identity/会话不匹配中至少有明确 FAIL，而不是测试加载失败后记成通过。

- [ ] **Step 3: 实现创建时间绑定、强制刷新与 fail-closed**

在 winProcess 增加 `readProcessStartedAt(pid)`，先校验 PID 为正整数，再用常量 PowerShell 模板查询该 PID 的 CreationDate 并返回 Unix ms；查询不到或超时抛错。SessionService 注册后为每个会话保存同一个身份 Promise，避免“进程刚启动就停止”绕过绑定：

```ts
private identityReady = new Map<string, Promise<void>>()

private trackIdentity(id: string, pid: number): void {
  const ready = readProcessStartedAt(pid).then((startedAt) => {
    const entry = this.entries.get(id)
    if (!entry || entry.meta.pid !== pid) throw new Error('会话身份已变化')
    this.ownership.bindIdentity(id, startedAt)
  })
  this.identityReady.set(id, ready)
  void ready.catch(() => undefined) // kill/disposeAll 会 await 原 Promise；这里只防提前 unhandled rejection
}
```

`kill` 和 `disposeAll` 不得直接 `await this.identityReady.get(id)`——map 缺值时这会等价于 `await undefined` 并错误放行。统一经过显式 fail-closed helper：

```ts
private async awaitIdentity(id: string): Promise<void> {
  const ready = this.identityReady.get(id)
  if (!ready) throw new Error('会话身份尚未登记，拒绝终止')
  await ready
}
```

身份读取失败时拒绝终止并保留会话/ownership 登记；进程自然退出后才清理 Promise 与登记。`Tracked.startedAt` 初始为 null；`findOwningRoot` 必须同时取得目标行、命中根行和已绑定创建时间，根行时间必须等于绑定值，目标时间不得早于根时间，任一缺失即不判 owned。删除 60 秒容差。

`assertKillable(pid, table, sessionId)` 先明确区分“进程不存在/创建时间缺失”，再沿用 `verify` 的根进程绑定结果核对 sessionId，保证空表负向用例是因为目标原因失败：

```ts
const row = table.byPid.get(pid)
if (!row || typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt)) {
  throw new Error('进程不存在或创建时间缺失，拒绝终止')
}
const verdict = this.verify(pid, table)
if (verdict.ownership !== 'owned') {
  throw new Error(`拒绝终止 PID ${pid}：归属判定为 ${verdict.ownership}，非本应用启动`)
}
if (verdict.sessionId !== sessionId) throw new Error('会话不匹配，拒绝终止')
return verdict
```

`verify` 内部仍沿父链找到 tracked root，并校验该根的 CreationDate；不要新增“tracked.rootPid 必须等于目标 pid”的限制，否则受管子进程会被误拒。`ScannerService.table(hintPids = [], force = false)` 在 force 时无条件重新 `readProcessMeta()`；SessionService 的 taskkill 前使用 `table([pid], true)` 并传当前 sessionId。EntryService.stop 也不能留在旧签名：

```ts
const table = await this.scanner.table([runtime.pid], true)
await this.ownership.assertKillable(runtime.pid, table, runtime.sessionId)
```

scanner 未注入、身份未绑定、表读取失败或校验失败都不得终止。`doKill` 失败时保留 ownership 和会话登记并发出 warning，只有进程退出或本次终止已发出后才 unregister；不得把“拒绝 kill”变成“遗忘仍存活进程”。

- [ ] **Step 4: 重跑合成负向用例和真实会话回归**

Run: `node scripts/verify-review-ownership.cjs; npm run build; npx electron scripts/verify-m5.cjs; npx electron scripts/verify-m8.cjs; npx electron scripts/verify-m9.cjs`

Expected: 合成用例全部 PASS；真实正常启动/停止仍可完成；外部进程仍不可杀；没有因 scanner 暂不可用而绕过校验。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/main/lib/winProcess.ts src/main/services/OwnershipService.ts src/main/services/ScannerService.ts src/main/services/SessionService.ts src/main/services/EntryService.ts scripts/verify-review-ownership.cjs
git commit -m "fix(security): bind kill authorization to process identity" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 7: 为条目操作建立代次与 sessionId 双重屏障

**Files:**
- Modify: `src/main/services/EntryService.ts`
- Modify: `src/renderer/src/views/BackendConsole.tsx`
- Test: `scripts/verify-review-entry-races.cjs`

- [ ] **Step 1: 写启动中删除、重复启动和运行中第二个会话的失败用例**

使用只运行夹具代码的长期 `hold` 与短期 `build`：

```js
const starting = js(`window.mile.entry.start('race').then(
  r => ({ ok: true, result: r }), e => ({ ok: false, error: String(e) }))`)
const removing = js(`window.mile.entry.remove('race').then(
  () => ({ ok: true }), e => ({ ok: false, error: String(e) }))`)
const [started, removed] = await Promise.all([starting, removing])
const sessions = await js(`window.mile.session.list()`)
check('删除使在途 start 失效，不留下无条目会话',
  sessions.filter(s => s.projectId === 'race').length === 0, JSON.stringify({ started, removed, sessions }))
```

再分别执行重复 start 与“运行中 runScript(build)”：重复 start 用 `Promise.allSettled` 收集两个结果，先确认调用前没有 live session，再断言最终恰好一个 session、至少一个调用成功，所有拒绝都属于过期代次；已有 live session 后再次 start 则必须成功返回同一个 `runtime.sessionId`，不新增会话。运行中 runScript(build) 必须明确拒绝且 session 数与 runtime.sessionId 不变。重启后构造旧 session exit，要求旧事件不改变新 runtime。每个负向用例先确认夹具确有 session，防止因启动失败而假绿。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-entry-races.cjs`

Expected: 当前删除后仍可能创建会话，重复操作可生成多个 session，运行中第二个脚本覆盖 runtime.sessionId。记录实际会话数和错误，不用“可能发生”代替测量。

- [ ] **Step 3: 实现统一 operation generation**

```ts
private operations = new Map<string, number>()
private beginOperation(id: string): number {
  const generation = (this.operations.get(id) ?? 0) + 1
  this.operations.set(id, generation)
  return generation
}
private currentOperation(id: string): number {
  return this.operations.get(id) ?? 0
}
private assertCurrent(id: string, generation: number): void {
  if (this.operations.get(id) !== generation || !this.get(id)) {
    throw new Error('操作已被更新，丢弃过期结果')
  }
}
```

`start` 先检查已有 live runtime：有 sessionId 时保持现有幂等语义，直接返回该 runtime，不自增代次、不创建第二个会话；没有 live session 时才 `beginOperation`。并发 start 都由代次收口，最终只能保留当前代次创建的一个会话。install/mavenRun/packageWithProfile/runScript 在已有 live session 时统一拒绝“该条目已有运行中的会话，请先停止”。

`stop` 只读取 `currentOperation(id)` 并捕获当前 sessionId，**不自增代次**，否则本次正常 stop 后，当前 watch 的 exit 会被自己的新代次误判为旧事件。stop 的异步回写同时核对捕获代次与 sessionId。`restart` / `remove` 各调用一次 `beginOperation`，随后把同一 generation 传给内部 stop/start；remove 不得调用会再次自增或改变事件语义的公开 stop。

其余 start/install/mavenRun/packageWithProfile/runScript 公开入口各取一次 generation。所有 precheck、目录读取、构建枚举和 listJars await 后调用 `assertCurrent`。新 session 创建后再次复核；若已过期，先按新 sessionId 走安全终止，再丢弃结果。

在现有 watch 记录中增加 `generation`，创建会话时写入本次代次。onSessionExit、absorb、onCaptureTimeout 先按事件 sessionId 找 watch，再同时满足 `watch.generation === this.operations.get(watch.entryId)` 与 `runtime.sessionId === event.id` 才允许更新；package 的异步 listJars 回调则闭包捕获 generation 并复核。正常 stop 因未自增代次仍能接收 exit；restart/remove 的旧 watch 则已失效。

remove 停止失败时保留条目、会话和 ownership 追踪，不删除后遗忘进程；若同一 runtime.sessionId 仍需保留，把该 watch 的 generation 调整为 remove 的当前代次，使后续真实 exit 不被永久丢弃，同时旧 generation 的在途启动/构建仍然失效。后端按钮同步使用 live 状态禁用第二会话操作并显示原因；start 的幂等返回不显示错误。

- [ ] **Step 4: 重跑竞态与现有启停回归**

Run: `npm run build; npx electron scripts/verify-review-entry-races.cjs; npx electron scripts/verify-m5.cjs; npx electron scripts/verify-m8.cjs; npx electron scripts/verify-springboot.cjs`

Expected: 过期启动不留下会话；并发 start 最终只有一个 session，已有 live 的 start 返回同一 sessionId；运行中第二会话操作明确拒绝；旧 exit 不污染新 runtime；正常 stop 的 exit 仍更新状态，stop/restart/build 回归 0 FAIL。随后做一次仅还原 generation 检查的反向对照，确认目标三条变红，再恢复并 rebuild。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/main/services/EntryService.ts src/renderer/src/views/BackendConsole.tsx scripts/verify-review-entry-races.cjs
git commit -m "fix(entries): reject stale lifecycle operations" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 8: 让 Scanner 失败快照可发布，收口异步 rejection

**Files:**
- Modify: `src/main/services/ScannerService.ts:90-176` 及所有 `void this.tick()` 调用点
- Modify: `src/main/index.ts`
- Test: `scripts/verify-review-scanner.cjs`

- [ ] **Step 1: 写受控采集失败用例**

在 require 主进程前用 Module `_load` Proxy 包装 `node:child_process.execFile`，只对 PowerShell/pwsh 返回受控错误，netstat 与其他进程调用仍走真实实现。记录 `unhandledRejection`：

```js
const failed = await waitUntil(async () => {
  const snapshot = await js(`window.mile.scanner.snapshot()`)
  return snapshot?.failed ? snapshot : null
}, 20_000)
check('采集失败发布 failed 快照', !!failed, JSON.stringify(failed))
check('失败保留 lastSuccessAt 语义', failed && 'lastSuccessAt' in failed)
check('没有未处理 rejection', rejections.length === 0, rejections.join('\n'))
```

等待必须轮询；首个失败快照出现时 `listeners` 可为空，但不能因此跳过 failed/lastSuccessAt 断言。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-scanner.cjs`

Expected: 当前特殊 `error` 事件使 `publishFailure` 不可达，failed 等待超时，并记录到 rejection 或主进程错误。测试失败必须来自这些目标，不得把 Electron 提前退出当作通过。

- [ ] **Step 3: 改非特殊事件并统一调度收口**

tick 不再自行 `emit('error')` 或 `publishFailure()`；它只保留采集 try/finally，并在 finally 复位 `running`。所有失败由统一调度入口发布一次，index 订阅非特殊 `scanError` 事件只写主进程日志：

```ts
private runTick(after?: () => void): void {
  void this.tick()
    .catch((err: unknown) => {
      this.publishFailure()
      this.emit('scanError', err)
    })
    .finally(() => after?.())
}
```

start、setVisible、refresh、ignore、hideOnce、setGroup、setWatchedKeywords 与定时器都调用 runTick，禁止裸 `void this.tick()`；tick 与 runTick 不得重复发布同一失败。

- [ ] **Step 4: 重跑失败与恢复验证**

Run: `npm run build; npx electron scripts/verify-review-scanner.cjs; npx electron scripts/verify-m9.cjs; npx electron scripts/verify-m11-dual.cjs`

Expected: failed=true 在超时可量，lastSuccessAt 不被失败覆盖，rejection 数为 0；撤掉 PowerShell 故障后下一次成功采集恢复 failed=false；双 PID 同端口回归 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/main/services/ScannerService.ts src/main/index.ts scripts/verify-review-scanner.cjs
git commit -m "fix(scanner): publish failures without unhandled rejections" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 9: 保留良好备份，并让退出清理可等待

**Files:**
- Modify: `src/main/services/ConfigStore.ts`
- Modify: `src/main/services/SessionService.ts:161-221`
- Modify: `src/main/index.ts:421-425`
- Modify: `scripts/verify-m9-recover.cjs`
- Test: `scripts/verify-review-quit.cjs`

- [ ] **Step 1: 写备份字节不变与退出后进程不存在的失败用例**

m9-recover 在构造主进程前记录：

```js
const backupBefore = readFileSync(BAK, 'utf8')
// 主进程恢复并完成迁移后：
check('恢复不覆盖唯一良好 .bak', readFileSync(BAK, 'utf8') === backupBefore)
```

新增父/子式 quit harness：子 Electron 在沙箱中启动夹具 hold，取得真实根 PID 后 `app.quit()`；父进程等待子进程退出，再用 `tasklist.exe /FI "PID eq <pid>" /FO CSV /NH` 验证 PID 消失。finally 中只允许清理本 harness 创建的夹具 PID，不得按端口杀进程。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-m9-recover.cjs; node scripts/verify-review-quit.cjs`

Expected: 当前恢复后的 `.bak` 变成坏主文件，字节比较失败；quit 后夹具仍可查询或清理未等待的记录不符合预期。若进程因 ConPTY 自身行为已退出，必须另以 disposeAll 完成回执证明新实现确实被等待，不能据此宣称开关原已有效。

- [ ] **Step 3: 给恢复写回加 skipBackup，并等待任务树终止**

ConfigStore：

```ts
private persist(options: { skipBackup?: boolean } = {}): void {
  if (!options.skipBackup && existsSync(this.file)) copyFileSync(this.file, this.backup)
  // 保留现有临时文件 + rename 原子写
}
```

仅“从良好 backup 恢复后的第一次写回”使用 `{ skipBackup: true }`，正常 patch 仍轮转 `.bak`。

`SessionService.kill` 返回 Promise；taskkill 用 execFile 数组形式、timeout 和回调 Promise 等待，失败后回退 pty.kill。`disposeAll(): Promise<void>` 对当前 ids `Promise.allSettled`，检查每个结果；任一 rejected 就保留未清理会话并抛错，不提前 clear entries。before-quit 在开关开启且尚未清理时 preventDefault，只启动一次 disposeAll；全部成功后设置 `cleanupDone=true` 并再次 `app.quit()`，第二次事件不得再次 prevent。清理失败则记录错误、显示本地通知、复位 `quitting/cleanupStarted` 让用户可重试，不能带着存活进程继续退出。开关关闭保持原行为，不新增锁或设置。

- [ ] **Step 4: 重跑恢复、正常配置写入与退出验证**

Run: `npm run build; npx electron scripts/verify-m9-recover.cjs; npx electron scripts/verify-m9.cjs; node scripts/verify-review-quit.cjs`

Expected: 恢复后 `.bak` 字节不变、主文件已迁移、后续正常 patch 仍能创建新备份；quit harness 等到 disposeAll 回执且夹具 PID 消失；所有清理失败都计入结果而不被 catch 吞掉。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/main/services/ConfigStore.ts src/main/services/SessionService.ts src/main/index.ts scripts/verify-m9-recover.cjs scripts/verify-review-quit.cjs
git commit -m "fix(lifecycle): preserve backups and await quit cleanup" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 10: 修复工作组校形、排序与删除后的跨 store 同步

**Files:**
- Modify: `src/main/services/GroupService.ts`
- Modify: `src/main/services/EntryService.ts`
- Modify: `src/main/index.ts:278-300`
- Test: `scripts/verify-review-groups.cjs`

- [ ] **Step 1: 写重复 id、非有限 order 与删除广播失败用例**

```js
const initialGroups = await js(`window.mile.group.list()`)
check('测试前提：恰有 a/b 两个工作组', initialGroups.length === 2, JSON.stringify(initialGroups))
const initialEntries = await js(`window.mile.entry.list()`)
check('测试前提：确有属于 a 的条目',
  initialEntries.length > 0 && initialEntries.some(e => e.groupId === a), JSON.stringify(initialEntries))
const reorderResult = await js(`window.mile.group.reorder(['${a}', '${a}', '${b}']).then(
  () => ({ ok: true }), e => ({ ok: false, error: String(e) }))`)
const afterReorder = await js(`window.mile.group.list()`)
check('reorder 因重复 id 拒绝且列表不变',
  !reorderResult.ok && /重复|恰好|未知/.test(reorderResult.error) &&
  afterReorder.length === initialGroups.length &&
  new Set(afterReorder.map(g => g.id)).size === afterReorder.length,
  JSON.stringify({ reorderResult, afterReorder }))

const orderBefore = afterReorder.find(g => g.id === a).order
const orderResults = []
for (const expression of ['Number.NaN', 'Number.POSITIVE_INFINITY']) {
  orderResults.push(await js(`window.mile.group.patch('${a}', { order: ${expression} }).then(
    () => ({ ok: true }), e => ({ ok: false, error: String(e) }))`))
}
const afterOrder = await js(`window.mile.group.list()`)
const diskAfterOrder = JSON.parse(readFileSync(CONFIG, 'utf8'))
check('NaN/Infinity 因有限数字校形被拒绝且不落盘',
  orderResults.length === 2 && orderResults.every(r => !r.ok && /有限数字/.test(r.error)) &&
  afterOrder.find(g => g.id === a).order === orderBefore &&
  diskAfterOrder.groups.find(g => g.id === a).order === orderBefore,
  JSON.stringify({ orderResults, orderBefore, afterOrder }))

await js(`window.__groupReviewChanges = [];
  window.__groupReviewOff = window.mile.entry.onChange(list => window.__groupReviewChanges.push(list))`)
const removeResult = await js(`window.mile.group.remove('${a}').then(
  () => ({ ok: true }), e => ({ ok: false, error: String(e) }))`)
const afterGroups = await js(`window.mile.group.list()`)
const diskAfterRemove = JSON.parse(readFileSync(CONFIG, 'utf8'))
check('删除 IPC 成功，配置中的组与条目 groupId 均更新',
  removeResult.ok && !afterGroups.some(g => g.id === a) &&
  diskAfterRemove.entries.length === initialEntries.length &&
  diskAfterRemove.entries.every(e => e.groupId !== a),
  JSON.stringify({ removeResult, afterGroups, diskAfterRemove }))
const broadcasts = await waitUntil(async () => {
  const value = await js(`window.__groupReviewChanges`)
  return value.length > 0 ? value : null
}, 2000)
const lastBroadcast = broadcasts?.at(-1)
check('删除后广播非空条目 DTO，渲染层可同步清空 groupId',
  Array.isArray(lastBroadcast) && lastBroadcast.length === initialEntries.length &&
  lastBroadcast.length > 0 && lastBroadcast.every(e => e.groupId !== a),
  JSON.stringify(broadcasts))
await js(`window.__groupReviewOff(); window.__groupReviewChanges = []`)
```

断言必须同时检查 IPC 回执、沙箱配置和真实 `entry:changed`；不能只重新调用 `entry.list()`，因为主进程配置在修复前就已清除 groupId，缺陷是渲染层没有收到广播。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-groups.cjs`

Expected: 重复 id 被写入；NaN 被接受；删除后渲染层 entries 仍持旧 groupId。控制字符正则问题由静态检查单独报出，不把乱码当成测试通过。

- [ ] **Step 3: 清理控制字符并修服务与事件**

先用 Node 字节读写仅把 `validateGroupDesc` 中真实控制字符范围改为可见源码 `/[\x00-\x1f\x7f]/`，保持 UTF-8 无 BOM 与 LF。随后：

```ts
if ('order' in patch) {
  if (typeof patch.order !== 'number' || !Number.isFinite(patch.order)) {
    throw new Error('工作组排序必须是有限数字')
  }
  out.order = Math.max(0, Math.trunc(patch.order))
}
```

reorder 要求 ids 为字符串数组，`new Set(ids).size === ids.length`，未知 id 抛错，所有现有组必须恰好出现一次；重复时抛 `工作组 id 重复`，缺项/多项时抛 `工作组列表必须恰好包含所有现有工作组各一次`，不再用“未传入自动追加”掩盖缺项。remove 在 config.patch 后同时发出 groups changed 与 entries changed；由 index 将 EntryService 的公开 DTO 广播复用到该路径，避免另造一套 env 映射。EntryService 提供 `emitChanged()` 仅广播当前列表，不重复写盘。

- [ ] **Step 4: 重跑工作组与 env 泄露回归**

Run: `npm run build; npx electron scripts/verify-review-groups.cjs; npx electron scripts/verify-review-ipc.cjs`

Expected: 非有限 order 和重复/缺失 id 均拒绝且不落盘；合法 reorder 顺序唯一；删除后两组 store 同步；条目广播仍无 env 值；源码无真实 NUL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/main/services/GroupService.ts src/main/services/EntryService.ts src/main/index.ts scripts/verify-review-groups.cjs
git commit -m "fix(groups): validate ordering and broadcast entry changes" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 11: 修复后端响应式订阅、jar 编辑结果与工作组动作闭环

**Files:**
- Modify: `src/renderer/src/views/BackendConsole.tsx`
- Modify: `src/renderer/src/views/Workgroups.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/lib/useEntryFix.tsx`
- Test: `scripts/verify-review-backend-workgroups.cjs`

- [ ] **Step 1: 写状态更新、编辑失败和动作失败用例**

用真实 runtime 广播改变 running/sessionId/lastBuiltJar，断言 ProjectItem/ConsolePanel 文本在同一次轮询内更新，且先存在对应 DOM。通过 Module `_load` 或受控配置让 edit 返回失败，点击“使用最近构建 jar”，要求不调用 start 且错误仍可见。工作组分别点击日志、诊断、被预检阻止的启动，要求打开正确 session、正确条目诊断页；再确认空 onPin 不再截走 onLogs。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-backend-workgroups.cjs`

Expected: 稳定 getter 场景 DOM 不更新；jar 编辑失败仍启动；工作组日志无响应，诊断不跳转，预检结果被丢弃。每条输出附当前 view、entryId、sessionId 和调用计数。

- [ ] **Step 3: 直接订阅数据并检查 boolean**

BackendConsole：

```ts
const runtimeValue = useEntries((s) => s.runtimes[entry.id])
const runtime = runtimeValue ?? runtimeOf(entry.id)
const group = useGroups((s) => s.groups.find((g) => g.id === entry.groupId))
```

把 runtime/group 作为 props 传给 ConsolePanel，不再用 useShallow 订阅稳定 getter 代替数据订阅。

jar 按钮：

```ts
clearError()
const ok = await edit(entry.id, {
  jarPath: runtime.lastBuiltJar ?? null,
  launchMode: 'jar'
})
if (ok) await handleStart()
```

ScriptPicker 的 onPick 回调必须显式写成 async，并使用同一个 boolean 契约；不要只复制 await 到非 async 回调里：

```tsx
onPick={async (script) => {
  const ok = await edit(target, { script, registerOnly: false })
  if (ok) onAfterFix(target)
}}
```

Workgroups 删除空 onPin；`onDiagnose` 调用 App 传入的 `openDiagnose(entry.id)`；onStart 检查 `const precheck = await start(entry.id)`，非 null 时 `openDiagnose(entry.id)`。App 的 openDiagnose 只做 `setDiagnoseId(id); setView('diagnose')`，复用现有 Diagnose 收集，不重复请求 precheck 后丢弃。

- [ ] **Step 4: 重跑后端与工作组回归**

Run: `npm run build; npx electron scripts/verify-review-backend-workgroups.cjs; npx electron scripts/verify-springboot.cjs`

Expected: 状态广播驱动 DOM；编辑失败不启动、不清错误；日志进入原 session，诊断目标 id 正确；成功启动不强制跳诊断；全部 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/renderer/src/views/BackendConsole.tsx src/renderer/src/views/Workgroups.tsx src/renderer/src/App.tsx src/renderer/src/lib/useEntryFix.tsx scripts/verify-review-backend-workgroups.cjs
git commit -m "fix(renderer): close backend and workgroup action flows" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 12: 给添加条目、日志、诊断和终端流建立顺序屏障

**Files:**
- Modify: `src/shared/types.ts:32-40`
- Modify: `src/main/services/SessionService.ts:13-24,105-144`
- Modify: `src/main/index.ts` 的 log.clear 注册
- Modify: `src/preload/index.ts:35,103-105`
- Modify: `src/renderer/src/components/AddEntryDialog.tsx`
- Modify: `src/renderer/src/components/TerminalView.tsx:99-130`
- Modify: `src/renderer/src/views/LogCenter.tsx:28-52,145-150`
- Modify: `src/renderer/src/views/Diagnose.tsx:28-56`
- Test: `scripts/verify-review-async.cjs`

- [ ] **Step 1: 写可控慢响应与重复流失败用例**

通过 IPC 响应探针延迟旧 detect/log query/diagnose，再触发新请求，要求旧响应不能覆盖新状态。AddEntryDialog 在 A 请求未完成时选择 B，最终 detected.path、name/script 必须属于 B；提交时 path 与 detected.path 不一致必须拒绝；双击提交只产生一个条目。

Terminal 先订阅实时事件，再请求历史；主进程给每块 flush 数据分配 rev。断言同一 rev 只写一次、历史之后只回放 `rev > history.rev` 的缓冲，卸载后 Promise 不写 term。LogCenter clear 必须等待主进程完成后再 load，清空前的旧 query 不得复活旧结果。Diagnose 保留现有 report.entryId 门槛，并额外断言旧请求不能改 loading/failure。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-async.cjs`

Expected: A 的慢识别可覆盖 B；重复点击产生重复 add；历史+pending 可重复写；旧日志/诊断响应可覆盖新状态。探针必须证明 A/B 都真实返回，未返回不算竞态验证成功。

- [ ] **Step 3: 实现 generation、clear 回执与 history rev**

AddEntryDialog 使用 `detectGeneration` 与同步 `submittingRef`；`submitting` state 只负责显示/禁用，不能作为双击锁，因为同一渲染周期的第二次点击可能仍读到 false。补上新 state/ref、规范路径回写和自动名称归属：

```ts
const detectGeneration = useRef(0)
const submittingRef = useRef(false)
const mountedRef = useRef(true)
const nameDirtyRef = useRef(Boolean(initialName))
const [submitting, setSubmitting] = useState(false)
useEffect(() => {
  mountedRef.current = true
  return () => {
    mountedRef.current = false
    detectGeneration.current += 1
  }
}, [])

const generation = ++detectGeneration.current
setDetected(null)
const result = await window.mile.entry.detect(target)
if (generation !== detectGeneration.current) return
setDetected(result)
setPath(result.path) // 后续 submit 比较的是主进程返回的同一规范路径
if (!nameDirtyRef.current) setName(result.name)

// 现有 submit 在校形后、任何 await 之前同步上锁：
if (submittingRef.current || detected?.path !== path || !name.trim()) return
submittingRef.current = true
setSubmitting(true)
```

选择新目录时在调用 detect 前执行 `nameDirtyRef.current = false; setName('')`，避免 A 的自动名称带到 B；名称输入的 onChange 同步执行 `nameDirtyRef.current = true` 后再 setName，保留用户主动命名。detect 的 catch/finally 也只允许当前代次写 error/detecting，旧 A 的失败不能覆盖新 B 的结果。

为现有 submit 增加统一的 try/catch/finally，覆盖可启动与仅登记两个 onSubmit 分支：onSubmit 成功后才 onClose，异常写入对话框 error，finally 同步解锁并避免卸载后 setState：

```ts
finally {
  submittingRef.current = false
  if (mountedRef.current) setSubmitting(false)
}
```

失败用例要在 React 重渲染前连续触发两次真实提交，并确认两次点击都进入事件路径、最终只新增一个条目；仅检查按钮后来变成 disabled 不算通过。

扩展现有 `SessionDataEvent`，不要重复声明同名接口；新增历史返回类型：

```ts
export interface SessionDataEvent { id: string; chunk: string; rev: number }
export interface SessionHistory { text: string; rev: number }
```

SessionService 每个 Entry 从 rev=0 开始，flush 时 `rev += 1` 并随 data 发出；history 先 flush pending，再返回 `{ text: entry.buffer, rev: entry.rev }`，会话不存在时返回 `{ text: '', rev: 0 }`。TerminalView 先订阅并缓冲，历史写入后仅回放更大 rev；`historyReady` 之前不直接写实时块，之后只写 rev 更大的新块，清理时设置 disposed 并退订。

LogCenter 用 `queryGeneration.current` 只接收最新响应；`log.clear` 从 send 改为 invoke，preload 返回 `Promise<void>`，主进程清空完成后才 resolve。清空按钮先递增 query generation，再 `await clear(); await load()`。Diagnose 用同一 generation 模式包裹 report/failure/loading 的每个写入，卸载时失效。

- [ ] **Step 4: 重跑顺序与现有终端/日志回归**

Run: `npm run build; npx electron scripts/verify-review-async.cjs; npx electron scripts/verify-m10.cjs; npx electron scripts/verify-m11-add.cjs`

Expected: 只有最新 detect/query/diagnose 能落地；提交一次只有一条；终端无重复 rev 且无历史后旧块丢失；清空结果不被旧请求复活；现有 harness 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/shared/types.ts src/main/services/SessionService.ts src/main/index.ts src/preload/index.ts src/renderer/src/components/AddEntryDialog.tsx src/renderer/src/components/TerminalView.tsx src/renderer/src/views/LogCenter.tsx src/renderer/src/views/Diagnose.tsx scripts/verify-review-async.cjs
git commit -m "fix(renderer): serialize async views and terminal history" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 13: 修复停止按钮与四处零散交互断点

**Files:**
- Modify: `src/renderer/src/components/MyServicesPanel.tsx`
- Modify: `src/renderer/src/App.tsx` 的 QuickActions 回调
- Modify: `src/renderer/src/views/About.tsx`
- Modify: `src/renderer/src/store/scanner.ts`
- Modify: `src/renderer/src/components/ScriptPickerDialog.tsx`
- Modify: `src/renderer/src/components/DiscoveredListeners.tsx:60-65`
- Test: `scripts/verify-review-interactions.cjs`

- [ ] **Step 1: 写五个动作的真实 DOM 用例**

断言：busy 状态仍能看到一个“停止”且没有“强制关闭”；Dashboard 点击添加服务后 view=launchpad 且对话框出现；About 点击项目地址不触发 window.open，复制成功或显示可手动选择地址；同端口、不同 processName 的两个 PID 中 ignore 一个后另一个仍在本地 unmanaged；ScriptPicker 在 entry.script 已失效时默认选中 names[0]，提交不能发送失效脚本。持久忽略仍按 processName+port 生效，因此同端口且同 processName 的另一个 PID 不用于证明本地过滤缺陷。

- [ ] **Step 2: 运行并确认红**

Run: `npm run build; npx electron scripts/verify-review-interactions.cjs`

Expected: 普通停止不可达；Dashboard 只改 paletteAdd；About 被 window open 守卫拒绝；ignore 同端口另一 PID 被本地滤掉；失效 script 没有有效 radio 选中却仍可提交。

- [ ] **Step 3: 做最小交互修复**

MyServicesPanel 用 `canStop = isLive` 渲染一个停止按钮，onClick 只调用现有 handleStop，删除 canForceStop 分支，不新增 IPC。App 抽取命令面板已有的 `requestPaletteAdd(kind)`，同时设置 paletteAdd 与 view，Dashboard/Launchpad/CommandPalette 共用。

About 用 `navigator.clipboard.writeText(GITHUB_URL)` 和可见状态反馈；clipboard 失败时显示只读可聚焦输入框中的完整 URL，不调用 window.open，不修改主进程外链白名单。

scanner store 的 ignore 签名改为 `(processName, port, pid)`，主进程持久规则仍只传 processName+port，本地仅过滤 `u.pid === pid && u.port === port`。`DiscoveredListeners` 的点击回调同步改为 `ignore(u.processName, u.port, u.pid)`，并检索确认没有遗漏其他调用点。ScriptPicker：

```ts
const initial = entry.script && names.includes(entry.script)
  ? entry.script
  : (names[0] ?? '')
const [selected, setSelected] = useState(initial)
```

names 或 entry.id 改变时重新校正 selected；names 为空禁用提交。

- [ ] **Step 4: 重跑交互与现有 palette 回归**

Run: `npm run build; npx electron scripts/verify-review-interactions.cjs; npx electron scripts/verify-m6-palette.cjs; npx electron scripts/verify-m6-settings.cjs`

Expected: 五个动作闭环；同端口其他 PID 不消失；主进程持久忽略语义未改变；命令面板与设置 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/renderer/src/components/MyServicesPanel.tsx src/renderer/src/App.tsx src/renderer/src/views/About.tsx src/renderer/src/store/scanner.ts src/renderer/src/components/ScriptPickerDialog.tsx src/renderer/src/components/DiscoveredListeners.tsx scripts/verify-review-interactions.cjs
git commit -m "fix(renderer): repair small action flow breaks" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 14: 修复 CSS 定位/动画规则，并用探针决定 Portal 是否需要改代码

**Files:**
- Modify: `src/renderer/src/styles/tokens.css`
- Modify: `src/renderer/src/components/EntryCard.tsx`（仅 Portal 探针变红时）
- Modify: `scripts/verify-m7-visual.cjs`
- Test: `scripts/verify-review-visual.cjs`

- [ ] **Step 1: 写几何、动画与 Portal 探针**

用 getComputedStyle/getBoundingClientRect 断言：

```js
check('surface-card 建立 absolute 包含块', cards.length > 0 && cards.every(c => c.position === 'relative'))
check('view 入场结束后不保留 transform', views.length > 0 && views.every(v => v.transform === 'none'))
check('busy 扫描 keyframes 不含 layout 属性', !/@keyframes\s+status-scan[\s\S]*?(top|height)\s*:/.test(statusScanRule))
```

keyframes 必须通过 CSSOM 找到精确规则并序列化，不能用跨后续规则的贪婪文本匹配。禁用态沿父链合成底色与 opacity，分别量 light/dark，正文与按钮文字均要求 4.5:1；先输出实际数值再判定。

Portal 用真实 `webContents.sendInputEvent` 点击 menuitem，断言目标脚本确实启动；再覆盖滚动关闭、空间不足上翻和菜单内滚动。Portal 点击若原本为绿，保留回归断言且不改 containment；若为红才进入 Step 3 的 menuRef 修复。

- [ ] **Step 2: 运行并区分规则红与未复现项**

Run: `npm run build; npx electron scripts/verify-review-visual.cjs; npx electron scripts/verify-m7-visual.cjs`

Expected: status-scan 的 top/height 与 view 终态 transform 为红；surface-card 的其他使用点若有定位问题会带元素路径报红。Portal 结果如实记录为 PASS 或 FAIL，不预设事故。阴影与禁用态输出实际 alpha/对比度。

- [ ] **Step 3: 修明确规则，Portal 只在探针红时加 menuRef**

`.surface-card` 显式 `position: relative`，并删除“border-radius 自动带来定位”的错误注释。busy 伪元素设 `bottom: auto; height: 30%`，keyframes 只改 transform/opacity：

```css
@keyframes status-scan {
  0% { transform: translateY(-100%); opacity: 0.5; }
  50% { opacity: 1; }
  100% { transform: translateY(333.333%); opacity: 0.5; }
}
```

view/item/event/header/bar 动画类改用 `animation-fill-mode: backwards`，结束后回基态；位移动画终态写 `transform: none`。reduced-motion 覆盖继续放在所有 active/动画规则之后。

按 D7 将 dark/light 的 `--shadow-lift` 与 `--shadow-lift-lg` alpha 压到 `0.05` 或更低，重跑 hover 对比度与几何。禁用态若某元素不足 4.5:1，只改该元素：去掉整块 disabled opacity，改用弱化底色 + 可见边框 + 原文字色，不能全局机械替换。

Portal 红时：

```ts
const target = event.target as Node
if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) {
  setOpen(false)
}
```

把 menuRef 挂到 portal 的 `role="menu"` 容器，其他定位/滚动逻辑不变。

- [ ] **Step 4: 重跑视觉与真实按压回归**

Run: `npm run build; npx electron scripts/verify-review-visual.cjs; npx electron scripts/verify-m7-visual.cjs; npx electron scripts/verify-m12-press.cjs`

Expected: 动画结束 transform=none，扫描无 layout 属性，所有 surface-card absolute 子元素相对正确容器；深浅禁用态数值不低于 4.5:1；Portal 菜单动作、滚动和翻转符合探针；真实 :active 按压回归 0 FAIL。

- [ ] **Step 5: 经授权后单独提交**

```bash
git add src/renderer/src/styles/tokens.css src/renderer/src/components/EntryCard.tsx scripts/verify-m7-visual.cjs scripts/verify-review-visual.cjs
git commit -m "fix(ui): correct animation and overlay geometry" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 15: 修复官网次要文本对比度，明确根域部署边界

**Files:**
- Modify: `website/src/styles.css:1-12`
- Modify: `website/README.md`
- Test: `scripts/verify-website.cjs`

`website/` 整体是用户未跟踪在途内容。先记录文件清单和现有内容，只改上述文件；不得把整目录作为本次修复默认暂存。

- [ ] **Step 1: 写真实页面文本对比度失败用例**

构建官网后，由 harness 用 Node `http` 在 127.0.0.1 随机端口安全提供 `website/dist`，Electron 加载该 URL。先在隐藏 probe 元素上解析 `color: var(--faint)` 的计算值，再收集所有可见文本叶子中使用该颜色的节点，要求 `nodes.length >= 18`，这样测的是本问题实际影响的文本而不是任意跳过其他节点。对每个节点沿父链合成实际背景；背景为渐变时枚举所有色标并取最低对比度。背景为图片时，只把该文本节点的 `color` 临时设为 `transparent`、`textShadow` 设为 `none`，保留元素自身背景、布局与其他绘制属性，截取同一 rect 按背景像素最坏值补测，随后恢复原来的 inline color/textShadow；**不能用 `visibility: hidden` 或 `opacity: 0` 隐去整个元素**，否则元素自身背景也消失，量到的是错误底色。仍无法测量的节点必须显式 FAIL，不能跳过记绿。7–11px 文本同样要求 4.5:1。另断言构建后的 JS/CSS/favicon/preload 请求均为 2xx 且没有 `/mile-terminal/mile-terminal` 之类错误拼接。

- [ ] **Step 2: 运行并确认红**

Run: `npm --prefix website run build; npx electron scripts/verify-website.cjs`

Expected: 使用 `--faint` 的实际文本节点出现低于 4.5:1 的读数；输出包含 selector、fontSize、foreground、composedBackground、ratio。根域资源请求应成功；若失败先修 harness 静态服务，不把它混同为对比度结论。

- [ ] **Step 3: 改设计令牌，不猜部署目标**

```css
:root {
  --faint: #7d8999;
}
```

候选值不照搬原报告：`#7b8798` 对 `#18202b` 的 WCAG 计算值为 4.4998:1，仍低于严格 4.5:1；`#7d8999` 为 4.6162:1，在本轮已抽样深色底色中最低也是 4.6162:1。该人工答案只用于选令牌，不能替代 Step 4 的真实页面测量。

不在本任务修改 `website/vite.config.ts`、JSX 图片路径或 `og:image`。README 明确“当前资源路径按根域部署设计；子路径部署需要先提供发布 base URL，再统一调整 Vite base、静态资源与公开 og:image 绝对地址”。

- [ ] **Step 4: 重跑官网与 375/768/1024/1440 布局门槛**

Run: `npm --prefix website run build; npx electron scripts/verify-website.cjs`

Expected: 所有已测量正文节点均不低于 4.5:1，未测量集合必须为空；四个宽度的 `scrollWidth <= innerWidth`，键盘 focus 可见，reduced-motion 下非必要动画关闭；根域资源无 4xx。

- [ ] **Step 5: 经用户明确授权后再提交官网指定文件**

```bash
git add website/src/styles.css website/README.md scripts/verify-website.cjs
git commit -m "fix(website): raise secondary text contrast" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 16: 回写文档与当前实现，保留在途 AGENTS 修改

**Files:**
- Modify: `../docs/PRD.md`
- Modify: `../docs/PRD-WORKGROUPS.md`
- Modify: `../docs/GUIDE-WORKGROUPS.md`
- Modify: `../CLAUDE.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Review only: `AGENTS.md`

- [ ] **Step 1: 写文档一致性检查**

用 Grep/Read 记录以下旧表述的位置：PRD `v1.5.0`、“唯一可启动的非 npm 生态”、README“六个视图”和 Go/Rust 一概仅登记、PRD-WORKGROUPS“不在 NavRail 新增顶级导航项”、GUIDE 从启动台进入工作组、子项目 `CONFIG_VERSION = 8`、根 PRD 的固定字节数。检查必须先失败于这些仍存在的历史文本，再开始编辑。

- [ ] **Step 2: 确认文档基线与在途差异**

Run: `git diff -- AGENTS.md README.md CLAUDE.md ../CLAUDE.md ../docs/PRD.md ../docs/PRD-WORKGROUPS.md ../docs/GUIDE-WORKGROUPS.md`

Expected: 只读输出。AGENTS.md 已有用户修改，本任务不覆盖、不暂存它；其“只有 initial CRA commit”漂移在汇报中单列，待用户决定是否与在途修改一起编辑。

- [ ] **Step 3: 按代码事实做最小编辑**

PRD 当前版本对齐 package.json 的 1.7.0，并保留历史里程碑原文；在当前能力章节注明 Python/Django/FastAPI/Flask/Streamlit、Go、Rust、C++ 的固定命令启动路径，Hugo/Jekyll/Docker Compose/static 等按 DetectResult 的真实 `registerOnly` 行为写，不能一概改成全部可启动。Spring Boot 删除“唯一”表述。

README 改为九个 ViewId，并补后端控制台、工作组、关于；保留“23 个正式 harness”的现有口径，三个硬停止旧脚本不计入。PRD-WORKGROUPS 将旧导航决策标为已被当前独立 NavRail 入口取代并注明日期；GUIDE 改为左侧“工作组”入口。子项目 CLAUDE 的 CONFIG_VERSION 改为 9。根 CLAUDE 删除 PRD 固定字节数，按当前代码拆写各非 npm 生态能力。文档涉及安全行为的句子必须与 Task 3–9 的最终代码一致，不提前宣称未验证行为。

- [ ] **Step 4: 回读并检查旧表述与编码**

Run: `git diff --check; node -e "const fs=require('fs');const files=['../docs/PRD.md','../docs/PRD-WORKGROUPS.md','../docs/GUIDE-WORKGROUPS.md','../CLAUDE.md','README.md','CLAUDE.md'];for(const f of files){const b=fs.readFileSync(f);if(b.includes(Buffer.from([0xef,0xbf,0xbd])))throw Error(f+' 含 U+FFFD');if(b[0]===0xef&&b[1]===0xbb&&b[2]===0xbf)throw Error(f+' 含 BOM')}console.log('PASS UTF-8/BOM 检查')"`

Expected: diff check 无输出，编码检查 PASS；Grep 不再命中当前章节中的旧导航、六视图、CONFIG_VERSION=8 或“唯一非 npm”表述。历史章节若保留旧版本事实，必须能明确识别为历史而非当前规则。

- [ ] **Step 5: 经授权后只提交本次文档文件**

```bash
git add ../docs/PRD.md ../docs/PRD-WORKGROUPS.md ../docs/GUIDE-WORKGROUPS.md ../CLAUDE.md README.md CLAUDE.md
git commit -m "docs: align guides with current desktop behavior" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

若父目录文件不属于当前 git 仓库，不执行该提交命令；只保留文件改动并在汇报中说明实际仓库边界，不另初始化仓库。

### Task 17: 全量回归、反向对照与交付证据

**Files:**
- Verify only; 不新增产品改动

- [ ] **Step 1: 检查工作区与危险脚本状态**

Run: `git status --short; node scripts/verify-harness-contract.cjs; git diff --check`

Expected: 三个旧脚本安全门 PASS；没有 AGENTS.md 或 website 无关文件被意外暂存；diff check 无输出。任何非本计划改动先停下来交用户判断。

- [ ] **Step 2: 构建并运行所有新增非 UI/主进程 harness**

Run: `npm run build; node scripts/verify-css-color.cjs; node scripts/verify-review-ownership.cjs`

Expected: typecheck node/web 和 electron-vite build 成功，新增静态/合成用例全部 PASS。ownership 只证明合成边界，不写成真实 PID 复用实测。

- [ ] **Step 3: 运行正式 23 个 harness，逐一保留日志与退出码**

```bash
set -e
LOG_DIR="$(mktemp -d)"
for f in m4-ui m5 m6-sort m6-palette m6-settings m7-visual m8 m9 m9-readonly m9-recover m10 m11-add m11-port m11-dual m12-press m12-port-config m13-icon m14-categories m14-favicon m15-uniapp m16-langs springboot m17-image; do
  npx electron "scripts/verify-$f.cjs" > "$LOG_DIR/$f.log" 2>&1 || { printf 'FAIL %s: %s\n' "$f" "$LOG_DIR/$f.log"; exit 1; }
  grep -aE '结果：|Result:|PASS [0-9]+ / FAIL|FAIL' "$LOG_DIR/$f.log"
done
printf 'PASS 23 official harnesses; logs=%s\n' "$LOG_DIR"
```

Expected: 23 个进程退出码均为 0。不得只用管道后的 `$?` 判定，也不得把已知 DPR 差异直接豁免；解析和断言修正后若仍红，继续定位。

- [ ] **Step 4: 运行本轮新增 Electron/官网/退出 harness**

```bash
set -e
for f in review-ipc review-entry-races review-scanner review-groups review-backend-workgroups review-async review-interactions review-visual; do
  npx electron "scripts/verify-$f.cjs" || exit 1
done
node scripts/verify-review-quit.cjs
npm --prefix website run build
npx electron scripts/verify-website.cjs
```

Expected: 每个脚本 0 FAIL，且包含非空计数、真实等待结果、负向拒绝原因或计算样式数值。Scanner 是受控故障实测；Portal 若原本未复现，只报告回归探针通过；quit 验证夹具而非外部进程。

- [ ] **Step 5: 汇总证据与未覆盖项**

输出每个 Task 的命令、退出码、关键 PASS/FAIL 数值和反向对照结果。明确列出：没有构造真实 PID 复用；`build:win` 需 Node 22 LTS，除非用户另行要求打包，不在本轮运行；官网子路径部署与公开 og:image 地址仍未定；AGENTS.md 的在途修改及历史描述是否已获用户处理。最后 `git status --short` 应只显示获授权保留的改动/提交后状态，不得把用户 WIP 写成自己的修复。

---

## 4. 执行前自审清单

- C1、I1–I12、S1–S9 均映射到 Task 1–16；附加的 sender、Portal 与覆盖缺口也有验证位置。
- 每个实现 Task 都有失败断言、红运行命令、最小实现、绿运行命令和独立提交边界。
- `CreateShellSessionInput` 只用于自由终端 IPC，`SessionSpawnSpec` 只用于主进程内部；`StoredLaunchEntry`、`LaunchEntry`、`EnvPatch` 的方向保持一致。
- `assertKillable(pid, table, sessionId)`、`table(hintPids, force)`、`history(): SessionHistory`、`SessionDataEvent.rev` 在后续 Task 中签名一致。
- 不把合成 PID 表称为真实复用，不把静态 CSS 风险称为已错位，不把受控 Scanner 故障称为自然故障，不把根域构建称为子路径支持。
- 执行中若实际方法签名、UI 选择器或文档仓库边界与本计划不同，先停下更新计划与失败用例，不靠猜测继续。
