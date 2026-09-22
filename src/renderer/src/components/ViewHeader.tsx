/**
 * 视图页头：eyebrow + 标题行（主标 + 等宽罗马字副标）+ 说明 + 右侧动作区。
 *
 * 升级方向：收紧垂直空间，标题从展示型大字缩为紧凑标题行，
 * 保留 eyebrow + romanized 签名但尺寸降档，让内容区更早出现在屏幕上。
 */
export function ViewHeader({
  eyebrow,
  title,
  romanized,
  caption,
  actions
}: {
  eyebrow: string
  title: string
  /** 主标右侧的等宽小字，如 LAUNCHPAD */
  romanized: string
  caption: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="shrink-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-4">
          {/* 竖向分隔线 + eyebrow 标签 */}
          <div className="flex items-center gap-3">
            <span className="h-5 w-px shrink-0 bg-accent/70" aria-hidden />
            <p className="font-mono text-[9.5px] font-bold uppercase tracking-[0.2em] text-ink-faint/70 whitespace-nowrap">
              {eyebrow}
            </p>
          </div>

          {/* 标题 + 副标 */}
          <div className="flex items-baseline gap-2.5 min-w-0">
            <h1 className="text-[18px] font-bold tracking-tight text-ink-strong leading-none whitespace-nowrap">
              {title}
            </h1>
            <span
              className="font-mono text-[9px] font-semibold tracking-[0.22em] text-ink-faint/50 uppercase whitespace-nowrap"
              aria-hidden
            >
              {romanized}
            </span>
          </div>

          {/* 说明文字，宽屏时紧随标题 */}
          {caption && (
            <p className="hidden lg:block text-[12px] text-ink-faint/80 truncate max-w-sm">
              {caption}
            </p>
          )}
        </div>

        {/* 右侧动作区 */}
        {actions && (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </header>
  )
}
