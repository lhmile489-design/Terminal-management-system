/**
 * engines.node 比对，只做 PRD §5.1 第 5 项需要的子集。
 *
 * 不引入 semver 依赖：这里只需要判断当前 Node 是否满足 range，且结果只出 warn。
 * 支持 `>=x`、`>x`、`<=x`、`<x`、`^x`、`~x`、`x.y.z`、`x || y` 与空格分隔的交集。
 * 无法解析时返回 null（未知），由调用方按「不阻止」处理。
 */
export function satisfies(version: string, range: string): boolean | null {
  const target = parse(version)
  if (!target) return null

  const alternatives = range.split('||').map((r) => r.trim()).filter(Boolean)
  if (alternatives.length === 0) return null

  let parsedAny = false
  for (const alt of alternatives) {
    const clauses = alt.split(/\s+/).filter(Boolean)
    let all = true
    let anyClause = false

    for (const clause of clauses) {
      const result = matchClause(target, clause)
      if (result === null) continue
      anyClause = true
      if (!result) all = false
    }

    if (!anyClause) continue
    parsedAny = true
    if (all) return true
  }

  return parsedAny ? false : null
}

type Version = [number, number, number]

function matchClause(target: Version, clause: string): boolean | null {
  if (clause === '*' || clause === 'x') return true

  const m = clause.match(/^(>=|<=|>|<|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/)
  if (!m) return null

  const op = m[1] ?? '='
  const base: Version = [Number(m[2]), numOr(m[3], 0), numOr(m[4], 0)]

  switch (op) {
    case '>=':
      return compare(target, base) >= 0
    case '>':
      return compare(target, base) > 0
    case '<=':
      return compare(target, base) <= 0
    case '<':
      return compare(target, base) < 0
    case '^':
      // ^0.x 锁次版本，^x.y 锁主版本
      return base[0] === 0
        ? target[0] === 0 && target[1] === base[1] && compare(target, base) >= 0
        : target[0] === base[0] && compare(target, base) >= 0
    case '~':
      return target[0] === base[0] && target[1] === base[1] && compare(target, base) >= 0
    default: {
      // 省略的段视为通配：`22` 匹配任意 22.x.x
      if (m[3] === undefined || m[3] === 'x' || m[3] === '*') return target[0] === base[0]
      if (m[4] === undefined || m[4] === 'x' || m[4] === '*') {
        return target[0] === base[0] && target[1] === base[1]
      }
      return compare(target, base) === 0
    }
  }
}

function parse(version: string): Version | null {
  const m = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function numOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === 'x' || v === '*') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
