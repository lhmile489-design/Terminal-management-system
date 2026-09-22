import { readFile, stat, statfs } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import type {
  LaunchEntry,
  PackageManager,
  PrecheckItem,
  PrecheckResult,
  ScanSnapshot
} from '@shared/types'
import { satisfies } from '../lib/semver'
import { findFreePort } from '../lib/portScanner'
import type { DetectService } from './DetectService'

/** 包管理器可执行文件名，只查 PATH 中存在性，绝不执行，PRD §5.1 第 4 项 */
const PM_BINARIES: Record<PackageManager, string[]> = {
  npm: ['npm.cmd', 'npm.exe'],
  pnpm: ['pnpm.cmd', 'pnpm.exe'],
  yarn: ['yarn.cmd', 'yarn.exe'],
  bun: ['bun.exe']
}

/** Spring Boot 预检用到的文件名与可执行文件，与 EntryService 保持一致 */
const MVNW_CMD = 'mvnw.cmd'
const GRADLEW_BAT = 'gradlew.bat'
const JAVA_BINARIES = ['java.exe']
const SYSTEM_MAVEN_BINARIES = ['mvn.cmd', 'mvn.bat', 'mvn']
const SYSTEM_GRADLE_BINARIES = ['gradle.cmd', 'gradle.bat', 'gradle']

/** 各语言解释器 / 构建工具，与 EntryService 保持一致 */
const PYTHON_BINARIES = ['python.exe', 'python3.exe', 'py.exe', 'python', 'python3']
const GO_BINARIES = ['go.exe', 'go']
const CARGO_BINARIES = ['cargo.exe', 'cargo']

const MIN_FREE_BYTES = 500 * 1024 * 1024

/**
 * 启动前预检，PRD §5。
 *
 * 只读文件系统：不写入、不安装依赖、不 spawn 任何进程（连 `node -v` 都不跑，
 * 版本比对用本进程已知的 process.versions.node）。
 * fail 阻止启动，warn 只提示。
 */
export class PrecheckService {
  constructor(private detect: DetectService) {}

