import { useEffect, useState } from 'react'
import { ArrowSquareOut, GithubLogo, ShieldCheck, type Icon } from '@phosphor-icons/react'
import { ICON } from '../lib/icons'
import logoUrl from '../assets/logo.png'

// 外链地址写死在主进程 PROJECT_LINKS：window.open 会被窗口守卫按 localhost-only 拦下，点了没反应

/** 使用教程：按现在的页面结构写（总览 / 服务 / 终端），UI-REFACTOR §3 */
const GUIDE_STEPS: { icon: Icon; title: string; desc: string }[] = [
  {
    icon: ICON.add,
    title: '添加服务',
    desc: '在「服务」页点「添加服务」，选项目目录。应用只读 package.json、pom.xml 等标记文件识别框架，不执行项目代码。'
  },
  {
    icon: ICON.group,
    title: '按工作组整理',
    desc: '「新建工作组」把前后端放在一起。把服务行拖到别的工作组即可换组，拖到行上方或下方可排顺序。'
  },
  {
    icon: ICON.start,
    title: '启停与查看输出',
    desc: '行上的按钮启停单个服务，组头的「全部启动」一次启动整组。点一行打开详情，概览、输出、诊断、配置都在里面。'
  },
  {
    icon: ICON.port,
    title: '打开前端页面',
    desc: '服务运行起来后，行上的端口号可以点，直接在浏览器打开 localhost。多个服务撞在同一端口时会标「端口重合」。'
  },
  {
    icon: ICON.diagnose,
    title: '预检与诊断',
    desc: '启动前自动检查目录、脚本、运行时和端口。没通过时右下角弹通知，「查看诊断」直达原因和修复入口。'
  },
  {
    icon: ICON.navOverview,
    title: '总览本机状态',
    desc: '「总览」显示监听端口、CPU、内存和最常用的 5 个服务，端口被谁占用、是不是本应用启动的一眼可见。'
  },
  {
    icon: ICON.output,
    title: '终端与全部输出',
    desc: '「终端」页可新建 PowerShell；「全部输出」汇总所有会话的日志，按级别、会话、关键字筛选，点一行跳回对应会话。'
  }
]

const DESIGN_PRINCIPLES: { title: string; desc: string }[] = [
  { title: '不安装依赖，不执行项目代码', desc: '识别只读文件，不跑 npm install 和任何版本查询。缺依赖时只提示，由你主动创建安装会话。' },
  { title: '归属可证才能终止进程', desc: '只停止通过「运行 token + 进程组 + 当前用户」三重校验的进程，不因端口相同就结束外部进程。' },
  { title: '失败前置', desc: '启动前把能检查的问题都检查一遍，并直接给出修复入口。' },
  { title: '日志只留内存', desc: '跨会话日志是环形缓冲，不落盘；环境变量只显示键名，不显示值。' }
]

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: 'Ctrl+K', desc: '打开命令面板' },
  { keys: 'Ctrl+1–5', desc: '切换总览 / 服务 / 终端 / 设置 / 关于' },
  { keys: '↑ / ↓', desc: '服务页移动选中行' },
  { keys: 'Space', desc: '启动或停止选中的服务' },
  { keys: 'Ctrl+↑ / ↓', desc: '在本组内调整顺序' },
  { keys: '?', desc: '快捷键一览' }
]

const STACK = ['Electron 43', 'React 19', 'TypeScript', 'Vite 7', 'Tailwind 4', 'node-pty', 'xterm.js 6', 'Zustand']

export function About(): React.JSX.Element {
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    void window.mile.app.info().then((info) => setVersion(info.version))
  }, [])

  return (
    <div className="about-grid">
      <section className="ui-tile about-brand" aria-labelledby="about-title">
        <div className="about-brand-top">
          <span className="about-logo" aria-hidden>
            <img src={logoUrl} alt="" draggable={false} />
          </span>
          <div className="min-w-0">
            <h2 id="about-title" className="about-name">Mile Terminal</h2>
            {version && <span className="ui-pill" data-tone="accent" data-mono="true">v{version}</span>}
          </div>
        </div>
        <p className="about-lead">
          Windows 本地服务与终端管理工作台。把「本机现在跑着什么」和「我常跑的那几个项目」收进一个界面：
          按工作组启停前后端、看端口占用、跨会话回看输出、启动前诊断。
        </p>
        <div className="about-actions">
          <button type="button" className="ui-btn" data-variant="primary" onClick={() => window.mile.shell.openProjectLink('repo')}>
            <GithubLogo size={16} aria-hidden />GitHub 仓库<ArrowSquareOut size={16} aria-hidden />
          </button>
          <button type="button" className="ui-btn" data-variant="secondary" onClick={() => window.mile.shell.openProjectLink('issues')}>
            提交 Issue<ArrowSquareOut size={16} aria-hidden />
          </button>
        </div>
        <ul className="about-stack" aria-label="技术栈">
          {STACK.map((t) => <li key={t}>{t}</li>)}
        </ul>
        <p className="about-meta">个人自用 · Windows 11 · 开源</p>
      </section>

      <section className="ui-tile about-tile" aria-labelledby="about-shortcuts-heading">
        <h3 id="about-shortcuts-heading" className="about-h">常用快捷键</h3>
        <dl className="about-keys">
          {SHORTCUTS.map((r) => (
            <div key={r.keys}>
              <dt>{r.desc}</dt>
              <dd><kbd className="ui-kbd">{r.keys}</kbd></dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="ui-tile about-tile about-wide" aria-labelledby="about-guide-heading">
        <h3 id="about-guide-heading" className="about-h">使用教程</h3>
        <ol className="about-steps">
          {GUIDE_STEPS.map((s, i) => {
            const IconCmp = s.icon
            return (
              <li key={s.title}>
                <span className="about-step-icon" aria-hidden><IconCmp size={20} /></span>
                <div className="min-w-0">
                  <b><span className="about-step-n">{i + 1}</span>{s.title}</b>
                  <p>{s.desc}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <section className="ui-tile about-tile about-wide" aria-labelledby="about-principles-heading">
        <h3 id="about-principles-heading" className="about-h">
          <ShieldCheck size={20} aria-hidden />设计原则
        </h3>
        <div className="about-principles">
          {DESIGN_PRINCIPLES.map((p) => (
            <div key={p.title}>
              <b>{p.title}</b>
              <p>{p.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
