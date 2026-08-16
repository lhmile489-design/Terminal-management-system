import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useTheme } from '../store/theme'
import { useSettings } from '../store/settings'

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

export function TerminalView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resolved = useTheme((s) => s.resolved)
  const fontSize = useSettings((s) => s.settings?.terminalFontSize)
  const scrollback = useSettings((s) => s.settings?.scrollback)

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
    term.loadAddon(new SearchAddon())
    term.loadAddon(new WebLinksAddon())
    term.open(host)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL 不可用时回退到 canvas 渲染
    }

    const sync = (): void => {
      fit.fit()
      window.mile.session.resize(sessionId, term.cols, term.rows)
    }

    void window.mile.session.history(sessionId).then((history) => {
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
      observer.disconnect()
      inputDisposable.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
    }
  }, [sessionId])

  return (
    <div
      ref={hostRef}
      className="h-full w-full px-3 py-2"
      style={{ background: 'var(--terminal-bg)' }}
    />
  )
}
