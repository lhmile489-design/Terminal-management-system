import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  Command,
  Copy,
  Folders,
  Gear,
  GithubLogo,
  Link,
  MagnifyingGlass,
  ShieldCheck,
  type Icon
} from '@phosphor-icons/react'
import {
  ARCHITECTURE_LAYERS,
  CAPABILITIES,
  DOCS_URL,
  FAQS,
  GITHUB_URL,
  INSTALL_COMMANDS,
  PRINCIPLES,
  QUICK_START_STEPS,
  STATS,
  TECH_STACK
} from '../data/content'

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: ReactNode; description: string }): React.JSX.Element {
  return (
    <div className="section-heading section-heading--split" data-reveal>
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <p>{description}</p>
    </div>
  )
}

export function MetricsSection(): React.JSX.Element {
  return (
    <section className="metrics container" aria-label="项目关键指标" data-reveal>
      {STATS.map((stat) => (
        <div className="metric" key={stat.label}>
          <div className="metric-value">{stat.value}<span>{stat.unit}</span></div>
          <strong>{stat.label}</strong>
          <small>{stat.note}</small>
        </div>
      ))}
    </section>
  )
}

export function WorkflowSection(): React.JSX.Element {
  const rows = [
    { index: '01', before: '5173 到底被谁占了？', after: '端口、PID、目录、归属与负载，同一行看清。' },
    { index: '02', before: '这个项目该跑哪个命令？', after: '只列出项目真实声明的脚本，不再靠回忆。' },
    { index: '03', before: '刚才的报错藏在哪个窗口？', after: '按会话、级别和关键字，直接检索输出。' }
  ]

  return (
    <section id="workflow" className="section workflow-section">
      <div className="container workflow-grid">
        <div className="workflow-intro" data-reveal>
          <span className="eyebrow">THE DAILY FRICTION</span>
          <h2>散落的窗口，<br />不该是你的工作流。</h2>
          <p>Mile Terminal 不替代你的终端。它把每天反复发生的寻找、切换与排查，变成一条更短的路径。</p>
        </div>
        <div className="workflow-list" data-reveal>
          {rows.map((row) => (
            <article className="workflow-row" key={row.index}>
              <span className="workflow-index">{row.index}</span>
              <div><small>BEFORE</small><h3>{row.before}</h3></div>
              <ArrowRight size={20} aria-hidden />
              <div><small>WITH MILE</small><p>{row.after}</p></div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

const CAPABILITY_ICONS: Record<(typeof CAPABILITIES)[number]['id'], Icon> = {
  command: Command,
  tasks: Bell,
  ports: Link,
  groups: Folders,
  settings: Gear,
  recognition: MagnifyingGlass
}

export function CapabilitiesSection(): React.JSX.Element {
  return (
    <section id="capabilities" className="section capabilities-section">
      <div className="container">
        <SectionHeading
          eyebrow="02 / SMALL DETAILS, REAL FLOW"
          title={<>不止集中，<br />更要顺手。</>}
          description="真正节省时间的，往往不是更大的功能列表，而是每个高频动作都少一步、每个异常状态都说得清楚。"
        />
        <div className="capability-grid">
          {CAPABILITIES.map((capability, index) => {
            const IconComponent = CAPABILITY_ICONS[capability.id]
            return (
              <article
                className={`capability-card capability-card--${capability.size}`}
                key={capability.id}
                data-reveal
                style={{ '--reveal-order': index % 3 } as React.CSSProperties}
              >
                <div className="capability-card-top">
                  <span className="capability-icon"><IconComponent size={20} aria-hidden /></span>
                  <span className="capability-tag">{capability.tag}</span>
                </div>
                <h3>{capability.title}</h3>
                <p>{capability.description}</p>
                <span className="capability-number" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export function SecuritySection(): React.JSX.Element {
  return (
    <section id="security" className="section security-section">
      <div className="container">
        <div className="security-hero" data-reveal>
          <div className="security-copy">
            <span className="eyebrow">03 / SAFETY BY DESIGN</span>
            <h2>看得见系统，<br /><span>但不越界。</span></h2>
            <p>本机工具需要权限，更需要克制。Mile Terminal 把安全边界写成产品行为，而不是一句附注。</p>
            <div className="security-assurance"><ShieldCheck size={20} aria-hidden /><span>观察外部进程，不等于有权终止它。</span></div>
          </div>

          <div className="ownership-diagram" aria-label="进程归属三重校验示意">
            <div className="diagram-header"><span>OWNERSHIP PROTOCOL</span><span>REVALIDATE BEFORE KILL</span></div>
            <div className="credential-stack">
              <div><span>01</span><strong>RUN TOKEN</strong><small>启动会话登记</small></div>
              <div><span>02</span><strong>PROCESS GROUP</strong><small>进程树与归属</small></div>
              <div><span>03</span><strong>CURRENT UID</strong><small>仅限当前用户</small></div>
            </div>
            <div className="diagram-connector" aria-hidden><span /><span /><span /></div>
            <div className="ownership-result">
              <span className="result-icon"><Check size={20} aria-hidden /></span>
              <div><small>OWNED PROCESS</small><strong>归属可证，才允许终止</strong></div>
              <span className="result-status">VERIFIED</span>
            </div>
            <div className="external-result"><span>EXTERNAL PROCESS</span><strong>可观察 · 可诊断 · 不误杀</strong></div>
          </div>
        </div>

        <div className="principles-grid">
          {PRINCIPLES.map((principle, index) => (
            <article className="principle-card" key={principle.index} data-reveal style={{ '--reveal-order': index } as React.CSSProperties}>
              <span className="principle-index">{principle.index}</span>
              <h3>{principle.title}</h3>
              <strong>{principle.summary}</strong>
              <p>{principle.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Clipboard unavailable')
}

function CommandCopy({ label, command }: { label: string; command: string }): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')

  useEffect(() => {
    if (status === 'idle') return
    const timer = window.setTimeout(() => setStatus('idle'), 1800)
    return () => window.clearTimeout(timer)
  }, [status])

  const handleCopy = async (): Promise<void> => {
    try {
      await copyText(command)
      setStatus('copied')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="install-command">
      <span>{label}</span>
      <code><b>$</b> {command}</code>
      <button type="button" onClick={() => void handleCopy()} aria-label={`复制命令：${command}`}>
        {status === 'copied' ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
        <span aria-live="polite">{status === 'copied' ? '已复制' : status === 'error' ? '复制失败' : '复制'}</span>
      </button>
    </div>
  )
}

export function QuickStartSection(): React.JSX.Element {
  return (
    <section id="quickstart" className="section quickstart-section">
      <div className="container">
        <SectionHeading
          eyebrow="04 / FROM ZERO TO RUNNING"
          title={<>四步，<br />跑起第一个项目。</>}
          description="不用学习一套新的命令语言。登记真实项目，选择真实脚本，剩下的交给清晰的状态与反馈。"
        />

        <div className="quickstart-grid">
          <div className="steps-list" data-reveal>
            {QUICK_START_STEPS.map((step) => (
              <article className="step-item" key={step.index}>
                <span>{step.index}</span>
                <div><h3>{step.title}</h3><p>{step.description}</p></div>
              </article>
            ))}
          </div>

          <aside className="install-panel" data-reveal aria-label="源码运行命令">
            <div className="install-panel-head">
              <span>BUILD FROM SOURCE</span>
              <span className="status-pill status-pill--live">V1.7.0</span>
            </div>
            <h3>你的本机，<br />就是你的运行环境。</h3>
            <p>Windows · Node.js 20+<br />发布构建推荐 Node 22 LTS</p>
            <div className="install-commands">
              {INSTALL_COMMANDS.map((item) => <CommandCopy key={item.command} {...item} />)}
            </div>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">阅读完整使用指南<ArrowUpRight size={14} aria-hidden /></a>
          </aside>
        </div>
      </div>
    </section>
  )
}

export function ArchitectureSection(): React.JSX.Element {
  return (
    <section id="architecture" className="section architecture-section">
      <div className="container">
        <SectionHeading
          eyebrow="05 / ENGINEERING"
          title={<>界面足够轻，<br />边界足够硬。</>}
          description="Electron 负责桌面能力，React 负责交互体验。所有特权操作与命令构造都留在主进程，渲染层不越权。"
        />

        <div className="architecture-flow" data-reveal>
          {ARCHITECTURE_LAYERS.map((layer, index) => (
            <article className="architecture-layer" key={layer.name}>
              <div className="architecture-layer-head"><span>{layer.index}</span><small>src/{layer.name.toLowerCase()}</small></div>
              <h3>{layer.name}</h3>
              <strong>{layer.subtitle}</strong>
              <p>{layer.description}</p>
              {index < ARCHITECTURE_LAYERS.length - 1 ? <span className="architecture-arrow" aria-hidden>→</span> : null}
            </article>
          ))}
          <div className="architecture-shared"><span>src/shared</span><strong>共用领域类型 + IPC 频道名</strong><small>一条明确、可审查的进程边界</small></div>
        </div>

        <div className="tech-grid" data-reveal>
          {TECH_STACK.map((tech) => (
            <div className="tech-item" key={tech.name}><strong>{tech.name}</strong><span>{tech.role}</span></div>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FaqSection(): React.JSX.Element {
  return (
    <section id="faq" className="section faq-section">
      <div className="container faq-grid">
        <div className="faq-intro" data-reveal>
          <span className="eyebrow">06 / QUESTIONS, ANSWERED</span>
          <h2>在开始之前，<br />把边界说清楚。</h2>
          <p>一个本地工具最值得信任的表达，是明确告诉你它会做什么，以及绝不会做什么。</p>
          <a href={DOCS_URL} target="_blank" rel="noreferrer"><BookOpen size={16} aria-hidden />查看项目文档<ArrowUpRight size={13} aria-hidden /></a>
        </div>
        <div className="faq-list" data-reveal>
          {FAQS.map((faq, index) => (
            <details key={faq.question} open={index === 0}>
              <summary><span>{String(index + 1).padStart(2, '0')}</span><strong>{faq.question}</strong><i aria-hidden /></summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FinalCtaSection(): React.JSX.Element {
  return (
    <section className="section final-cta-section">
      <div className="container final-cta" data-reveal>
        <div className="final-cta-code" aria-hidden>LOCAL / OPS / READY</div>
        <img src="/mile-terminal.webp" alt="" width="88" height="88" loading="lazy" />
        <span className="eyebrow">YOUR LOCAL PROJECTS, IN ONE PLACE</span>
        <h2>把下一个项目，<br />收进指挥台。</h2>
        <p>少一些窗口切换，多一些确定状态。<br />Mile Terminal，为每天都在发生的本地开发而来。</p>
        <div className="final-cta-actions">
          <a className="button button--primary" href={GITHUB_URL} target="_blank" rel="noreferrer"><GithubLogo size={18} aria-hidden />从 GitHub 获取<ArrowUpRight size={14} aria-hidden /></a>
          <a className="button button--secondary" href="#quickstart">查看快速开始<ArrowRight size={15} aria-hidden /></a>
        </div>
      </div>
    </section>
  )
}
