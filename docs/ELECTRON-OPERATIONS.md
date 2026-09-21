# Electron 操作文档

本文记录 Mile Terminal 这套工程的脚手架来源、从零复现步骤、目录约定、原生模块处理、构建打包链与已踩过的坑。所有结论都来自当前仓库的真实配置文件，不是通用教程。

---

## 一、技术栈基线

| 层 | 依赖 | 版本 |
|---|---|---|
| 运行时 | electron | 43.4.0 |
| 构建 | electron-vite | 5.0.0 |
| 打包 | electron-builder | 26.15.3 |
| 打底构建器 | vite | 7.3.6 |
| 视图 | react / react-dom | 19.2.8 |
| 状态 | zustand | 5.0.15 |
| 样式 | tailwindcss + @tailwindcss/vite | 4.3.3 |
| 图标 | @phosphor-icons/react | 2.1.10 |
| 终端 | @xterm/xterm | 6.0.0 |
| 终端插件 | addon-fit / addon-search / addon-web-links / addon-webgl | 0.11.0 / 0.16.0 / 0.12.0 / 0.19.0 |
| 伪终端 | node-pty | 1.1.0 |
| 进程采样 | pidusage | 4.0.1 |
| 原生模块重建 | @electron/rebuild | 4.2.0 |
| 语言 | typescript | 5.9.3 |

生产依赖只有三个：`node-pty`、`pidusage`、`@types/pidusage`。其余全部是 devDependencies，因为渲染层代码会被 Vite 打进 `out/`，不需要在安装包里再带一份 node_modules。

---

## 二、脚手架判定

这套工程出自 **electron-vite 官方脚手架 `@quick-start/electron` 的 React + TypeScript 模板**。判据如下，任何一条单独看都可能是巧合，七条同时成立就只能是这个模板：

| 证据 | 内容 |
|---|---|
| 入口指向构建产物 | `package.json` 的 `"main": "./out/main/index.js"` |
| 开发命令 | `dev` / `preview` 直接调 `electron-vite`，没有自己拼 concurrently |
| 双 typecheck 脚本 | `typecheck:node` 与 `typecheck:web` 分别指向两份 tsconfig |
| tsconfig 只做路由 | 根 `tsconfig.json` 仅 `files: []` + 两条 `references` |
| postinstall | `electron-builder install-app-deps` |
| 三入口目录 | `src/main` / `src/preload` / `src/renderer` |
| 依赖外部化 | `electron.vite.config.ts` 中 main 与 preload 各自 `externalizeDepsPlugin()` |

根 tsconfig 的全文就是四行：

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

### 为什么第一眼认不出来

模板原版会带 `@electron-toolkit/tsconfig`、`@electron-toolkit/preload`、`@electron-toolkit/utils` 三件套，两份子 tsconfig 靠 `extends "@electron-toolkit/tsconfig/tsconfig.node.json"` 继承预设。本工程把这三个包全部删掉了：

- 两份子 tsconfig **都没有 `extends`**，compilerOptions 全部内联；
- preload 不用 `@electron-toolkit/preload`，自己手写 `contextBridge`；
- 主进程不用 `@electron-toolkit/utils`。

结论是：**看依赖表会以为不是这个模板，看脚本名和目录结构才能确认。**

---

## 三、从零复现

### 3.1 生成骨架

```powershell
npm create @quick-start/electron@latest
```

交互选择：

- 框架：**React**
- TypeScript：**Yes**
- ESLint / Prettier：本工程未启用，按需

生成的骨架包含 `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/`、`electron.vite.config.ts`、根 tsconfig + 两份子 tsconfig、`package.json` 里的 dev/build/typecheck 脚本。

### 3.2 去掉 toolkit 三件套

```powershell
npm uninstall @electron-toolkit/tsconfig @electron-toolkit/preload @electron-toolkit/utils
```

然后把两份子 tsconfig 的 `extends` 删除，把继承来的 compilerOptions 手写进去。当前工程的实际内容：

`tsconfig.node.json`（main + preload + 配置文件本身）

```json
{
  "include": ["electron.vite.config.ts", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"],
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] }
  }
}
```

`tsconfig.web.json`（renderer）

```json
{
  "include": ["src/renderer/**/*", "src/preload/index.d.ts", "src/shared/**/*"],
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@/*": ["src/renderer/src/*"]
    }
  }
}
```

两份都开了 `composite: true`，所以仓库里会出现 `tsconfig.node.tsbuildinfo` 和 `tsconfig.web.tsbuildinfo`，用于增量类型检查。这两个文件应当进 `.gitignore`。

### 3.3 逐层加增量

