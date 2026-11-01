import { ArrowUpRight, BookOpen, GithubLogo } from '@phosphor-icons/react'
import { DOCS_URL, GITHUB_URL, ISSUES_URL } from '../data/content'

export function Footer(): React.JSX.Element {
  return (
    <footer className="site-footer">
      <div className="container footer-main">
        <a className="brand footer-brand" href="#top" aria-label="返回首页">
          <img src="/mile-terminal.webp" alt="" width="42" height="42" />
          <span className="brand-type">
            <strong>MILE</strong>
            <span>TERMINAL</span>
          </span>
        </a>
        <p>为本地开发而生的 Windows Ops 指挥台。<br />项目、终端、端口与进程，一处收口。</p>
        <nav className="footer-links" aria-label="页脚导航">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubLogo size={15} aria-hidden />源代码<ArrowUpRight size={12} aria-hidden /></a>
          <a href={DOCS_URL} target="_blank" rel="noreferrer"><BookOpen size={15} aria-hidden />使用指南<ArrowUpRight size={12} aria-hidden /></a>
          <a href={ISSUES_URL} target="_blank" rel="noreferrer">问题反馈<ArrowUpRight size={12} aria-hidden /></a>
        </nav>
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} MILE TERMINAL</span>
        <span>LOCAL-FIRST · WINDOWS · NO ACCOUNT</span>
        <a href="#top">BACK TO TOP ↑</a>
      </div>
    </footer>
  )
}
