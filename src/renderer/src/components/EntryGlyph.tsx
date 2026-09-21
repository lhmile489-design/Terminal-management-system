import { useState } from 'react'
import type { EntryKind, Framework, LaunchEntry } from '@shared/types'
import { SERVICE_ICON_META } from '../lib/entryMeta'

/**
 * 卡片/列表共用的图标字形组件。显示优先级（两视图必须一致，这是同时修「卡片不显示
 * 自定义图/ favicon」bug 的根）：
 *
 *   自定义图片(imageUrl) > 服务预设图标(entry.icon) > 框架字标
 *
 * favicon 与自定义图片都由调用方经 useEntryImage 解析后，作为 imageUrl 传进来 ——
 * 本组件不关心图片来自 favicon 还是用户上传，只按「有没有图」决定显示图还是回退字标。
 *
 * @param size 图片/图标像素尺寸（卡片 20，列表 16 左右）
 * @param glyphClass 框架字标的字号类（卡片与列表字号不同）
 */
export function EntryGlyph({
  entry,
  imageUrl,
  size = 20,
  glyphClass = 'text-[15px]'
}: {
  entry: Pick<LaunchEntry, 'kind' | 'icon' | 'framework'>
  imageUrl?: string | null
  size?: number
  glyphClass?: string
}): React.JSX.Element {
  // 图片理论上不会加载失败（data URL），但坏图仍回退字标而非空瓦片。
  // Hook 必须无条件在顶层调用，不能放到 early return 之后。
  const [broken, setBroken] = useState(false)

  // 用户显式选的服务预设图标次于自定义图片：上传了图就以图为准
  const meta = entry.kind === 'service' && entry.icon ? SERVICE_ICON_META[entry.icon] : undefined

  if (imageUrl && !broken) {
    const px = `${size}px`
    return (
      <img
        src={imageUrl}
        style={{ width: px, height: px }}
        className="rounded-[4px] object-contain"
        alt=""
        aria-hidden
        draggable={false}
        onError={() => setBroken(true)}
      />
    )
  }
  if (meta) {
    const IconCmp = meta.icon
    return <IconCmp size={size} weight="bold" aria-hidden />
  }
  return <FrameworkGlyph framework={entry.framework} kind={entry.kind} glyphClass={glyphClass} />
}

/**
 * 用框架名首字母而非彩色 logo —— 内置各家品牌图标会带来商标与体积问题，
 * 且深浅两模式都要各配一版。与 EntryCard/EntryRow 曾各存一份 GLYPH，现收归此处。
 */
const GLYPH: Record<Framework, string> = {
  next: 'N',
  nuxt: 'Nu',
  angular: 'A',
  'vue-vite': 'V',
  'vue-cli': 'V',
  'react-vite': 'R',
  'react-cra': 'R',
  svelte: 'S',
  electron: 'E',
  hexo: 'Hx',
  node: 'JS',
  'spring-boot': 'SB',
  uniapp: 'U',
  hugo: 'Hg',
  jekyll: 'Jk',
  django: 'Dj',
  fastapi: 'Fa',
  flask: 'Fl',
  streamlit: 'St',
  python: 'Py',
  'docker-compose': 'Do',
  go: 'Go',
  rust: 'Rs',
  cpp: 'C++',
  static: '</>',
  unknown: '?'
}

function FrameworkGlyph({
  framework,
  kind,
  glyphClass
}: {
  framework: Framework
  kind: EntryKind
  glyphClass: string
}): React.JSX.Element {
  // 未识别的任务给个终端符号，比一个问号更像「一条命令」
  const text = framework === 'unknown' && kind === 'task' ? '>_' : GLYPH[framework]
  return (
    <span className={`font-mono font-bold ${glyphClass}`} aria-hidden>
      {text}
    </span>
  )
}
