// 前端 ↔ Go 的唯一入口（BINDINGS-CONTRACT §1.1）。
//
// 组件与 store **不直接 import `src/mygo.ts`**，只用这里的 `mile`；它的形状与原版
// window 上的 mile 命名空间一致，所以搬过来的组件调用点不用改。
//
// 类型换算：渲染层只认原版 @shared 的类型（字符串字面量联合、判别联合）；生成层没有这两样，
// 同名类型是 string / unknown。两边字段名一致（Go 的 contract 包按原版逐字搬），
// 所以这里在边界断言一次（契约 §1.3）：出参用 `narrow`，入参用 `loose`，事件用 `listen`。
//
// 三处与原版的差异都写在这里，便于回查：
//   1. 终端输出：原版是全局 `session.onData` 广播；Go 侧是按会话 attach 的流（契约 §4）。
//      这里保留 `onData` 的回调形状；首次 `history(id)` 时发起 attach（见下方 session.history），
//      收到的帧再分发给 `onData` 的订阅者，TerminalView 不用改。
//   2. 文件对话框：mygo v0.8.3 的 Dialog 只有 Error，没有选择框，`dialog.pickDirectory`
//      与 `config.export/import` 直接以错误拒绝（MIGRATION-PLAN §6 已登记）。
//   3. 若干「变化通知」事件 Go 侧还没发（appFocusEntry / appOpenPalette / plannerFocus，
//      都由托盘、通知点击、全局快捷键触发），
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
import type { SessionDataEvent } from "../shared/types";
import type { MileApi } from "./mile-api";

/** 出参：生成类型 → 原版类型。字段名两边一致，只是生成层的字面量联合退化成了 string。 */
function narrow<T>(p: Promise<unknown>): Promise<T> {
  return p as Promise<T>;
}

/** 入参：原版类型 → 生成类型（原版更窄，传过去总是合法的）。 */
function loose<T>(v: T): never {
  return v as never;
}

