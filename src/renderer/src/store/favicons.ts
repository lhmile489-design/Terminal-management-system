import { create } from 'zustand'
import { useEffect } from 'react'
import type { Framework, LaunchEntry } from '@shared/types'
import { isWebFramework } from '@shared/types'

/**
 * 前端条目本地 favicon 的内存缓存。不落盘 —— favicon 只是展示增强，
 * 每次启动重新按需读一遍即可，且目录里的图标可能随时被换掉。
 *
 * 缓存键是 `id::path`：编辑目录后 path 变，键就变，会重新读；同一条目未变时
 * 命中缓存不再打 IPC。null（读不到）也进缓存，避免每次渲染都重读磁盘。
 */
interface FaviconStore {
  /** key = `${id}::${path}` → data URL 或 null（读过但没有） */
  cache: Record<string, string | null>
  /** 正在读的键，避免同一条目并发重复 invoke */
  loading: Record<string, true>
  /** 懒加载：命中缓存直接返回，否则打一次 IPC 并写缓存 */
  load: (id: string, path: string) => void
  /** 取当前值：undefined = 还没读过，string = 有图标，null = 读过但没有 */
  get: (id: string, path: string) => string | null | undefined
}

const keyOf = (id: string, path: string): string => `${id}::${path}`

export const useFavicons = create<FaviconStore>((set, get) => ({
  cache: {},
  loading: {},

  load: (id, path) => {
    const key = keyOf(id, path)
    const s = get()
    if (key in s.cache || s.loading[key]) return
    set((st) => ({ loading: { ...st.loading, [key]: true } }))
    void window.mile.entry
      .favicon(id)
      .then((url) => {
        set((st) => {
          const loading = { ...st.loading }
          delete loading[key]
          return { cache: { ...st.cache, [key]: url }, loading }
        })
      })
      .catch(() => {
        // 读失败当作「没有」缓存下来，不反复重试
        set((st) => {
          const loading = { ...st.loading }
          delete loading[key]
          return { cache: { ...st.cache, [key]: null }, loading }
        })
      })
  },

  get: (id, path) => get().cache[keyOf(id, path)]
}))

/**
 * 卡片/列表行用的 favicon hook：只对前端框架条目触发懒加载，返回当前 data URL。
 * 非前端框架返回 null（不打 IPC）；正在读或读不到时也返回 null，UI 自然回退字标。
 */
export function useEntryFavicon(id: string, path: string, framework: Framework): string | null {
  const web = isWebFramework(framework)
  const url = useFavicons((s) => (web ? s.cache[keyOf(id, path)] : undefined))
  const load = useFavicons((s) => s.load)
  useEffect(() => {
    if (web) load(id, path)
  }, [web, id, path, load])
  return url ?? null
}

/**
 * 条目自定义图片的内存缓存。与 favicon 分开一个 store：键是 imageId（内容哈希文件名），
 * 换图后 imageId 变、键就变、自动重取；同 imageId 命中缓存不再打 IPC。图片本身已由
 * 主进程压缩落盘，这里只负责按需取 data URL 供显示，不落盘。
 */
interface CustomImageStore {
  cache: Record<string, string | null>
  loading: Record<string, true>
  load: (id: string, imageId: string) => void
}

export const useCustomImages = create<CustomImageStore>((set, get) => ({
  cache: {},
  loading: {},
  load: (id, imageId) => {
    const s = get()
    if (imageId in s.cache || s.loading[imageId]) return
    set((st) => ({ loading: { ...st.loading, [imageId]: true } }))
    void window.mile.entry
      .image(id)
      .then((url) => {
        set((st) => {
          const loading = { ...st.loading }
          delete loading[imageId]
          return { cache: { ...st.cache, [imageId]: url }, loading }
        })
      })
      .catch(() => {
        set((st) => {
          const loading = { ...st.loading }
          delete loading[imageId]
          return { cache: { ...st.cache, [imageId]: null }, loading }
        })
      })
  }
}))

/**
 * 卡片/列表统一的图标图片来源。显示优先级：自定义图片(imageId) > favicon(web 框架)。
 * 两个视图共用这一个 hook —— 消除「卡片与列表各写一段 <img>」的分叉，是保证两视图
 * 一致显示的根。返回 data URL 或 null（null 时上层回退到 icon 预设 / 框架字标）。
 *
 * 注意 hooks 必须无条件在顶层调用：favicon 与 custom-image 两个订阅都要每次渲染都跑，
 * 不能按条件短路，否则会违反 hooks 规则。最终返回值再按优先级取。
 */
export function useEntryImage(entry: Pick<LaunchEntry, 'id' | 'path' | 'framework' | 'imageId'>): string | null {
  const imageId = entry.imageId
  const custom = useCustomImages((s) => (imageId ? s.cache[imageId] : undefined))
  const loadCustom = useCustomImages((s) => s.load)
  useEffect(() => {
    if (imageId) loadCustom(entry.id, imageId)
  }, [imageId, entry.id, loadCustom])

  const favicon = useEntryFavicon(entry.id, entry.path, entry.framework)

  if (imageId) return custom ?? null
  return favicon
}
