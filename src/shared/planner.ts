// 原版 `@shared/planner` 的落点：进度与日程的类型由生成层提供，
// 这里只补 Go 侧用 json.RawMessage 收、因此没有生成对应接口的那几个入参类型。

export type * from "../mygo";

import type { LeadMinutes, PlannerTaskStatus, ScheduleRepeat } from "../mygo";

/** 任务可编辑字段（原版 PlannerTaskInput）。 */
export interface PlannerTaskInput {
  title: string;
  status?: PlannerTaskStatus;
  startDate?: string | null;
  dueDate?: string | null;
  note?: string | null;
}

export type PlannerTaskPatch = Partial<PlannerTaskInput>;

/** 看板可编辑字段。 */
export interface PlannerBoardPatch {
  startDate?: string | null;
  endDate?: string | null;
  note?: string | null;
}

/** 日程可编辑字段。null = 显式清空（taskId、until、snoozeUntil）。 */
export interface PlannerScheduleInput {
  title: string;
  taskId?: string | null;
  date: string;
  time: string;
  repeat?: ScheduleRepeat;
  until?: string | null;
  leadMinutes?: LeadMinutes;
  stopWhenTaskDone?: boolean;
  paused?: boolean;
}

export type PlannerSchedulePatch = Partial<PlannerScheduleInput> & { snoozeUntil?: number | null };
