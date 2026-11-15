// 原版 src/preload/index.ts 第 264 行导出的 `MileApi = typeof api` 的手抄版。
//
// preload 依赖 electron 类型，不能直接 import，所以按契约 §1.1 把形状抄成接口；
// src/lib/mile.ts 末尾有一条 `const _check: MileApi = mile` 的类型断言，
// 少方法或签名不符都会编译失败。

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
  SettingsPatch,
  ThemeState,
  EntryDiagnosis,
  EntryEdit,
  EntryHealth,
  EntryRuntime,
  EntryStartResult,
  DetectResult,
  OrderedStartResult,
  PrecheckResult,
  PlannerSnapshot,
} from "../mygo";

/** 与原版 `window.mile.*` 完全同形。 */
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
    export(): Promise<unknown>;
    import(): Promise<unknown>;
  };

  settings: {
    get(): Promise<Settings>;
    patch(patch: SettingsPatch): Promise<Settings>;
    onChange(cb: (settings: Settings) => void): () => void;
  };

  theme: {
    get(): Promise<ThemeState>;
    set(preference: string): Promise<ThemeState>;
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
    onFocusEntry(cb: (req: { id: string; tab: string }) => void): () => void;
    onOpenPalette(cb: () => void): () => void;
  };

  group: {
    list(): Promise<ProjectGroup[]>;
    add(input: unknown): Promise<ProjectGroup>;
    patch(id: string, patch: unknown): Promise<ProjectGroup>;
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<void>;
    onChange(cb: (list: ProjectGroup[]) => void): () => void;
  };

  planner: {
    get(): Promise<PlannerSnapshot>;
    addBoard(groupId: string): Promise<unknown>;
    editBoard(boardId: string, patch: unknown): Promise<unknown>;
    reassignBoard(boardId: string, groupId: string): Promise<unknown>;
    removeBoard(boardId: string): Promise<void>;
    reorderBoards(ids: string[]): Promise<void>;
    addTask(boardId: string, input: unknown): Promise<unknown>;
    editTask(boardId: string, taskId: string, patch: unknown): Promise<unknown>;
    removeTask(boardId: string, taskId: string): Promise<void>;
    reorderTasks(boardId: string, ids: string[]): Promise<void>;
    addSchedule(boardId: string, input: unknown): Promise<unknown>;
    editSchedule(boardId: string, scheduleId: string, patch: unknown): Promise<unknown>;
    removeSchedule(boardId: string, scheduleId: string): Promise<void>;
    completeTask(boardId: string, scheduleId: string): Promise<void>;
    dismissMissed(boardId: string, scheduleId: string, at?: number): Promise<void>;
    clearMissed(): Promise<void>;
    onChange(cb: (snap: PlannerSnapshot) => void): () => void;
    onReminder(cb: (fire: unknown) => void): () => void;
    onFocus(cb: (req: unknown) => void): () => void;
  };
}
