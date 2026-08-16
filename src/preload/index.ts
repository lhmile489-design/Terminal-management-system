import { contextBridge, ipcRenderer } from 'electron'
import { Channels } from '@shared/channels'
import type {
  CreateSessionInput,
  DetectResult,
  EntryDiagnosis,
  EntryEdit,
  EntryRuntime,
  EntryStartResult,
  LaunchEntry,
  ListenerGroup,
  LogQuery,
  LogResult,
  NewLaunchEntry,
  PrecheckResult,
  ScanDiff,
  ScanSnapshot,
  Settings,
  SessionDataEvent,
  SessionExitEvent,
  SessionMeta,
  ThemePreference,
  ThemeState
} from '@shared/types'

const api = {
  session: {
    list: (): Promise<SessionMeta[]> => ipcRenderer.invoke(Channels.sessionList),
    create: (input: CreateSessionInput): Promise<SessionMeta> =>
      ipcRenderer.invoke(Channels.sessionCreate, input),
    history: (id: string): Promise<string> => ipcRenderer.invoke(Channels.sessionHistory, id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke(Channels.sessionStop, id),
    write: (id: string, data: string): void => ipcRenderer.send(Channels.sessionWrite, id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send(Channels.sessionResize, id, cols, rows),
    onData: (cb: (e: SessionDataEvent) => void): (() => void) =>
      subscribe(Channels.sessionData, cb),
    onExit: (cb: (e: SessionExitEvent) => void): (() => void) =>
      subscribe(Channels.sessionExit, cb)
  },
  entry: {
    list: (): Promise<LaunchEntry[]> => ipcRenderer.invoke(Channels.entryList),
    add: (input: NewLaunchEntry): Promise<LaunchEntry> =>
      ipcRenderer.invoke(Channels.entryAdd, input),
    edit: (id: string, patch: EntryEdit): Promise<LaunchEntry> =>
      ipcRenderer.invoke(Channels.entryEdit, id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(Channels.entryRemove, id),
    reorder: (ids: string[]): Promise<LaunchEntry[]> =>
      ipcRenderer.invoke(Channels.entryReorder, ids),
    detect: (path: string): Promise<DetectResult> => ipcRenderer.invoke(Channels.entryDetect, path),
    precheck: (id: string): Promise<PrecheckResult> =>
      ipcRenderer.invoke(Channels.entryPrecheck, id),
    start: (id: string): Promise<EntryStartResult> => ipcRenderer.invoke(Channels.entryStart, id),
    stop: (id: string): Promise<EntryRuntime> => ipcRenderer.invoke(Channels.entryStop, id),
    restart: (id: string): Promise<EntryStartResult> =>
      ipcRenderer.invoke(Channels.entryRestart, id),
    install: (id: string): Promise<EntryRuntime> => ipcRenderer.invoke(Channels.entryInstall, id),
    runScript: (id: string, script: string): Promise<EntryRuntime> =>
      ipcRenderer.invoke(Channels.entryRunScript, id, script),
    diagnose: (id: string): Promise<EntryDiagnosis> =>
      ipcRenderer.invoke(Channels.entryDiagnose, id),
    outputDir: (id: string): Promise<string | null> =>
      ipcRenderer.invoke(Channels.entryOutputDir, id),
    openPackageJson: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.entryOpenPackageJson, id),
    runtimes: (): Promise<EntryRuntime[]> => ipcRenderer.invoke(Channels.entryRuntimes),
    onChange: (cb: (list: LaunchEntry[]) => void): (() => void) =>
      subscribe(Channels.entryChanged, cb),
    onRuntime: (cb: (runtime: EntryRuntime) => void): (() => void) =>
      subscribe(Channels.entryRuntimeChanged, cb),
    onWarning: (cb: (text: string) => void): (() => void) =>
      subscribe(Channels.entryWarning, cb)
  },
  log: {
    query: (query: LogQuery): Promise<LogResult> => ipcRenderer.invoke(Channels.logQuery, query),
    clear: (): void => ipcRenderer.send(Channels.logClear)
  },
  dialog: {
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(Channels.dialogPickDirectory)
  },
  shell: {
    openLocalhost: (port: number): void => ipcRenderer.send(Channels.shellOpenLocalhost, port),
    openPath: (target: string): void => ipcRenderer.send(Channels.shellOpenPath, target)
  },
  scanner: {
    snapshot: (): Promise<ScanSnapshot | null> => ipcRenderer.invoke(Channels.scannerSnapshot),
    refresh: (): void => ipcRenderer.send(Channels.scannerRefresh),
    setVisible: (visible: boolean): void => ipcRenderer.send(Channels.scannerVisibility, visible),
    ignore: (processName: string, port: number): void =>
      ipcRenderer.send(Channels.scannerIgnore, processName, port),
    hideOnce: (pid: number, port: number): void =>
      ipcRenderer.send(Channels.scannerHideOnce, pid, port),
    setGroup: (processName: string, group: ListenerGroup | null): Promise<void> =>
      ipcRenderer.invoke(Channels.scannerSetGroup, processName, group),
    watchedKeywords: (): Promise<string[]> => ipcRenderer.invoke(Channels.scannerWatchedGet),
    setWatchedKeywords: (keywords: string[]): Promise<string[]> =>
      ipcRenderer.invoke(Channels.scannerWatchedSet, keywords),
    onDiff: (cb: (diff: ScanDiff) => void): (() => void) => subscribe(Channels.scannerDiff, cb)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(Channels.settingsGet),
    patch: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(Channels.settingsPatch, patch),
    onChange: (cb: (settings: Settings) => void): (() => void) =>
      subscribe(Channels.settingsChanged, cb)
  },
  theme: {
    get: (): Promise<ThemeState> => ipcRenderer.invoke(Channels.themeGet),
    set: (preference: ThemePreference): Promise<ThemeState> =>
      ipcRenderer.invoke(Channels.themeSet, preference),
    onChange: (cb: (state: ThemeState) => void): (() => void) =>
      subscribe(Channels.themeChanged, cb)
  },
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    close: (): void => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(Channels.windowIsMaximized),
    onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) =>
      subscribe(Channels.windowMaximizeChanged, cb)
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('mile', api)

export type MileApi = typeof api
