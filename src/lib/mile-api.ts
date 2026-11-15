// 原版 src/preload/index.ts 第 264 行导出的 `MileApi = typeof api` 的手抄版。
//
// preload 依赖 electron 类型，不能直接 import，所以按契约 §1.1 把形状抄成接口。
// 这里的类型全部来自原版的 @shared（原文复制），不是生成层：渲染层只认原版类型，
// 生成类型与原版类型的换算只发生在 src/lib/mile.ts（`export const mile: MileApi`，少方法会编译失败）。

import type {
  AppInfo,
  CreateShellSessionInput,
  LaunchEntry,
  LogQuery,
  LogResult,
  NewLaunchEntry,
  OutputAlert,
  ProjectGroup,
  ScanDiff,
  ScanSnapshot,
  SessionDataEvent,
  SessionExitEvent,
  SessionMeta,
  Settings,
  ConfigExportResult,
  ConfigImportResult,
  FocusEntryRequest,
  GroupPatch,
  NewProjectGroup,
  PlannerFocusRequest,
  ThemePreference,
  ThemeState,
  EntryDiagnosis,
  EntryEdit,
  EntryHealth,
  EntryRuntime,
  EntryStartResult,
  DetectResult,
  OrderedStartResult,
  PrecheckResult,
} from "../shared/types";
import type {
  PlannerBoard,
  PlannerBoardPatch,
  PlannerScheduleInput,
  PlannerSchedulePatch,
  PlannerTaskInput,
  PlannerTaskPatch,
  PlannerSchedule,
  PlannerSnapshot,
  PlannerTask,
  ReminderFire,
} from "../shared/planner";

/** 与原版 window 上的 mile 命名空间完全同形。 */
export interface MileApi {
  /** 当前平台，渲染层据此切换修饰键与标题栏 */
  platform: string;

  session: {
    list(): Promise<SessionMeta[]>;
    create(input: CreateShellSessionInput): Promise<SessionMeta>;
    history(id: string): Promise<string>;
    stop(id: string): Promise<void>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    onData(cb: (e: SessionDataEvent) => void): () => void;
    onExit(cb: (e: SessionExitEvent) => void): () => void;
  };

  entry: {
    list(): Promise<LaunchEntry[]>;
    add(input: NewLaunchEntry): Promise<LaunchEntry>;
    edit(id: string, patch: EntryEdit): Promise<LaunchEntry>;
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<LaunchEntry[]>;
    detect(path: string): Promise<DetectResult>;
    precheck(id: string): Promise<PrecheckResult>;
    start(id: string): Promise<EntryStartResult>;
    startOrdered(ids: string[]): Promise<OrderedStartResult[]>;
    stop(id: string): Promise<EntryRuntime>;
    restart(id: string): Promise<EntryStartResult>;
    install(id: string): Promise<EntryRuntime>;
    mavenRun(id: string, goal: string): Promise<EntryRuntime>;
    packageWithProfile(id: string, profile: string | null): Promise<EntryRuntime>;
    detectProfiles(id: string): Promise<string[]>;
    switchPort(id: string, port: number): Promise<void>;
    listJars(id: string): Promise<string[]>;
    runScript(id: string, script: string): Promise<EntryRuntime>;
    diagnose(id: string): Promise<EntryDiagnosis>;
    outputDir(id: string): Promise<string | null>;
    revealOutput(id: string): Promise<boolean>;
    openPackageJson(id: string): Promise<boolean>;
    openInHBuilderX(id: string): Promise<boolean>;
    favicon(id: string): Promise<string | null>;
    setImage(id: string, bytes: ArrayBuffer): Promise<string>;
    clearImage(id: string): Promise<LaunchEntry>;
    image(id: string): Promise<string | null>;
    runtimes(): Promise<EntryRuntime[]>;
    openExternalTerminal(id: string): Promise<void>;
    revealLastJar(id: string): Promise<boolean>;
    healthList(): Promise<EntryHealth[]>;
    onHealth(cb: (health: EntryHealth) => void): () => void;
    cancelAutoRestart(id: string): Promise<EntryRuntime | null>;
    onAlert(cb: (alert: OutputAlert) => void): () => void;
    onChange(cb: (list: LaunchEntry[]) => void): () => void;
    onRuntime(cb: (runtime: EntryRuntime) => void): () => void;
    onWarning(cb: (text: string) => void): () => void;
  };

