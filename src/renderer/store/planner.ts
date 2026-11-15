import { mile } from "../../lib/mile";
import { create } from 'zustand'
import type {
  MissedReminder,
  PlannerBoard,
  PlannerBoardPatch,
  PlannerScheduleInput,
  PlannerSchedulePatch,
  PlannerSnapshot,
  PlannerTaskInput,
  PlannerTaskPatch
} from '@shared/planner'

/**
 * 进度与日程的渲染层状态（docs/PRD-PLANNER.md P1）。
 *
 * 数据只认主进程广播的整份快照：主进程在写入时同步 emit('changed')，广播比 invoke 回执先到，
 * 这里若再按回执追加一条就会出现重复（CLAUDE.md 平台细节）。所以动作只发意图，
 * 列表一律由 onChange 整体替换。
 */
interface PlannerStore {
  boards: PlannerBoard[]
  readOnly: boolean
  loaded: boolean
  error: string | null
  /** P3：错过的提醒汇总，主进程 snapshot 直接下发 */
  missed: MissedReminder[]
  init: () => Promise<void>
  apply: (snap: PlannerSnapshot) => void
  clearError: () => void
  addBoard: (groupId: string) => Promise<PlannerBoard | null>
  editBoard: (boardId: string, patch: PlannerBoardPatch) => Promise<boolean>
  reassignBoard: (boardId: string, groupId: string) => Promise<boolean>
  removeBoard: (boardId: string) => Promise<boolean>
  reorderBoards: (ids: string[]) => Promise<boolean>
  addTask: (boardId: string, input: PlannerTaskInput) => Promise<boolean>
  editTask: (boardId: string, taskId: string, patch: PlannerTaskPatch) => Promise<boolean>
  removeTask: (boardId: string, taskId: string) => Promise<boolean>
  reorderTasks: (boardId: string, ids: string[]) => Promise<boolean>
  // 日程 P2
  addSchedule: (boardId: string, input: PlannerScheduleInput) => Promise<boolean>
  editSchedule: (boardId: string, scheduleId: string, patch: PlannerSchedulePatch) => Promise<boolean>
  removeSchedule: (boardId: string, scheduleId: string) => Promise<boolean>
  completeScheduleTask: (boardId: string, scheduleId: string) => Promise<boolean>
  // 错过的提醒 P3
  dismissMissed: (boardId: string, scheduleId: string, at?: number) => Promise<boolean>
  clearMissed: () => Promise<boolean>
}

export const usePlanner = create<PlannerStore>((set) => {
  /** 主进程校形失败会抛错；吞掉就看不出为什么没保存，所以落到 error 字段显示出来 */
  const run = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    set({ error: null })
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
      return null
    }
  }
  const ok = async (fn: () => Promise<unknown>): Promise<boolean> => (await run(async () => { await fn(); return true })) === true

  return {
    boards: [],
    readOnly: false,
    loaded: false,
    error: null,
    missed: [],

    init: async () => {
      const snap = await mile.planner.get()
      set({ boards: snap.boards, readOnly: snap.readOnly, missed: snap.missed ?? [], loaded: true })
    },
    apply: (snap) => set({ boards: snap.boards, readOnly: snap.readOnly, missed: snap.missed ?? [], loaded: true }),
    clearError: () => set({ error: null }),

    addBoard: (groupId) => run(() => mile.planner.addBoard(groupId)),
    editBoard: (boardId, patch) => ok(() => mile.planner.editBoard(boardId, patch)),
    reassignBoard: (boardId, groupId) => ok(() => mile.planner.reassignBoard(boardId, groupId)),
    removeBoard: (boardId) => ok(() => mile.planner.removeBoard(boardId)),
    reorderBoards: (ids) => ok(() => mile.planner.reorderBoards(ids)),
    addTask: (boardId, input) => ok(() => mile.planner.addTask(boardId, input)),
    editTask: (boardId, taskId, patch) => ok(() => mile.planner.editTask(boardId, taskId, patch)),
    removeTask: (boardId, taskId) => ok(() => mile.planner.removeTask(boardId, taskId)),
    reorderTasks: (boardId, ids) => ok(() => mile.planner.reorderTasks(boardId, ids)),

    // ── 日程 P2 ──
    addSchedule: (boardId, input) => run(() => mile.planner.addSchedule(boardId, input)).then((r) => r !== null),
    editSchedule: (boardId, scheduleId, patch) => ok(() => mile.planner.editSchedule(boardId, scheduleId, patch)),
    removeSchedule: (boardId, scheduleId) => ok(() => mile.planner.removeSchedule(boardId, scheduleId)),
    completeScheduleTask: (boardId, scheduleId) => ok(() => mile.planner.completeTask(boardId, scheduleId)),

    // ── 错过的提醒 P3 ──
    dismissMissed: (boardId, scheduleId, at) => ok(() => mile.planner.dismissMissed(boardId, scheduleId, at)),
    clearMissed: () => ok(() => mile.planner.clearMissed())
  }
})
