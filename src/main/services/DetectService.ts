import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DetectResult, Framework, PackageManager } from '@shared/types'

/** 依赖键 → 框架，按 PRD §8.1 优先级排列，取首个命中 */
const FRAMEWORK_RULES: { dep: string; resolve: (deps: Set<string>) => Framework }[] = [
  { dep: 'next', resolve: () => 'next' },
  { dep: 'nuxt', resolve: () => 'nuxt' },
  { dep: '@angular/core', resolve: () => 'angular' },
  { dep: 'vue', resolve: (d) => (d.has('@vue/cli-service') ? 'vue-cli' : 'vue-vite') },
  { dep: 'react', resolve: (d) => (d.has('react-scripts') ? 'react-cra' : 'react-vite') },
  { dep: 'svelte', resolve: () => 'svelte' },
  { dep: 'electron', resolve: () => 'electron' },
  // Hexo 走 npm，命令形状与前端项目一致，因此留在依赖表里而不是标记表
  { dep: 'hexo', resolve: () => 'hexo' }
]

/** 锁文件 → 包管理器，顺序即优先级 */
const LOCKFILES: { file: string; pm: PackageManager }[] = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'package-lock.json', pm: 'npm' }
]

/**
 * 无 package.json 时的标记文件识别，PRD §8.4。
 *
 * 只有存在性判断与文本读取 —— 不执行 `hugo version`、不 `pip show`、不 `go list`。
 * 命中也只是给个准确的名字与仅登记条目：启动路径写死为 `包管理器 run 脚本`
 * （EntryService.launch），这些生态推不出那个形状的命令，硬猜等于替用户构造命令。
 *
 * 顺序即优先级，取首个命中。语言/框架标记排在 docker-compose 之前 ——
 * 一个 Django 仓库常常同时有 compose 文件，那时它仍应显示为 Django。
 */
const MARKER_RULES: {
  framework: Framework
  hint: string
  match: (path: string) => Promise<boolean>
}[] = [
  {
    framework: 'django',
    hint: 'Django 项目（manage.py）',
    match: (p) => exists(join(p, 'manage.py'))
  },
  {
    framework: 'fastapi',
    hint: 'FastAPI 项目',
    match: (p) => pythonDeps(p, ['fastapi'])
  },
  {
    framework: 'streamlit',
    hint: 'Streamlit 应用',
    match: (p) => pythonDeps(p, ['streamlit'])
  },
  {
    framework: 'flask',
    hint: 'Flask 项目',
    match: (p) => pythonDeps(p, ['flask'])
  },
  {
    framework: 'python',
    hint: 'Python 项目',
    match: async (p) =>
      (await exists(join(p, 'requirements.txt'))) || (await exists(join(p, 'pyproject.toml')))
  },
  {
    framework: 'go',
    hint: 'Go 模块（go.mod）',
    match: (p) => exists(join(p, 'go.mod'))
  },
  {
    framework: 'rust',
    hint: 'Rust crate（Cargo.toml）',
    match: (p) => exists(join(p, 'Cargo.toml'))
  },
  {
    framework: 'jekyll',
    hint: 'Jekyll 站点（_config.yml）',
    match: (p) => exists(join(p, '_config.yml'))
  },
  {
    framework: 'hugo',
    // 光有 config.toml 不能算 Hugo —— 那个文件名太通用。要求同时有 Hugo 的目录约定
    hint: 'Hugo 站点',
    match: async (p) => {
      const conf =
        (await exists(join(p, 'hugo.toml'))) ||
        (await exists(join(p, 'hugo.yaml'))) ||
        (await exists(join(p, 'config.toml'))) ||
        (await exists(join(p, 'config.yaml')))
      if (!conf) return false
      return (
        (await exists(join(p, 'content'))) ||
        (await exists(join(p, 'layouts'))) ||
        (await exists(join(p, 'archetypes')))
      )
    }
  },
  {
    framework: 'docker-compose',
    hint: 'Docker Compose 编排',
    match: async (p) =>
      (await exists(join(p, 'docker-compose.yml'))) ||
      (await exists(join(p, 'docker-compose.yaml'))) ||
      (await exists(join(p, 'compose.yml'))) ||
      (await exists(join(p, 'compose.yaml')))
  },
  {
    framework: 'static',
    // 兜底：有首页、又没上面任何构建标记，就是一个直接打开就能看的静态站
    hint: '静态站点（index.html）',
    match: (p) => exists(join(p, 'index.html'))
  }
]