  async run(
    entry: LaunchEntry,
    snapshot: ScanSnapshot | null,
    allEntries: LaunchEntry[] = []
  ): Promise<PrecheckResult> {
    const items: PrecheckItem[] = []
    const cwd = resolveCwd(entry)

    // 1. 工作目录
    const dir = await statSafe(cwd)
    if (!dir?.isDirectory()) {
      items.push({
        id: 'cwd',
        label: '工作目录存在且可读',
        level: 'fail',
        detail: `${cwd} 不存在或不是目录`,
        fix: { action: 'pickDirectory', label: '重新选择目录' }
      })
      return finish(items)
    }
    items.push({ id: 'cwd', label: '工作目录存在且可读', level: 'pass', detail: cwd })

    // Spring Boot 走独立预检序列：它没有 package.json / node_modules / npm 脚本，
    // 后面那套 npm 专属检查全不适用。放在 registerOnly 分支之前 —— Spring Boot 是
    // registerOnly=false 的非 npm 生态，不能落进「仅登记」的 fail。
    if (entry.framework === 'spring-boot') {
      return finish(await this.springBootItems(entry, cwd, snapshot, allEntries, items))
    }

    // Python / Go / Rust / C++：命令形状固定的可启动生态，各走独立预检序列（只读、不 spawn、
    // 不构建、不装依赖）。同样放在 registerOnly 分支之前 —— 它们 registerOnly=false。
    if (entry.framework === 'go' || entry.framework === 'rust' || entry.framework === 'cpp') {
      return finish(await this.nativeLangItems(entry, cwd, snapshot, allEntries, items))
    }
    if (
      entry.framework === 'python' ||
      entry.framework === 'django' ||
      entry.framework === 'fastapi' ||
      entry.framework === 'flask' ||
      entry.framework === 'streamlit'
    ) {
      return finish(await this.pythonItems(entry, cwd, snapshot, allEntries, items))
    }

    // Python 等仅登记条目到此为止，后面的检查项都以 package.json 为前提
    if (entry.registerOnly) {
      items.push({
        id: 'registerOnly',
        label: '条目为仅登记',
        level: 'fail',
        detail: '该条目只做监控，未配置可启动的命令',
        fix: { action: 'pickScript', label: '配置启动命令' }
      })
      return finish(items)
    }

    // 2. package.json 可解析
    const pkgPath = join(cwd, 'package.json')
    let pkg: { scripts?: unknown; engines?: unknown }
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts?: unknown; engines?: unknown }
    } catch (err) {
      const missing = !(await statSafe(pkgPath))
      items.push({
        id: 'packageJson',
        label: 'package.json 存在且能解析',
        level: 'fail',
        detail: missing ? `${pkgPath} 不存在` : (err as Error).message,
        fix: missing
          ? { action: 'pickDirectory', label: '重新选择目录' }
          : { action: 'openInEditor', label: '在编辑器中打开' }
      })
      return finish(items)
    }
    items.push({ id: 'packageJson', label: 'package.json 存在且能解析', level: 'pass' })

    // 3. 脚本存在于 scripts
    const scripts = stringRecord(pkg.scripts)
    const engines = stringRecord(pkg.engines)
    if (!entry.script || typeof scripts[entry.script] !== 'string') {
      items.push({
        id: 'script',
        label: '配置的脚本存在于 scripts',
        level: 'fail',
        detail: entry.script
          ? `scripts 中没有 ${entry.script}，现有：${Object.keys(scripts).join(', ') || '（空）'}`
          : '未配置脚本',
        fix: { action: 'pickScript', label: '选择其他脚本' }
      })
    } else {
      items.push({
        id: 'script',
        label: '配置的脚本存在于 scripts',
        level: 'pass',
        detail: `${entry.script} → ${scripts[entry.script]}`
      })
    }

    // 4. 包管理器可执行文件在 PATH 中
    const pmPath = await whichAny(PM_BINARIES[entry.packageManager])
    if (!pmPath) {
      const available = await availableManagers()
      items.push({
        id: 'packageManager',
        label: '包管理器可执行文件可用',
        level: 'fail',
        detail: `PATH 中找不到 ${entry.packageManager}；检测到：${available.join(', ') || '无'}`,
        fix:
          entry.packageManager === 'npm'
            ? undefined
            : { action: 'useNpm', label: '改用 npm' }
      })
    } else {
      items.push({
        id: 'packageManager',
        label: '包管理器可执行文件可用',
        level: 'pass',
        detail: pmPath
      })
    }

    // 5. Node 版本满足 engines.node —— 用本进程版本比对，不 spawn node
    const required = engines.node ?? null
    const current = process.versions.node
    if (!required) {
      items.push({
        id: 'node',
        label: 'Node 运行时版本满足 engines.node',
        level: 'pass',
        detail: `未声明 engines.node，当前 ${current}`
      })
    } else {
      const ok = satisfies(current, required)
      items.push({
        id: 'node',
        label: 'Node 运行时版本满足 engines.node',
        level: ok === false ? 'warn' : 'pass',
        detail:
          ok === null
            ? `无法解析范围 ${required}，当前 ${current}`
            : `要求 ${required}，当前 ${current}`,
        fix:
          ok === false
            ? { action: 'showNodeRequirement', label: '查看版本要求' }
            : undefined
      })
    }

    // 6. node_modules 存在 —— 缺失是 fail，不自动安装，PRD §5.2
    const nm = await statSafe(join(cwd, 'node_modules'))
    if (!nm?.isDirectory()) {
      items.push({
        id: 'nodeModules',
        label: 'node_modules 存在',
        level: 'fail',
        detail: '依赖未安装。自动安装会执行依赖的 postinstall 脚本，必须由你显式发起',
        fix: { action: 'createInstallSession', label: '创建安装会话' }
      })
    } else {
      items.push({ id: 'nodeModules', label: 'node_modules 存在', level: 'pass' })
    }

    // 7. 锁文件与包管理器一致
    const lock = await this.detect.lockfileFor(cwd)
    if (lock && lock !== entry.packageManager) {
      items.push({
        id: 'lockfile',
        label: '锁文件与包管理器一致',
        level: 'warn',
        detail: `锁文件指向 ${lock}，条目配置为 ${entry.packageManager}`
      })
    } else {
      items.push({
        id: 'lockfile',
        label: '锁文件与包管理器一致',
        level: 'pass',
        detail: lock ? `${lock} 锁文件` : '无锁文件'
      })
    }

    // 8. 预期端口空闲 —— 查最近一次采集快照，不额外发起探测
    items.push(await portItem(entry, snapshot, allEntries))

    // 9. 磁盘余量
    items.push(await diskItem(cwd))

    return finish(items)
  }

  /**
   * Spring Boot 预检项，只读、不 spawn、不构建。
   *
   * 按 launchMode 校验各自前提：wrapper 文件存在 / jar 文件存在 / 系统构建工具在 PATH；
   * jar 与 system 模式额外查 java 在 PATH。端口与磁盘复用 npm 路径的同款检查。
   */
  private async springBootItems(
    entry: LaunchEntry,
    cwd: string,
    snapshot: ScanSnapshot | null,
    allEntries: LaunchEntry[],
    items: PrecheckItem[]
  ): Promise<PrecheckItem[]> {
    const mode = entry.launchMode

    if (!mode) {
      items.push({
        id: 'launchMode',
        label: 'Spring Boot 启动方式已配置',
        level: 'fail',
        detail: '未选择启动方式（Maven/Gradle Wrapper、jar 或系统构建工具）',
        fix: { action: 'pickScript', label: '配置启动方式' }
      })
      return items
    }

    // 各启动方式的前提文件 / 可执行文件
    switch (mode) {
      case 'maven-wrapper':
        items.push(
          await fileItem(join(cwd, MVNW_CMD), 'launchMode', 'Maven Wrapper（mvnw.cmd）存在', MVNW_CMD)
        )
        break
      case 'gradle-wrapper':
        items.push(
          await fileItem(join(cwd, GRADLEW_BAT), 'launchMode', 'Gradle Wrapper（gradlew.bat）存在', GRADLEW_BAT)
        )
        break
      case 'jar': {
        items.push(await jarItem(entry, cwd))
        break
      }
      case 'system-maven':
        items.push(await pathItem(SYSTEM_MAVEN_BINARIES, 'launchMode', '系统 Maven（mvn）可用', 'mvn'))
        break
      case 'system-gradle':
        items.push(await pathItem(SYSTEM_GRADLE_BINARIES, 'launchMode', '系统 Gradle（gradle）可用', 'gradle'))
        break
    }

    // jar / system 模式跑的是 java；wrapper 模式由 wrapper 自己找 JAVA_HOME，这里不强求
    if (mode === 'jar' || mode === 'system-maven' || mode === 'system-gradle') {
      const java = await whichAny(JAVA_BINARIES)
      items.push({
        id: 'java',
        label: 'java 可执行文件可用',
        level: java ? 'pass' : 'fail',
        detail: java ?? 'PATH 中找不到 java，请安装 JDK 或配置 PATH'
      })
    }

    // 端口与磁盘：与 npm 路径同款检查
    items.push(await portItem(entry, snapshot, allEntries))
    items.push(await diskItem(cwd))
    return items
  }

  /**
   * Python 预检序列，只读、不 spawn、不装依赖（不 pip install）。
   * python 在 PATH + 按 launchMode 校验入口前提 + 端口 + 磁盘。
   */
  private async pythonItems(
    entry: LaunchEntry,
    cwd: string,
    snapshot: ScanSnapshot | null,
    allEntries: LaunchEntry[],
    items: PrecheckItem[]
  ): Promise<PrecheckItem[]> {
    items.push(await pathItem(PYTHON_BINARIES, 'python', 'python 可执行文件可用', 'python'))

    const mode = entry.launchMode
    switch (mode) {
      case 'python-file':
        items.push(
          await fileItem(
            join(cwd, entry.jarPath ?? ''),
            'launchMode',
            'Python 入口文件存在',
            entry.jarPath || '入口文件'
          )
        )
        break
      case 'django':
        items.push(await fileItem(join(cwd, 'manage.py'), 'launchMode', 'manage.py 存在', 'manage.py'))
        break
      case 'python-module':
      case 'uvicorn':
        items.push({
          id: 'launchMode',
          label: '启动模块已配置',
          level: entry.jarPath ? 'pass' : 'fail',
          detail: entry.jarPath ? entry.jarPath : '未配置模块名',
          fix: entry.jarPath ? undefined : { action: 'pickScript', label: '配置模块名' }
        })
        break
      case 'flask':
        // flask run 由 FLASK_APP 环境变量决定入口，这里不强求文件；给个信息项
        items.push({ id: 'launchMode', label: 'Flask 启动方式', level: 'pass', detail: 'flask run' })
        break
      default:
        items.push({
          id: 'launchMode',
          label: 'Python 启动方式已配置',
          level: 'fail',
          detail: `未选择合法的启动方式：${mode ?? '（空）'}`,
          fix: { action: 'pickScript', label: '配置启动方式' }
        })
    }

    items.push(await portItem(entry, snapshot, allEntries))
    items.push(await diskItem(cwd))
    return items
  }

  /**
   * Go / Rust / C++ 预检序列，只读、不 spawn、不构建、不装依赖。
   * - go：go 在 PATH + go.mod 存在
   * - rust：cargo 在 PATH + Cargo.toml 存在
   * - cpp：已配置且存在项目内 .exe（jarItem 泛化）
   */
  private async nativeLangItems(
    entry: LaunchEntry,
    cwd: string,
    snapshot: ScanSnapshot | null,
    allEntries: LaunchEntry[],
    items: PrecheckItem[]
  ): Promise<PrecheckItem[]> {
    if (entry.framework === 'go') {
      items.push(await pathItem(GO_BINARIES, 'go', 'go 可执行文件可用', 'go'))
      items.push(await fileItem(join(cwd, 'go.mod'), 'launchMode', 'go.mod 存在', 'go.mod'))
    } else if (entry.framework === 'rust') {
      items.push(await pathItem(CARGO_BINARIES, 'cargo', 'cargo 可执行文件可用', 'cargo'))
      items.push(await fileItem(join(cwd, 'Cargo.toml'), 'launchMode', 'Cargo.toml 存在', 'Cargo.toml'))
    } else {
      // cpp：只跑已构建 exe，复用 binItem 校验（路径约束 + 存在性）
      items.push(await binItem(entry, cwd, /\.exe$/i, 'exe'))
    }

    items.push(await portItem(entry, snapshot, allEntries))
    items.push(await diskItem(cwd))
    return items
  }
}

