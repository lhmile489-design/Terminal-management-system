import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_VERSION, type AppConfig } from '@shared/types'

const DEFAULTS: AppConfig = {
  version: CONFIG_VERSION,
  entries: [],
  groups: [],
  ignoredListeners: [],
  groupOverrides: [],
  watchedKeywords: [],
  settings: {
    scanIntervalMs: 2000,
    theme: 'system',
    externalTerminal: 'wt',
    terminalFontSize: 13,
    scrollback: 5000,
    killOwnedOnQuit: true,
    closeToTray: false,
    notifyOnTaskDone: true,
    hideFromTaskbar: false
  }
}

export class ConfigStore {
  private readonly dir = join(app.getPath('appData'), 'mile-terminal')
  private readonly file = join(this.dir, 'config.json')
  /** 上一份良好版本，PRD §8。主文件写坏时从这里恢复 */
  private readonly backup = join(this.dir, 'config.json.bak')
  private cache: AppConfig
  /**
   * 只读保护，PRD §8。主配置与备份都读不到、但文件确实存在时置位。
   * 这种情况多半是被别的东西写坏或占着，此时用空配置覆盖就是把用户的条目删干净了 ——
   * 宁可这一次运行不落盘。
   */
  private readOnly = false

  constructor() {
    this.cache = this.boot()
  }

  private boot(): AppConfig {
    const primary = this.read(this.file)
    if (primary) return this.migrate(primary)

    const fallback = this.read(this.backup)
    if (fallback) {
      // 从备份恢复要立刻写回主文件，否则下次启动还得再走一遍这条路
      const migrated = this.migrate(fallback)
      this.cache = migrated
      this.persist()
      return migrated
    }

    // 两份都解析不出来但文件在：不是「首次运行」，是数据出问题了，别覆盖
    if (existsSync(this.file) || existsSync(this.backup)) this.readOnly = true
    return structuredClone(DEFAULTS)
  }

  private read(path: string): Partial<AppConfig> | null {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
      return raw as Partial<AppConfig>
    } catch {
      return null
    }
  }

  /**
   * 显式、幂等的 schema 迁移，PRD §8。
   *
   * 不靠 `{...DEFAULTS, ...raw}` 兜底就完事：那样 v1 的文件会被当成 v2 用，
   * 版本号永远停在 1，下一次真需要区分新旧结构时就没有依据了。每一版单独一步，
   * 重复跑同一步不改变结果。
   */
  private migrate(raw: Partial<AppConfig>): AppConfig {
    const from = typeof raw.version === 'number' ? raw.version : 1
    const out: AppConfig = {
      ...DEFAULTS,
      ...raw,
      version: CONFIG_VERSION,
      settings: { ...DEFAULTS.settings, ...raw.settings }
    }

    // v1 → v2：分组覆盖与关注关键字是新增的，老文件里没有
    if (from < 2) {
      out.groupOverrides = []
      out.watchedKeywords = []
    }

    // v2 → v3：任务完成通知。老用户默认开着 —— 这是个提示而非行为变更，
    // 且默认关掉会让「加了通知功能」在升级后看起来毫无变化
    if (from < 3) {
      out.settings.notifyOnTaskDone = true
    }

    // v3 -> v4：此前没有受支持的自定义服务图标。丢弃手工塞入的旧字段，
    // 让升级后的条目回退到自动框架字标，而不是信任未经白名单校验的数据。
    if (from < 4 && Array.isArray(out.entries)) {
      out.entries = out.entries.map(({ icon: _icon, ...entry }) => entry)
    }

    // v4 -> v5: category is optional. Entries without it render under the
    // unclassified panel; malformed legacy values are discarded on upgrade.
    if (from < 5 && Array.isArray(out.entries)) {
      out.entries = out.entries.map((entry) => {
        const category = typeof entry.category === 'string' ? entry.category.trim() : ''
        if (!category || category.length > 40 || /[\u0000-\u001F\u007F]/.test(category)) {
          const { category: _category, ...rest } = entry
          return rest
        }
        return { ...entry, category }
      })
    }

    // v5 -> v6：从任务栏隐藏（仅托盘）。默认关，行为对现有用户保持不变
    if (from < 6) {
      out.settings.hideFromTaskbar = DEFAULTS.settings.hideFromTaskbar
    }

    // v6 -> v7：LaunchEntry 新增可选的 launchMode / jarPath（仅 Spring Boot 用）。
    // 老条目本就不该有这两个字段，保持 undefined 即可，无需回填 —— 这一步只把
    // 版本号推进到 7，好让下次需要区分新旧结构时有依据。
    void from

    // v7 -> v8：LaunchEntry 新增可选的 imageId（自定义图片文件名，服务与任务均可用）。
    // 老条目无此字段，保持 undefined 即可 —— 图片是纯展示增强，缺省时回退 icon/favicon/字标。
    // 仅推进版本号，不回填。（imageId 只由主进程 setImage 写入，迁移不构造它。）
    void from

    // v8 -> v9：AppConfig 新增 groups 字段（工作组列表）；LaunchEntry 新增可选 groupId。
    // 老条目无 groupId，保持 undefined 即可；groups 数组初始化为空，用户自行创建。
    if (from < 9) {
      if (!Array.isArray(out.groups)) out.groups = []
    }

    // 迁移后仍要校形：数组字段被手改成对象会让下游 .some / .filter 直接抛
    if (!Array.isArray(out.entries)) out.entries = []
    if (!Array.isArray(out.groups)) out.groups = []
    if (!Array.isArray(out.ignoredListeners)) out.ignoredListeners = []
    if (!Array.isArray(out.groupOverrides)) out.groupOverrides = []
    if (!Array.isArray(out.watchedKeywords)) out.watchedKeywords = []

    return out
  }

  get(): AppConfig {
    return this.cache
  }

  isReadOnly(): boolean {
    return this.readOnly
  }

  patch(partial: Partial<AppConfig>): AppConfig {
    this.cache = { ...this.cache, ...partial }
    this.persist()
    return this.cache
  }

  patchSettings(partial: Partial<AppConfig['settings']>): AppConfig {
    this.cache = { ...this.cache, settings: { ...this.cache.settings, ...partial } }
    this.persist()
    return this.cache
  }

  /**
   * 写入前先把当前良好版本留成 .bak，再临时文件 + rename 换上新版本。
   * 顺序不能颠倒 —— 先 rename 再备份就会把刚写的新内容备份成「上一份良好版本」。
   */
  private persist(): void {
    if (this.readOnly) return
    mkdirSync(this.dir, { recursive: true })

    if (existsSync(this.file)) {
      try {
        copyFileSync(this.file, this.backup)
      } catch {
        // 备份失败不该挡住正常写入，主文件本身仍是原子替换
      }
    }

    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}
