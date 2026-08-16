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
import type { DetectService } from './DetectService'

/** 包管理器可执行文件名，只查 PATH 中存在性，绝不执行，PRD §5.1 第 4 项 */
const PM_BINARIES: Record<PackageManager, string[]> = {
  npm: ['npm.cmd', 'npm.exe'],
  pnpm: ['pnpm.cmd', 'pnpm.exe'],
  yarn: ['yarn.cmd', 'yarn.exe'],
  bun: ['bun.exe']
}

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

  async run(entry: LaunchEntry, snapshot: ScanSnapshot | null): Promise<PrecheckResult> {
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
    items.push(portItem(entry, snapshot))

    // 9. 磁盘余量
    items.push(await diskItem(cwd))

    return finish(items)
  }
}

function portItem(entry: LaunchEntry, snapshot: ScanSnapshot | null): PrecheckItem {
  const port = entry.expectedPort
  if (!port) {
    return { id: 'port', label: '预期端口空闲', level: 'pass', detail: '未设置预期端口' }
  }
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
  return {
    id: 'port',
    label: '预期端口空闲',
    level: 'warn',
    detail: `${self}:${port} 被 ${owned.processName}（PID ${owned.pid}，${
      owned.ownership === 'owned' ? '受控' : '外部'
    }）占用${more}`,
    fix: { action: 'resolvePort', label: owned.ownership === 'owned' ? '停止它' : '改用其他端口' }
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