/** requirements.txt / pyproject.toml 里是否声明了某个包 */
async function pythonDeps(path: string, names: string[]): Promise<boolean> {
  for (const file of ['requirements.txt', 'pyproject.toml']) {
    let text: string
    try {
      text = await readFile(join(path, file), 'utf8')
    } catch {
      continue
    }
    const lower = text.toLowerCase()
    // 包名边界要卡住：'flask' 不能被 'flask-login' 顶掉，也不能被注释行带进来
    for (const name of names) {
      if (new RegExp(`(^|[\\s"'\\[])${name}($|[\\s"'\\]<>=!~,;\\[])`, 'm').test(lower)) return true
    }
  }
  return false
}

const DEV_CANDIDATES = ['dev', 'serve', 'start', 'dev:local', 'develop']
const BUILD_CANDIDATES = ['build:prod', 'build:production', 'build:pro', 'build']

interface PackageJson {
  name?: unknown
  packageManager?: unknown
  scripts?: unknown
  dependencies?: unknown
  devDependencies?: unknown
}

/**
 * 项目识别，PRD §8。
 *
 * 只读 package.json 与锁文件的存在性 —— 不执行项目代码、不 `npm ls`、不安装依赖。
 * 识别不出来就交给用户手填，不做任何猜测性的命令执行。
 */
export class DetectService {
  async detect(path: string): Promise<DetectResult> {
    const warnings: string[] = []
    const pkgPath = join(path, 'package.json')
    let pkg: PackageJson | null = null

    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as PackageJson
    } catch (err) {
      // 目录不存在、无 package.json、JSON 语法错都落到这里，区分靠下面的 exists
      if (await exists(pkgPath)) {
        warnings.push(`package.json 解析失败：${(err as Error).message}`)
      }
    }

    if (!pkg) return await this.fallback(path, warnings)

    const scripts = toStringRecord(pkg.scripts)
    const deps = new Set([
      ...Object.keys(toStringRecord(pkg.dependencies)),
      ...Object.keys(toStringRecord(pkg.devDependencies))
    ])

    const devScript = pick(scripts, DEV_CANDIDATES)
    const buildScript = pick(scripts, BUILD_CANDIDATES)
    const packageManager = await this.detectPackageManager(path, pkg.packageManager)

    if (!devScript && Object.keys(scripts).length > 0) {
      warnings.push('未找到 dev 类脚本，monorepo 请指定子包目录')
    }

    return {
      path,
      hasPackageJson: true,
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : basename(path),
      framework: resolveFramework(deps),
      packageManager,
      scripts,
      devScript,
      buildScript,
      monorepoHint: !devScript,
      registerOnly: false,
      warnings
    }
  }

  /** 无 package.json：按标记文件认出生态，但一律仅登记、都不推断命令 */
  private async fallback(path: string, warnings: string[]): Promise<DetectResult> {
    let framework: Framework = 'unknown'
    for (const rule of MARKER_RULES) {
      if (await rule.match(path)) {
        framework = rule.framework
        warnings.push(`识别为 ${rule.hint}，仅登记不推断启动命令`)
        break
      }
    }
    if (framework === 'unknown') warnings.push('无 package.json，需手动填写命令')

    return {
      path,
      hasPackageJson: false,
      name: basename(path) || path,
      framework,
      packageManager: 'npm',
      scripts: {},
      devScript: null,
      buildScript: null,
      monorepoHint: false,
      registerOnly: true,
      warnings
    }
  }

  /** packageManager 字段优先，其次锁文件，最后默认 npm，PRD §8.2 */
  private async detectPackageManager(path: string, field: unknown): Promise<PackageManager> {
    if (typeof field === 'string') {
      const name = field.split('@')[0].trim().toLowerCase()
      if (isPackageManager(name)) return name
    }
    for (const { file, pm } of LOCKFILES) {
      if (await exists(join(path, file))) return pm
    }
    return 'npm'
  }

  /** 锁文件与配置的包管理器是否一致，供预检出 warn，PRD §5.1 第 7 项 */
  async lockfileFor(path: string): Promise<PackageManager | null> {
    for (const { file, pm } of LOCKFILES) {
      if (await exists(join(path, file))) return pm
    }
    return null
  }
}

function resolveFramework(deps: Set<string>): Framework {
  for (const rule of FRAMEWORK_RULES) {
    if (deps.has(rule.dep)) return rule.resolve(deps)
  }
  return 'node'
}

function pick(scripts: Record<string, string>, candidates: string[]): string | null {
  for (const key of candidates) {
    if (typeof scripts[key] === 'string') return key
  }
  return null
}

function isPackageManager(v: string): v is PackageManager {
  return v === 'npm' || v === 'pnpm' || v === 'yarn' || v === 'bun'
}

function toStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return out
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}
