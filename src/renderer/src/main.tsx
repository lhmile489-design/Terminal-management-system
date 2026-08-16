import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useTheme } from './store/theme'
import './styles/tokens.css'

// 首帧前落定主题，避免明暗闪烁
await useTheme.getState().init()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
