# CLAUDE.md

Mile Terminal（Ops 指挥台）—— Windows 本地终端与前端项目管理工作台。个人自用，不做多用户、不做远程。

**权威文档是 `../docs/PRD.md`**（在仓库的父目录，不在本目录）。它记录了需求、每个决策的理由、以及每个里程碑的实测结果。本文件只讲「怎么在这个仓库里干活」，不重复 PRD 的内容。改动涉及产品行为时，PRD 与代码一起改。

---

## 命令

```bash
npm run dev              # electron-vite dev，热重载
npm run typecheck        # node + web 两套 tsconfig，缺一不可
npm run build            # 先 typecheck，再 electron-vite build → out/
npm run build:win        # 打 NSIS 安装包 → release/（需要 Node 22 LTS，见下）
npm run rebuild          # node-pty 换 Electron 版本后重编原生模块
```

**没有单元测试框架，也不要引入一个。** 验证方式是 `scripts/verify-*.cjs`：启动真实主进程、加载真实构建产物、用 `executeJavaScript` 驱动真实渲染层。理由见下文「验证纪律」。

```bash
npm run build                          # 必须先构建，harness 加载的是 out/ 里的产物
npx electron scripts/verify-m10.cjs    # 跑单个
```

全套 23 个 harness，逐条断言（m7-visual 的「1px 边框」在 devicePixelRatio=2 环境差 1 条，属显示密度差异非代码回归，见 §验证纪律）：

```bash
for f in m4-ui m5 m6-sort m6-palette m6-settings m7-visual m8 m9 m9-readonly m9-recover m10 m11-add m11-port m11-dual m12-press m12-port-config m13-icon m14-categories m14-favicon m15-uniapp m16-langs springboot m17-image; do
  npx electron scripts/verify-$f.cjs 2>&1 | grep -E '结果：|Result:|PASS [0-9]+ / FAIL|^\s*FAIL'
done
```

m9-readonly / m9-recover 单独成进程，因为它们要「带着坏配置文件启动」—— 只读判定与备份恢复都发生在 `ConfigStore` 构造时，主进程起来之后再改文件已经晚了。

m11-add 是唯一**从 DOM 驱动**的 harness：它要验的缺陷在渲染层 store 里，调 `window.mile.entry.*` 根本不过那条路。原生目录选择器是模态窗口，harness 点不动，所以在主进程里 `removeHandler` + 重注册 `dialog:pickDirectory` 返回夹具目录 —— 换掉的只是「用户选了哪个目录」，识别与落盘全走真实实现。

m12-press 量按压动画。**`:active` 不能用合成事件触发** —— `dispatchEvent(new MouseEvent('mousedown'))` 不改渲染引擎的交互状态，`getComputedStyle` 读回来还是基态，六条位移断言会全体假绿。必须走 `webContents.sendInputEvent` 进真实输入管线。因此每条位移断言都配一次基态对照，并且断言「按下时 `el.matches(':active')` 为真」证明探针有效。同一个原因，松手也必须在元素原地松（移到别处松开 `:active` 不解除，会把按下态一路带进后面的小节），改从 window 捕获阶段吃掉 `click` 来避免探针真的启动服务、真的切视图。

m11-dual 用 `scripts/fixture/dual-server.cjs` 造出「两个进程分别绑 IPv4 / IPv6 的同一端口」。它先用真实 `netstat.exe -ano` 确认这个前提成立，再去核对应用的说法 —— 否则两个夹具压根没撞上时，后面所有「不该说空闲」的断言都会因为「没冲突」而全体空过。

---

## 架构

```
src/main/       主进程。所有特权操作、所有命令构造、所有校验
  index.ts        IPC 注册与参数校形（sanitize*），窗口/托盘/通知
  services/       各司其职，构造函数注入依赖，无全局单例
  lib/            Windows 平台细节（PowerShell 调用、进程表、归属推断）
src/preload/    contextBridge 白名单，暴露 window.mile.*
src/renderer/   React 19 + zustand + Tailwind 4。只做展示与交互
src/shared/     两侧共用的类型与 IPC 频道名
```

**渲染层没有任何特权。** 它拿不到 `runToken`、拿不到环境变量的值、不能构造命令、不能指定要执行的可执行文件。所有这些都在主进程决定。

服务职责与关键约束：

