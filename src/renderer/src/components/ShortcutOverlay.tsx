import { DialogShell } from './ui'

/**
 * 快捷键一览，UI-REFACTOR §5.2。按 `?` 打开。
 * 列表键盘操作（方向键 / Space / Enter）随阶段 4 的服务页一起上线，这里先列出全局部分。
 */
const KEYS: { label: string; keys: string[] }[] = [
  { label: '打开命令面板', keys: ['Ctrl', 'K'] },
  { label: '切换到总览 / 服务 / 终端 / 设置 / 关于', keys: ['Ctrl', '1–5'] },
  { label: '打开快捷键一览', keys: ['?'] },
  { label: '关闭最上层的弹窗、抽屉或菜单', keys: ['Esc'] }
]

export function ShortcutOverlay({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <DialogShell title="快捷键" onClose={onClose} width={480}>
      <dl className="ui-keys">
        {KEYS.map((k) => (
          <div key={k.label} style={{ display: 'contents' }}>
            <dt>{k.label}</dt>
            <dd>
              {k.keys.map((key) => (
                <kbd key={key} className="ui-kbd">
                  {key}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p className="ui-field-hint" style={{ marginTop: 12 }}>
        光标在输入框或终端里时，单键快捷键不生效。
      </p>
    </DialogShell>
  )
}
