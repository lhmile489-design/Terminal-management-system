// 前端 ↔ Go 的唯一入口（BINDINGS-CONTRACT §1.1）。
//
// 组件与 store **不直接 import `src/mygo.ts`**，只用这里的 `mile`；它的形状与原版
// 原版的 window 上的 mile 命名空间一致，所以搬过来的组件调用点不用改。
//
// 三处与原版的差异都写在这里，便于回查：
//   1. 终端输出：原版是全局 `session.onData` 广播；Go 侧是按会话 attach 的流（契约 §4）。
//      这里保留 `onData` 的回调形状，额外提供 `session.attach(id)`：组件在挂载终端时调一次，
//      收到的事件再分发给 `onData` 的订阅者。
//   2. 文件对话框：mygo v0.8.3 的 Dialog 只有 Error，没有选择框，`dialog.pickDirectory`
//      与 `config.export/import` 直接以错误拒绝（MIGRATION-PLAN §6 已登记）。
//   3. 若干「变化通知」事件 Go 侧还没发（settingsChanged / themeChanged /
//      windowMaximizeChanged / appFocusEntry / appOpenPalette / plannerFocus），
//      `on*` 先返回空退订函数，随 S32 原生集成补齐。

import { Channel } from "mygo-runtime";

import {
  AppService,
  ClipboardService,
  EntryService,
  GroupService,
  LogService,
  PlannerService,
  ScannerService,
  SessionService,
  SettingsService,
  ShellService,
  ThemeService,
  WindowService,
  events,
} from "../mygo";
import type {
  CreateShellSessionInput,
  EntryEdit,
  LaunchEntry,
  LogQuery,
  NewLaunchEntry,
  SessionDataEvent,
  SettingsPatch,
  ThemeState,
} from "../mygo";
import type { MileApi } from "./mile-api";

/** 未接入的能力统一用这个错误，页面能识别出「不是业务失败」。 */
const unsupported = (what: string): Promise<never> =>
  Promise.reject(new Error(`${what}在当前运行时不可用`));

/** ArrayBuffer → base64：Go 侧 `[]byte` 按 base64 解码。 */
function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i += 1) out += String.fromCharCode(arr[i]!);
  return btoa(out);
}

// ── 终端输出：按会话 attach，分发给 onData 的订阅者 ──────────────────────
const dataListeners = new Set<(e: SessionDataEvent) => void>();
const attached = new Set<string>();

function attachSession(id: string): void {
  if (attached.has(id)) return;
  attached.add(id);
  const ch = new Channel<SessionDataEvent>();
  void SessionService.attach(id, ch)
    .catch(() => undefined)
    .finally(() => attached.delete(id));
  void (async () => {
    for await (const frame of ch) {
      for (const cb of dataListeners) cb(frame);
    }
  })();
}

/** 空退订：事件还没由 Go 侧发出的那些 on*。 */
const noopOff = (_cb: unknown): (() => void) => () => {};

