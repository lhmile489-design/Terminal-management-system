/**
 * 视图页头：eyebrow + 展示型大标题（中文主标 + 等宽罗马字副标）+ 说明 + 右侧动作区。
 *
 * 参考项目的核心视觉签名。副标用 em 跟随主标缩放，窗口变窄时比例不变。
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
    <header className="mb-7 shrink-0">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="eyebrow eyebrow-tight mb-2.5">{eyebrow}</p>
          <h1 className="display-title">
            {title}
            <span className="romanized" aria-hidden>
              {romanized}
            </span>
          </h1>
          <p className="mt-2 text-[13px] text-ink-muted">{caption}</p>
        </div>
        {actions && <div className="flex shrink-0 flex-col items-end gap-2.5">{actions}</div>}
      </div>
    </header>
  )
}
