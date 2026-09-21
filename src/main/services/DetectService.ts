import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type {
  DetectResult,
  Framework,
  LaunchMode,
  PackageManager,
  SpringBootLaunchMode
} from '@shared/types'

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
    framework: 'cpp',
    // C++ 项目标记：CMake / MSBuild 工程文件，或 Makefile + 源文件。只读存在性，不构建。
    hint: 'C++ 项目',
    match: (p) => cppMarker(p)
  },
  {
    framework: 'spring-boot',
    // pom.xml 含 spring-boot 或 build.gradle 含 org.springframework.boot 才算数 ——
    // 光有 pom.xml 只能说明是个 Maven 项目，不一定是 Spring Boot
    hint: 'Spring Boot 项目',
    match: (p) => springBootMarker(p)
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
    framework: 'uniapp',
    // uniapp 常带 index.html，必须排在 static 之前，否则会被兜底成静态站
    hint: 'uniapp 项目（manifest.json + pages.json）',
    match: (p) => uniappMarker(p)
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

/**
 * 是不是 Spring Boot 项目。只读文件内容，绝不执行 mvn / gradle。
 *
 * pom.xml 里出现 spring-boot（starter-parent 或 maven-plugin），或
 * build.gradle[.kts] 里出现 org.springframework.boot，即认定。
 */
async function springBootMarker(path: string): Promise<boolean> {
  const pom = await readTextSafe(join(path, 'pom.xml'))
  if (pom && /spring-boot/i.test(pom)) return true

  for (const file of ['build.gradle', 'build.gradle.kts']) {
    const gradle = await readTextSafe(join(path, file))
    if (gradle && /org\.springframework\.boot/i.test(gradle)) return true
  }
  return false
}

/**
 * uniapp（HBuilderX）项目标记：manifest.json 与 pages.json 同时存在。
 *
 * 两者缺一不认 —— 单个 manifest.json 太通用（很多工具都用这个名字），只有配上
 * uniapp 的路由清单 pages.json 才能确定是 uniapp。纯存在性判断，不读内容、不执行代码。
 */
async function uniappMarker(path: string): Promise<boolean> {
  return (await exists(join(path, 'manifest.json'))) && (await exists(join(path, 'pages.json')))
}

/**
 * C++ 项目标记：CMake / MSBuild 工程文件，或 Makefile 同时存在 .cpp/.cc/.cxx 源文件。
 * 只读目录列表与文件存在性，不执行任何构建工具。
 */
async function cppMarker(path: string): Promise<boolean> {
  if (await exists(join(path, 'CMakeLists.txt'))) return true
  try {
    const names = await readdir(path)
    if (names.some((n) => /\.vcxproj$/i.test(n))) return true
    const hasMakefile = names.some((n) => /^(GNUmakefile|makefile|Makefile)$/.test(n))
    const hasCppSrc = names.some((n) => /\.(cpp|cc|cxx)$/i.test(n))
    return hasMakefile && hasCppSrc
  } catch {
    return false
  }
}

/**
 * 为命令形状固定的语言探测默认启动方式，供新建向导预填 launchMode。
 * 只读文件、不执行代码。返回 null 表示该 framework 不属于「可启动的非 npm 语言」。
 *
 * Spring Boot 有独立的 detectSpringBootLaunchMode（含端口探测），不走这里。
 */
async function detectLaunchableMode(
  framework: Framework,
  path: string
): Promise<{ mode: LaunchMode; detectedPort?: number } | null> {
  switch (framework) {
    case 'django':
      return { mode: 'django' }
    case 'fastapi':
      return { mode: 'uvicorn' }
    case 'flask':
      return { mode: 'flask' }
    case 'streamlit':
    case 'python': {
      // 有 main.py / app.py 优先按入口文件跑，否则也给 python-file（用户在编辑面板填入口）
      const hasMain = await exists(join(path, 'main.py'))
      const hasApp = await exists(join(path, 'app.py'))
      return { mode: hasMain || hasApp ? 'python-file' : 'python-file' }
    }
    case 'go':
      return { mode: 'go-run' }
    case 'rust':
      return { mode: 'cargo-run' }
    case 'cpp':
      // C++ 只跑已构建 exe，识别时不知产物在哪，仍给默认 mode，路径由用户在编辑面板选
      return { mode: 'cpp-exe' }
    default:
      return null
  }
}

/**
 * 探测 Spring Boot 的默认启动方式，供新建向导预填。
 *
 * 优先用项目自带 wrapper（不依赖系统装了什么），wrapper 缺失时退回系统 mvn / gradle。
 * 只看文件存在性，不查 PATH、不执行任何东西。
 */
async function detectSpringBootLaunchMode(path: string): Promise<SpringBootLaunchMode> {
  const hasMvnw = await exists(join(path, 'mvnw.cmd'))
  const hasGradlew = await exists(join(path, 'gradlew.bat'))
  const hasPom = await exists(join(path, 'pom.xml'))

  if (hasMvnw) return 'maven-wrapper'
  if (hasGradlew) return 'gradle-wrapper'
  return hasPom ? 'system-maven' : 'system-gradle'
}

/**
 * 从 application.properties / application.yml 读 server.port。读不到返回 undefined。
 * 只在常见的 resources 目录与项目根找，纯文本解析，不引 YAML 库。
 */
async function detectSpringBootPort(path: string): Promise<number | undefined> {
  const locations = [
    join(path, 'src', 'main', 'resources', 'application.properties'),
    join(path, 'src', 'main', 'resources', 'application.yml'),
    join(path, 'src', 'main', 'resources', 'application.yaml'),
    join(path, 'application.properties'),
    join(path, 'application.yml'),
    join(path, 'application.yaml')
  ]
  for (const file of locations) {
    const text = await readTextSafe(file)
    if (!text) continue
    // properties: server.port=8080 ； yaml: server.port: 8080 或缩进的 port: 8080
    const m =
      text.match(/^\s*server\.port\s*[=:]\s*(\d{1,5})\s*$/m) ??
      text.match(/^\s*port\s*:\s*(\d{1,5})\s*$/m)
    if (m) {
      const port = Number(m[1])
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port
    }
  }
  return undefined
}

/**
 * 扫描 Spring Boot 项目的 profile 配置文件，返回 profile 名列表（已排序）。
 * 只读目录结构，不读文件内容，不执行任何代码。
 * 匹配 src/main/resources 和项目根下的 application-{profile}.properties/yml/yaml。
 */
async function detectSpringBootProfiles(projectPath: string): Promise<string[]> {
  const dirs = [
    join(projectPath, 'src', 'main', 'resources'),
    projectPath
  ]
  const found = new Set<string>()
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue // 目录不存在时跳过，不报错
    }
    for (const name of names) {
      const m = /^application-([^.]+)\.(properties|ya?ml)$/i.exec(name)
      if (!m) continue
      const profile = m[1]
      // 白名单过滤：字母、数字、下划线、连字符（与 SAFE_PROFILE 一致）
      if (/^[A-Za-z0-9_-]+$/.test(profile)) found.add(profile)
    }
  }
  return [...found].sort()
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

    // uniapp（HBuilderX）项目：有 package.json 但编译器内置在 HBuilderX 里，不走 npm 脚本。
    // 无论 scripts 里有什么，都覆盖为 uniapp + registerOnly，启动交给 HBuilderX（openInHBuilderX）。
    if (await uniappMarker(path)) {
      warnings.push('识别为 uniapp 项目，启动由 HBuilderX 负责')
      return {
        path,
        hasPackageJson: true,
        name:
          typeof pkg.name === 'string' && pkg.name ? pkg.name : basename(path) || path,
        framework: 'uniapp',
        packageManager: await this.detectPackageManager(path, pkg.packageManager),
        scripts: toStringRecord(pkg.scripts),
        devScript: null,
        buildScript: null,
        monorepoHint: false,
        registerOnly: true,
        warnings
      }
    }

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

  /** 无 package.json：按标记文件认出生态。命令形状固定的可启动，其余仅登记、不推断命令 */
  private async fallback(path: string, warnings: string[]): Promise<DetectResult> {
    let framework: Framework = 'unknown'
    for (const rule of MARKER_RULES) {
      if (await rule.match(path)) {
        framework = rule.framework
        break
      }
    }

    // Spring Boot：命令形状固定（wrapper/jar + 硬编码子命令），可启动，预填启动方式与端口。
    if (framework === 'spring-boot') {
      const launchMode = await detectSpringBootLaunchMode(path)
      const detectedPort = await detectSpringBootPort(path)
      warnings.push(`识别为 Spring Boot 项目，默认启动方式：${launchMode}`)
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
        registerOnly: false,
        detectedLaunchMode: launchMode,
        ...(detectedPort ? { detectedPort } : {}),
        warnings
      }
    }

    // Python / Go / Rust / C++：命令形状固定（file 固定 + 硬编码子命令 / 项目内产物），
    // 走 EntryService 的第 N 条命令构造路径，可启动。识别时探测默认 launchMode 供预填。
    const launchable = await detectLaunchableMode(framework, path)
    if (launchable) {
      warnings.push(`识别为 ${MARKER_RULES.find((r) => r.framework === framework)?.hint ?? framework}，默认启动方式：${launchable.mode}`)
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
        registerOnly: false,
        detectedLaunchMode: launchable.mode,
        ...(launchable.detectedPort ? { detectedPort: launchable.detectedPort } : {}),
        warnings
      }
    }

    if (framework === 'unknown') {
      warnings.push('无 package.json，需手动填写命令')
    } else {
      const rule = MARKER_RULES.find((r) => r.framework === framework)
      warnings.push(`识别为 ${rule?.hint ?? framework}，仅登记不推断启动命令`)
    }

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

  /**
   * 读取前端项目的本地 favicon，返回 { mime, base64 } 或 null。
   *
   * 纯只读：仅在项目目录内按常见约定找静态图标文件、或解析 index.html 的
   * `<link rel="icon">`。不联网、不执行项目代码、不抓运行中的站点（红线 1）。
   * 解析出的 href 一律经 resolveInside 校验落在项目根内，`..` 逃逸一律拒绝（红线 4）。
   * 超过 FAVICON_MAX_BYTES 的文件跳过（favicon 都很小，大文件多半是误读的插图）。
   */
  async readFavicon(rootDir: string): Promise<{ mime: string; base64: string } | null> {
    for (const rel of FAVICON_CANDIDATES) {
      const hit = await tryReadIcon(rootDir, rel)
      if (hit) return hit
    }

    // 兜底：解析 index.html 里声明的图标，覆盖非约定位置（如 assets/xxx.png）
    const html = await readTextSafe(join(rootDir, 'index.html'))
    if (html) {
      for (const href of parseIconHrefs(html)) {
        const hit = await tryReadIcon(rootDir, href)
        if (hit) return hit
      }
    }
    return null
  }

  /**
   * 扫描 Spring Boot 项目的 profile 配置文件，返回 profile 名列表（已排序）。
   * 委托给模块级 detectSpringBootProfiles 函数，此方法是公共入口。
   * 只读目录结构，不读文件内容，不执行代码。
   */
  async detectSpringBootProfiles(projectPath: string): Promise<string[]> {
    return detectSpringBootProfiles(projectPath)
  }
}