export const mile: MileApi = {
  platform: "win32",

  session: {
    list: () => SessionService.list(),
    create: (input: CreateShellSessionInput) => SessionService.createShell(input),
    history: (id: string) => SessionService.history(id),
    stop: (id: string) => SessionService.stop(id),
    write: (id: string, data: string) => {
      void SessionService.write(id, data);
    },
    resize: (id: string, cols: number, rows: number) => {
      void SessionService.resize(id, cols, rows);
    },
    onData: (cb) => {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit: (cb) => events.sessionExit.on(cb),
  },

  entry: {
    list: () => EntryService.list(),
    add: (input: NewLaunchEntry) => EntryService.add(input),
    edit: (id: string, patch: EntryEdit) => EntryService.edit(id, patch),
    remove: (id: string) => EntryService.remove(id),
    reorder: (ids: string[]) => EntryService.reorder(ids),
    detect: (path: string) => EntryService.detect(path),
    precheck: (id: string) => EntryService.precheck(id),
    start: (id: string) => EntryService.start(id),
    startOrdered: (ids: string[]) => EntryService.startOrdered(ids),
    stop: (id: string) => EntryService.stop(id),
    restart: (id: string) => EntryService.restart(id),
    install: (id: string) => EntryService.install(id),
    mavenRun: (id: string, goal: string) => EntryService.mavenRun(id, goal),
    packageWithProfile: (id: string, profile: string | null) =>
      EntryService.packageWithProfile(id, profile ?? ""),
    detectProfiles: (id: string) => EntryService.detectProfiles(id),
    switchPort: (id: string, port: number) => EntryService.switchPort(id, port),
    listJars: (id: string) => EntryService.listJars(id),
    runScript: (id: string, script: string) => EntryService.runScript(id, script),
    diagnose: (id: string) => EntryService.diagnose(id),
    outputDir: (id: string) => EntryService.outputDir(id),
    revealOutput: (id: string) => EntryService.revealOutput(id),
    openPackageJson: (id: string) => EntryService.openPackageJSON(id),
    openInHBuilderX: (id: string) => EntryService.openInHBuilderX(id),
    favicon: (id: string) => EntryService.favicon(id),
    setImage: (id: string, bytes: ArrayBuffer) => EntryService.setImage(id, toBase64(bytes)),
    clearImage: (id: string) => EntryService.clearImage(id),
    image: (id: string) => EntryService.image(id),
    runtimes: () => EntryService.runtimes(),
    openExternalTerminal: (id: string) => EntryService.openExternalTerminal(id),
    revealLastJar: (id: string) => EntryService.revealLastJar(id),
    healthList: () => EntryService.healthList(),
    onHealth: (cb) => events.entryHealth.on(cb),
    cancelAutoRestart: (id: string) => EntryService.cancelAutoRestart(id),
    onAlert: (cb) => events.entryAlert.on(cb),
    onChange: (cb) => events.entryChanged.on(cb),
    onRuntime: (cb) => events.entryRuntimeChanged.on(cb),
    onWarning: (cb) => events.entryWarning.on(cb),
  },

  log: {
    query: (query: LogQuery) => LogService.query(query),
    clear: () => {
      void LogService.clear();
    },
  },

  dialog: {
    pickDirectory: () => unsupported("选择目录"),
    pickImportRoot: () => unsupported("选择导入目录"),
  },

  shell: {
    openLocalhost: (port: number) => {
      void ShellService.openLocalhost(port);
    },
    openPath: (target: string) => {
      void ShellService.openPath(target);
    },
    openProjectLink: (key: string) => {
      void ShellService.openProjectLink(key);
    },
  },

  clipboard: {
    writeText: (text: string) => ClipboardService.writeText(text),
  },

  scanner: {
    snapshot: () => ScannerService.snapshot(),
    refresh: () => {
      void ScannerService.refresh();
    },
    setVisible: (visible: boolean) => {
      void ScannerService.setVisible(visible);
    },
    ignore: (processName: string, port: number) => {
      void ScannerService.ignore(processName, port);
    },
    hideOnce: (pid: number, port: number) => {
      void ScannerService.hideOnce(pid, port);
    },
    setGroup: (processName: string, group: string | null) =>
      ScannerService.setGroup(processName, group),
    watchedKeywords: () => ScannerService.watchedKeywords(),
    setWatchedKeywords: (keywords: string[]) => ScannerService.setWatchedKeywords(keywords),
    onDiff: (cb) => events.scannerDiff.on(cb),
  },

  config: {
    export: () => unsupported("导出配置"),
    import: () => unsupported("导入配置"),
  },

  settings: {
    get: () => SettingsService.get(),
    patch: (patch: SettingsPatch) => SettingsService.patch(patch),
    onChange: noopOff,
  },

  theme: {
    get: () => ThemeService.get() as Promise<ThemeState>,
    set: (preference: string) => ThemeService.set(preference),
    onChange: noopOff,
  },

  window: {
    minimize: () => {
      void WindowService.minimize();
    },
    toggleMaximize: () => {
      void WindowService.toggleMaximize();
    },
    close: () => {
      void WindowService.close();
    },
    isMaximized: () => WindowService.isMaximized(),
    onMaximizeChange: noopOff,
  },

  app: {
    info: () => AppService.info(),
    ready: () => AppService.ready(),
    onFocusEntry: noopOff,
    onOpenPalette: noopOff,
  },

  group: {
    list: () => GroupService.list(),
    add: (input: unknown) => GroupService.add(input as never),
    patch: (id: string, patch: unknown) => GroupService.patch(id, patch as never),
    remove: (id: string) => GroupService.remove(id),
    reorder: (ids: string[]) => GroupService.reorder(ids),
    onChange: (cb) => events.groupChanged.on(cb),
  },

  planner: {
    get: () => PlannerService.get(),
    addBoard: (groupId: string) => PlannerService.addBoard(toRaw(groupId)),
    editBoard: (boardId: string, patch: unknown) =>
      PlannerService.editBoard(toRaw(boardId), toRaw(patch)),
    reassignBoard: (boardId: string, groupId: string) =>
      PlannerService.reassignBoard(toRaw(boardId), toRaw(groupId)),
    removeBoard: (boardId: string) => PlannerService.removeBoard(toRaw(boardId)),
    reorderBoards: (ids: string[]) => PlannerService.reorderBoards(toRaw(ids)),
    addTask: (boardId: string, input: unknown) =>
      PlannerService.addTask(toRaw(boardId), toRaw(input)),
    editTask: (boardId: string, taskId: string, patch: unknown) =>
      PlannerService.editTask(toRaw(boardId), toRaw(taskId), toRaw(patch)),
    removeTask: (boardId: string, taskId: string) =>
      PlannerService.removeTask(toRaw(boardId), toRaw(taskId)),
    reorderTasks: (boardId: string, ids: string[]) =>
      PlannerService.reorderTasks(toRaw(boardId), toRaw(ids)),
    addSchedule: (boardId: string, input: unknown) =>
      PlannerService.addSchedule(toRaw(boardId), toRaw(input)),
    editSchedule: (boardId: string, scheduleId: string, patch: unknown) =>
      PlannerService.editSchedule(toRaw(boardId), toRaw(scheduleId), toRaw(patch)),
    removeSchedule: (boardId: string, scheduleId: string) =>
      PlannerService.removeSchedule(toRaw(boardId), toRaw(scheduleId)),
    completeTask: (boardId: string, scheduleId: string) =>
      PlannerService.completeTask(boardId, scheduleId),
    dismissMissed: (boardId: string, scheduleId: string, at?: number) =>
      PlannerService.dismissMissed(boardId, scheduleId, at ?? 0),
    clearMissed: () => PlannerService.clearMissed(),
    onChange: (cb) => events.plannerChanged.on(cb),
    onReminder: (cb) => events.plannerReminder.on(cb as never),
    onFocus: noopOff,
  },
};

/** planner 的入参在 Go 侧是 json.RawMessage，生成的类型是 string。 */
function toRaw(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** 终端挂载时调一次：把该会话的输出接到 `onData` 的订阅者上。 */
export const attachSessionOutput = attachSession;
