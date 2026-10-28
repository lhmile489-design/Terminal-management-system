import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  ConfigExportResult,
  ConfigImportResult,
  GroupOverride,
  LaunchEntry,
  NewLaunchEntry,
  ProjectGroup
} from '@shared/types'
import type { ConfigStore } from './ConfigStore'
import type { EntryService } from './EntryService'
import type { GroupService } from './GroupService'
import type { ScannerService } from './ScannerService'

/** 导出文件的格式标记。导入时只认带这个标记的文件 */
const FORMAT = 'mile-terminal-export'
const FORMAT_VERSION = 1
/** 正常导出远小于这个数，超过的多半选错了文件，不读进内存 */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024
/** 导出时去掉的条目字段：运行痕迹与本机图片文件名，换台机器没有意义 */
const DROP_ON_EXPORT = new Set(['lastStartedAt', 'lastExitCode', 'imageId'])
/** 导入新条目时交给 entry:add 的字段，其余（id、order、startAfter、env）由这里另行处理 */
const IMPORT_FIELDS = [
  'kind', 'name', 'category', 'icon', 'path', 'cwd', 'framework', 'packageManager', 'script',
  'scripts', 'expectedPort', 'outputDir', 'launchMode', 'jarPath', 'registerOnly', 'pinned'
] as const

interface ExportFile {
  format: string
  formatVersion: number
  configVersion: number
  exportedAt: string
  entries: Record<string, unknown>[]
  groups: Record<string, unknown>[]
  ignoredListeners: unknown[]
  groupOverrides: unknown[]
  watchedKeywords: unknown[]
  settings: unknown
}

/**
 * 配置导入导出（2.3.0），换机器、重装系统时把条目与工作组带走。
 *
 * - 导出：环境变量只留变量名，值一律清空 —— 导出文件会被拷来拷去，密钥不能跟着走。
 * - 导入：先把当前配置原样备份，再合并。新条目逐个走 EntryService.add，
 *   与界面添加同一套校验（绝对路径、目录存在、脚本已声明）；设置不覆盖，
 *   环境变量不写入，只在结果里列出要重填的变量名。
 * 文件路径只来自主进程的系统对话框，这里不做选择。
 */
export class ConfigTransferService {
  constructor(
    private readonly config: ConfigStore,
    private readonly entries: EntryService,
    private readonly groups: GroupService,
    private readonly scanner: ScannerService
  ) {}

