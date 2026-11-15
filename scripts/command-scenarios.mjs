// S21b 对拍场景：命令构造。生成脚本在原版 EntryService.ts 上逐步回放并记录，
// Go 侧（internal/entries/command_test.go）用同一份夹具目录结构重放。
//
// 夹具目录（生成脚本与 Go 测试各自建一份，内容一致；JSON 里写 <FIX> 占位）：
//   <FIX>/bin/{npm.cmd,pnpm.cmd,yarn.cmd,bun.exe,java.exe,mvn.cmd,gradle.bat,python.exe,go.exe,cargo.exe}
//   <FIX>/proj/{package.json,manage.py,mvnw.cmd,gradlew.bat,main.py,target/app.jar,bin/app.exe,cmd/}
//   <FIX>/proj/cmd/package.json   （子目录自己也有脚本表，用于 cwd 落在子目录的场景）
//   <FIX>/proj2/package.json
//   <FIX>/outside/
// PATH 只留 <FIX>/bin，所以 whichAny 只会命中夹具里的假可执行文件。
//
// 步骤字段：op = build | spawn
//   build  entry / script（null 表示 install 形态）→ {file, args, title}
//   spawn  entry / script / kind → sessions.create 的入参与运行态

const FIX = '<FIX>'

const base = (over = {}) => ({
  id: 'e1',
  kind: 'service',
  name: '服务一',
  path: FIX + '/proj',
  framework: 'next',
  packageManager: 'npm',
  script: 'dev',
  scripts: { dev: 'next dev' },
  env: { PORT: '3000' },
  registerOnly: false,
  pinned: false,
  order: 0,
  createdAt: 1_700_000_000_000,
  ...over
})

const sb = (over = {}) => base({ framework: 'spring-boot', packageManager: 'npm', script: null, ...over })

export const SCENARIOS = [
  {
    name: 'npm',
    steps: [
      { op: 'build', entry: base({}), script: 'dev' },
      { op: 'build', entry: base({}), script: null },
      { op: 'build', entry: base({}), script: 'build' },
      { op: 'build', entry: base({ scripts: { dev: 'next dev' } }), script: 'nope' },
      { op: 'build', entry: base({}), script: 'a b' },
      { op: 'build', entry: base({ packageManager: 'pnpm' }), script: 'dev' },
      { op: 'build', entry: base({ packageManager: 'yarn' }), script: 'dev' },
      { op: 'build', entry: base({ packageManager: 'bun' }), script: 'dev' }
    ]
  },
  {
    name: 'spring-boot',
    steps: [
      { op: 'build', entry: sb({ launchMode: 'maven-wrapper' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'gradle-wrapper' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'jar', jarPath: 'target/app.jar' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'jar', jarPath: 'target/app.zip' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'jar', jarPath: 'target/missing.jar' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'jar', jarPath: 'C:\\abs\\app.jar' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'jar', jarPath: '../app.jar' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'jar' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'system-maven' }), script: null },
      { op: 'build', entry: sb({ launchMode: 'system-gradle' }), script: null },
      { op: 'build', entry: sb({ launchMode: undefined }), script: null },
      { op: 'build', entry: sb({ launchMode: 'go-run' }), script: null },
      // wrapper 不在项目里
      { op: 'build', entry: sb({ path: FIX + '/proj2', launchMode: 'maven-wrapper' }), script: null },
      { op: 'build', entry: sb({ path: FIX + '/proj2', launchMode: 'gradle-wrapper' }), script: null }
    ]
  },
  {
    name: 'python',
    steps: [
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-file', jarPath: 'main.py' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-file', jarPath: 'missing.py' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-file', jarPath: 'main.txt' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-file', jarPath: 'main file.py' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-file' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-module', jarPath: 'app.main' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-module', jarPath: 'bad-name' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'python-module' }), script: null },
      { op: 'build', entry: base({ framework: 'fastapi', launchMode: 'uvicorn', jarPath: 'app.main:app' }), script: null },
      { op: 'build', entry: base({ framework: 'fastapi', launchMode: 'uvicorn', jarPath: 'bad app' }), script: null },
      { op: 'build', entry: base({ framework: 'flask', launchMode: 'flask' }), script: null },
      { op: 'build', entry: base({ framework: 'django', launchMode: 'django' }), script: null },
      { op: 'build', entry: base({ framework: 'django', launchMode: 'django', path: FIX + '/proj2' }), script: null },
      { op: 'build', entry: base({ framework: 'python', launchMode: 'jar' }), script: null },
      { op: 'build', entry: base({ framework: 'streamlit', launchMode: 'flask' }), script: null }
    ]
  },
  {
    name: 'go-rust-cpp',
    steps: [
      { op: 'build', entry: base({ framework: 'go', launchMode: 'go-run' }), script: null },
      { op: 'build', entry: base({ framework: 'go', launchMode: 'go-run', jarPath: 'cmd/app' }), script: null },
      { op: 'build', entry: base({ framework: 'go', launchMode: 'go-run', jarPath: '  ./cmd  ' }), script: null },
      { op: 'build', entry: base({ framework: 'go', launchMode: 'go-run', jarPath: '../escape' }), script: null },
      { op: 'build', entry: base({ framework: 'go', launchMode: 'go-run', jarPath: 'bad pkg' }), script: null },
      { op: 'build', entry: base({ framework: 'go', launchMode: 'python-file' }), script: null },
      { op: 'build', entry: base({ framework: 'rust', launchMode: 'cargo-run' }), script: null },
      { op: 'build', entry: base({ framework: 'rust', launchMode: 'cargo-run-release' }), script: null },
      { op: 'build', entry: base({ framework: 'rust', launchMode: 'go-run' }), script: null },
      { op: 'build', entry: base({ framework: 'cpp', launchMode: 'cpp-exe', jarPath: 'bin/app.exe' }), script: null },
      { op: 'build', entry: base({ framework: 'cpp', launchMode: 'cpp-exe', jarPath: 'bin/app' }), script: null },
      { op: 'build', entry: base({ framework: 'cpp', launchMode: 'cpp-exe' }), script: null },
      { op: 'build', entry: base({ framework: 'cpp', launchMode: 'jar' }), script: null }
    ]
  },
  {
    name: 'spawn',
    steps: [
      // cwd 落在条目内：正常起会话，标题是「名称 · 子标题」
      { op: 'spawn', entry: base({}), script: 'dev', kind: 'dev' },
      { op: 'spawn', entry: base({ cwd: 'cmd' }), script: 'dev', kind: 'dev' },
      { op: 'spawn', entry: base({}), script: null, kind: 'install' },
      { op: 'spawn', entry: base({}), script: 'dev', kind: 'build' },
      // cwd 是绝对路径且在条目外：拒绝
      { op: 'spawn', entry: base({ cwd: FIX + '/outside' }), script: 'dev', kind: 'dev' },
      // cwd 用 .. 跳出
      { op: 'spawn', entry: base({ cwd: '../outside' }), script: 'dev', kind: 'dev' }
    ]
  }
]

export { FIX }
