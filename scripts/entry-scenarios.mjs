// S21a 对拍场景：每个场景是一串步骤，生成脚本在原版 EntryService.ts 上逐步回放并记录，
// Go 侧（internal/entries/entries_test.go）拿同一串步骤在 Go 实现上回放并逐项比对。
//
// 步骤字段：
//   op      add / edit / sanitize / runtime / remove / reorder / list /
//           capturePort / taskStatus / isSafeRelative / normalizePath / groupEnv / startAfter / clock
//   sanitize 记录的是 `{...target, ...clean}` 合并后的条目 —— 与原版 `{...target, ...patch}` 的语义
//   一致，也比直接比补丁对象更能反映真实结果（补丁里 undefined / null 的差别会被 JSON 抹掉）。
//
// `<FIX>` 是生成时的临时夹具目录占位，生成脚本会建好 proj / proj2 并在写盘时替换回来；
// Go 测试建同名目录并替换成自己的临时目录。
//
// 不放进来的（Go 侧由类型系统挡住，见 MIGRATION-PLAN §6）：非字符串的 name / path / cwd /
// 非整数的 expectedPort（原版会 String() / Number() 隐式转换）、env 或 scripts 不是对象、
// healthCheck 缺 enabled、alertOnErrors 等不是布尔值。

const FIX = '<FIX>'

const BASE = {
  id: 'e1',
  kind: 'service',
  name: '条目一',
  path: FIX + '/proj',
  framework: 'next',
  packageManager: 'npm',
  script: 'dev',
  scripts: { dev: 'next dev', build: 'next build' },
  env: { A: '1' },
  registerOnly: false,
  pinned: false,
  order: 0,
  createdAt: 1_700_000_000_000
}

const entry = (over = {}) => ({ ...BASE, ...over })

// 一个等着被改的夹具条目，按 id 供 sanitize / edit 使用
const SEED = [
  // e1 带着端口、图标、健康检查与自动重启，用来验证「转成任务时一并清掉」
  entry({
    id: 'e1',
    order: 0,
    expectedPort: 3000,
    icon: 'rocket',
    healthCheck: { path: '/health', enabled: true },
    autoRestart: true
  }),
  entry({ id: 'e2', name: '条目二', order: 1, pinned: true }),
  entry({ id: 'e3', name: '任务一', kind: 'task', expectedPort: undefined, order: 2 }),
  entry({ id: 'e4', name: '生产服务', groupId: 'g2', order: 3 }),
  entry({ id: 'e5', name: 'Python 服务', framework: 'fastapi', launchMode: 'uvicorn', jarPath: 'app.main:app', order: 4 })
]

const GROUPS = [
  { id: 'g1', name: '开发', env: 'dev', order: 0 },
  { id: 'g2', name: '生产', env: 'prod', order: 1 },
  { id: 'g3', name: '沙箱', env: 'sandbox', order: 2 }
]

