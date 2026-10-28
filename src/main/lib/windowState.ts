import { app, screen } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 窗口位置、大小、最大化状态的记忆。放在 appData/mile-terminal/window-state.json，
 * 与 config.json 分开：它是纯展示偏好，写坏了不该牵连条目配置，也不进 .bak 轮转。
 */
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const MIN_WIDTH = 1180
export const MIN_HEIGHT = 760
const DEFAULT_STATE: WindowState = { width: 1440, height: 900, maximized: false }
/** 窗口与某块屏幕的工作区至少重叠这么多才算「看得见」，拔掉副屏后留下的坐标会被丢弃 */
const MIN_VISIBLE = 100

const stateFile = (): string => join(app.getPath('appData'), 'mile-terminal', 'window-state.json')

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function visibleOnSomeDisplay(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea
    const ox = Math.min(x + width, w.x + w.width) - Math.max(x, w.x)
    const oy = Math.min(y + height, w.y + w.height) - Math.max(y, w.y)
    return ox >= MIN_VISIBLE && oy >= MIN_VISIBLE
  })
}

/** 读上次的窗口状态。文件缺失、损坏、坐标跑到屏幕外，都退回默认大小并交给系统居中 */
export function loadWindowState(): WindowState {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return { ...DEFAULT_STATE }
  }
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STATE }
  const r = raw as Record<string, unknown>

  const width = finite(r.width) ? Math.max(MIN_WIDTH, Math.round(r.width)) : DEFAULT_STATE.width
  const height = finite(r.height) ? Math.max(MIN_HEIGHT, Math.round(r.height)) : DEFAULT_STATE.height
  const state: WindowState = { width, height, maximized: r.maximized === true }
  if (finite(r.x) && finite(r.y) && visibleOnSomeDisplay(r.x, r.y, width, height)) {
    state.x = Math.round(r.x)
    state.y = Math.round(r.y)
  }
  return state
}

/**
 * 缩放不是 100% 时（如 175%），DIP 与物理像素互相换算会有舍入，同一个窗口每开关一次
 * 读回的尺寸就多出 2 到 5 像素，反复启动会越开越大。实际值与上次保存值只差几个像素时，
 * 当作没变，沿用上次的值；真正拖动调整（差值超过容差）才更新。
 */
const DRIFT_TOLERANCE = 8
let lastSaved: WindowState | null = null
const near = (a: number, b: number): boolean => Math.abs(a - b) <= DRIFT_TOLERANCE

function save(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return
  // 最大化或全屏时 getBounds 是满屏尺寸，要记还原后的普通尺寸，否则取消最大化后窗口变不回来
  const b = win.getNormalBounds()
  const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
  if (lastSaved && near(state.width, lastSaved.width) && near(state.height, lastSaved.height)) {
    state.width = lastSaved.width
    state.height = lastSaved.height
  }
  if (lastSaved && lastSaved.x !== undefined && lastSaved.y !== undefined && near(b.x, lastSaved.x) && near(b.y, lastSaved.y)) {
    state.x = lastSaved.x
    state.y = lastSaved.y
  }
  try {
    const file = stateFile()
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, file)
    lastSaved = state
  } catch {
    // 记不住窗口位置不值得打断使用
  }
}

/** 移动、缩放时防抖落盘，关闭时同步落盘（进程被强杀时至少留着最近一次的位置） */
export function trackWindowState(win: BrowserWindow): void {
  lastSaved = loadWindowState()
  let timer: NodeJS.Timeout | null = null
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => save(win), 400)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save(win)
  })
}