/** 事件回调：订阅者按原版类型写，事件实例按生成类型发。 */
function listen<P, T>(
  ev: { on(cb: (payload: P) => void): () => void },
  cb: (payload: T) => void,
): () => void {
  return ev.on(cb as unknown as (payload: P) => void);
}

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
    list: () => narrow(SessionService.list()),
    create: (input) => narrow(SessionService.createShell(loose(input))),
    // 原版 TerminalView 的套路是「先 history 再 onData」。Go 侧的 attach 自带历史快照、
    // 并且快照与订阅在同一把锁里登记（不丢不重），所以首次挂载时由这里发起 attach、
    // history 返回空串，历史随 onData 到达；已经 attach 过（切回该会话重新挂载）
    // 就照原版拉一次历史，实时输出继续走已有的流。
    history: (id) => {
      if (attached.has(id)) return SessionService.history(id);
      attachSession(id);
      return Promise.resolve("");
    },
    stop: (id) => SessionService.stop(id),
    write: (id, data) => {
      void SessionService.write(id, data);
    },
    resize: (id, cols, rows) => {
      void SessionService.resize(id, cols, rows);
    },
    onData: (cb) => {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit: (cb) => listen(events.sessionExit, cb),
  },

  entry: {
    list: () => narrow(EntryService.list()),
    add: (input) => narrow(EntryService.add(loose(input))),
    edit: (id, patch) => narrow(EntryService.edit(id, loose(patch))),
    remove: (id) => EntryService.remove(id),
    reorder: (ids) => narrow(EntryService.reorder(ids)),
    detect: (path) => narrow(EntryService.detect(path)),
    precheck: (id) => narrow(EntryService.precheck(id)),
    start: (id) => narrow(EntryService.start(id)),
    startOrdered: (ids) => narrow(EntryService.startOrdered(ids)),
    stop: (id) => narrow(EntryService.stop(id)),
    restart: (id) => narrow(EntryService.restart(id)),
    install: (id) => narrow(EntryService.install(id)),
    mavenRun: (id, goal) => narrow(EntryService.mavenRun(id, goal)),
    packageWithProfile: (id, profile) =>
      narrow(EntryService.packageWithProfile(id, profile ?? "")),
    detectProfiles: (id) => EntryService.detectProfiles(id),
    switchPort: (id, port) => EntryService.switchPort(id, port),
    listJars: (id) => EntryService.listJars(id),
    runScript: (id, script) => narrow(EntryService.runScript(id, script)),
    diagnose: (id) => narrow(EntryService.diagnose(id)),
    outputDir: (id) => EntryService.outputDir(id),
    revealOutput: (id) => EntryService.revealOutput(id),
    openPackageJson: (id) => EntryService.openPackageJSON(id),
    openInHBuilderX: (id) => EntryService.openInHBuilderX(id),
    favicon: (id) => EntryService.favicon(id),
    setImage: (id, bytes) => EntryService.setImage(id, toBase64(bytes)),
    clearImage: (id) => narrow(EntryService.clearImage(id)),
    image: (id) => EntryService.image(id),
    runtimes: () => narrow(EntryService.runtimes()),
    openExternalTerminal: (id) => EntryService.openExternalTerminal(id),
    revealLastJar: (id) => EntryService.revealLastJar(id),
    healthList: () => narrow(EntryService.healthList()),
    onHealth: (cb) => listen(events.entryHealth, cb),
    cancelAutoRestart: (id) => narrow(EntryService.cancelAutoRestart(id)),
    onAlert: (cb) => listen(events.entryAlert, cb),
    onChange: (cb) => listen(events.entryChanged, cb),
    onRuntime: (cb) => listen(events.entryRuntimeChanged, cb),
    onWarning: (cb) => listen(events.entryWarning, cb),
  },

  log: {
    query: (query) => narrow(LogService.query(loose(query))),
    clear: () => {
      void LogService.clear();
    },
  },

  dialog: {
    pickDirectory: () => unsupported("选择目录"),
    pickImportRoot: () => unsupported("选择导入目录"),
  },

  shell: {
    openLocalhost: (port) => {
      void ShellService.openLocalhost(port);
    },
    openPath: (target) => {
      void ShellService.openPath(target);
    },
    openProjectLink: (key) => {
      void ShellService.openProjectLink(key);
    },
  },

  clipboard: {
    writeText: (text) => ClipboardService.writeText(text),
  },

  scanner: {
    snapshot: () => narrow(ScannerService.snapshot()),
    refresh: () => {
      void ScannerService.refresh();
    },
    setVisible: (visible) => {
      void ScannerService.setVisible(visible);
    },
    ignore: (processName, port) => {
      void ScannerService.ignore(processName, port);
    },
    hideOnce: (pid, port) => {
      void ScannerService.hideOnce(pid, port);
    },
    setGroup: (processName, group) => ScannerService.setGroup(processName, group),
    watchedKeywords: () => ScannerService.watchedKeywords(),
    setWatchedKeywords: (keywords) => ScannerService.setWatchedKeywords(keywords),
    onDiff: (cb) => listen(events.scannerDiff, cb),
  },

  config: {
    export: () => unsupported("导出配置"),
    import: () => unsupported("导入配置"),
  },

  settings: {
    get: () => narrow(SettingsService.get()),
    patch: (patch) => narrow(SettingsService.patch(loose(patch))),
    onChange: (cb) => listen(events.settingsChanged, cb),
  },

  theme: {
    get: () => narrow(ThemeService.get()),
    set: (preference) => narrow(ThemeService.set(preference)),
    onChange: (cb) => listen(events.themeChanged, cb),
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
    onMaximizeChange: (cb) => listen(events.windowMaximizeChanged, cb),
  },

  app: {
    info: () => AppService.info(),
    ready: () => AppService.ready(),
    onFocusEntry: noopOff,
    onOpenPalette: noopOff,
  },

  group: {
    list: () => narrow(GroupService.list()),
    add: (input) => narrow(GroupService.add(loose(input))),
    patch: (id, patch) => narrow(GroupService.patch(id, loose(patch))),
    remove: (id) => GroupService.remove(id),
    reorder: (ids) => GroupService.reorder(ids),
    onChange: (cb) => listen(events.groupChanged, cb),
  },

  planner: {
    get: () => narrow(PlannerService.get()),
    addBoard: (groupId) => narrow(PlannerService.addBoard(toRaw(groupId))),
    editBoard: (boardId, patch) =>
      narrow(PlannerService.editBoard(toRaw(boardId), toRaw(patch))),
    reassignBoard: (boardId, groupId) =>
      narrow(PlannerService.reassignBoard(toRaw(boardId), toRaw(groupId))),
    removeBoard: (boardId) => PlannerService.removeBoard(toRaw(boardId)),
    reorderBoards: (ids) => PlannerService.reorderBoards(toRaw(ids)),
    addTask: (boardId, input) => narrow(PlannerService.addTask(toRaw(boardId), toRaw(input))),
    editTask: (boardId, taskId, patch) =>
      narrow(PlannerService.editTask(toRaw(boardId), toRaw(taskId), toRaw(patch))),
    removeTask: (boardId, taskId) => PlannerService.removeTask(toRaw(boardId), toRaw(taskId)),
    reorderTasks: (boardId, ids) => PlannerService.reorderTasks(toRaw(boardId), toRaw(ids)),
    addSchedule: (boardId, input) =>
      narrow(PlannerService.addSchedule(toRaw(boardId), toRaw(input))),
    editSchedule: (boardId, scheduleId, patch) =>
      narrow(PlannerService.editSchedule(toRaw(boardId), toRaw(scheduleId), toRaw(patch))),
    removeSchedule: (boardId, scheduleId) =>
      PlannerService.removeSchedule(toRaw(boardId), toRaw(scheduleId)),
    completeTask: (boardId, scheduleId) => PlannerService.completeTask(boardId, scheduleId),
    dismissMissed: (boardId, scheduleId, at) =>
      PlannerService.dismissMissed(boardId, scheduleId, at ?? 0),
    clearMissed: () => PlannerService.clearMissed(),
    onChange: (cb) => listen(events.plannerChanged, cb),
    onReminder: (cb) => listen(events.plannerReminder, cb),
    onFocus: noopOff,
  },
};

/** planner 的入参在 Go 侧是 json.RawMessage，生成的类型是 string。 */
function toRaw(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** 终端挂载时调一次：把该会话的输出接到 `onData` 的订阅者上。 */
export const attachSessionOutput = attachSession;
