import { useEffect, useState } from 'react'
import { ArrowUpRight, GithubLogo, List, X } from '@phosphor-icons/react'
import { GITHUB_URL, NAV_ITEMS } from '../data/content'

export function Header(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  return (
    <header className="site-header">
      <div className="container header-inner">
        <a className="brand" href="#top" aria-label="Mile Terminal 首页" onClick={() => setOpen(false)}>
          <img src="/mile-terminal.webp" alt="" width="38" height="38" />
          <span className="brand-type">
            <strong>MILE</strong>
            <span>TERMINAL</span>
          </span>
        </a>

        <nav id="site-nav" className={`site-nav${open ? ' is-open' : ''}`} aria-label="官网导航">
          {NAV_ITEMS.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="header-actions">
          <a className="header-github" href={GITHUB_URL} target="_blank" rel="noreferrer">
            <GithubLogo size={17} aria-hidden />
            <span>GitHub</span>
            <ArrowUpRight size={13} aria-hidden />
          </a>
          <button
            className="menu-toggle"
            type="button"
            aria-label={open ? '关闭导航' : '打开导航'}
            aria-expanded={open}
            aria-controls="site-nav"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={22} aria-hidden /> : <List size={22} aria-hidden />}
          </button>
        </div>
      </div>
    </header>
  )
}