  async exportTo(file: string): Promise<ConfigExportResult> {
    const cfg = this.config.get()
    const data: ExportFile = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      configVersion: cfg.version,
      exportedAt: new Date().toISOString(),
      entries: cfg.entries.map(exportEntry),
      groups: cfg.groups.map((g) => ({ ...g })),
      ignoredListeners: cfg.ignoredListeners,
      groupOverrides: cfg.groupOverrides,
      watchedKeywords: cfg.watchedKeywords,
      settings: cfg.settings
    }
    // Node 的 utf8 写入不带 BOM
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
    return { path: file, entries: data.entries.length, groups: data.groups.length }
  }

  async importFrom(file: string): Promise<ConfigImportResult> {
    if (this.config.isReadOnly()) throw new Error('配置处于只读保护，这次运行不能导入')
    const data = await readExport(file)

    // 先验格式再备份：坏文件直接拒绝，不留多余的备份，也不动配置
    const backup = this.config.backupBeforeImport()
    const skipped: ConfigImportResult['skipped'] = []
    const envToRefill: ConfigImportResult['envToRefill'] = []

    // 工作组按名称合并：同名复用，没有就新建
    const groupMap = new Map<string, string>()
    let groupsAdded = 0
    for (const raw of data.groups) {
      if (!isObject(raw) || typeof raw.name !== 'string' || typeof raw.id !== 'string') continue
      const name = raw.name.trim()
      const existing = this.groups.list().find((g) => g.name === name)
      if (existing) {
        groupMap.set(raw.id, existing.id)
        continue
      }
      try {
        const created = this.groups.add({
          name,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          env: raw.env as ProjectGroup['env']
        })
        groupMap.set(raw.id, created.id)
        groupsAdded++
      } catch (err) {
        skipped.push({ name: `工作组 ${name}`, reason: messageOf(err) })
      }
    }

    // 条目：同目录同子目录同脚本视为已登记，映射到已有条目，供 startAfter 重映射
    const idMap = new Map<string, string>()
    const known = new Map(this.entries.list().map((e) => [entryKey(e), e.id]))
    const pendingAfter: { id: string; deps: string[] }[] = []
    let added = 0
    for (const raw of data.entries) {
      if (!isObject(raw)) continue
      const name = typeof raw.name === 'string' ? raw.name : '（未命名）'
      const oldId = typeof raw.id === 'string' ? raw.id : null
      if (typeof raw.path !== 'string') {
        skipped.push({ name, reason: '缺少项目目录' })
        continue
      }
      const key = entryKey(raw as unknown as LaunchEntry)
      const dup = known.get(key)
      if (dup) {
        if (oldId) idMap.set(oldId, dup)
        skipped.push({ name, reason: '已登记过同一目录与脚本' })
        continue
      }

      const input: Record<string, unknown> = {}
      for (const f of IMPORT_FIELDS) if (raw[f] !== undefined && raw[f] !== null) input[f] = raw[f]
      if (typeof raw.groupId === 'string' && groupMap.has(raw.groupId)) {
        input.groupId = groupMap.get(raw.groupId)
      }
      try {
        const entry = await this.entries.add(input as unknown as NewLaunchEntry)
        added++
        known.set(entryKey(entry), entry.id)
        if (oldId) idMap.set(oldId, entry.id)
        const keys = isObject(raw.env) ? Object.keys(raw.env).filter((k) => k.length <= 128) : []
        if (keys.length > 0) envToRefill.push({ id: entry.id, name: entry.name, keys })
        if (Array.isArray(raw.startAfter)) {
          pendingAfter.push({ id: entry.id, deps: raw.startAfter.filter((d): d is string => typeof d === 'string') })
        }
      } catch (err) {
        skipped.push({ name, reason: messageOf(err) })
      }
    }

    // 先等待要等全部条目落地后才能换成新 id；成环或指向被跳过的条目就丢掉这一项
    for (const { id, deps } of pendingAfter) {
      const mapped = [...new Set(deps.map((d) => idMap.get(d)).filter((d): d is string => !!d))]
      if (mapped.length === 0) continue
      try {
        await this.entries.edit(id, { startAfter: mapped })
      } catch (err) {
        const entry = this.entries.get(id)
        skipped.push({ name: `${entry?.name ?? id} 的先等待`, reason: messageOf(err) })
      }
    }

    this.mergeScannerRules(data)
    return { backup, added, groupsAdded, skipped, envToRefill }
  }

  /** 忽略规则、手动分组、关注关键字取并集；已有的规则优先 */
  private mergeScannerRules(data: ExportFile): void {
    const cfg = this.config.get()
    const ignored = [...cfg.ignoredListeners]
    for (const raw of data.ignoredListeners) {
      if (!isObject(raw)) continue
      const { processName, port } = raw
      if (typeof processName !== 'string' || !processName || processName.length > 260) continue
      if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) continue
      if (!ignored.some((i) => i.processName === processName && i.port === port)) {
        ignored.push({ processName, port: port as number })
      }
    }
    const overrides: GroupOverride[] = [...cfg.groupOverrides]
    for (const raw of data.groupOverrides) {
      if (!isObject(raw)) continue
      const { processName, group } = raw
      if (typeof processName !== 'string' || !processName || processName.length > 260) continue
      if (group !== 'mine' && group !== 'background') continue
      if (!overrides.some((o) => o.processName.toLowerCase() === processName.toLowerCase())) {
        overrides.push({ processName, group })
      }
    }
    this.config.patch({ ignoredListeners: ignored, groupOverrides: overrides })
    // 关键字的规整（去空、小写、去重、限量）只在 ScannerService 一处
    this.scanner.setWatchedKeywords([...cfg.watchedKeywords, ...data.watchedKeywords])
  }
}

function exportEntry(entry: LaunchEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(entry)) if (!DROP_ON_EXPORT.has(k)) out[k] = v
  // 只带变量名：值清空，导入后在界面里重填
  out.env = Object.fromEntries(Object.keys(entry.env ?? {}).map((k) => [k, '']))
  return out
}

async function readExport(file: string): Promise<ExportFile> {
  const info = await stat(file)
  if (info.size > MAX_IMPORT_BYTES) throw new Error('文件太大，不是 Mile Terminal 导出的配置文件')
  let parsed: unknown
  try {
    // 别的编辑器另存过可能带 BOM，剥掉再解析；写成转义形式，字面 BOM 在编辑里会悄悄丢
    parsed = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  if (!isObject(parsed) || parsed.format !== FORMAT || !Array.isArray(parsed.entries)) {
    throw new Error('格式不对：不是 Mile Terminal 导出的配置文件')
  }
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  return {
    format: FORMAT,
    formatVersion: typeof parsed.formatVersion === 'number' ? parsed.formatVersion : 0,
    configVersion: typeof parsed.configVersion === 'number' ? parsed.configVersion : 0,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    entries: list(parsed.entries).filter(isObject),
    groups: list(parsed.groups).filter(isObject),
    ignoredListeners: list(parsed.ignoredListeners),
    groupOverrides: list(parsed.groupOverrides),
    watchedKeywords: list(parsed.watchedKeywords),
    settings: parsed.settings
  }
}

/** 同一目录、同一子目录、同一脚本算同一个条目；Windows 路径大小写不敏感 */
function entryKey(e: Pick<LaunchEntry, 'path' | 'cwd' | 'script'>): string {
  const path = resolve(String(e.path)).replace(/[\\/]+$/, '').toLowerCase()
  // Windows 路径大小写不敏感，子目录与项目根一样要小写后再比
  const cwd = typeof e.cwd === 'string' ? e.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : ''
  const script = typeof e.script === 'string' ? e.script : ''
  return `${path}|${cwd}|${script}`
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
