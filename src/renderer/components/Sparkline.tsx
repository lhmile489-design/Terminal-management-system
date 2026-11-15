const WIDTH = 54
const HEIGHT = 20

export function Sparkline({ points, tone }: { points: number[]; tone: string }): React.JSX.Element {
  if (points.length < 2) {
    return <div className="h-[20px] w-[54px] shrink-0" aria-hidden />
  }

  const max = Math.max(...points, 1)
  const step = WIDTH / (points.length - 1)
  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(HEIGHT - (v / max) * HEIGHT).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="shrink-0"
      aria-hidden
      focusable="false"
    >
      <path d={d} fill="none" stroke={tone} strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  )
}