```powershell
# 样式：Tailwind 4 走 Vite 插件，不走 PostCSS
npm i -D tailwindcss@4.3.3 @tailwindcss/vite@4.3.3

# 状态
npm i -D zustand@5.0.15

# 终端
npm i -D @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-search@0.16.0 @xterm/addon-web-links@0.12.0 @xterm/addon-webgl@0.19.0

# 图标
npm i -D @phosphor-icons/react@2.1.10

# 伪终端与采样（生产依赖）
npm i node-pty@1.1.0 pidusage@4.0.1
npm i -D @electron/rebuild@4.2.0
npm i @types/pidusage@2.0.5
```

Tailwind 4 与 3 的接法不同：**不需要 `tailwind.config.js`，也不需要 PostCSS 配置**，只在 renderer 的 plugins 里加 `tailwindcss()`，设计令牌写在 CSS 里的 `@theme inline`，暗色走 `@custom-variant dark`。

---

## 四、目录约定与 `src/shared`

模板只有三个入口目录。本工程手工加了第四个 `src/shared`，放跨进程共用的类型和 IPC 频道常量：

```
src/
  main/       —— 主进程：index.ts + lib/ + services/
  preload/    —— 桥接层：index.ts + index.d.ts
  renderer/   —— 渲染层：index.html + src/
  shared/     —— 共用：channels.ts + types.ts
```

权限边界固定为三段：主进程拥有全部能力；preload 只通过 `contextBridge` 暴露白名单，挂到 `window.mile.*`；渲染层零 Node 能力。`webPreferences` 必须是 `contextIsolation: true`、`nodeIntegration: false`。

### `@shared` 别名要登记两处

只登记一处会出现「构建过但类型报错」或「类型过但运行时找不到模块」。

第一处，`electron.vite.config.ts` 的**三段 config 各自**的 `resolve.alias`：

```ts
const shared = resolve(__dirname, 'src/shared')

main:     { resolve: { alias: { '@shared': shared } } }
preload:  { resolve: { alias: { '@shared': shared } } }
renderer: { resolve: { alias: { '@shared': shared, '@': resolve(__dirname, 'src/renderer/src') } } }
```

第二处，两份子 tsconfig 的 `include` 与 `paths`：

```json
"include": ["...", "src/shared/**/*"],
"paths": { "@shared/*": ["src/shared/*"] }
```

新增任何跨进程目录，都要同时改这两处，共四个位置（配置文件三段 + tsconfig 两份）。

---

## 五、原生模块 node-pty

`node-pty` 是 C++ 原生模块，必须针对 Electron 的 ABI 重编译，且不能被打进 asar。三件配置缺一不可，缺任何一件都表现为「开发能跑、装完打不开」：

```json
{
  "scripts": {
    "rebuild": "electron-rebuild -f -w node-pty"
  },
  "build": {
    "npmRebuild": false,
    "asarUnpack": ["**/node_modules/node-pty/**"]
  }
}
```

- `rebuild` —— 手动针对 Electron ABI 重建，装完依赖或换 Electron 版本后执行；
- `npmRebuild: false` —— 禁止 electron-builder 打包时再自行 rebuild，避免它用错的 ABI 覆盖上一步的产物；
- `asarUnpack` —— `.node` 二进制无法从 asar 内加载，必须解包到 `app.asar.unpacked/`。

`postinstall` 里的 `electron-builder install-app-deps` 是模板自带的，作用是安装后按 Electron ABI 处理原生依赖。

---

## 六、构建与打包链

```json
"scripts": {
  "dev": "electron-vite dev",
  "preview": "electron-vite preview",
  "typecheck:node": "tsc -p tsconfig.node.json --noEmit",
  "typecheck:web": "tsc -p tsconfig.web.json --noEmit",
  "typecheck": "npm run typecheck:node && npm run typecheck:web",
  "build": "npm run typecheck && electron-vite build",
  "build:win": "npm run build && electron-builder --win"
}
```

`build` 前置 `typecheck` 不是习惯问题：**electron-vite 用 esbuild 转译，完全不做类型检查**。不串 typecheck，类型错误会一路带进 `out/`，直到运行时才炸。

两份 tsconfig 也必须都跑：`typecheck:node` 覆盖 main/preload，`typecheck:web` 覆盖 renderer，各自的 lib 和 types 不同，单跑一份等于半个工程没检查。

打包配置内联在 `package.json` 的 `build` 字段，没有独立 `electron-builder.yml`：

```json
"build": {
  "appId": "com.mile.terminal",
  "productName": "Mile Terminal",
  "directories": { "output": "release", "buildResources": "build" },
  "npmRebuild": false,
  "files": ["out/**/*", "package.json"],
  "extraResources": [{ "from": "resources/icon.png", "to": "icon.png" }],
  "asarUnpack": ["**/node_modules/node-pty/**"],
  "win": {
    "icon": "build/icon.ico",
    "target": [{ "target": "nsis", "arch": ["x64"] }]
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "installerIcon": "build/icon.ico",
    "uninstallerIcon": "build/icon.ico",
    "shortcutName": "Mile Terminal"
  }
}
```