| 服务 | 职责 | 不能碰的红线 |
| --- | --- | --- |
| `ScannerService` | 每 2s 采集监听端口 / CPU / 内存 / 运行时长 | 窗口不可见时降频，`tick()` 有互斥锁 |
| `OwnershipService` | 运行 token + 进程组 + UID 三重判定 | **kill 前必须重新验证**（PID 复用窗口） |
| `SessionService` | node-pty 会话，16ms 合并刷新 | `spawn(file, argsArray)` 数组形式，永不拼字符串进 shell |
| `EntryService` | 条目 CRUD、启动/停止、运行态 | 可执行脚本只能来自项目 `package.json` 的 `scripts` 键 |
| `DetectService` | 识别框架 / 包管理器 / 脚本 | **只读文件、不执行项目代码**（连 `go list` 都不行） |
| `PrecheckService` | 启动前静态检查 | 只读，不写、不安装 |
| `LogService` | 跨会话日志聚合、分级、筛选 | 只在内存，不落盘 |
| `ConfigStore` | 配置读写、版本迁移、`.bak` 轮转 | 原子写（临时文件 + rename），UTF-8 无 BOM |

---

## 安全红线（用户明确要求，不可协商）

这四条来自需求原文，任何改动不得违反：

1. **不安装依赖、不执行项目代码。** `npm install` 会跑 postinstall 脚本，等于执行任意代码。因此 PRD 初版的「缺 `node_modules` 就自动装」被**删掉**了，替换为预检 `fail` + 用户显式点击「创建安装会话」。识别阶段同理：只读文件与文本，不跑任何版本查询命令。
2. **不因端口相同就杀死外部进程。** 归属只认 `OwnershipService.assertKillable`（运行 token + 进程组 + 当前 UID）。启动来源徽标、分组、进程名都是展示用，**绝不参与 kill 授权** —— 进程名是进程自己能随便写的。
3. **命令只用 `spawn(file, argsArray)` 数组形式**，永不把用户输入拼进 shell 字符串。脚本名走 `SAFE_SCRIPT` 字符白名单，且必须存在于项目 `package.json` 的 `scripts` 里。
4. **工作目录必须是已注册条目的路径或其子路径。**

配套约束：

- `runToken` 永不发给渲染层。
- 诊断面板只显示环境变量的**键名**，从不显示值。
- `shell:openExternal` 只允许 http/https 且 host 为 localhost/127.0.0.1。
- `shell:openPath` 只接受白名单路径。`outputDir` 因此必须是相对路径且不含 `..` —— 它会进那个白名单。
- 新增 IPC 一律在 `index.ts` 里写 `sanitize*` 校形函数，白名单外的键静默丢弃，非法值抛错且**不落盘**。

---

## 验证纪律

这是这个项目最重要的工作方式，PRD §12 里有十几次实证。

**用量出来的数字判断，不看截图。** 截图能证明「没崩」，证明不了圆角是 12px、对比度是 4.62:1、状态色真的进了边框。UI 断言读 `getComputedStyle` / `getBoundingClientRect`。

**先确认自己量的是对的东西。** 一个通过的断言可能是靠错误的原因通过的。反复踩到的具体形式：

- **`[].every(...)` 返回 `true`。** 所有集合断言都必须先有 `length > 0` 门槛。曾有四条分组断言同时空过。
- **选择器选空 = 静默通过。** 曾在没有条目卡片的工作台上量卡片文案，`undefined` 检查全员空过。断言要带 `12/12` 这样的计数。
- **固定 `sleep` 会把「还没跑完」误判成「没这个东西」。** IPC 回执、CSS 过渡、采集周期都要轮询到目标出现再量。新 PID 出现在监听表实测约 12 秒（未知 PID 触发约 3.5s 的 CIM 刷新，且 `tick()` 有锁会丢掉期间的 `refresh()`）。
- **合成后再算。** 对比度要沿父链合成半透明底与祖先 `opacity`；纯 SVG 按钮的 `textContent` 可能来自 `opacity-0` 的 tooltip。
- **`color-mix()` 的计算值不是 `rgb()`。** 它读回 `color(srgb 0.83 0.84 0.86)`，分量在 0..1。按 0..255 解析会把浅底当纯黑 —— 实测把一个高对比的按钮算成 1.09:1。凡是解析颜色的探针都要按前缀分档乘 255。
- **`transform` 矩阵是复合后的值。** `scale(.96) translateY(1px)` 的 `matrix` 里 f = 0.96×1 = 0.96，不是 1。断言要按「缩放后的期望位移」比，别硬套 CSS 里写的数。
- **间歇性失败：先量原始数据，别信推理。** M10 有一次「合理但不是本次成因」的误判 —— 表面看是 `exit` 与末尾 `data` 的竞争，实际是 npm 转轮进度用 `\r` 把末行擦了。详见 PRD §12.10。
- **探针本身可能量错对象。** 查双端口时我先记下「监听表只给出一个 PID」，据此差点去改 `parseNetstat`。重新探测发现：那次的探针在取快照后按 `entryId` 过滤了行，滤掉的正是另一条。`parseNetstat` 的去重键是 `${pid}:${port}`，两个不同 PID 的行**不会**被合并。真正的缺陷全在下游四处 `.find()`。
- **同端口场景的 harness 必须先验前提。** 「不该说空闲」这类断言，在两个夹具其实没撞上时会因为「没冲突」而假绿。m11-dual 因此先跑真实 netstat 数 PID。
- **改判定逻辑后做一次反向对照。** 把 `portItem` 的 `filter` 临时改回 `.slice(0, 1)` 重新构建重跑，确认恰好那三条断言变红（`pass / :39100 空闲`、`fix` 为 `null`）—— 证明 harness 抓的是这个缺陷本身，不是靠别的原因凑巧通过。对照做完必须还原源码**并重新构建**，否则 `out/` 里留着的是明知有病的产物。

