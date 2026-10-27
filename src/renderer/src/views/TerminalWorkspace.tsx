import { useMemo, useState } from 'react'
import type { SessionMeta, SessionStatus } from '@shared/types'
import { TerminalView } from '../components/TerminalView'
import { IconButton, Segmented, StatusDot, Tile, TileHeader, toast } from '../components/ui'
import { LogCenter } from './LogCenter'
import { useSessions } from '../store/sessions'
import { useEntries } from '../store/entries'
import { useGroups } from '../store/groups'
import { ICON } from '../lib/icons'
import type { Tone } from '../lib/entryMeta'

const TONE: Record<SessionStatus, Tone> = {
  starting: 'warn',
  running: 'live',
  building: 'warn',
  stopped: 'idle',
  crashed: 'fault'
}
const LABEL: Record<SessionStatus, string> = {
  starting: '启动中',
  running: '运行中',
  building: '构建中',
  stopped: '已退出',
  crashed: '异常退出'
}

type Tab = 'term' | 'logs'

/**
 * 终端页，UI-REFACTOR Q18。左侧会话列表分「我的终端」（自建 PowerShell）与
 * 「服务会话」（按工作组归类）；顶部「终端 / 全部输出」，原日志页并入「全部输出」，
 * 点一条日志跳到它所在的会话。
 */
export function TerminalWorkspace(): React.JSX.Element {
  const { sessions, activeId, openShell, select, stop, focus } = useSessions()
  const entries = useEntries((s) => s.entries)
  const groups = useGroups((s) => s.groups)
  const [tab, setTab] = useState<Tab>('term')

  const sections = useMemo(() => {
    const shells = sessions.filter((s) => !s.projectId)
    const groupName = (s: SessionMeta): string => {
      const entry = entries.find((e) => e.id === s.projectId)
      return (entry?.groupId && groups.find((g) => g.id === entry.groupId)?.name) || '未分组'
    }
    const byGroup = new Map<string, SessionMeta[]>()
    for (const s of sessions.filter((x) => x.projectId)) {
      const k = groupName(s)
      byGroup.set(k, [...(byGroup.get(k) ?? []), s])
    }
    return { shells, byGroup: [...byGroup.entries()] }
  }, [sessions, entries, groups])

  /**
   * 从日志行跳到会话。先刷新会话列表（日志里的会话可能还没进本地列表）；
   * 会话已经结束、不在列表里时不跳到别的会话冒充，给一条提示。
   */
  const jumpTo = (sessionId: string): void => {
    void window.mile.session.list().then((list) => {
      if (!list.some((s) => s.id === sessionId)) {
        toast({ tone: 'info', title: '这个会话已经结束', body: '它的输出仍在「全部输出」里，可以按会话筛选查看' })
        return
      }
      void focus(sessionId).then(() => setTab('term'))
    })
  }

  const row = (s: SessionMeta): React.JSX.Element => (
    <div key={s.id} className="term-sess" aria-current={s.id === activeId} data-session-id={s.id}>
      <button type="button" className="term-sess-main" onClick={() => select(s.id)} aria-label={`打开 ${s.title}`}>
        <StatusDot tone={TONE[s.status]} label={LABEL[s.status]} />
        <span className="term-sess-name">
          <b>{s.title}</b>
          <span>PID {s.pid} · {LABEL[s.status]}</span>
        </span>
      </button>
      <IconButton
        icon={ICON.stop}
        label={`停止 ${s.title}`}
        tone="danger"
        disabled={s.status === 'stopped' || s.status === 'crashed'}
        onClick={() => void stop(s.id)}
      />
    </div>
  )

  return (
    <div className="term-page" data-terminal-page>
      <Segmented<Tab>
        label="终端视图"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'term', label: '终端', count: sessions.length },
          { value: 'logs', label: '全部输出' }
        ]}
      />

      {tab === 'logs' ? (
        <LogCenter onJump={jumpTo} />
      ) : (
        <div className="term-layout">
          <Tile className="term-sessions" aria-label="会话">
            <TileHeader
              title="会话"
              level={2}
              actions={<IconButton icon={ICON.add} label="新建终端会话" onClick={() => void openShell()} />}
            />
            <div className="term-list">
              <h3 className="term-sec">我的终端</h3>
              {sections.shells.length ? sections.shells.map(row) : (
                <p className="term-note">还没有自建终端，点右上角「+」新建一个 PowerShell</p>
              )}
              <h3 className="term-sec">服务会话</h3>
              {sections.byGroup.length ? sections.byGroup.map(([name, list]) => (
                <div key={name} role="group" aria-label={name}>
                  <p className="term-note">{name}</p>
                  {list.map(row)}
                </div>
              )) : (
                <p className="term-note">服务启动后，它的输出会出现在这里</p>
              )}
            </div>
          </Tile>

          <Tile className="term-main" aria-label="终端输出">
            {activeId ? (
              <TerminalView key={activeId} sessionId={activeId} />
            ) : (
              <div className="term-empty">
                <ICON.output size={28} aria-hidden />
                <p>选择或新建一个会话以查看终端输出</p>
              </div>
            )}
          </Tile>
        </div>
      )}
    </div>
  )
}
