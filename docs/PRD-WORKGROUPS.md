# PRD-WORKGROUPS.md

> **技术设计文档** - Mile Terminal - 工作组 + 环境功能
>
> 版本: 1.0
> 状态: 草案（待评审）
> 关联配置版本: CONFIG_VERSION 8 -> 9

---

## 目录

1. 背景与目标
2. 功能设计
3. 架构决策
4. 类型定义（TypeScript）
5. UI 流程设计
6. IPC 变更
7. 实现步骤
8. 配置迁移
9. 验证方案
10. 约束备忘

---
## 1. 背景与目标

### 1.1 现状

Mile Terminal 目前用 LaunchEntry.category（自由文本）在启动台做浅层分类，
每个条目彼此平行、没有组的概念，更没有对应环境的概念。
后端控制台（BackendConsole.tsx）在打包完成后，用户需要手动选 jar 文件、手动切换启动方式，
且没有快捷打开产物位置的入口（虽然底层 entry:revealOutput channel 已经存在）。

### 1.2 目标

| 编号 | 需求 | 交付物 |
|------|------|--------|
| R1 | 工作组：把多个条目收口到一个命名的项目里 | ProjectGroup 类型；Launchpad 新增工作组视图 |
| R2 | 环境：工作组可切换 dev/sandbox/prod，影响启动警告和 profile 联动 | GroupEnvironment 类型；环境横幅组件 |
| R3 | 后端控制台 UX：Package 后快速定位 jar；自动切换到 jar 模式 | entry:revealOutput 复用；packageWithProfile 回调增强 |

---

## 2. 功能设计

### 2.1 数据模型

#### 2.1.1 新增：ProjectGroup

字段清单：
- id          : string           - randomUUID，由主进程生成
- name        : string           - 用户命名，1-40 字符，不允许控制字符
- description : string?          - 可选说明，不超过 120 字符
- env         : GroupEnvironment - 当前激活的环境，默认 dev
- createdAt   : number           - Unix 毫秒时间戳
- order       : number           - 排序号，由主进程维护

#### 2.1.2 扩展：LaunchEntry

新增一个可选字段，其他字段保持不变：
  groupId?: string    - 所属工作组 ID；未分组时 undefined

#### 2.1.3 扩展：AppConfig

  groups: ProjectGroup[]    - 工作组列表，v9 起新增

#### 2.1.4 新增枚举类型

  GroupEnvironment = dev | sandbox | prod

### 2.2 现有字段复用策略

- LaunchEntry.category 保持不动，工作组独立维护分组关系，避免既有「未分类」逻辑受影响。
- BackendConsole.tsx 现有的 classifyProfile 函数返回值域（prod/sandbox/dev/custom）
  与 GroupEnvironment 保持一致，Profile 联动逻辑可直接复用这个函数。

---

## 3. 架构决策

### 3.1 工作组存储位置：内联 AppConfig.groups（不单独文件）

理由：
- 现有 ConfigStore 已有原子写（tmp-rename）+ .bak 备份机制，不需要重复造轮子。
- entries 与 groups 经常需要联动查询（按 groupId 过滤 entries），
  合并在同一文件内可以原子读写，避免两文件不一致的竞态。
- 单独文件引入第二套 readOnly 保护与 migrate 路径，增加维护成本。
- 配置文件增大有限（一个工作组约 200 字节），可接受。

### 3.2 工作组视图集成方式：Launchpad 内新增视图模式（不加 NavRail 条目）

理由：
- NavRail 条目语义是功能模式（启动台、后端控制台、终端……），
  工作组是启动台的一种视图，不是独立模式，加入 NavRail 会破坏信息层级。
- 在 Launchpad 工具栏最左侧加一个视图模式分段控件：
  模式 A = 现有分类视图，模式 B = 工作组视图。
- 工作组视图仅需复用现有 EntryCard / EntryRow + 新的 GroupView 组件，改动最小。

### 3.3 环境持久化：存在 ProjectGroup.env 字段

理由：
- 环境是工作组的属性，不是全局设置，随工作组落盘最自然。
- 不做运行时状态（不放 Zustand 临时状态），因为用户关掉 app 重开后应该
  记住上次的环境选择，避免在沙箱或生产环境意外启动服务。

