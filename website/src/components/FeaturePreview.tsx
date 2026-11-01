import type { FeatureId } from '../data/content'

function DashboardPreview(): React.JSX.Element {
  return (
    <>
      <div className="preview-kpi-grid">
        <div><span>我的服务</span><strong>4 / 6</strong><i className="mini-chart mini-chart--up" /></div>
        <div><span>CPU LOAD</span><strong>28%</strong><i className="mini-chart" /></div>
        <div><span>端口冲突</span><strong className="text-live">0</strong><small>无冲突</small></div>
      </div>
      <div className="preview-table">
        <div className="preview-table-head"><span>SERVICE</span><span>PORT</span><span>CPU</span></div>
        {[
          ['storefront', ':5173', '12.4%'],
          ['api-server', ':8080', '8.1%'],
          ['docs-preview', ':4173', '2.6%']
        ].map((row) => (
          <div className="preview-table-row" key={row[0]}>
            <span><i className="status-dot" />{row[0]}</span><b>{row[1]}</b><span>{row[2]}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function LaunchpadPreview(): React.JSX.Element {
  return (
    <div className="preview-card-grid">
      {[
        { name: 'Mall Frontend', type: 'React · Vite', port: ':5173', status: '运行中', tone: 'live' },
        { name: 'Production Build', type: 'TASK · build:prod', port: '00:42', status: '已完成', tone: 'info' }
      ].map((card) => (
        <div className="preview-entry-card" key={card.name}>
          <div className="entry-card-top"><span className="entry-glyph">{card.name.charAt(0)}</span><span className={`status-pill status-pill--${card.tone}`}>{card.status}</span></div>
          <strong>{card.name}</strong>
          <span className="entry-meta">{card.type}</span>
          <div className="entry-path">E:\WebApp\mile\{card.name === 'Mall Frontend' ? 'frontend' : 'release'}</div>
          <div className="entry-actions"><span>{card.tone === 'live' ? '停止' : '再次运行'}</span><span>日志</span><b>{card.port}</b></div>
        </div>
      ))}
      <div className="preview-inline-command"><span>⌘</span><div><strong>拖一下，顺序就保存</strong><small>也支持 Ctrl + 方向键</small></div></div>
    </div>
  )
}

function BackendPreview(): React.JSX.Element {
  return (
    <div className="backend-preview">
      <div className="backend-project"><span className="entry-glyph">SB</span><div><strong>mall-backend</strong><small>Spring Boot · Maven Wrapper</small></div><span className="status-pill status-pill--live">RUNNING</span></div>
      <div className="preview-label">BUILD TARGETS</div>
      <div className="build-goals"><span>Clean</span><span>Validate</span><span className="is-selected">Package</span><span>Install</span></div>
      <div className="preview-label">PROFILES</div>
      <div className="profile-row"><span>dev</span><span className="profile-sandbox">sandbox</span><span className="profile-prod">prod</span></div>
      <div className="jar-success"><span className="success-check">✓</span><div><strong>打包完成：mall-api-1.7.0.jar</strong><small>target/mall-api-1.7.0.jar</small></div><span>定位产物 →</span></div>
      <div className="backend-command"><span>$</span> .\mvnw.cmd package -P sandbox</div>
    </div>
  )
}

function WorkgroupsPreview(): React.JSX.Element {
  return (
    <div className="workgroup-preview">
      <div className="group-sidebar">
        <span className="preview-label">WORKGROUPS</span>
        <div className="group-item is-active"><strong>商城系统</strong><small>3 个条目</small></div>
        <div className="group-item"><strong>内容平台</strong><small>2 个条目</small></div>
        <div className="group-add">+ 新建工作组</div>
      </div>
      <div className="group-detail">
        <div className="group-detail-head"><div><small>PROJECT GROUP</small><strong>商城系统</strong></div><span>开发</span></div>
        <div className="environment-switch"><span className="is-active">DEV</span><span>SANDBOX</span><span>PROD</span></div>
        {['mall-frontend', 'mall-backend', 'db-migration'].map((entry, index) => (
          <div className="group-entry" key={entry}><i className={index === 2 ? 'status-dot is-idle' : 'status-dot'} /><span>{entry}</span><small>{index === 0 ? ':5173' : index === 1 ? ':8080' : 'TASK'}</small></div>
        ))}
        <div className="environment-note">环境切换会持久化 · 生产环境启动前警示</div>
      </div>
    </div>
  )
}

function TerminalPreview(): React.JSX.Element {
  return (
    <div className="terminal-preview">
      <div className="terminal-tabs"><span className="is-active">mall-web</span><span>mall-api</span><span>PowerShell</span><b>+</b></div>
      <div className="terminal-screen">
        <p><span className="terminal-path">E:\WebApp\mall-web</span> npm run dev</p>
        <p>&nbsp;</p>
        <p><span className="text-info">VITE v7.3.6</span> ready in 182 ms</p>
        <p>➜ Local: <span className="text-info">http://localhost:5173/</span></p>
        <p>➜ Network: use --host to expose</p>
        <p>&nbsp;</p>
        <p><span className="text-live">✓</span> hot module update: src/App.tsx</p>
        <p><span className="terminal-prompt">❯</span> <i className="terminal-cursor" /></p>
      </div>
      <div className="terminal-status"><span>CONPTY · UTF-8</span><span>WEBGL · 5000 LINES</span></div>
    </div>
  )
}

function LogsPreview(): React.JSX.Element {
  return (
    <div className="logs-preview">
      <div className="log-filters"><span>全部会话⌄</span><span>全部级别⌄</span><div>⌕ 输入关键字</div></div>
      <div className="log-summary"><span>4,812 LINES IN MEMORY</span><span>磁盘写入：0</span></div>
      {[
        ['14:32:08.104', 'INFO', 'mall-web', 'VITE ready in 182 ms'],
        ['14:32:09.442', 'INFO', 'mall-api', 'Started MallApplication in 3.218 seconds'],
        ['14:32:11.018', 'WARN', 'mall-web', 'Port 5174 is in use, trying another one'],
        ['14:32:12.731', 'ERROR', 'build', 'Cannot find module ./missing-config']
      ].map((line) => (
        <div className={`log-line log-line--${line[1].toLowerCase()}`} key={`${line[0]}-${line[1]}`}>
          <span>{line[0]}</span><b>{line[1]}</b><span>{line[2]}</span><code>{line[3]}</code>
        </div>
      ))}
    </div>
  )
}

function DiagnosePreview(): React.JSX.Element {
  return (
    <div className="diagnose-preview">
      <div className="diagnose-head"><div><small>PRECHECK REPORT</small><strong>mall-web</strong></div><span className="status-pill status-pill--warn">1 项待处理</span></div>
      {[
        ['工作目录可用', 'PASS', 'E:\\WebApp\\mall-web'],
        ['启动脚本已声明', 'PASS', 'npm run dev'],
        ['Node.js 运行时', 'PASS', 'v20.19.0'],
        ['项目依赖已安装', 'FAIL', '未找到 node_modules']
      ].map((check) => (
        <div className={`diagnose-row${check[1] === 'FAIL' ? ' is-fail' : ''}`} key={check[0]}>
          <span>{check[1] === 'PASS' ? '✓' : '!'}</span><strong>{check[0]}</strong><small>{check[2]}</small><b>{check[1]}</b>
        </div>
      ))}
      <div className="diagnose-fix"><div><strong>缺失依赖不会自动安装</strong><small>由你确认后，创建一个显式安装会话</small></div><span>创建安装会话 →</span></div>
      <div className="diagnose-privacy">ENV KEYS ONLY · VALUES NEVER EXPOSED</div>
    </div>
  )
}

function renderPreview(feature: FeatureId): React.JSX.Element {
  switch (feature) {
    case 'dashboard': return <DashboardPreview />
    case 'launchpad': return <LaunchpadPreview />
    case 'backend': return <BackendPreview />
    case 'workgroups': return <WorkgroupsPreview />
    case 'terminal': return <TerminalPreview />
    case 'logs': return <LogsPreview />
    case 'diagnose': return <DiagnosePreview />
  }
}

export function FeaturePreview({ feature }: { feature: FeatureId }): React.JSX.Element {
  return (
    <div className={`feature-preview feature-preview--${feature}`} aria-hidden="true">
      <div className="preview-window-bar"><span /><span /><span /><b>{feature.toUpperCase()} / MILE TERMINAL</b></div>
      <div className="preview-window-body">{renderPreview(feature)}</div>
    </div>
  )
}
