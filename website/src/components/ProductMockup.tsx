import {
  Command,
  Folders,
  Gauge,
  Gear,
  ListMagnifyingGlass,
  Rocket,
  Stethoscope,
  Terminal,
  TreeStructure
} from '@phosphor-icons/react'

const NAV_ICONS = [Gauge, Rocket, TreeStructure, Folders, Terminal, ListMagnifyingGlass, Stethoscope]

const SERVICES = [
  { name: 'mall-web', stack: 'React · Vite', port: ':5173', status: 'RUNNING', cpu: '12.4%', tone: 'live' },
  { name: 'mall-api', stack: 'Spring Boot', port: ':8080', status: 'RUNNING', cpu: '8.1%', tone: 'live' },
  { name: 'docs-site', stack: 'Vue · Vite', port: ':4173', status: 'IDLE', cpu: '—', tone: 'idle' }
]

export function ProductMockup(): React.JSX.Element {
  return (
    <div className="product-stage" role="img" aria-label="Mile Terminal 工作台界面示意，展示服务、端口、资源与终端状态">
      <div className="product-backplate" aria-hidden="true" />
      <div className="app-window" aria-hidden="true">
        <div className="app-titlebar">
          <div className="app-title">
            <img src="/mile-terminal.webp" alt="" width="20" height="20" />
            <span>Mile Terminal</span>
            <span className="app-title-muted">/ OPS CONSOLE</span>
          </div>
          <div className="window-controls"><span /><span /><span /></div>
        </div>

        <div className="app-layout">
          <div className="app-rail">
            <div className="rail-mark"><Terminal size={15} /></div>
            {NAV_ICONS.map((Icon, index) => (
              <span key={index} className={`rail-icon${index === 0 ? ' is-active' : ''}`}>
                <Icon size={14} />
              </span>
            ))}
            <span className="rail-icon rail-settings"><Gear size={14} /></span>
          </div>

          <div className="app-main">
            <div className="app-heading">
              <div>
                <span className="app-eyebrow">DASHBOARD</span>
                <strong>工作台</strong>
              </div>
              <span className="app-live"><span className="live-dot" /> LIVE · 2S</span>
            </div>

            <div className="app-kpis">
              <div><span>我的服务</span><strong>04<small>/ 06</small></strong></div>
              <div><span>外部监听</span><strong>12</strong></div>
              <div><span>CPU</span><strong>28<small>%</small></strong></div>
              <div><span>内存</span><strong>61<small>%</small></strong></div>
            </div>

            <div className="app-section-head">
              <span>LISTENING SERVICES</span>
              <span>6 ITEMS</span>
            </div>

            <div className="app-services">
              {SERVICES.map((service) => (
                <div className="app-service" key={service.name}>
                  <span className={`service-state service-state--${service.tone}`} />
                  <div className="service-name">
                    <strong>{service.name}</strong>
                    <span>{service.stack}</span>
                  </div>
                  <span className="service-port">{service.port}</span>
                  <span className="service-cpu">{service.cpu}</span>
                  <span className={`service-status service-status--${service.tone}`}>{service.status}</span>
                </div>
              ))}
            </div>

            <div className="app-terminal">
              <div className="terminal-head"><span>TERMINAL / mall-web</span><span>PTY 04</span></div>
              <div className="terminal-lines">
                <p><span>$</span> npm run dev</p>
                <p className="terminal-muted">VITE v7.3.6 ready in 182 ms</p>
                <p><span>→</span> Local: <b>http://localhost:5173/</b></p>
                <p><span>$</span> <i className="terminal-cursor" /></p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="command-float" aria-hidden="true">
        <div className="command-float-head">
          <Command size={14} />
          <span>全局命令面板</span>
          <kbd>Ctrl K</kbd>
        </div>
        <div className="command-search"><span>›</span> 5173</div>
        <div className="command-result"><span>定位监听端口</span><strong>:5173</strong></div>
      </div>
    </div>
  )
}