### 3.4 工作组 Zustand Store 方案

新建 src/renderer/src/store/groups.ts，独立于 entries.ts，避免单个 Store 体积膨胀。

groups store 暴露：
- groups[]           - 工作组列表（与 AppConfig.groups 同步）
- add(name) -> group - 调用 group:add
- patch(id, partial) - 调用 group:patch，包括修改 env
- remove(id)         - 调用 group:remove
- reorder(ids)       - 调用 group:reorder

entries store 不改签名。条目的 groupId 字段通过现有 entry:changed 广播自动更新。

---
## 4. 类型定义（TypeScript）

以下为完整的新增/修改代码，均在 src/shared/types.ts 中操作。

### 4.1 新增类型（在 AppConfig 定义之后插入）

```typescript
// GroupEnvironment: dev = 本地开发无警告；sandbox = 沙箱/UAT，启动 Java 服务弹确认；
//                   prod = 生产，启动 Java 服务弹确认（更强视觉警示）
export type GroupEnvironment = 'dev' | 'sandbox' | 'prod'

export interface ProjectGroup {
  id: string
  name: string
  description?: string
  env: GroupEnvironment
  createdAt: number
  order: number
}

// 新建工作组的入参，id/order/createdAt 由主进程生成
export type NewProjectGroup = Pick<ProjectGroup, 'name'> &
  Partial<Pick<ProjectGroup, 'description'>>

// 渲染层可变更的工作组字段
export type ProjectGroupPatch = Partial<Pick<ProjectGroup, 'name' | 'description' | 'env'>>
```

### 4.2 修改 LaunchEntry（在 createdAt 字段之后添加）

```typescript
  // 所属工作组 ID（ProjectGroup.id）。
  // 未分组时为 undefined；工作组删除时主进程自动清空。
  groupId?: string
```

### 4.3 修改 AppConfig（新增 groups 字段）

```typescript
export interface AppConfig {
  version: number
  entries: LaunchEntry[]
  ignoredListeners: { processName: string; port: number }[]
  groupOverrides: GroupOverride[]
  watchedKeywords: string[]
  /** 工作组列表，v9 起。 */
  groups: ProjectGroup[]
  settings: Settings
}
```

### 4.4 修改 EditableEntryField（新增 groupId）

在现有字段列表末尾添加：
```typescript
  | 'groupId'
```

### 4.5 修改 EntryEdit（新增 groupId 字段）

在现有交叉类型末尾加：
```typescript
  // null 显式移出工作组；string 必须是 AppConfig.groups 中的有效 id
  groupId?: string | null
```

### 4.6 修改 EntryRuntime（新增 lastBuiltJar 字段）

```typescript
  // packageWithProfile 成功后主进程携带的最新 jar 相对路径（如 target/app-1.0.0.jar）
  lastBuiltJar?: string
```

### 4.7 修改 CONFIG_VERSION

```typescript
export const CONFIG_VERSION = 9
```

---
## 5. UI 流程设计

### 5.1 Launchpad 工作组视图

#### 5.1.1 视图模式切换器

在 Launchpad 工具栏最左侧、现有 StackTab nav 之前，插入视图模式分段控件（segmented 样式，
与现有 serviceFilter/taskFilter 分段控件样式一致）：

  [ 全部 ]  [ 工作组 ]

- 全部：现有视图（分类分组 + 技术栈 tab），无变化
- 工作组：切换到 GroupView，技术栈 tab 隐藏（工作组视图不按栈筛选）

视图模式持久化到 localStorage（键名 mile.launchpad.launchpadMode），下次打开沿用。

#### 5.1.2 工作组视图结构（GroupView.tsx）

  ┌─ [工作组选择器 v]  商城系统       [✎ 编辑]  [+ 新建工作组] ─┐
  │                                                             │
  │  环境: [ dev ]  [ sandbox ]  [ prod ]                       │
  │                                                             │
  │  ┌─ 警告横幅（仅 sandbox/prod 时显示）──────────────────┐  │
  │  └──────────────────────────────────────────────────────┘  │
  │                                                             │
  │  进程概况: ● 3 运行中   ○ 1 已停止   ○ 1 闲置              │
  │                                                             │
  │  ── 服务 ─────────────────────────────────────────────     │
  │  [EntryCard]  [EntryCard]  ...                              │
  │                                                             │
  │  ── 任务 ─────────────────────────────────────────────     │
  │  [EntryRow]  ...                                            │
  └─────────────────────────────────────────────────────────────┘