**harness 自己也会有缺陷**，PRD 里留档了六处以上。改产品结构后要同步 harness 的选择器。

---

## 平台细节（都是踩过的坑）

- **ConPTY 的输出不是行流。** 它用绝对光标定位（`\x1b[5;1H`）跳行而不是发 `\n`；在最终输出后补 `\r\x1b[K`。只按 `\r?\n` 切会粘行，只取最后一个 `\r` 之后的内容会丢末行。见 `LogService`。
- **会话环境里关掉 npm 转轮进度**（`npm_config_progress=false`）。它用 `\r` 重绘会擦掉紧邻的、无换行结尾的真实输出。
- **`exit` 不保证晚于最后一块 `data`。** 收尾要延迟（`LogService.scheduleFinalFlush`）。
- **转义序列一律写成 `\x1b` 这种可见形式**，不敲字面 ESC 字节 —— 字面控制字符在编辑、复制、diff 里会悄悄丢掉，那时正则静默地什么都不匹配。
- **含正则的文件不要用 shell heredoc 写。** `cat <<EOF` 会吃掉反斜杠，`\x1b\\` 变成 `\x1b\`。用写文件工具。
- **`devicePixelRatio` 不是 1。** 「1px 边框」在 1.75 倍屏上读出 `0.571429px`，那正好是一个设备像素。比较前乘 `devicePixelRatio`。
- **`electron.Notification` 是不可配置的 getter**，`Object.defineProperty` 会抛 `Cannot redefine property`。要在测试里替换它，用 `Module._load` 拦截 + `Proxy`，装在 `require` 主进程包**之前**（`verify-m10.cjs` 开头有可用实现）。
- **IPC 的结构化克隆会丢掉 `undefined` 的键。** 要清空一个字段用 `null`，否则到主进程就变成「没提这个字段」。
- **`entry:changed` 广播比 `invoke` 回执先到。** `EntryService.commit` 是同步 `emit`，所以渲染层收到整份新列表时，`await window.mile.entry.add(...)` 还没 resolve。**任何乐观更新都必须按 id 幂等**（实测无条件 push 会出现两张一样的卡片，直到下一次广播整体覆盖才收敛）。`edit` / `remove` / `reorder` 天然按 id 或整体替换，只有追加型操作会踩到。
- **ConPTY 默认代码页 936**，中文与进度条会乱码。`SessionService` 里对 PowerShell 会先发 `chcp 65001`。
- **同一个端口可以被两个进程同时占住。** 一个绑 `0.0.0.0:P`（Vite 的 `vite.config` 常写死 `host: '0.0.0.0'`），另一个绑 `[::]:P`（Node 默认，`ipv6Only`）—— **两边 `listen` 都成功、都不打印回退告警**，`netstat` 出两行两个 PID。实测 `127.0.0.1:P` 通向 IPv4 那个，`localhost:P` 与 `[::1]:P` 通向 IPv6 那个。所以「两张卡片都写 :3000」是事实，不是显示错误；错的是应用据此说「空闲」。凡是从监听表回答「这个端口谁在用」的地方，**一律 `filter` 后排掉自己，不要 `.find()` 取第一行** —— 第一行恰好是自己时结论就反了。
- **真正监听端口的是链条末端的 `node.exe`**（`cmd.exe → npm → node`），而条目记的是根 PID。判断「这个监听是不是我自己的」不能只比 `runtime.pid`，要并上快照里 `entryId` 等于本条目的 PID（采集已按会话归属回填）。见 `EntryService.ownListenPids`。

---

## 修改 harness 夹具时

**harness 必须在 `require` 主进程包之前 `app.setPath('appData', tmpdir)`。** 否则它写的是 `%APPDATA%/mile-terminal/config.json` —— 你真实的条目。曾经差点覆盖掉（PRD §12.6）。沙箱清理是尽力而为：Electron 退出时仍持有 appData 下的缓存句柄，`rmSync` 会抛 EPERM，捕获后交系统清理，**绝不让清理失败污染结果判定**。

`scripts/fixture-task/package.json` 被多个 harness 共用，而 `verify-m5.cjs` 会**按内容重建**它。所以某个 harness 要用的脚本必须由它自己写进磁盘、结束时还原 —— 只写进沙箱配置是不够的，`EntryService.assertScriptDeclared` 启动前会重读磁盘上的 `package.json`。忽略这一点的症状是「单跑绿、全套红」。`verify-m10.cjs` 里有现成的补丁-还原写法。

---

## 加一个 Framework 值要改四处

漏一处就会在界面上渲染出 `undefined`：

1. `src/shared/types.ts` 的 `Framework` 联合类型
2. `src/main/services/EntryService.ts` 的 `FRAMEWORKS` 校验 Set
3. `src/renderer/src/lib/entryMeta.ts` 的 `FRAMEWORK_LABEL`
4. `src/renderer/src/components/EntryCard.tsx` 的 `GLYPH: Record<Framework, string>`

新生态如果推不出 `<包管理器> run <脚本>` 这个命令形状（Go / Rust / Hugo / Django 等），必须标 `registerOnly: true` —— 硬猜命令等于替用户构造命令，违反红线 1。

---

## UI 约定

风格锁定 `.claude/skills/minimalist-ui`，一处明确偏离：配色用冷调双色（深空蓝黑 / 雾灰），因为 Ops 场景需要深色模式。

- 无渐变、无重阴影（不透明度 < 0.05）、边框统一 1px、等宽字体做区块标签、Phosphor 图标。禁用 Inter/Roboto，禁用 emoji，大容器不用 `rounded-full`。
- **状态色只染边框、图标瓦片与胶囊，绝不染卡片底。** 底色跟着状态走，六张卡片同屏就成了色块拼贴。
- **每个组件只赋一次 `--glow`**，其余读同一个自定义属性。改配色不需要逐个组件跟改。
- 文字对比度 ≥ 4.5:1，**深浅两模式分别校验，且要包含按钮的启用/禁用两态**。`--text-faint` 承载 KPI 标签与区块标题，属正文，不放宽到 3:1。
- 主按钮用 `.btn-primary`（`tokens.css`）。底 `--text-strong`、字 `--text-on-ink`。**不要用 `--text-inverse`** —— 它相对页面底色反转，而 `ink-strong` 已经反转过一次，两次抵消会让字底同色（实测 1.81:1 / 1.37:1）。
- **禁用态不压整块 `opacity`**，那会把文字一起拖到 1.26:1。换弱化底色 + 可见边框，文字守住 AA。
- `.segmented` 只用于同一视图内的口径切换。**不做顶部分段视图切换器** —— 左侧导航轨是唯一的视图入口，两套导航会让人以为它们切的是不同东西。
- 图标按钮必须有 `aria-label`；焦点态 2px 可见描边。
- **按压反馈统一走 `.pressable`（缩 0.96 + 下沉 1px）与 `.pressable-flat`（只下沉，给命令面板结果行、会话行这类宽条目）。** 位移量与控件尺寸成反比，整行缩放看着像橡皮。`.btn-primary` 与 `.segmented-item` 把 `:active` 收在类里，调用方不用再挂 `.pressable` —— 六处以上的调用点漏一处就少一处手感。**贴窗口边缘的面（标题栏控件、折叠后的侧栏条）只换底色不做位移**，缩放会露出底下的画布。
  - `tokens.css` **没有 `@layer`**，它的 `transition` 简写会盖过 Tailwind 在 `@layer utilities` 里的 `transition-colors`。所以这两个类的简写必须把 `background-color/border-color/color/box-shadow` 一起写上，否则 hover 变色变成硬切。
  - `:active` 必须写在 `:hover` **之后** —— 两者特异性相等，后写的才生效。
  - `prefers-reduced-motion` 的覆盖块要排在所有 `:active` 规则之后，且选择器长度一致（带上那两个 `:not()`）：媒体查询不加特异性，写短了盖不住。

---

## 环境

- **Node 20.19。`electron-builder` 打包前需升到 22 LTS**（长期待办，从 M1 挂到现在）。
- 平台 Windows 11。shell 用 bash 语法（`/dev/null`、正斜杠路径）。
- 配置落在 `%APPDATA%/mile-terminal/config.json`，`.bak` 是上一份良好版本。当前 `CONFIG_VERSION = 8`。
- **改 `CONFIG_VERSION` 时**：迁移写显式版本分支，不要用 `{...DEFAULTS, ...raw}` 铺开 —— 那样 `version` 会永远停在旧值，每次启动都重跑迁移。harness 里不要写死版本号，从 `src/shared/types.ts` 读。
