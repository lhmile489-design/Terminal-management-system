// S17 对拍场景。每个场景：
//   files    项目树（相对 <ROOT>）：字符串 = 文件内容，{ dir: true } = 空目录
//   path     PATH 的各段（相对 <ROOT> 的目录，'' 原样保留为空段）；null = PATH 未设置
//   entry    条目（path / cwd 里的 <ROOT> 由生成脚本和 Go 测试各自换成真实路径）
//   snapshot / all   采集快照与全部条目
//   node     本进程的 Node 版本（原版 process.versions.node，Go 侧经 Options.NodeVersion 注入）
//   statfs   { bsize, bavail } 或 'throw'；freePort   findFreePort(start) 的返回表，键是 start
// 不带的字段取 base 的默认值。

const B = String.fromCharCode(92)
export const R = (rel) => '<ROOT>' + (rel ? B + rel.split('/').join(B) : '')

const BIG = { bsize: 4096, bavail: 1000000 }
const pkg = (o) => JSON.stringify(o)
const npmProject = (extra = {}) => ({
  'p/package.json': pkg({ scripts: { dev: 'vite' }, engines: { node: '>=18' } }),
  'p/node_modules': { dir: true },
  'p/package-lock.json': '{}',
  ...extra,
})
const npmBin = { 'bin/npm.cmd': '' }

const base = {
  files: npmProject(npmBin),
  path: ['bin'],
  entry: { id: 'e1', kind: 'service', name: 'web', path: R('p'), framework: 'react-vite', packageManager: 'npm', script: 'dev', scripts: {}, env: {}, registerOnly: false, pinned: false, order: 0, createdAt: 0 },
  snapshot: null,
  all: [],
  node: '22.23.4',
  statfs: BIG,
  freePort: {},
}

const e = (patch) => ({ ...base.entry, ...patch })
const L = (pid, ports, processName, ownership, entryId) => ({ pid, ports, processName, ownership, entryId, cpu: null, memory: 0, group: 'mine', groupOverridden: false, launchSource: 'unknown' })
const snap = (...listeners) => ({ at: 1, listeners, unmanaged: [], watched: [], system: { cpu: null, memory: 0 }, portConflicts: 0, failed: false, lastSuccessAt: 1 })
const other = (id, name, port) => e({ id, name, expectedPort: port })