工作组选择器：<select> 元素，样式同现有 select 控件（appearance-none border-line bg-raised/40）。
进程概况：3 个计数，复用 isLiveStatus 工具函数，不新增图表组件。

#### 5.1.3 工作组创建/编辑（GroupDialog.tsx）

新建模式：
  - 名称输入框（1-40 字）
  - 说明输入框（可选，不超过 120 字）
  - 初始环境单选：dev / sandbox / prod
  - 取消 + 创建工作组按钮

编辑模式额外显示危险区：「删除工作组」按钮，点击后弹二次确认：
  「工作组下的 N 个条目将移出工作组，条目本身不会删除。」

#### 5.1.4 向工作组分配/移出条目

在 EntryCard / EntryRow 的 ... 上下文菜单中新增：
- 「加入工作组...」: 弹小型 popover 列出已有工作组，选中后 entry:edit({ groupId: id })
- 「移出工作组」（仅当 entry.groupId 存在时显示）: entry:edit({ groupId: null })

不新增专用 IPC，完全复用现有 entry:edit 的 groupId 字段扩展。

---

### 5.2 环境切换与警示横幅

#### 5.2.1 环境切换器样式（活跃态 Tailwind class）

- dev:     border-live/30 bg-live/8 text-live
- sandbox: border-warn/30 bg-warn/8 text-warn
- prod:    border-fault/30 bg-fault/8 text-fault

点击 sandbox 或 prod 时不立即切换，先显示确认模态。

#### 5.2.2 环境切换确认模态

沙箱示例：
  ┌─ 切换到沙箱环境 ──────────────────────────────────────┐
  │  ⚠  当前工作组「商城系统」将切换到沙箱环境。           │
  │                                                        │
  │  沙箱/生产环境下启动 Java 服务时会出现确认提示，        │
  │  打包操作将高亮推荐对应 profile。                      │
  │                                                        │
  │  [取消]                       [确认切换到沙箱]         │
  └────────────────────────────────────────────────────────┘

确认后调用 window.mile.group.patch(groupId, { env: sandbox })。

#### 5.2.3 环境警示横幅（EnvWarningBanner）

仅当 group.env !== dev 时显示，位于进程概况上方。

沙箱（图标 Phosphor Warning）：
  border-warn/25 bg-warn/7 text-warn
  「当前工作组运行在沙箱环境。启动 Java 服务时将弹出确认提示。」

生产（图标 Phosphor WarningDiamond）：
  border-fault/25 bg-fault/7 text-fault
  「当前工作组运行在生产环境。启动 Java 服务需要二次确认。」

横幅不染整体背景（bg/7 约 3% fill），符合「状态色只染边框不染底色」约束。

#### 5.2.4 Java 服务启动确认弹窗

触发条件：group.env !== dev  且  entry.framework === spring-boot

渲染层前置拦截（不在主进程做 UX 确认）：
1. GroupView 里 actionsFor 的 onStart 回调加判断
2. BackendConsole.tsx 的 ConsolePanel 接受 groupEnv prop，handleStart 加前置确认

弹窗示例（sandbox）：
  「在沙箱环境中启动服务」
  ⚠ 即将启动「order-service」，当前工作组环境：沙箱
  确认这不是意外操作？
  [取消]  [确认启动]

生产弹窗：更强措辞 + border-fault/35 边框。

#### 5.2.5 Profile 联动（env -> 推荐 profile）

在打包区 PackageButton 列表上方，当 env !== dev 且有匹配 profile 时显示提示：
  「当前环境「沙箱」-> 建议使用 sandbox / staging / uat 包」

匹配逻辑（复用现有 classifyProfile）：
```typescript
function suggestedProfilesFor(env: GroupEnvironment, profiles: string[]): string[] {
  if (env === 'prod') return profiles.filter(p => classifyProfile(p) === 'prod')
  if (env === 'sandbox') return profiles.filter(p => classifyProfile(p) === 'sandbox')
  return []  // dev 不做推荐
}
```

