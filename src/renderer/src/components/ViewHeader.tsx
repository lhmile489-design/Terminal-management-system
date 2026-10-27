/**
 * 视图头，UI-REFACTOR §3.2：标题（Manrope 700，22px）+ 一行说明 + 右侧本页主操作。
 * 随内容滚动，不吸顶；吸顶的只有标题栏。
 * 旧版的 eyebrow 与等宽罗马字副标去掉了 —— 9–9.5px、对比度 2.1:1，是阶段 0 基线里
 * 每个视图都有的低对比度来源。
 */
export function ViewHeader({
  title,
  caption,
  actions
}: {
  title: string
  caption?: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="ui-view-head">
      <div className="min-w-0">
        <h1 className="ui-view-title">{title}</h1>
        {caption && <p className="ui-view-caption">{caption}</p>}
      </div>
      {actions && <div className="ui-view-actions">{actions}</div>}
    </header>
  )
}
