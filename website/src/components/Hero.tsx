import { ArrowDown, ArrowUpRight, GithubLogo } from '@phosphor-icons/react'
import { GITHUB_URL } from '../data/content'
import { ProductMockup } from './ProductMockup'

export function Hero(): React.JSX.Element {
  return (
    <section id="top" className="hero container">
      <div className="hero-grid">
        <div className="hero-copy">
          <div className="hero-kicker hero-enter" style={{ '--enter-order': 0 } as React.CSSProperties}>
            <span className="live-dot" aria-hidden />
            <span>LOCAL OPS CONSOLE</span>
            <span className="hero-version">V1.7.0</span>
          </div>

          <h1 className="hero-enter" style={{ '--enter-order': 1 } as React.CSSProperties}>
            本机开发，
            <span>一个指挥台。</span>
          </h1>

          <p className="hero-lead hero-enter" style={{ '--enter-order': 2 } as React.CSSProperties}>
            把「本机现在跑着什么」和「我常跑的那几个项目」收进同一个界面。
            项目、终端、端口与进程，终于不用再四处寻找。
          </p>

          <div className="hero-actions hero-enter" style={{ '--enter-order': 3 } as React.CSSProperties}>
            <a className="button button--primary" href="#features">
              探索核心功能
              <ArrowDown size={16} aria-hidden />
            </a>
            <a className="button button--secondary" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GithubLogo size={18} aria-hidden />
              GitHub 仓库
              <ArrowUpRight size={14} aria-hidden />
            </a>
          </div>

          <div className="hero-meta hero-enter" style={{ '--enter-order': 4 } as React.CSSProperties}>
            <span>WINDOWS 11 / X64</span>
            <span>本机离线</span>
            <span>无需账号</span>
          </div>
        </div>

        <div className="hero-visual hero-enter" style={{ '--enter-order': 2 } as React.CSSProperties}>
          <div className="hero-coordinate hero-coordinate--top" aria-hidden>OPS / 01</div>
          <ProductMockup />
          <div className="hero-local-note" aria-hidden>
            <span>LOCAL FIRST</span>
            <span>NO CLOUD</span>
          </div>
        </div>
      </div>

      <div className="hero-footnote hero-enter" style={{ '--enter-order': 5 } as React.CSSProperties}>
        <span>不是另一个终端窗口，而是本地开发的工作流入口。</span>
        <span className="hero-scroll" aria-hidden>SCROLL TO EXPLORE <ArrowDown size={13} /></span>
      </div>
    </section>
  )
}