匹配的 PackageButton 加 ring-1 ring-accent/40 高亮边框，不强制，用户仍可选任意 profile。
无匹配时不显示提示（静默降级）。

---

### 5.3 后端控制台 UX 优化

#### 5.3.1 Package 完成后快捷操作条

触发条件：packageWithProfile 返回的 EntryRuntime.lastBuiltJar 非空。

位置：打包区（PackageButton 列表）下方，border-live/25 bg-live/7 细条：

  ┌─ ✓ 打包完成  target/app-1.0.0.jar  [在资源管理器中打开]  [切换到此 jar] ─┐
  └────────────────────────────────────────────────────────────────────────────┘

- 「在资源管理器中打开」: 调用 window.mile.entry.revealOutput(entry.id)
  （entry:revealOutput channel 已存在，无需修改）
- 「切换到此 jar」: edit(entry.id, { launchMode: jar, jarPath: lastBuiltJar })；
  服务运行中（live = true）时置灰，tooltip「请先停止服务再切换」

#### 5.3.2 渲染层状态管理

```typescript
// ConsolePanel 局部 state（不持久化，条目切换时随 mount 自动清空）
const [lastBuiltJar, setLastBuiltJar] = useState<string | null>(null)

const handlePackage = useCallback(async (profile: string | null) => {
  clearError()
  const runtime = await packageWithProfile(entry.id, profile)
  if (runtime?.lastBuiltJar) setLastBuiltJar(runtime.lastBuiltJar)
}, [packageWithProfile, entry.id, clearError])

const handleSwitchToJar = useCallback(async () => {
  if (!lastBuiltJar || live) return
  await edit(entry.id, { launchMode: 'jar', jarPath: lastBuiltJar })
  setLastBuiltJar(null)  // 成功后清除操作条
}, [edit, entry.id, lastBuiltJar, live])
```

ConsolePanel 以 key={selectedEntry.id} 渲染，切换条目时自动重新 mount，state 清空。

#### 5.3.3 主进程侧：packageWithProfile 增强

EntryService.packageWithProfile 在构建 exit code === 0 后：

```typescript
// 扫描 target/ 取最新非 -sources/-javadoc jar（listJars 已有此方法，直接复用）
const jars = await this.listJars(entryId)
if (jars.length > 0) {
  // listJars 已过滤 -sources/-javadoc，取第一个（已按 mtime 倒序）
  runtime.lastBuiltJar = jars[0]
}
return runtime
```

Package 失败（exit code != 0）时 lastBuiltJar 不携带，渲染层不显示操作条。

---
## 6. IPC 变更

### 6.1 新增 channels（src/shared/channels.ts）

在 Channels 对象末尾追加（位于 entrySwitchPort 之后）：

```typescript
  // 工作组 CRUD，PRD §11（v9 起）
  /** 获取所有工作组列表 */
  groupList:    'group:list',
  /** 新建工作组，校验字段后返回 ProjectGroup */
  groupAdd:     'group:add',
  /** 更新工作组字段（name/description/env），返回更新后的 ProjectGroup */
  groupPatch:   'group:patch',
  /** 删除工作组；同时将成员条目的 groupId 清空并广播 entry:changed */
  groupRemove:  'group:remove',
  /** 按 ids 顺序更新 order 字段，返回排序后的完整列表 */
  groupReorder: 'group:reorder',
  /** push：AppConfig.groups 变更时主进程广播，渲染层更新 store */
  groupChanged: 'group:changed',
```

### 6.2 主进程字段校验规则（GroupService）

| 字段 | 规则 |
|------|------|
| name | trim 后长度 1-40；禁 U+0000-U+001F / U+007F 控制字符 |
| description | 可选；trim 后不超过 120；禁控制字符 |
| env | 必须是 dev 或 sandbox 或 prod，否则 throw |
| groupId（entry:edit）| 必须是 AppConfig.groups 现有 id，或 null（移出组）；空串/不存在均 throw |

### 6.3 既有 channels 扩展

