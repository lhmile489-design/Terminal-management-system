import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useTheme } from '../store/theme'
import { useSettings } from '../store/settings'
import { IconButton } from './ui'
import { ICON } from '../lib/icons'

const THEMES = {
  light: {
    background: '#ffffff',
    foreground: '#3d4653',
    cursor: '#161b22',
    selectionBackground: '#d8e6f7',
    black: '#3d4653',
    red: '#c93c37',
    green: '#1a7f37',
    yellow: '#8a6100',
    blue: '#0a5aa8',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6b7684',
    brightBlack: '#9aa4b2'
  },
  dark: {
    background: '#0f1419',
    foreground: '#c9d3e0',
    cursor: '#f0f4f9',
    selectionBackground: '#264166',
    black: '#484f58',
    red: '#f85149',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7b8c'
  }
} as const

/**
 * 搜索命中的高亮色。SearchAddon 只认 #RRGGBB，所以不能用 CSS 变量；
 * 深浅两套各取一组，命中底色淡、当前命中底色深一档。
 */
const SEARCH_DECORATIONS = {
  light: {
    matchBackground: '#fff1b8',
    matchOverviewRuler: '#d4a72c',
    activeMatchBackground: '#ffc94d',
    activeMatchColorOverviewRuler: '#b07800'
  },
  dark: {
    matchBackground: '#4d3d0f',
    matchOverviewRuler: '#d29922',
    activeMatchBackground: '#8a6a12',
    activeMatchColorOverviewRuler: '#f0c040'
  }
} as const

export function TerminalView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resolved = useTheme((s) => s.resolved)
  const fontSize = useSettings((s) => s.settings?.terminalFontSize)
  const scrollback = useSettings((s) => s.settings?.scrollback)

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  /** index 为 -1 表示命中数超过高亮上限，只知道总数 */
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[resolved]
  }, [resolved])

  // 字号与回滚行数改了要立刻生效，不必重开会话。改字号后必须重新 fit，
  // 否则行列数还是旧的，输出会错行。
  useEffect(() => {
    const term = termRef.current
    if (!term || !fontSize) return
    term.options.fontSize = fontSize
    fitRef.current?.fit()
    window.mile.session.resize(sessionId, term.cols, term.rows)
  }, [fontSize, sessionId])

  useEffect(() => {
    if (termRef.current && scrollback) termRef.current.options.scrollback = scrollback
  }, [scrollback])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // 字号与回滚行数取设置，缺省值与 ConfigStore 保持一致
    const initial = useSettings.getState().settings
    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: initial?.terminalFontSize ?? 13,
      lineHeight: 1.5,
      scrollback: initial?.scrollback ?? 5000,
      cursorBlink: true,
      theme: THEMES[useTheme.getState().resolved],
      allowProposedApi: true
    })
    termRef.current = term

    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    const search = new SearchAddon()
    searchRef.current = search
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon())
    term.open(host)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL 不可用时回退到 canvas 渲染
    }

    // Ctrl+F 在终端里打开搜索条，而不是作为 ^F 发给 shell。返回 false = xterm 不处理这次按键
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setSearchOpen(true)
        // 已经开着时再按一次，把焦点拉回搜索框并全选
        requestAnimationFrame(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        })
        return false
      }
      return true
    })

    const offResults = search.onDidChangeResults((r) => {
      setResult({ index: r.resultIndex, count: r.resultCount })
    })

    // 切换会话或卸载后 term 已 dispose，迟到的 history 回执不能再写它、也不能 resize
    let disposed = false
    const sync = (): void => {
      if (disposed) return
      fit.fit()
      window.mile.session.resize(sessionId, term.cols, term.rows)
    }

    void window.mile.session.history(sessionId).then((history) => {
      if (disposed) return
      if (history) term.write(history)
      sync()
    })

    const offData = window.mile.session.onData((e) => {
      if (e.id === sessionId) term.write(e.chunk)
    })

    const offExit = window.mile.session.onExit((e) => {
      if (e.id === sessionId) term.write(`\r\n\x1b[90m[进程退出，代码 ${e.exitCode}]\x1b[0m\r\n`)
    })

    const inputDisposable = term.onData((data) => window.mile.session.write(sessionId, data))

    const observer = new ResizeObserver(sync)
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      inputDisposable.dispose()
      offResults.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
      searchRef.current = null
    }
  }, [sessionId])

  const searchOptions = (incremental: boolean): ISearchOptions => ({
    incremental,
    decorations: SEARCH_DECORATIONS[useTheme.getState().resolved]
  })

  const run = (q: string, direction: 'next' | 'prev', incremental = false): void => {
    const search = searchRef.current
    if (!search) return
    if (!q) {
      search.clearDecorations()
      setResult(null)
      return
    }
    const hit = direction === 'next'
      ? search.findNext(q, searchOptions(incremental))
      : search.findPrevious(q, searchOptions(false))
    // 搜不到时 onDidChangeResults 不一定触发，这里直接置零
    if (!hit) setResult({ index: -1, count: 0 })
  }

  const closeSearch = (): void => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setResult(null)
    termRef.current?.focus()
  }

  const status = !query
    ? ''
    : !result || result.count === 0
      ? '无结果'
      : result.index >= 0
        ? `第 ${result.index + 1} / 共 ${result.count} 条`
        : `共 ${result.count} 条`

  return (
    <div className="term-view">
      {searchOpen && (
        <div className="term-search" data-term-search role="search" aria-label="在终端输出中搜索">
          <ICON.search size={16} aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            aria-label="搜索终端输出"
            placeholder="搜索输出"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              run(e.target.value, 'next', true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                run(query, e.shiftKey ? 'prev' : 'next')
              } else if (e.key === 'Escape') {
                // 只关搜索条，不让全局 Esc（关详情、关浮层）接着处理
                e.preventDefault()
                e.stopPropagation()
                closeSearch()
              }
            }}
          />
          <span className="term-search-status" data-term-search-status aria-live="polite">{status}</span>
          <IconButton icon={ICON.moveUp} label="上一条（Shift+Enter）" disabled={!query} onClick={() => run(query, 'prev')} />
          <IconButton icon={ICON.moveDown} label="下一条（Enter）" disabled={!query} onClick={() => run(query, 'next')} />
          <IconButton icon={ICON.close} label="关闭搜索（Esc）" onClick={closeSearch} />
        </div>
      )}
      <div
        ref={hostRef}
        className="h-full w-full px-3 py-2"
        style={{ background: 'var(--terminal-bg)' }}
      />
    </div>
  )
}