export const SCENARIOS = [
  {
    name: 'sanitize-name-category',
    entries: SEED,
    steps: [
      { op: 'sanitize', id: 'e1', patch: { name: '  新名字  ' } },
      { op: 'sanitize', id: 'e1', patch: { name: '   ' } },
      { op: 'sanitize', id: 'e1', patch: { name: 'a'.repeat(60) } },
      { op: 'sanitize', id: 'e1', patch: { name: 'a'.repeat(61) } },
      // 30 个 BMP 外字符（U+20000）= 60 个码元；这里换成 30 个是为了留在 60 码元以内
      // 用 fromCodePoint 而不是字面字符：源码里不放 emoji，也不依赖转义
      { op: 'sanitize', id: 'e1', patch: { name: String.fromCodePoint(0x20000).repeat(30) } },
      { op: 'sanitize', id: 'e1', patch: { category: '  前端  ' } },
      { op: 'sanitize', id: 'e1', patch: { category: '   ' } },
      { op: 'sanitize', id: 'e1', patch: { category: null } },
      { op: 'sanitize', id: 'e1', patch: { category: 'c'.repeat(40) } },
      { op: 'sanitize', id: 'e1', patch: { category: 'c'.repeat(41) } },
      { op: 'sanitize', id: 'e1', patch: { category: 'a\u0001b' } },
      { op: 'sanitize', id: 'e2', patch: { groupId: 'g1' } },
      { op: 'sanitize', id: 'e2', patch: { groupId: null } },
      { op: 'sanitize', id: 'e2', patch: { groupId: 'g'.repeat(64) } },
      { op: 'sanitize', id: 'e2', patch: { groupId: 'g'.repeat(65) } }
    ]
  },
  {
    name: 'sanitize-kind-icon-image',
    entries: SEED,
    steps: [
      { op: 'sanitize', id: 'e1', patch: { kind: 'task' } },
      { op: 'sanitize', id: 'e1', patch: { kind: 'service' } },
      { op: 'sanitize', id: 'e1', patch: { kind: 'other' } },
      { op: 'sanitize', id: 'e1', patch: { icon: 'rocket' } },
      { op: 'sanitize', id: 'e1', patch: { icon: 'nope' } },
      { op: 'sanitize', id: 'e1', patch: { icon: null } },
      { op: 'sanitize', id: 'e3', patch: { icon: 'rocket' } },
      { op: 'sanitize', id: 'e3', patch: { icon: 'rocket', kind: 'service' } },
      { op: 'sanitize', id: 'e1', patch: { imageId: null } },
      { op: 'sanitize', id: 'e1', patch: { imageId: 'abcdef123456.png' } },
      { op: 'sanitize', id: 'e1', patch: { pinned: true, registerOnly: true } },
      { op: 'sanitize', id: 'e1', patch: { pinned: false } }
    ]
  },
  {
    name: 'sanitize-paths',
    entries: SEED,
    steps: [
      { op: 'sanitize', id: 'e1', patch: { path: FIX + '/proj2' } },
      { op: 'sanitize', id: 'e1', patch: { path: 'relative/dir' } },
      { op: 'sanitize', id: 'e1', patch: { cwd: 'packages/web' } },
      { op: 'sanitize', id: 'e1', patch: { cwd: '  ' } },
      { op: 'sanitize', id: 'e1', patch: { cwd: 'C:\\abs' } },
      { op: 'sanitize', id: 'e1', patch: { cwd: '../escape' } },
      { op: 'sanitize', id: 'e1', patch: { cwd: 'a/../b' } },
      { op: 'sanitize', id: 'e1', patch: { outputDir: 'dist' } },
      { op: 'sanitize', id: 'e1', patch: { outputDir: '  ' } },
      { op: 'sanitize', id: 'e1', patch: { outputDir: null } },
      { op: 'sanitize', id: 'e1', patch: { outputDir: 'C:\\out' } },
      { op: 'sanitize', id: 'e1', patch: { outputDir: 'a/../dist' } }
    ]
  },
  {
    name: 'sanitize-env-scripts-script',
    entries: SEED,
    steps: [
      { op: 'sanitize', id: 'e1', patch: { env: { A: '2', B: '3' } } },
      { op: 'sanitize', id: 'e1', patch: { env: { A: null } } },
      { op: 'sanitize', id: 'e1', patch: { env: {} } },
      { op: 'sanitize', id: 'e1', patch: { env: { '1BAD': 'x' } } },
      { op: 'sanitize', id: 'e1', patch: { env: { 'A-B': 'x' } } },
      { op: 'sanitize', id: 'e1', patch: { env: { _ok: '', 'lower9': 'y' } } },
      { op: 'sanitize', id: 'e1', patch: { script: 'build' } },
      { op: 'sanitize', id: 'e1', patch: { script: null } },
      { op: 'sanitize', id: 'e1', patch: { scripts: { dev: 'next dev --turbo', other: 'x' } } },
      { op: 'sanitize', id: 'e1', patch: { scripts: {} } },
      { op: 'sanitize', id: 'e1', patch: { framework: 'vue-vite' } },
      { op: 'sanitize', id: 'e1', patch: { framework: 'nope' } },
      { op: 'sanitize', id: 'e1', patch: { packageManager: 'pnpm' } },
      { op: 'sanitize', id: 'e1', patch: { packageManager: 'nope' } }
    ]
  },
  {
    name: 'sanitize-port-launchmode',
    entries: SEED,
    steps: [
      { op: 'sanitize', id: 'e1', patch: { expectedPort: 3000 } },
      { op: 'sanitize', id: 'e1', patch: { expectedPort: 1 } },
      { op: 'sanitize', id: 'e1', patch: { expectedPort: 65535 } },
      { op: 'sanitize', id: 'e1', patch: { expectedPort: 0 } },
      { op: 'sanitize', id: 'e1', patch: { expectedPort: 65536 } },
      { op: 'sanitize', id: 'e1', patch: { expectedPort: null } },
      { op: 'sanitize', id: 'e3', patch: { expectedPort: 3000 } },
      { op: 'sanitize', id: 'e3', patch: { expectedPort: null } },
      // 启动方式：框架不支持 / 枚举外 / 本平台不支持 / 正常
      { op: 'sanitize', id: 'e1', patch: { launchMode: 'go-run' } },
      { op: 'sanitize', id: 'e1', patch: { launchMode: 'nope' } },
      { op: 'sanitize', id: 'e1', patch: { launchMode: 'go-run', framework: 'go' } },
      { op: 'sanitize', id: 'e1', patch: { launchMode: 'django', framework: 'django' } },
      { op: 'sanitize', id: 'e5', patch: { launchMode: null } },
      { op: 'sanitize', id: 'e5', patch: { launchMode: 'flask' } }
    ]
  },
  {
    name: 'sanitize-jarpath',
    entries: SEED,
    steps: [
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'target/app.jar', launchMode: 'jar', framework: 'spring-boot' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'target/app.zip', launchMode: 'jar', framework: 'spring-boot' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'target/APP.JAR', launchMode: 'jar', framework: 'spring-boot' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'C:\\abs\\app.jar', launchMode: 'jar', framework: 'spring-boot' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: '../app.jar', launchMode: 'jar', framework: 'spring-boot' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: null, launchMode: 'jar', framework: 'spring-boot' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'bin/app.exe', launchMode: 'cpp-exe', framework: 'cpp' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'bin/app', launchMode: 'cpp-exe', framework: 'cpp' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'main.py', launchMode: 'python-file', framework: 'python' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'main.txt', launchMode: 'python-file', framework: 'python' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'main file.py', launchMode: 'python-file', framework: 'python' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'app.main:app', launchMode: 'uvicorn', framework: 'fastapi' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'app.main-bad', launchMode: 'uvicorn', framework: 'fastapi' } },
      { op: 'sanitize', id: 'e1', patch: { jarPath: 'app/main.py:app', launchMode: 'python-module', framework: 'python' } },
      { op: 'sanitize', id: 'e5', patch: { jarPath: 'app.main:app' } }
    ]
  },
  {
    name: 'sanitize-lists',
    entries: SEED,
    steps: [
      { op: 'sanitize', id: 'e1', patch: { startAfter: ['e2', 'e3'] } },
      { op: 'sanitize', id: 'e1', patch: { startAfter: ['e2', 'e2', 'e3'] } },
      { op: 'sanitize', id: 'e1', patch: { startAfter: [] } },
      { op: 'sanitize', id: 'e1', patch: { startAfter: null } },
      { op: 'sanitize', id: 'e1', patch: { startAfter: Array.from({ length: 33 }, (_, i) => 'x' + i) } },
      { op: 'sanitize', id: 'e1', patch: { startAfter: Array.from({ length: 32 }, (_, i) => 'x' + i) } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/health', enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/', enabled: false } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: 'health', enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '//evil', enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/a b', enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/a#b', enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/a@b', enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/' + 'a'.repeat(255), enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/' + 'a'.repeat(256), enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: { path: '/ok?x=1&y=%20', enabled: true } } },
      { op: 'sanitize', id: 'e1', patch: { healthCheck: null } },
      { op: 'sanitize', id: 'e1', patch: { alertKeywords: ['  timeout  ', 'timeout', '', 'ERROR'] } },
      { op: 'sanitize', id: 'e1', patch: { alertKeywords: [] } },
      { op: 'sanitize', id: 'e1', patch: { alertKeywords: null } },
      { op: 'sanitize', id: 'e1', patch: { alertKeywords: Array.from({ length: 11 }, (_, i) => 'k' + i) } },
      { op: 'sanitize', id: 'e1', patch: { alertKeywords: ['k'.repeat(65)] } },
      { op: 'sanitize', id: 'e1', patch: { alertKeywords: ['k'.repeat(64)] } },
      { op: 'sanitize', id: 'e1', patch: { alertKeywords: ['a\u0001b'] } }
    ]
  },
  {
    name: 'sanitize-task-clearing',
    entries: SEED,
    steps: [
      // 服务转任务：端口、图标、健康检查一起清掉，自动重启也一并撤掉
      { op: 'sanitize', id: 'e1', patch: { kind: 'task' } },
      { op: 'sanitize', id: 'e1', patch: { kind: 'task', icon: null, healthCheck: null } },
      // 转回服务后字段是空的，可以重新设
      { op: 'sanitize', id: 'e1', patch: { kind: 'service', expectedPort: 3000 } },
      // 已经是任务时再给健康检查 / 自动重启：拒绝
      { op: 'sanitize', id: 'e3', patch: { healthCheck: { path: '/h', enabled: true } } },
      { op: 'sanitize', id: 'e3', patch: { autoRestart: true } },
      { op: 'sanitize', id: 'e3', patch: { autoRestart: false } },
      // 任务带 autoRestart:false 不报错
      { op: 'sanitize', id: 'e3', patch: { autoRestart: false, alertOnErrors: true } },
      { op: 'sanitize', id: 'e1', patch: { autoRestart: true, alertOnErrors: true } }
    ]
  },
  {
    name: 'add',
    entries: SEED,
    steps: [
      {
        op: 'add',
        input: {
          kind: 'service',
          name: '新服务',
          path: FIX + '/proj',
          framework: 'next',
          packageManager: 'npm',
          script: 'dev',
          scripts: { dev: 'next dev' },
          env: { PORT: '3000' }
        }
      },
      { op: 'add', input: { kind: 'service', path: FIX + '/proj', framework: 'next', packageManager: 'npm' } },
      { op: 'add', input: { kind: 'service', name: 'x', framework: 'next', packageManager: 'npm' } },
      { op: 'add', input: { kind: 'service', name: 'x', path: FIX + '/missing', framework: 'next', packageManager: 'npm' } },
      {
        op: 'add',
        input: {
          kind: 'service',
          name: 'x',
          path: FIX + '/proj',
          framework: 'next',
          packageManager: 'npm',
          script: 'nope',
          scripts: { dev: 'next dev' }
        }
      },
      {
        op: 'add',
        input: {
          kind: 'service',
          name: 'x',
          path: FIX + '/proj',
          framework: 'next',
          packageManager: 'npm',
          script: 'a b',
          scripts: { 'a b': 'next dev' }
        }
      },
      // 白名单外的键静默丢弃：id / order / createdAt 不生效
      {
        op: 'add',
        input: {
          kind: 'service',
          name: '带额外键',
          path: FIX + '/proj2',
          framework: 'static',
          packageManager: 'npm',
          id: 'hacked',
          order: 99,
          createdAt: 1,
          env: {}
        }
      },
      { op: 'list' }
    ]
  },
  {
    name: 'edit-locked-and-validation',
    entries: SEED,
    steps: [
      { op: 'runtime', id: 'e1', status: 'running' },
      // 非身份字段可以改
      { op: 'edit', id: 'e1', patch: { name: '改个名字' } },
      // 身份字段被挡
      { op: 'edit', id: 'e1', patch: { expectedPort: 3000 } },
      { op: 'edit', id: 'e1', patch: { path: FIX + '/proj2' } },
      { op: 'edit', id: 'e1', patch: { env: { A: '2' } } },
      { op: 'edit', id: 'e1', patch: { env: { A: '1' } } },
      { op: 'edit', id: 'e1', patch: { cwd: 'sub' } },
      { op: 'edit', id: 'e1', patch: { launchMode: 'go-run', framework: 'go' } },
      // 多个身份字段一起被挡，文案按字段顺序
      { op: 'edit', id: 'e1', patch: { expectedPort: 3001, cwd: 'sub2', env: { B: '2' } } },
      { op: 'runtime', id: 'e1', status: 'stopped' },
      { op: 'edit', id: 'e1', patch: { expectedPort: 3000 } },
      // 换目录必须存在
      { op: 'edit', id: 'e2', patch: { path: FIX + '/missing' } },
      { op: 'edit', id: 'e2', patch: { path: FIX + '/proj2' } },
      // 脚本必须已声明
      { op: 'edit', id: 'e2', patch: { script: 'nope' } },
      { op: 'edit', id: 'e2', patch: { script: 'build' } },
      { op: 'edit', id: 'e2', patch: { script: 'nope', scripts: { nope: 'x' } } },
      { op: 'edit', id: 'e2', patch: { script: 'a b', scripts: { 'a b': 'x' } } },
      // startAfter 校验
      { op: 'edit', id: 'e2', patch: { startAfter: ['e2'] } },
      { op: 'edit', id: 'e2', patch: { startAfter: ['zzz'] } },
      { op: 'edit', id: 'e2', patch: { startAfter: ['e1'] } },
      { op: 'edit', id: 'e2', patch: { startAfter: ['e1', 'e3'] } },
      // 自动重启只在 dev 环境
      { op: 'edit', id: 'e4', patch: { autoRestart: true } },
      { op: 'edit', id: 'e4', patch: { autoRestart: true, groupId: 'g1' } },
      { op: 'edit', id: 'e4', patch: { autoRestart: true, groupId: null } },
      { op: 'edit', id: 'e1', patch: { autoRestart: true } },
      { op: 'edit', id: 'nope', patch: { name: 'x' } },
      { op: 'list' }
    ]
  },
  {
    name: 'crud',
    entries: SEED,
    steps: [
      { op: 'list' },
      { op: 'reorder', ids: ['e4', 'e1'] },
      { op: 'list' },
      { op: 'reorder', ids: [] },
      { op: 'list' },
      { op: 'reorder', ids: ['e3', 'e1', 'e2', 'e4', 'e5'] },
      { op: 'list' },
      { op: 'remove', id: 'e2' },
      { op: 'list' },
      { op: 'remove', id: 'nope' },
      { op: 'remove', id: 'e1' },
      { op: 'list' }
    ]
  },
  {
    name: 'utils',
    entries: SEED,
    steps: [
      // 端口捕获：PORT_PATTERNS 每条一个样例，顺序在前面的先命中
      { op: 'capturePort', chunk: 'Tomcat started on port(s): 8080 (http)' },
      { op: 'capturePort', chunk: 'Netty started on port 9090' },
      { op: 'capturePort', chunk: 'Tomcat initialized with port 7070 (http)' },
      { op: 'capturePort', chunk: 'ready at http://localhost:5173/' },
      { op: 'capturePort', chunk: 'ready at http://127.0.0.1:6001/' },
      { op: 'capturePort', chunk: '\x1b[32mLocal:\x1b[39m   \x1b[36mhttp://localhost:3000\x1b[39m' },
      { op: 'capturePort', chunk: 'Server listening on port 4000' },
      { op: 'capturePort', chunk: 'now on port 5500' },
      // 被占用那句话说 3000，真正在听的 3001
      { op: 'capturePort', chunk: 'Port 3000 is in use by process 14944, using available port 3001 instead.' },
      { op: 'capturePort', chunk: 'Error: address already in use :::3000\nLocal: http://localhost:3001' },
      // 两个都在：先命中前面的
      { op: 'capturePort', chunk: 'http://localhost:1234 and port 5678' },
      // 端口越界与没有端口
      { op: 'capturePort', chunk: 'http://localhost:70000/' },
      { op: 'capturePort', chunk: 'nothing here' },
      { op: 'capturePort', chunk: 'Tomcat started on port\uff0812345\uff09' },
      // 任务状态
      { op: 'taskStatus', code: 0, stoppedByUser: false },
      { op: 'taskStatus', code: 130, stoppedByUser: false },
      { op: 'taskStatus', code: 1, stoppedByUser: false },
      { op: 'taskStatus', code: 1, stoppedByUser: true },
      { op: 'taskStatus', code: 0, stoppedByUser: true },
      // 相对路径判定
      { op: 'isSafeRelative', p: 'dist/app.jar' },
      { op: 'isSafeRelative', p: '../app.jar' },
      { op: 'isSafeRelative', p: 'a/../b' },
      { op: 'isSafeRelative', p: 'a\\..\\b' },
      { op: 'isSafeRelative', p: 'C:\\abs' },
      // 路径比较键
      { op: 'normalizePath', p: 'C:\\Proj\\Web\\' },
      { op: 'normalizePath', p: 'c:/proj/web' },
      { op: 'normalizePath', p: 'C:\\proj\\web\\packages' },
      // 工作组环境：未分组 / 已删除 / 三种取值
      { op: 'groupEnv', groupId: undefined },
      { op: 'groupEnv', groupId: '' },
      { op: 'groupEnv', groupId: 'g1' },
      { op: 'groupEnv', groupId: 'g2' },
      { op: 'groupEnv', groupId: 'g3' },
      { op: 'groupEnv', groupId: 'gone' },
      // startAfter：自指 / 不存在 / 成环 / 正常
      { op: 'startAfter', id: 'e1', deps: ['e1'] },
      { op: 'startAfter', id: 'e1', deps: ['zzz'] },
      { op: 'startAfter', id: 'e1', deps: ['e2', 'e3'] }
    ]
  },
  {
    name: 'startafter-cycle',
    entries: [
      entry({ id: 'e1', startAfter: ['e2'] }),
      entry({ id: 'e2', startAfter: ['e3'] }),
      entry({ id: 'e3', startAfter: [] }),
      entry({ id: 'e4', startAfter: ['e3'] })
    ],
    steps: [
      { op: 'startAfter', id: 'e3', deps: ['e1'] },
      { op: 'startAfter', id: 'e3', deps: ['e4'] },
      { op: 'startAfter', id: 'e1', deps: ['e3'] },
      { op: 'startAfter', id: 'e4', deps: ['e1', 'e3'] }
    ]
  }
]

export { FIX, GROUPS }