const raw = [
  // ---- 工作目录 ----
  { name: 'ok-all' },
  { name: 'cwd-missing', files: {}, entry: e({ path: R('nope') }) },
  { name: 'cwd-is-file', files: { p: 'x' } },
  { name: 'cwd-relative', files: { ...npmBin, 'p/packages/web/package.json': pkg({ scripts: { dev: 'x' } }) }, entry: e({ cwd: 'packages/web' }) },
  { name: 'cwd-relative-dotdot', files: { ...npmBin, 'p/x': '', 'q/package.json': pkg({ scripts: { dev: 'x' } }) }, entry: e({ cwd: '../q' }) },
  { name: 'cwd-absolute', files: { ...npmBin, 'other/package.json': pkg({ scripts: { dev: 'x' } }) }, entry: e({ cwd: R('other') }) },
  { name: 'cwd-forward-slash', files: { ...npmBin, 'p/sub/package.json': '{}' }, entry: e({ cwd: './sub/' }) },

  // ---- 仅登记 ----
  { name: 'register-only', entry: e({ framework: 'hugo', registerOnly: true }) },
  { name: 'register-only-node', entry: e({ registerOnly: true }) },

  // ---- package.json ----
  { name: 'pkg-missing', files: { ...npmBin, 'p/node_modules': { dir: true } } },
  { name: 'pkg-bad-json', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts": {"dev": "x",}}' }) },
  { name: 'pkg-is-dir', files: npmProject({ ...npmBin, 'p/package.json': { dir: true } }) },
  { name: 'pkg-null', files: npmProject({ ...npmBin, 'p/package.json': 'null' }) },
  { name: 'pkg-number', files: npmProject({ ...npmBin, 'p/package.json': '5' }) },
  { name: 'pkg-array', files: npmProject({ ...npmBin, 'p/package.json': '[{"scripts":{"dev":"x"}}]' }) },
  { name: 'pkg-bom', files: npmProject({ ...npmBin, 'p/package.json': String.fromCharCode(0xfeff) + '{}' }) },
  { name: 'pkg-empty', files: npmProject({ ...npmBin, 'p/package.json': '' }) },

  // ---- 脚本 ----
  { name: 'script-null', entry: e({ script: null }) },
  { name: 'script-empty', entry: e({ script: '' }) },
  { name: 'script-missing-list', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":{"b":"1","2":"x","a":"y","1":"z","__proto__":"p","n":3}}' }), entry: e({ script: 'serve' }) },
  { name: 'script-missing-empty', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":{}}' }), entry: e({ script: 'serve' }) },
  { name: 'script-non-string', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":{"dev":1}}' }) },
  { name: 'script-proto', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":{"__proto__":"x","dev":"y"}}' }), entry: e({ script: '__proto__' }) },
  { name: 'script-constructor', entry: e({ script: 'constructor' }) },
  { name: 'script-tostring', entry: e({ script: 'toString' }) },
  { name: 'scripts-array', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":["dev"]}' }) },
  { name: 'script-empty-key', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":{"":"x","dev":"y"}}' }), entry: e({ script: '' }) },
  { name: 'script-chinese', files: npmProject({ ...npmBin, 'p/package.json': pkg({ scripts: { '开发': 'vite --host' } }) }), entry: e({ script: '开发' }) },

  // ---- 包管理器 ----
  { name: 'pm-pnpm-missing', files: npmProject({ 'bin/npm.cmd': '', 'bin2/yarn.exe': '' }), path: ['bin', 'bin2'], entry: e({ packageManager: 'pnpm' }) },
  { name: 'pm-npm-missing-none', files: npmProject({}), path: ['bin'] },
  { name: 'pm-bun-found', files: npmProject({ 'bin/bun.exe': '' }), entry: e({ packageManager: 'bun' }) },
  { name: 'pm-dir-counts', files: npmProject({ 'bin/npm.cmd': { dir: true } }) },
  { name: 'pm-path-order', files: npmProject({ 'b1/x': '', 'b2/npm.exe': '', 'b3/npm.cmd': '' }), path: ['b1', '', 'b2', 'b3'] },
  { name: 'pm-candidate-order', files: npmProject({ 'bin/npm.exe': '', 'bin/npm.cmd': '' }) },
  { name: 'pm-path-unset', path: null },
  { name: 'pm-path-empty', path: [] },
  { name: 'pm-yarn-all-detected', files: npmProject({ 'bin/npm.cmd': '', 'bin/pnpm.exe': '', 'bin/bun.exe': '' }), entry: e({ packageManager: 'yarn' }) },

  // ---- Node 版本 ----
  { name: 'node-no-engines', files: npmProject({ ...npmBin, 'p/package.json': pkg({ scripts: { dev: 'x' } }) }) },
  { name: 'node-engines-empty', files: npmProject({ ...npmBin, 'p/package.json': pkg({ scripts: { dev: 'x' }, engines: { node: '' } }) }) },
  { name: 'node-unparseable', files: npmProject({ ...npmBin, 'p/package.json': pkg({ scripts: { dev: 'x' }, engines: { node: 'latest' } }) }) },
  { name: 'node-too-old', files: npmProject({ ...npmBin, 'p/package.json': pkg({ scripts: { dev: 'x' }, engines: { node: '>=99' } }) }) },
  { name: 'node-range-ok', files: npmProject({ ...npmBin, 'p/package.json': pkg({ scripts: { dev: 'x' }, engines: { node: '^20 || ^22' } }) }) },
  { name: 'node-engines-number', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":{"dev":"x"},"engines":{"node":22}}' }) },
  { name: 'node-engines-array', files: npmProject({ ...npmBin, 'p/package.json': '{"scripts":{"dev":"x"},"engines":[">=18"]}' }) },
  { name: 'node-old-runtime', node: '16.20.2' },

  // ---- node_modules 与锁文件 ----
  { name: 'nm-missing', files: { ...npmBin, 'p/package.json': pkg({ scripts: { dev: 'x' } }) } },
  { name: 'nm-is-file', files: { ...npmBin, 'p/package.json': pkg({ scripts: { dev: 'x' } }), 'p/node_modules': '' } },
  { name: 'lock-mismatch', files: { ...npmBin, 'p/package.json': '{}', 'p/node_modules': { dir: true }, 'p/yarn.lock': '' } },
  { name: 'lock-match-pnpm', files: { 'bin/pnpm.cmd': '', 'p/package.json': '{}', 'p/node_modules': { dir: true }, 'p/pnpm-lock.yaml': '' }, entry: e({ packageManager: 'pnpm' }) },
  { name: 'lock-none', files: { ...npmBin, 'p/package.json': '{}', 'p/node_modules': { dir: true } } },

  // ---- 端口 ----
  { name: 'port-zero', entry: e({ expectedPort: 0 }) },
  { name: 'port-no-snapshot', entry: e({ expectedPort: 3000 }) },
  { name: 'port-free', entry: e({ expectedPort: 3000 }), snapshot: snap(L(10, [5173], 'node.exe', 'external')) },
  { name: 'port-self-only', entry: e({ expectedPort: 3000 }), snapshot: snap(L(10, [3000], 'node.exe', 'owned', 'e1')) },
  { name: 'port-self-and-external', entry: e({ expectedPort: 3000 }), snapshot: snap(L(10, [3000], 'node.exe', 'owned', 'e1'), L(20, [3000, 3001], 'vite.exe', 'external')), freePort: { 3001: 3002 } },
  { name: 'port-owned-not-first', entry: e({ expectedPort: 3000 }), snapshot: snap(L(20, [3000], 'a.exe', 'external'), L(30, [3000], 'b.exe', 'owned', 'e2'), L(40, [3000], 'c.exe', 'owned', 'e3')) },
  { name: 'port-two-others', entry: e({ expectedPort: 3000 }), snapshot: snap(L(20, [3000], 'a.exe', 'external'), L(21, [3000], 'b.exe', 'external')) },
  { name: 'port-external-next', entry: e({ expectedPort: 3000, framework: 'next' }), snapshot: snap(L(20, [3000], 'node.exe', 'external')), freePort: { 3001: 3005 } },
  { name: 'port-external-next-none', entry: e({ expectedPort: 3000, framework: 'next' }), snapshot: snap(L(20, [3000], 'node.exe', 'external')) },
  { name: 'port-config-conflict', entry: e({ expectedPort: 4000 }), all: [base.entry, other('e2', '后台', 4000), other('e3', 'api', 4000), other('e4', 'x', 4001)], freePort: { 4001: 4002 } },
  { name: 'port-config-conflict-next', entry: e({ expectedPort: 4000, framework: 'next' }), all: [other('e2', '后台', 4000)], freePort: { 4001: 4002 } },
  { name: 'port-config-conflict-next-none', entry: e({ expectedPort: 4000, framework: 'next' }), all: [other('e2', '后台', 4000)] },
  { name: 'port-config-conflict-self-id', entry: e({ expectedPort: 4000 }), all: [e({ expectedPort: 4000, name: 'dup-self' })] },
  { name: 'port-config-conflict-live', entry: e({ expectedPort: 4000 }), all: [other('e2', '后台', 4000)], snapshot: snap(L(50, [4000], 'java.exe', 'owned', 'e2')) },
  { name: 'port-config-conflict-self-live', entry: e({ expectedPort: 4000 }), all: [other('e2', '后台', 4000)], snapshot: snap(L(50, [4000], 'node.exe', 'owned', 'e1')) },

  // ---- 磁盘 ----
  { name: 'disk-throw', statfs: 'throw' },
  { name: 'disk-small', statfs: { bsize: 4096, bavail: 1000 } },
  { name: 'disk-exact', statfs: { bsize: 1024 * 1024, bavail: 500 } },
  { name: 'disk-just-over', statfs: { bsize: 1, bavail: 500 * 1024 * 1024 + 1 } },
  { name: 'disk-round-half', statfs: { bsize: 1, bavail: 600 * 1024 * 1024 + 524288 } },
  { name: 'disk-round-down', statfs: { bsize: 1, bavail: 600 * 1024 * 1024 + 524287 } },

  // ---- Spring Boot ----
  { name: 'sb-no-mode', files: { 'p/pom.xml': '' }, entry: e({ framework: 'spring-boot', expectedPort: 8080 }) },
  { name: 'sb-mvnw-ok', files: { 'p/mvnw.cmd': '' }, entry: e({ framework: 'spring-boot', launchMode: 'maven-wrapper' }) },
  { name: 'sb-mvnw-missing', files: { 'p/pom.xml': '' }, entry: e({ framework: 'spring-boot', launchMode: 'maven-wrapper' }) },
  { name: 'sb-mvnw-dir', files: { 'p/mvnw.cmd': { dir: true } }, entry: e({ framework: 'spring-boot', launchMode: 'maven-wrapper' }) },
  { name: 'sb-gradlew-ok', files: { 'p/gradlew.bat': '' }, entry: e({ framework: 'spring-boot', launchMode: 'gradle-wrapper' }) },
  { name: 'sb-jar-none', files: { 'p/x': '', 'bin/java.exe': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar' }) },
  { name: 'sb-jar-abs', files: { 'p/x': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'C:' + B + 'a.jar' }) },
  { name: 'sb-jar-root-slash', files: { 'p/x': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: '/a.jar' }) },
  { name: 'sb-jar-dotdot', files: { 'p/x': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'target/../../a.jar' }) },
  { name: 'sb-jar-dotdot-back', files: { 'p/x': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'a' + B + '..' + B + 'b.jar' }) },
  { name: 'sb-jar-dots-name', files: { 'p/..x.jar': '', 'bin/java.exe': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: '..x.jar' }) },
  { name: 'sb-jar-wrong-ext', files: { 'p/a.war': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'a.war' }) },
  { name: 'sb-jar-upper', files: { 'p/target/App.JAR': '', 'bin/java.exe': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'target/App.JAR' }) },
  { name: 'sb-jar-is-dir', files: { 'p/target/app.jar': { dir: true }, 'bin/java.exe': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'target/app.jar' }) },
  { name: 'sb-jar-missing', files: { 'p/x': '', 'bin/java.exe': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'target/app.jar' }) },
  { name: 'sb-jar-ext-not-at-end', files: { 'p/a.jar.bak': '' }, entry: e({ framework: 'spring-boot', launchMode: 'jar', jarPath: 'a.jar.bak' }) },
  { name: 'sb-system-maven', files: { 'p/x': '', 'bin/mvn.bat': '' }, entry: e({ framework: 'spring-boot', launchMode: 'system-maven' }) },
  { name: 'sb-system-gradle-missing', files: { 'p/x': '', 'bin/java.exe': '' }, entry: e({ framework: 'spring-boot', launchMode: 'system-gradle' }) },
  { name: 'sb-register-only', files: { 'p/mvnw.cmd': '' }, entry: e({ framework: 'spring-boot', launchMode: 'maven-wrapper', registerOnly: true }) },
  { name: 'sb-foreign-mode', files: { 'p/x': '' }, entry: e({ framework: 'spring-boot', launchMode: 'python-file' }) },
  { name: 'sb-port-conflict', files: { 'p/mvnw.cmd': '' }, entry: e({ framework: 'spring-boot', launchMode: 'maven-wrapper', expectedPort: 8080 }), snapshot: snap(L(9, [8080], 'java.exe', 'external')), freePort: { 8081: 8081 } },

  // ---- Python ----
  { name: 'py-file-ok', files: { 'p/main.py': '', 'bin/python.exe': '' }, entry: e({ framework: 'python', launchMode: 'python-file', jarPath: 'main.py' }) },
  { name: 'py-file-none', files: { 'p/main.py': '' }, entry: e({ framework: 'python', launchMode: 'python-file' }) },
  { name: 'py-file-missing', files: { 'p/x': '', 'bin/py.exe': '' }, entry: e({ framework: 'fastapi', launchMode: 'python-file', jarPath: 'app/main.py' }) },
  { name: 'py-django', files: { 'p/manage.py': '', 'bin/python3': '' }, entry: e({ framework: 'django', launchMode: 'django' }) },
  { name: 'py-django-missing', files: { 'p/x': '' }, entry: e({ framework: 'django', launchMode: 'django' }) },
  { name: 'py-module-set', files: { 'p/x': '' }, entry: e({ framework: 'python', launchMode: 'python-module', jarPath: 'pkg.app' }) },
  { name: 'py-module-empty', files: { 'p/x': '' }, entry: e({ framework: 'streamlit', launchMode: 'python-module' }) },
  { name: 'py-uvicorn', files: { 'p/x': '' }, entry: e({ framework: 'fastapi', launchMode: 'uvicorn', jarPath: 'main:app' }) },
  { name: 'py-flask', files: { 'p/x': '' }, entry: e({ framework: 'flask', launchMode: 'flask' }) },
  { name: 'py-no-mode', files: { 'p/x': '' }, entry: e({ framework: 'python' }) },
  { name: 'py-foreign-mode', files: { 'p/x': '' }, entry: e({ framework: 'python', launchMode: 'jar' }) },
  { name: 'py-register-only', files: { 'p/x': '' }, entry: e({ framework: 'python', registerOnly: true, launchMode: 'flask' }) },

  // ---- Go / Rust / C++ ----
  { name: 'go-ok', files: { 'p/go.mod': '', 'bin/go.exe': '' }, entry: e({ framework: 'go', launchMode: 'go-run' }) },
  { name: 'go-missing', files: { 'p/x': '' }, entry: e({ framework: 'go' }) },
  { name: 'rust-ok', files: { 'p/Cargo.toml': '', 'bin/cargo': '' }, entry: e({ framework: 'rust' }) },
  { name: 'rust-missing', files: { 'p/x': '' }, entry: e({ framework: 'rust', registerOnly: true }) },
  { name: 'cpp-ok', files: { 'p/build/app.exe': '' }, entry: e({ framework: 'cpp', jarPath: 'build/app.exe' }) },
  { name: 'cpp-upper', files: { 'p/App.EXE': '' }, entry: e({ framework: 'cpp', jarPath: 'App.EXE' }) },
  { name: 'cpp-none', files: { 'p/x': '' }, entry: e({ framework: 'cpp' }) },
  { name: 'cpp-illegal', files: { 'p/x': '' }, entry: e({ framework: 'cpp', jarPath: '../app.exe' }) },
  { name: 'cpp-not-built', files: { 'p/x': '' }, entry: e({ framework: 'cpp', jarPath: 'out/app.exe', expectedPort: 9000 }), all: [other('e9', '同端口', 9000)] },
]

export const scenarios = raw.map((s) => ({ ...base, ...s }))
