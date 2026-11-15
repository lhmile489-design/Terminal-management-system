// 对应 src/renderer/src/main.tsx。S30 先挂视图台架（ViewHarness），S31 换成原版 App。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ViewHarness } from './renderer/ViewHarness'
import { useTheme } from './renderer/store/theme'
// Manrope 只用于标题、数字、品牌；只带 latin 子集 600/700/800，中文回落到雅黑
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import './styles/tokens.css'
import './styles/ui.css'

// 首帧前落定主题，避免明暗闪烁
await useTheme.getState().init()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ViewHarness />
  </StrictMode>
)