| Channel | 变更 |
|---------|------|
| entry:edit | EditableEntryField 新增 groupId；EntryEdit 新增 groupId?: string 或 null；主进程加白名单校验 |
| entry:packageWithProfile | 构建成功时返回的 EntryRuntime 新增 lastBuiltJar?: string |

entry:revealOutput 保持不变，直接复用。

### 6.4 Preload 新增 group namespace

src/preload/index.ts 的 api 对象中新增：

```typescript
group: {
  list: (): Promise<ProjectGroup[]> =>
    ipcRenderer.invoke(Channels.groupList),
  add: (input: NewProjectGroup): Promise<ProjectGroup> =>
    ipcRenderer.invoke(Channels.groupAdd, input),
  patch: (id: string, patch: ProjectGroupPatch): Promise<ProjectGroup> =>
    ipcRenderer.invoke(Channels.groupPatch, id, patch),
  remove: (id: string): Promise<void> =>
    ipcRenderer.invoke(Channels.groupRemove, id),
  reorder: (ids: string[]): Promise<ProjectGroup[]> =>
    ipcRenderer.invoke(Channels.groupReorder, ids),
  onChange: (cb: (groups: ProjectGroup[]) => void): (() => void) =>
    subscribe(Channels.groupChanged, cb),
},
```

src/preload/index.d.ts 同步更新类型声明（加 group namespace，类型与上述一致）。

---

## 7. 实现步骤

> 建议实施顺序: Phase 0 -> 1 -> 2 -> 5 -> 3 -> 4
>
> 先打通底层数据结构和后端控制台 UX 优化（最快见效、独立性最强），
> 再实现工作组 UI，最后加环境确认弹窗（依赖工作组 UI 完成）。
> 每个 Phase 完成后独立可验证，不阻塞后续 Phase 并行开发。

---

### Phase 0: 类型 + 配置迁移（无 UI，约 2-3 小时）

目标：app 在 v9 配置结构下正常启动，无现有功能回退。

- [ ] src/shared/types.ts:
  - 新增 GroupEnvironment、ProjectGroup、NewProjectGroup、ProjectGroupPatch
  - LaunchEntry 新增 groupId?: string
  - AppConfig 新增 groups: ProjectGroup[]
  - EditableEntryField 新增 groupId
  - EntryEdit 新增 groupId?: string | null
  - EntryRuntime 新增 lastBuiltJar?: string
  - CONFIG_VERSION = 9
- [ ] src/shared/channels.ts: 新增 6 个 group channels
- [ ] src/main/services/ConfigStore.ts:
  - DEFAULTS 补 groups: []
  - migrate() 新增 v8->v9 步骤（见第 8 节）
  - 校形代码块补 if (!Array.isArray(out.groups)) out.groups = []

验证：TypeScript 编译无报错；config.json 有 version:9 和 groups:[]；既有 entries 不变。

---

### Phase 1: 主进程 GroupService + IPC handler（约 3-4 小时）

目标：IPC 层可用，渲染层暂无 UI。

- [ ] 新建 src/main/services/GroupService.ts（list/add/patch/remove/reorder，含字段白名单校验）
- [ ] src/main/index.ts: 注册 6 个 group channel handler（参照 entry channel 的 ipcMain.handle 模式）
- [ ] src/preload/index.ts + src/preload/index.d.ts: 补 group namespace
- [ ] entry:edit handler 补 groupId 白名单校验

验证（DevTools console）:
```javascript
const g = await window.mile.group.add({ name: '测试工作组' })
await window.mile.group.list()
await window.mile.group.patch(g.id, { env: 'sandbox' })
await window.mile.group.remove(g.id)
await window.mile.group.list()  // 返回 []
```

---

### Phase 2: groups Zustand Store + 条目分配 UI（约 2 小时）

目标：渲染层可读写工作组，条目可从上下文菜单分配到组。

- [ ] 新建 src/renderer/src/store/groups.ts（仿 entries.ts 的 guard 模式）
- [ ] App.tsx: 初始化 groups store；订阅 window.mile.group.onChange
- [ ] EntryCard.tsx / EntryRow.tsx: 上下文菜单新增「加入工作组...」/ 「移出工作组」

验证：分配条目到工作组，config.json 中 groupId 已落盘；删除工作组，groupId 已清空。

---