  log: {
    query(query: LogQuery): Promise<LogResult>;
    clear(): void;
  };

  dialog: {
    pickDirectory(): Promise<string | null>;
    pickImportRoot(): Promise<{ root: string; items: DetectResult[] } | null>;
  };

  shell: {
    openLocalhost(port: number): void;
    openPath(target: string): void;
    openProjectLink(key: string): void;
  };

  clipboard: {
    writeText(text: string): Promise<boolean>;
  };

  scanner: {
    snapshot(): Promise<ScanSnapshot | null>;
    refresh(): void;
    setVisible(visible: boolean): void;
    ignore(processName: string, port: number): void;
    hideOnce(pid: number, port: number): void;
    setGroup(processName: string, group: string | null): Promise<void>;
    watchedKeywords(): Promise<string[]>;
    setWatchedKeywords(keywords: string[]): Promise<string[]>;
    onDiff(cb: (diff: ScanDiff) => void): () => void;
  };

  config: {
    export(): Promise<ConfigExportResult | null>;
    import(): Promise<ConfigImportResult | null>;
  };

  settings: {
    get(): Promise<Settings>;
    patch(patch: Partial<Settings>): Promise<Settings>;
    onChange(cb: (settings: Settings) => void): () => void;
  };

  theme: {
    get(): Promise<ThemeState>;
    set(preference: ThemePreference): Promise<ThemeState>;
    onChange(cb: (state: ThemeState) => void): () => void;
  };

  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  };

  app: {
    info(): Promise<AppInfo>;
    ready(): Promise<void>;
    onFocusEntry(cb: (req: FocusEntryRequest) => void): () => void;
    onOpenPalette(cb: () => void): () => void;
  };

  group: {
    list(): Promise<ProjectGroup[]>;
    add(input: NewProjectGroup): Promise<ProjectGroup>;
    patch(id: string, patch: GroupPatch): Promise<ProjectGroup>;
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<void>;
    onChange(cb: (list: ProjectGroup[]) => void): () => void;
  };

  planner: {
    get(): Promise<PlannerSnapshot>;
    addBoard(groupId: string): Promise<PlannerBoard>;
    editBoard(boardId: string, patch: PlannerBoardPatch): Promise<PlannerBoard>;
    reassignBoard(boardId: string, groupId: string): Promise<PlannerBoard>;
    removeBoard(boardId: string): Promise<void>;
    reorderBoards(ids: string[]): Promise<void>;
    addTask(boardId: string, input: PlannerTaskInput): Promise<PlannerTask>;
    editTask(boardId: string, taskId: string, patch: PlannerTaskPatch): Promise<PlannerTask>;
    removeTask(boardId: string, taskId: string): Promise<void>;
    reorderTasks(boardId: string, ids: string[]): Promise<void>;
    addSchedule(boardId: string, input: PlannerScheduleInput): Promise<PlannerSchedule>;
    editSchedule(boardId: string, scheduleId: string, patch: PlannerSchedulePatch): Promise<PlannerSchedule>;
    removeSchedule(boardId: string, scheduleId: string): Promise<void>;
    completeTask(boardId: string, scheduleId: string): Promise<void>;
    dismissMissed(boardId: string, scheduleId: string, at?: number): Promise<void>;
    clearMissed(): Promise<void>;
    onChange(cb: (snap: PlannerSnapshot) => void): () => void;
    onReminder(cb: (fire: ReminderFire) => void): () => void;
    onFocus(cb: (req: PlannerFocusRequest) => void): () => void;
  };
}
