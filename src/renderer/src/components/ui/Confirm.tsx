import { useRef } from 'react'
import { create } from 'zustand'
import { Warning } from '@phosphor-icons/react'
import { DialogShell } from './Overlay'
import { Button } from './Button'

/**
 * 应用内确认弹窗，替代 window.confirm（Q14）。
 * 只用于：移除条目、删除工作组、强制关闭、prod 环境启动、放弃未保存改动。
 *
 * 用法：`if (!(await confirm({ title, body, danger: true }))) return`
 * 默认焦点在「取消」，回车不会误触危险操作。
 */
export interface ConfirmOptions {
  title: string
  body?: React.ReactNode
  okLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface Request extends ConfirmOptions {
  id: number
  resolve: (ok: boolean) => void
}

let seq = 0
const useConfirmStore = create<{ queue: Request[] }>(() => ({ queue: [] }))

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.setState((s) => ({ queue: [...s.queue, { ...opts, id: ++seq, resolve }] }))
  })
}

/** 挂在 App 根部一次 */
export function ConfirmHost(): React.JSX.Element | null {
  const req = useConfirmStore((s) => s.queue[0])
  if (!req) return null
  return <ConfirmDialog key={req.id} req={req} />
}

function ConfirmDialog({ req }: { req: Request }): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const settled = useRef(false)

  const done = (ok: boolean): void => {
    if (settled.current) return
    settled.current = true
    useConfirmStore.setState((s) => ({ queue: s.queue.filter((r) => r.id !== req.id) }))
    req.resolve(ok)
  }

  return (
    <DialogShell
      title={req.title}
      alert
      width={420}
      dismissOnScrim={false}
      icon={req.danger ? <Warning size={20} /> : undefined}
      onClose={() => done(false)}
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={() => done(false)}>
            {req.cancelLabel ?? '取消'}
          </Button>
          <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
            {req.okLabel ?? '确定'}
          </Button>
        </>
      }
    >
      {req.body}
    </DialogShell>
  )
}