/** favicon 大小上限，超过跳过。favicon 通常几 KB，256KB 足够宽松 */
const FAVICON_MAX_BYTES = 256 * 1024

/** 扩展名 → MIME，仅收位图/矢量图标类型，其余（如 .html）不当图标 */
const FAVICON_MIME: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

/** 常见 favicon 静态位置，顺序即优先级，取首个存在且合规的 */
const FAVICON_CANDIDATES = [
  'public/favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'public/icon.svg',
  'public/logo.svg',
  'static/favicon.svg',
  'static/favicon.ico',
  'static/favicon.png',
  'src/favicon.ico',
  'src/assets/favicon.ico',
  'favicon.svg',
  'favicon.ico',
  'favicon.png'
]

/**
 * 把相对 root 的图标路径解析成绝对路径并校验：必须落在 root 内、扩展名须是已知图标类型、
 * 文件须存在且不超上限。任何一步不满足返回 null。
 */
async function tryReadIcon(
  root: string,
  rel: string
): Promise<{ mime: string; base64: string } | null> {
  const clean = rel.trim().replace(/^\.?\//, '').replace(/[?#].*$/, '')
  if (!clean) return null

  const mime = FAVICON_MIME[extname(clean).toLowerCase()]
  if (!mime) return null

  // 解析后必须仍在 root 之内 —— `..` 或绝对路径导致的逃逸一律拒绝
  const abs = resolve(root, clean)
  const rootAbs = resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null

  try {
    const info = await stat(abs)
    if (!info.isFile() || info.size === 0 || info.size > FAVICON_MAX_BYTES) return null
    const buf = await readFile(abs)
    return { mime, base64: buf.toString('base64') }
  } catch {
    return null
  }
}

/** 从 index.html 解析 <link rel="...icon...">/<link rel="mask-icon"> 的 href，纯正则、不执行 */
function parseIconHrefs(html: string): string[] {
  const out: string[] = []
  const linkRe = /<link\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html))) {
    const tag = m[0]
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    if (!/icon/.test(rel)) continue
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag)?.[1]
    // 只收相对本地路径：绝对 URL、协议相对、data: 一律跳过（不联网、不内联外链）
    if (href && !/^([a-z]+:)?\/\//i.test(href) && !href.startsWith('data:')) out.push(href)
  }
  return out
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

/** 读文本，文件不存在或读失败返回 null（不抛） */
async function readTextSafe(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8')
  } catch {
    return null
  }
}
