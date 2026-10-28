import { useCallback, useEffect, useState } from 'react'
import { Warning } from '@phosphor-icons/react'
import type { Settings as AppSettings } from '@shared/types'

/**
 * 设置页，PRD §9.3。采集周期、主题、终端偏好与退出行为。
 *
 * 每项改动立即写主进程并以回执为准：设置只有七项，攒一个「保存」按钮反而让人
 * 不确定改没改上。主进程会逐字段校验，非法值抛错并显示在顶部。
 */
export function Settings(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.mile.settings.get().then(setSettings)
    return window.mile.settings.onChange(setSettings)
  }, [])

  const patch = useCallback(async (next: Partial<AppSettings>) => {
    setSaving(true)
    setError(null)
    try {
      setSettings(await window.mile.settings.patch(next))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      // 校验失败时拉回真实值，避免界面停在用户输的非法值上
      setSettings(await window.mile.settings.get())
    } finally {
      setSaving(false)
    }
  }, [])

  if (!settings) {
    return (
      <div className="surface-card px-6 py-14 text-center">
        <p className="text-[13px] text-ink-muted">读取设置中</p>
      </div>
    )
  }

  return (
    <div className="set-grid">
      {error && (
        <div
          role="alert"
          className="set-error"
        >
          <Warning size={16} className="shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 break-words">{error}</p>
        </div>
      )}

      <section className="set-tile" aria-labelledby="settings-scan-heading">
        <h2 id="settings-scan-heading" className="set-tile-title">
          1 · 采集
        </h2>
          <Row label="采集周期" hint="窗口不可见时自动降频到 10 秒">
            <Choice
              options={[
                { value: 1000, label: '1 秒' },
                { value: 2000, label: '2 秒' },
                { value: 5000, label: '5 秒' },
                { value: 10000, label: '10 秒' }
              ]}
              value={settings.scanIntervalMs}
              disabled={saving}
              onPick={(v) => void patch({ scanIntervalMs: v as AppSettings['scanIntervalMs'] })}
            />
          </Row>
      </section>

      <section className="set-tile" aria-labelledby="settings-appearance-heading">
        <h2 id="settings-appearance-heading" className="set-tile-title">
          2 · 外观
        </h2>
          <Row label="主题">
            <Choice
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
                { value: 'system', label: '跟随系统' }
              ]}
              value={settings.theme}
              disabled={saving}
              onPick={(v) => void patch({ theme: v as AppSettings['theme'] })}
            />
          </Row>
      </section>

      <section className="set-tile" aria-labelledby="settings-terminal-heading">
        <h2 id="settings-terminal-heading" className="set-tile-title">
          3 · 终端
        </h2>
          <Row label="外部终端" hint="「在外部终端打开」使用的程序">
            <Choice
              options={[
                { value: 'wt', label: 'Windows Terminal' },
                { value: 'pwsh', label: 'PowerShell 7' },
                { value: 'powershell', label: 'PowerShell' },
                { value: 'cmd', label: 'CMD' },
                { value: 'gitbash', label: 'Git Bash' }
              ]}
              value={settings.externalTerminal}
              disabled={saving}
              onPick={(v) => void patch({ externalTerminal: v as AppSettings['externalTerminal'] })}
            />
          </Row>
          <Row label="终端字号" hint="10–22">
            <Stepper
              value={settings.terminalFontSize}
              min={10}
              max={22}
              step={1}
              unit="px"
              disabled={saving}
              onChange={(v) => void patch({ terminalFontSize: v })}
            />
          </Row>
          <Row label="回滚行数" hint="1000–50000，越大越占内存">
            <Stepper
              value={settings.scrollback}
              min={1000}
              max={50000}
              step={1000}
              unit="行"
              disabled={saving}
              onChange={(v) => void patch({ scrollback: v })}
            />
          </Row>
      </section>

      <section className="set-tile" aria-labelledby="settings-exit-heading">
        <h2 id="settings-exit-heading" className="set-tile-title">
          4 · 退出行为
        </h2>
          <Row label="退出时停止受控进程" hint="只停本应用启动的会话，外部进程一律不动">
            <Toggle
              label="退出时停止受控进程"
              checked={settings.killOwnedOnQuit}
              disabled={saving}
              onChange={(v) => void patch({ killOwnedOnQuit: v })}
            />
          </Row>
          <Row label="关闭窗口时收起到托盘" hint="服务继续在后台运行，从托盘菜单退出">
            <Toggle
              label="关闭窗口时收起到托盘"
              checked={settings.closeToTray}
              disabled={saving}
              onChange={(v) => void patch({ closeToTray: v })}
            />
          </Row>
          <Row label="从任务栏隐藏（仅托盘）" hint="任务栏不显示图标，应用只留在系统托盘；点托盘图标或菜单唤出窗口">
            <Toggle
              label="从任务栏隐藏（仅托盘）"
              checked={settings.hideFromTaskbar}
              disabled={saving}
              onChange={(v) => void patch({ hideFromTaskbar: v })}
            />
          </Row>
      </section>

      <section className="set-tile" aria-labelledby="settings-notify-heading">
        <h2 id="settings-notify-heading" className="set-tile-title">
          5 · 通知
        </h2>
          <Row label="任务完成时弹系统通知" hint="只在任务自然结束时推送，自己按停止不算；重启应用不会补发历史">
            <Toggle
              label="任务完成时弹系统通知"
              checked={settings.notifyOnTaskDone}
              disabled={saving}
              onChange={(v) => void patch({ notifyOnTaskDone: v })}
            />
          </Row>
          <Row label="服务崩溃或被拦时弹系统通知" hint="服务自己崩溃、启动被预检拦下、重启后端口迟迟不释放时推送；点通知直达输出或诊断。自己按停止不算">
            <Toggle
              label="服务崩溃或被拦时弹系统通知"
              checked={settings.notifyOnCrash}
              disabled={saving}
              onChange={(v) => void patch({ notifyOnCrash: v })}
            />
          </Row>
          <Row label="只在窗口收起或失焦时弹" hint="窗口在前台时应用内已有提示，不重复打扰；关掉后前台也会弹">
            <Toggle
              label="只在窗口收起或失焦时弹"
              checked={settings.notifyOnlyWhenBackground}
              disabled={saving || !settings.notifyOnCrash}
              onChange={(v) => void patch({ notifyOnlyWhenBackground: v })}
            />
          </Row>
      </section>
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="set-row">
      <div className="min-w-0">
        <p className="set-row-label">{label}</p>
        {hint && <p className="set-row-hint">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Choice<T extends string | number>({
  options,
  value,
  disabled,
  onPick
}: {
  options: { value: T; label: string }[]
  value: T
  disabled?: boolean
  onPick: (value: T) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" className="ui-seg set-seg">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled}
          onClick={() => onPick(o.value)}
          
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Stepper({
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onChange
}: {
  value: number
  min: number
  max: number
  step: number
  unit: string
  disabled?: boolean
  onChange: (value: number) => void
}): React.JSX.Element {
  const clamp = (v: number): number => Math.min(Math.max(v, min), max)
  return (
    <div className="ui-stepper">
      <button
        type="button"
        aria-label="减小"
        title="减小"
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - step))}
        className="ui-iconbtn set-step-btn" data-size="md"
      >
        −
      </button>
      <span className="ui-stepper-value">
        {value} {unit}
      </span>
      <button
        type="button"
        aria-label="增大"
        title="增大"
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + step))}
        className="ui-iconbtn set-step-btn" data-size="md"
      >
        +
      </button>
    </div>
  )
}

function Toggle({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="ui-switch"
    />
  )
}