`files` 只收 `out/**/*` 和 `package.json`，源码不进安装包。`build/` 放打包资源（`icon.ico`），`resources/` 放运行时要读的资源（托盘图标 `icon.png`），两者不是一回事。NSIS 用非一键模式，允许用户改安装目录。

常用命令顺序：

```powershell
npm run dev        # 开发，三段热更新
npm run typecheck  # 只查类型
npm run build      # typecheck + 产出 out/
npm run build:win  # build + 出 release/ 下的 NSIS 安装包
npm run rebuild    # node-pty 针对 Electron ABI 重建
```

---

## 七、踩坑清单

### 7.1 renderer 必须 `base: './'`

打包后页面走 `file://` 协议加载，默认的绝对路径 `/assets/...` 会解析到磁盘根目录，白屏。

```ts
renderer: { base: './' }
```

### 7.2 renderer 必须关掉 manualChunks

```ts
build: { rollupOptions: { output: { manualChunks: undefined } } }
```

Rollup 默认的分包策略会改变模块初始化顺序，导致运行时抛 `Cannot access 'X' before initialization`（TDZ）。关掉分包换成单 chunk 可解。这条是修过的问题，不要因为「优化产物体积」把它改回去。

### 7.3 IPC 结构化克隆会丢弃 `undefined` 键

`ipcRenderer.invoke` 走结构化克隆，对象里值为 `undefined` 的键会整个消失，对端拿不到该字段。要表达「清空这个字段」，必须显式传 `null`。

### 7.4 Tailwind 4 的 `tokens.css` 不加 `@layer` 会盖掉工具类

设计令牌文件如果不包在 `@layer` 里，其中的裸选择器优先级会压过 Tailwind 的 `transition-colors` 之类工具类，hover 变成硬切。本工程的处理是：在每条 `transition` 简写里显式列出 `background-color / border-color / color / box-shadow`，需要位移的组件再补 `transform`。

### 7.5 `:active` 要写在 `:hover` 之后

同等特异性下按源码顺序决胜，`:active` 写在前面永远不生效。`prefers-reduced-motion` 覆盖块同理，必须放在文件最后，且选择器长度要能压过被覆盖的规则（媒体查询本身不增加特异性）。

### 7.6 主题切换走 `data-theme`，不走 `prefers-color-scheme`

主进程用 `nativeTheme` 判定，写到 `<html data-theme>`。渲染层直接读属性，避免系统偏好与用户手动选择打架。

### 7.7 验证方式：真机脚本，不引入单测框架

`scripts/verify-*.cjs` 用真实主进程加载真实的 `out/` 产物，通过 `executeJavaScript` 断言。几条经验：

- 合成事件 `dispatchEvent(new MouseEvent('mousedown'))` **不会**改变 `:active`，必须用 `webContents.sendInputEvent`，并在同一元素上释放鼠标，否则 `:active` 会泄漏到后续断言；
- 断言 1px 边框时要乘 `devicePixelRatio`，1.75 缩放下 1px 读回来是 `0.571429px`；
- `color-mix()` 读回形如 `color(srgb 0.83 0.84 0.86)`，是 0..1 区间，按 0..255 解析会把高对比按钮算成 1.09:1；
- `[].every(...)` 返回 `true`，空选择器会静默通过，必须加 `length > 0` 的门禁；
- 脚本必须在加载主进程 bundle **之前** `app.setPath('appData', tmpdir)`，否则会写坏真实的 `%APPDATA%/mile-terminal/config.json`；
- 多个脚本共用 `scripts/fixture-*`，各自要写入并还原自己的磁盘状态，否则出现「单跑绿、全套红」。

### 7.8 Windows / ConPTY

- 光标定位用绝对坐标；
- 默认代码页 936，会话起来先 `chcp 65001`；
- npm 的进度条会用 `\r` 擦行，干扰输出断言，设 `npm_config_progress=false`；
- 本地服务探测要同时考虑 IPv4 / IPv6 双绑。

---

## 八、一句话复现路径

`npm create @quick-start/electron@latest` 选 React + TS，卸掉 `@electron-toolkit/*` 三件套并把两份 tsconfig 的 compilerOptions 内联，加 Tailwind 4（Vite 插件）/ zustand 5 / xterm 6 四插件 / node-pty + pidusage，新建 `src/shared` 并把 `@shared` 别名登记进配置三段与 tsconfig 两份，renderer 补 `base: './'` 和 `manualChunks: undefined`，node-pty 补 `rebuild` 脚本 + `npmRebuild: false` + `asarUnpack` 三件套，最后把 electron-builder 的 NSIS 配置内联进 `package.json`。