/** 文件存在性检查项：Spring Boot wrapper 用 */
async function fileItem(
  target: string,
  id: string,
  label: string,
  name: string
): Promise<PrecheckItem> {
  const ok = (await statSafe(target))?.isFile() ?? false
  return {
    id,
    label,
    level: ok ? 'pass' : 'fail',
    detail: ok ? target : `未找到 ${name}`,
    fix: ok ? undefined : { action: 'pickScript', label: '改用系统构建工具' }
  }
}

/** 可执行产物检查项：路径先按约束校形，再查存在性。jar / exe 通用（按后缀参数区分） */
async function binItem(
  entry: LaunchEntry,
  cwd: string,
  extRegex: RegExp,
  extLabel: string
): Promise<PrecheckItem> {
  const rel = entry.jarPath
  const label = `${extLabel} 文件存在`
  if (!rel) {
    return {
      id: 'launchMode',
      label,
      level: 'fail',
      detail: `未配置 ${extLabel} 路径`,
      fix: { action: 'pickScript', label: `配置 ${extLabel} 路径` }
    }
  }
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !extRegex.test(rel)) {
    return { id: 'launchMode', label, level: 'fail', detail: `${extLabel} 路径非法：${rel}` }
  }
  const abs = join(cwd, rel)
  const ok = (await statSafe(abs))?.isFile() ?? false
  return {
    id: 'launchMode',
    label,
    level: ok ? 'pass' : 'fail',
    detail: ok ? abs : `${extLabel} 不存在，请先构建：${rel}`
  }
}

