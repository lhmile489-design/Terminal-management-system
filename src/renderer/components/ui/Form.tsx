import { Lock, Minus, Plus } from '@phosphor-icons/react'
import { IconButton } from './Button'

/**
 * 表单字段外壳。运行时被锁的字段显示锁图标与「停止后可改」，不整块变灰（Q13）。
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  locked,
  full,
  children
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string
  locked?: boolean
  full?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ui-field" style={full ? { gridColumn: '1 / -1' } : undefined}>
      <label className="ui-field-label" htmlFor={htmlFor}>
        {label}
        {locked && (
          <span className="ui-field-lock">
            <Lock size={12} aria-hidden />
            停止后可改
          </span>
        )}
      </label>
      {children}
      {error ? <span className="ui-field-error" role="alert">{error}</span> : hint ? <span className="ui-field-hint">{hint}</span> : null}
    </div>
  )
}

export function TextInput({
  mono,
  invalid,
  ...rest
}: { mono?: boolean; invalid?: boolean } & React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      {...rest}
      className={`ui-input ${rest.className ?? ''}`}
      data-mono={mono || undefined}
      aria-invalid={invalid || undefined}
    />
  )
}

export function Select({
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select {...rest} className={`ui-input ${rest.className ?? ''}`}>
      {children}
    </select>
  )
}

/** 开关：40×24，点击区域满足 ≥ 24px */
export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      className="ui-switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = '',
  label
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  unit?: string
  label: string
}): React.JSX.Element {
  const set = (v: number): void => onChange(Math.min(max, Math.max(min, v)))
  return (
    <div className="ui-stepper" role="group" aria-label={label}>
      <IconButton icon={Minus} label={`减少${label}`} disabled={value <= min} onClick={() => set(value - step)} />
      <span className="ui-stepper-value" aria-live="polite">
        {value}
        {unit}
      </span>
      <IconButton icon={Plus} label={`增加${label}`} disabled={value >= max} onClick={() => set(value + step)} />
    </div>
  )
}
