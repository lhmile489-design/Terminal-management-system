# Mile Console

Mile Terminal 的 mygo 重写版：把 `../../mile-terminal-management`（Electron 43 + React 19 + node-pty）迁到 **egoist/mygo**（Go 后端 + 系统 WebView2 页面）。产品行为、界面与布局与原版一比一对等，只换运行时。

当前处于迁移 M0（脚手架与文档基线），业务代码尚未开始搬迁。

## 文档地图

| 想知道 | 读 |
| --- | --- |
| 产品是什么、六个页面、四条原则 | [`PRODUCT.md`](PRODUCT.md) |
| 长什么样、令牌与布局规格 | [`DESIGN.md`](DESIGN.md) |
| 在这个目录里怎么干活（命令、红线、验证纪律） | [`CLAUDE.md`](CLAUDE.md) |
| 怎么一步步迁、做到哪、哪些做不到一致 | [`docs/MIGRATION-PLAN.md`](docs/MIGRATION-PLAN.md) |
| Go 与页面之间怎么通信 | [`docs/BINDINGS-CONTRACT.md`](docs/BINDINGS-CONTRACT.md) |
| 原版需求与决策理由 | `../../docs/PRD.md` |
| 原版实现（行为与界面的唯一基准） | `../../mile-terminal-management/` |

## 版本

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Go | 1.27.3 | `go.mod` 的 `go` 指令 |
| `github.com/egoist/mygo` | v0.8.3 | 与 CLI、前端 runtime 对齐 |
| `mygo-cli` / `mygo-runtime` | ^0.8.3 | `package.json` |
| Vite / TypeScript | ^8 / ^7 | 模板默认 |

三处版本必须一致。`mygo init` 默认会 `go get ...@latest` 拉到更新的 Go 模块，与 CLI/runtime 的 0.8.3 形成跨版本组合；这里已手动固定为 v0.8.3。升级时三处一起改：`go get github.com/egoist/mygo@<ver>`、`package.json` 的两个依赖、本机 CLI（`go install github.com/egoist/mygo/cmd/mygo@<ver>`）。

## 命令

```bash
bun install              # 安装页面依赖（本目录自己的）
bun run dev              # mygo dev：起 Vite + 开窗口，监听 Go 变化重编
bun run generate         # 改过绑定方法/结构体/事件后重新生成 src/mygo.ts
bun run typecheck        # tsc --noEmit
bun run build            # mygo build：NSIS 安装包 + exe
go test ./...            # Go 纯逻辑单测
go vet ./...

# 真实窗口验收：一个终端带调试端口起窗口，另一个终端跑脚本
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" bun run dev
bun run scripts/cdp-verify.mjs
```

bash 里找不到 `go` 时：`export PATH="/c/Program Files/Go/bin:/c/Users/LHmile/go/bin:$PATH"`。

## 结构

```
main.go              绑定服务、事件、窗口、托盘、生命周期
internal/            业务与平台实现（契约包 + 各服务，见迁移计划）
src/mygo.ts          mygo generate 的生成物，不要手改
src/lib/mile.ts      前端唯一后端入口，与原版 window.mile.* 同形
src/renderer/        从原版搬来的 React 应用
src/styles/          tokens.css / ui.css 原文复制
index.html           页面骨架
mygo.config.ts       CLI 读取的运行期契约
vite.config.ts       端口 5173 + strictPort
resources/icon.png   1024x1024 应用图标
scripts/cdp-*.mjs    真实窗口验收（CDP over WebView2）
docs/                迁移计划与绑定契约
```

> `internal/` 与 `src/renderer/` 在 M1–M5 逐步落地，当前只有模板的 `Greeter`。

## 约定

1. **生成物不手改。** `src/mygo.ts` 由 `mygo generate` 产出；改了绑定签名后必须重新生成，并 `git diff` 核对。
2. **运行期契约不要凭记忆改。** `mygo.config.ts` 的 `devUrl` / `devCommand` / `buildCommand` / `frontendDist` / `bindings` / `out` 由模板生成；`devUrl` 的端口必须与 `vite.config.ts` 的 `server.port` 一致，且保持 `strictPort: true`。
3. **绑定方法第一个参数放 `context.Context`。** 它在 TS 侧不出现；所有外部 I/O 都从这个 ctx 派生，禁止 `context.Background()`，否则关窗后请求仍在跑。
4. **三种通道各司其职。** 调用（返回 Promise）用于请求/响应；`*mygo.Channel[T]` 用于一次调用内的连续数据（保序、有背压、页面离开即取消）；`mygo.NewEvent[T]` 用于与某次调用无关的 Go 主动通知。
5. **前端只经 transport 访问后端。** 组件不要直接 import `src/mygo.ts`，唯一入口是 `src/lib/mile.ts`；生产构建不引用 mock。
6. **窗口底色与页面底色一致。** `main.go` 的 `BackgroundColor` 用 `light-dark(<浅>, <深>)`，与页面画布色对齐，避免启动白闪。
7. **整窗不出现滚动条。** 主体高度用 `100dvh` 减去固定区，flex 链路每层 `min-height: 0`，每个滚动区自己 `overflow-y: auto`。
8. **数据目录分开。** 新版写 `%APPDATA%\mile-console\`，不碰原版的 `%APPDATA%\mile-terminal\`。

## 已验证

- `go vet ./...`、`go build ./...` 通过
- `bun run typecheck` 通过
- `bun run build:web` 通过（Vite 产物在 `dist/`）
- `mygo doctor`：Go / Bun / WebView2 / makensis / gh 全部就绪（signtool 可选，未安装）
- 真实窗口（`scripts/cdp-verify.mjs`）：6/6 通过 —— 标题、`Greeter.Info`、tick 事件持续推送、`Greeter.Greet` 返回 Go 文案、截图、控制台无错误

`mygo dev` 会打开真实窗口并阻塞，手动关窗后开发进程退出。托盘、单实例、全局快捷键、深浅外观这类原生行为仍需在真窗口里人工验收（当前模板尚未包含这些能力）。