/** jar 文件检查项：binItem 的 .jar 特化（Spring Boot jar 模式用） */
async function jarItem(entry: LaunchEntry, cwd: string): Promise<PrecheckItem> {
  return binItem(entry, cwd, /\.jar$/i, 'jar')
}

/** PATH 可执行文件检查项：Spring Boot system 模式用 */
async function pathItem(
  binaries: string[],
  id: string,
  label: string,
  name: string
): Promise<PrecheckItem> {
  const found = await whichAny(binaries)
  return {
    id,
    label,
    level: found ? 'pass' : 'fail',
    detail: found ?? `PATH 中找不到 ${name}`
  }
}

async function portItem(
  entry: LaunchEntry,
  snapshot: ScanSnapshot | null,
  allEntries: LaunchEntry[] = []
): Promise<PrecheckItem> {
  const port = entry.expectedPort
  if (!port) {
    return { id: 'port', label: '预期端口空闲', level: 'pass', detail: '未设置预期端口' }
  }

  // ── 优先检查：其他条目（不论启动状态）是否与本条目配置了同一端口 ──
  // 这是"配置冲突"，OS 还没有监听也会被发现，能在启动前拦住重复配置。
  // 只比较已设置 expectedPort 的其他条目；自己不算。
  const configConflicts = allEntries.filter(
    (e) => e.id !== entry.id && e.expectedPort === port
  )
  if (configConflicts.length > 0) {
    const names = configConflicts.map((e) => e.name).join('、')
    const suggestedPort = await findFreePort(port + 1)
    return {
      id: 'port',
      label: '预期端口空闲',
      level: 'warn',
      detail: `端口 :${port} 与「${names}」配置重复，同时运行时会冲突`,
      fix: {
        action: 'switchPort',
        label: suggestedPort ? `切换到 :${suggestedPort}` : '改用其他端口',
        suggestedPort: suggestedPort ?? undefined
      }
    }
  }

  // ── 次级检查：OS 监听快照（已在运行的进程是否占用此端口）──
  if (!snapshot) {
    return { id: 'port', label: '预期端口空闲', level: 'pass', detail: '尚无采集快照，跳过' }
  }

  /*
   * 取**全部**占用者再排掉自己，不能 find 一个就下结论。
   *
   * 同一端口可以被两个进程同时占住：一个绑 0.0.0.0（IPv4），另一个绑 ::（IPv6，
   * Node 默认），两边 bind 都成功、都不报错。实测 Vite（vite.config 里 host 写死
   * 0.0.0.0）与 Next 撞在 3000 上就是这个形状，netstat 出两行、两个 PID。
   *
   * 原来的 find 命中的是排序靠前的那一行。它正好是本条目自己时，结论就成了
   * 「:3000 空闲」—— 而实际上另一个条目也在听 3000，localhost 只解析到其中一个。
   * 这是「断言/判定靠错误的原因通过」的现场：判定本身没抛错，只是量的是第一行。
   */
  const holders = snapshot.listeners.filter((l) => l.ports.includes(port))
  const others = holders.filter((l) => l.entryId !== entry.id)
  if (others.length === 0) {
    return { id: 'port', label: '预期端口空闲', level: 'pass', detail: `:${port} 空闲` }
  }

  const owned = others.find((l) => l.ownership === 'owned') ?? others[0]
  const more = others.length > 1 ? `，另有 ${others.length - 1} 个进程也在监听` : ''
  const self = holders.length > others.length ? '本条目也在监听同一端口，' : ''

  // 尝试扫描一个空闲的候选端口，供用户一键切换
  const suggestedPort = await findFreePort(port + 1)

  return {
    id: 'port',
    label: '预期端口空闲',
    level: 'warn',
    detail: `${self}:${port} 被 ${owned.processName}（PID ${owned.pid}，${
      owned.ownership === 'owned' ? '受控' : '外部'
    }）占用${more}`,
    fix: owned.ownership === 'owned'
      ? { action: 'resolvePort', label: '停止它' }
      : {
          action: 'switchPort',
          label: suggestedPort ? `切换到 :${suggestedPort}` : '改用其他端口',
          suggestedPort: suggestedPort ?? undefined
        }
  }
}

