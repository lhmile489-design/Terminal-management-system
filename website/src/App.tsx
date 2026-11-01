import { useEffect } from 'react'
import { Header } from './components/Header'
import { Hero } from './components/Hero'
import { FeatureShowcase } from './components/FeatureShowcase'
import { Footer } from './components/Footer'
import {
  ArchitectureSection,
  CapabilitiesSection,
  FaqSection,
  FinalCtaSection,
  MetricsSection,
  QuickStartSection,
  SecuritySection,
  WorkflowSection
} from './components/Sections'

export default function App(): React.JSX.Element {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!('IntersectionObserver' in window)) {
      elements.forEach((element) => element.classList.add('is-visible'))
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        })
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px' }
    )

    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">跳至主要内容</a>
      <div className="site-atmosphere" aria-hidden="true" />
      <Header />
      <main id="main-content">
        <Hero />
        <MetricsSection />
        <WorkflowSection />
        <FeatureShowcase />
        <CapabilitiesSection />
        <SecuritySection />
        <QuickStartSection />
        <ArchitectureSection />
        <FaqSection />
        <FinalCtaSection />
      </main>
      <Footer />
    </div>
  )
}