### Phase 3: Launchpad 工作组视图（约 4-6 小时）

目标：启动台可以用工作组视图浏览条目。

- [ ] Launchpad.tsx: 新增视图模式 state（持久化 localStorage）；工具栏加模式切换器
- [ ] 新建 src/renderer/src/components/GroupView.tsx:
  工作组选择器、EnvWarningBanner、进程概况计数、条目列表（复用 EntryCard/EntryRow）
- [ ] 新建 src/renderer/src/components/GroupDialog.tsx: 创建/编辑/删除工作组的模态
- [ ] 环境切换确认模态（内联于 GroupView.tsx，useState 控制显示）

验证：
- 新建工作组，分配 2 个条目，工作组视图只显示这 2 个条目
- 切换环境到 sandbox，横幅出现（warn 黄色）；点取消，环境不变

---

### Phase 4: Java 服务启动环境确认（约 1-2 小时）

目标：sandbox/prod 环境下启动 spring-boot 条目时出现确认弹窗。

- [ ] GroupView.tsx 的 actionsFor onStart: 判断 env != dev 且 framework == spring-boot，弹确认
- [ ] BackendConsole.tsx ConsolePanel: 新增 groupEnv?: GroupEnvironment prop；handleStart 加前置确认

验证：
- sandbox 环境启动 spring-boot：弹窗出现，取消不启动，确认正常启动
- dev 环境直接启动，无弹窗
- sandbox 环境启动非 spring-boot（如 next.js）：无弹窗

---

### Phase 5: 后端控制台 UX 优化（约 2-3 小时）

目标：Package 完成后出现快捷操作条。

- [ ] EntryService.ts: packageWithProfile 成功（exit code 0）后 listJars(entryId)，取 jars[0]，写入 runtime.lastBuiltJar
- [ ] ConsolePanel.tsx: lastBuiltJar state；handlePackage 回调设置 state；渲染操作条；两个按钮逻辑
- [ ] 打包区: suggestedProfilesFor 计算推荐 profile；推荐按钮加 ring-1 ring-accent/40

验证：
- Package 成功后操作条出现，文件名正确
- 点「在资源管理器中打开」，资源管理器弹出且 jar 文件被选中
- 点「切换到此 jar」（服务停止），launchMode=jar，jarPath 更新，操作条消失
- 服务运行时「切换到此 jar」置灰，tooltip 正确
- Package 失败，无操作条
- 切换到其他条目再切回，操作条不显示（state 已清空）

---
## 8. 配置迁移 CONFIG_VERSION 8 -> 9

### 8.1 DEFAULTS 补全

src/main/services/ConfigStore.ts 中，DEFAULTS 对象的 watchedKeywords 字段之后添加：

```typescript
  groups: [],
```

### 8.2 migrate() 新增步骤

在现有「迁移后校形」代码块之前插入：

```typescript
// v8 -> v9: 工作组功能上线。
// - groups: 老文件里不存在此字段，补空数组。
// - LaunchEntry.groupId: 新增可选字段，老条目保持 undefined（未分组），无需回填。
// - 防御性清理: 若用户手动在 v8 config 里写了任意 groups 字段，
//   一律重置为空数组，不信任未经 GroupService 校验流程创建的数据。
if (from < 9) {
  out.groups = []
}
```

### 8.3 迁移后校形补充

在现有 if (!Array.isArray(out.entries)) 等校形代码之后补一行：

```typescript
if (!Array.isArray(out.groups)) out.groups = []
```

### 8.4 幂等性保证

if (from < 9) 确保重复运行同一步骤不会改变已有 groups 数据（v9 以上文件不触发）。

### 8.5 逆向兼容

v9 config 被旧版 app（不认识 groups 字段）加载时：
- groups 字段随 {...DEFAULTS, ...raw} 展开保留在内存
- 旧版 TypeScript 接口无 groups 字段，忽略多余字段，运行时不崩溃
- 工作组数据丢失，但条目完好——用户主动降级的可接受后果

---

## 9. 验证方案

项目暂无测试框架，采用「手动可重复剧本」方式验证。

### 9.1 配置迁移

| 步骤 | 期望 |
|------|------|
| 备份 v8 config，启动新版 app | config.json: version=9，groups=[]，既有 entries 完整保留 |
| 重启 app | version 仍是 9，未触发二次迁移 |