async function diskItem(cwd: string): Promise<PrecheckItem> {
  try {
    const fs = await statfs(cwd)
    const free = fs.bsize * fs.bavail
    return {
      id: 'disk',
      label: '磁盘剩余空间 > 500MB',
      level: free > MIN_FREE_BYTES ? 'pass' : 'warn',
      detail: `剩余 ${Math.round(free / 1024 / 1024)} MB`
    }
  } catch {
    return { id: 'disk', label: '磁盘剩余空间 > 500MB', level: 'pass', detail: '无法读取，跳过' }
  }
}

function finish(items: PrecheckItem[]): PrecheckResult {
  return { ok: !items.some((i) => i.level === 'fail'), items }
}

/** monorepo 子包：cwd 为相对路径时拼到 path 下 */
export function resolveCwd(entry: LaunchEntry): string {
  if (!entry.cwd) return entry.path
  return isAbsolute(entry.cwd) ? entry.cwd : join(entry.path, entry.cwd)
}

async function whichAny(names: string[]): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (await statSafe(candidate)) return candidate
    }
  }
  return null
}

async function availableManagers(): Promise<PackageManager[]> {
  const found: PackageManager[] = []
  for (const pm of Object.keys(PM_BINARIES) as PackageManager[]) {
    if (await whichAny(PM_BINARIES[pm])) found.push(pm)
  }
  return found
}

function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return out
}

async function statSafe(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

export { whichAny }
