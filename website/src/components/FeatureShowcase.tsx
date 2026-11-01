import { useRef, useState, type KeyboardEvent } from 'react'
import {
  Check,
  Folders,
  Gauge,
  ListMagnifyingGlass,
  Rocket,
  Stethoscope,
  Terminal,
  TreeStructure,
  type Icon
} from '@phosphor-icons/react'
import { FEATURES, type FeatureId } from '../data/content'
import { FeaturePreview } from './FeaturePreview'

const FEATURE_ICONS: Record<FeatureId, Icon> = {
  dashboard: Gauge,
  launchpad: Rocket,
  backend: TreeStructure,
  workgroups: Folders,
  terminal: Terminal,
  logs: ListMagnifyingGlass,
  diagnose: Stethoscope
}

export function FeatureShowcase(): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const active = FEATURES[activeIndex]

  const selectAndFocus = (index: number): void => {
    setActiveIndex(index)
    tabRefs.current[index]?.focus()
  }

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    let nextIndex: number | undefined
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = (activeIndex + 1) % FEATURES.length
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex = (activeIndex - 1 + FEATURES.length) % FEATURES.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = FEATURES.length - 1
    }

    if (nextIndex === undefined) return
    event.preventDefault()
    selectAndFocus(nextIndex)
  }

  return (
    <section id="features" className="section features-section">
      <div className="container">
        <div className="section-heading section-heading--split" data-reveal>
          <div>
            <span className="eyebrow">01 / CORE WORKSPACES</span>
            <h2>七个视图，<br />一条完整工作流。</h2>
          </div>
          <p>从发现端口到启动项目，从终端输出到故障诊断。每个视图只解决一类问题，但彼此共享同一份项目上下文。</p>
        </div>

        <div className="feature-explorer" data-reveal>
          <div className="feature-tabs" role="tablist" aria-label="核心工作视图" aria-orientation="vertical" onKeyDown={handleKeys}>
            {FEATURES.map((feature, index) => {
              const IconComponent = FEATURE_ICONS[feature.id]
              const selected = index === activeIndex
              return (
                <button
                  key={feature.id}
                  ref={(element) => { tabRefs.current[index] = element }}
                  id={`feature-tab-${feature.id}`}
                  className={`feature-tab${selected ? ' is-active' : ''}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="feature-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveIndex(index)}
                >
                  <span className="feature-tab-index">{String(index + 1).padStart(2, '0')}</span>
                  <IconComponent size={18} aria-hidden />
                  <span>{feature.navLabel}</span>
                  <span className="feature-tab-line" aria-hidden />
                </button>
              )
            })}
          </div>

          <div
            id="feature-panel"
            className="feature-panel"
            role="tabpanel"
            aria-labelledby={`feature-tab-${active.id}`}
            tabIndex={0}
          >
            <div className="feature-panel-inner" key={active.id}>
              <div className="feature-copy">
                <span className="eyebrow">{active.eyebrow}</span>
                <h3>{active.title}</h3>
                <p>{active.description}</p>
                <ul>
                  {active.bullets.map((bullet) => (
                    <li key={bullet}><Check size={14} aria-hidden />{bullet}</li>
                  ))}
                </ul>
                <div className="feature-metric">
                  <strong>{active.metric}</strong>
                  <span>{active.metricLabel}</span>
                </div>
              </div>
              <FeaturePreview feature={active.id} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
