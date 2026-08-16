import { EventEmitter } from 'node:events'
import { nativeTheme } from 'electron'
import type { ResolvedTheme, ThemePreference, ThemeState } from '@shared/types'
import type { ConfigStore } from './ConfigStore'

export class ThemeService extends EventEmitter {
  constructor(private readonly config: ConfigStore) {
    super()
    nativeTheme.themeSource = this.config.get().settings.theme

    // 仅 system 偏好下系统切换才需要广播
    nativeTheme.on('updated', () => {
      if (this.preference === 'system') this.emit('changed', this.state())
    })
  }

  private get preference(): ThemePreference {
    return this.config.get().settings.theme
  }

  private get resolved(): ResolvedTheme {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }

  state(): ThemeState {
    return { preference: this.preference, resolved: this.resolved }
  }

  set(preference: ThemePreference): ThemeState {
    this.config.patchSettings({ theme: preference })
    nativeTheme.themeSource = preference
    const next = this.state()
    this.emit('changed', next)
    return next
  }
}