### 9.2 工作组 CRUD

| 操作 | 期望 |
|------|------|
| 新建「商城系统」 | groups 增一条，env=dev |
| 重命名 | name 更新并落盘 |
| 删除（无成员）| groups 减一条，无 entry 受影响 |
| 删除（有成员 N 个）| groups 减一条；N 个条目 groupId 清空；entry:changed 广播 |
| 空名称/超 40 字/含控制字符 | 主进程 throw，UI 显示错误 |
| env = staging（非枚举）| 主进程 throw |

### 9.3 条目分配

| 操作 | 期望 |
|------|------|
| 上下文菜单加入工作组 | groupId 落盘；工作组视图立刻显示该条目 |
| 移出工作组 | groupId 清空；从工作组视图消失，「全部」视图保留 |
| entry:edit groupId = nonexistent | 主进程 throw |
| entry:edit groupId = 空串 | 主进程 throw |

### 9.4 环境切换

| 操作 | 期望 |
|------|------|
| 点 sandbox -> 取消 | 环境不变，无横幅 |
| 点 sandbox -> 确认 | 落盘，横幅出现（warn 黄色调）|
| 点 prod -> 确认 | 落盘，横幅出现（fault 红色，更强措辞）|
| 切回 dev | 横幅消失 |
| sandbox 启动非 spring-boot | 无弹窗 |
| sandbox 启动 spring-boot | 弹窗出现，取消不启动，确认正常启动 |
| prod 启动 spring-boot | 弹窗出现，fault 红色边框 |

### 9.5 后端控制台 UX

| 操作 | 期望 |
|------|------|
| Package 成功 | 操作条出现，文件名正确 |
| Package 失败（exit!=0）| 无操作条，现有错误横幅正常显示 |
| 点「在资源管理器中打开」| 资源管理器弹出，jar 文件被选中 |
| 点「切换到此 jar」（服务停止）| launchMode=jar，jarPath 更新，操作条消失 |
| 点「切换到此 jar」（服务运行中）| 按钮置灰，tooltip 提示停止后切换 |
| 切换到其他条目再切回 | 操作条不显示（state 随 mount 清空）|
| sandbox 环境下 Package | sandbox profile 按钮有 ring-1 ring-accent/40 高亮 |

### 9.6 安全红线

| 场景 | 期望 |
|------|------|
| group:add name 含控制字符 | 主进程 throw，渲染层显示错误 |
| group:patch env = staging | 主进程 throw |
| entry:edit groupId = ../evil | 主进程 throw（不在 groups id 白名单）|

---

## 10. 约束备忘

| 约束 | 落实位置 |
|------|---------|
| 不允许用户自由输入命令 | profile 联动只改 profile 参数，经 assertSafeProfile 白名单；工作组不涉及命令构造 |
| 所有路径走白名单 | revealOutput/jarPath 现有机制不变；工作组不涉及文件路径 |
| IPC channel 在主进程校验 | GroupService 所有 handler 先校验再落盘，不信任渲染层输入 |
| entry:edit groupId 校验 | 主进程验证必须是 groups 现有 id 或 null；拒绝空串和不存在的 id |
| CONFIG_VERSION 8 -> 9 + migrate | Phase 0 实现，见第 8 节 |
| LaunchEntry 少加字段 | 仅加 groupId?: string，一个可选字段 |
| 不引入新依赖 | 纯 React + Zustand + Tailwind；randomUUID 来自 Node 内置 crypto |
| 无渐变 | 横幅用 bg-warn/7、bg-fault/7，无 gradient |
| Phosphor 图标 | Warning（沙箱横幅）、WarningDiamond（生产横幅）——均在已安装的 @phosphor-icons/react 中 |
| 1px 边框 | border-warn/25、border-fault/25，Tailwind border 默认 1px |
| 状态色只染边框不染底色 | bg/7 约 3% fill 作轻微底色提示，符合约束定义 |

---

*文档由 Claude Opus 4.8 于 2026-09-22 起草，供 Mile Terminal 开发团队评审。*  
*更新时请同步修改文件顶部的版本号与状态标记。*
