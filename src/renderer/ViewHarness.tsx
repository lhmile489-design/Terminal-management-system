// S30 验收用的临时台架，S31 搬入原版 App.tsx 后删除。
//
// 只做原版 App 里「让视图能跑起来」的那部分：各 store 的 init、几条变化事件的订阅、
// 与原版同样的 <main> 容器结构（App.tsx 第 418–457 行）、ConfirmHost / ToastHost。
// 标题栏、导航、命令面板、实时动态都不在这里。视图由地址的 #hash 选：#dashboard、#services…
// 回调型 props 一律给空函数：跳转与聚焦属于外壳，S31 再接。

import { useEffect, useState } from "react";
import { ViewHeader } from "./components/ViewHeader";
import { ConfirmHost, ToastHost } from "./components/ui";
import { Dashboard } from "./views/Dashboard";
import { Services } from "./views/Services";
import { TerminalWorkspace } from "./views/TerminalWorkspace";
import { Planner } from "./views/Planner";
import { Settings } from "./views/Settings";
import { About } from "./views/About";
import { useSessions } from "./store/sessions";
import { useScanner } from "./store/scanner";
import { useEntries } from "./store/entries";
import { useSettings } from "./store/settings";
import { useGroups } from "./store/groups";
import { usePlanner } from "./store/planner";
import { mile } from "../lib/mile";

type ViewId = "services" | "dashboard" | "planner" | "terminal" | "settings" | "about";

// 与原版 App.tsx 的 TITLES 逐字一致
const TITLES: Record<ViewId, { title: string; caption: string }> = {
  services: { title: "服务", caption: "按工作组启停前端、后端与任务，点一个服务看详情" },
  dashboard: { title: "总览", caption: "实时掌握本机监听端口与进程负载" },
  planner: { title: "进度", caption: "按工作组记录项目进度、开始与预计结束时间" },
  terminal: { title: "终端", caption: "自建终端、服务会话与全部输出检索" },
  settings: { title: "设置", caption: "采集周期、主题与终端偏好" },
  about: { title: "关于", caption: "版本信息、使用教程与项目介绍" },
};

const noop = (): void => {};

function viewFromHash(): ViewId {
  const h = location.hash.slice(1);
  return (h in TITLES ? h : "services") as ViewId;
}

export function ViewHarness(): React.JSX.Element {
  const [view, setView] = useState<ViewId>(viewFromHash);
  useEffect(() => {
    const on = (): void => setView(viewFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const refresh = useSessions((s) => s.refresh);
  const initScanner = useScanner((s) => s.init);
  const applyDiff = useScanner((s) => s.applyDiff);
  const initEntries = useEntries((s) => s.init);
  const setEntries = useEntries((s) => s.setEntries);
  const setRuntime = useEntries((s) => s.setRuntime);
  const initSettings = useSettings((s) => s.init);
  const initGroups = useGroups((s) => s.init);
  const setGroups = useGroups((s) => s.setGroups);
  const initPlanner = usePlanner((s) => s.init);
  const applyPlanner = usePlanner((s) => s.apply);

  useEffect(() => {
    void refresh();
    void initScanner();
    void initEntries();
    void initSettings();
    void initGroups();
    void initPlanner();
  }, [refresh, initScanner, initEntries, initSettings, initGroups, initPlanner]);
  useEffect(() => mile.planner.onChange(applyPlanner), [applyPlanner]);
  useEffect(() => mile.scanner.onDiff(applyDiff), [applyDiff]);
  useEffect(() => mile.entry.onChange(setEntries), [setEntries]);
  useEffect(() => mile.group.onChange(setGroups), [setGroups]);
  useEffect(() => mile.entry.onRuntime(setRuntime), [setRuntime]);
  // 订阅都挂上之后再握手，排队的事件才不会丢（契约 §2）
  useEffect(() => {
    void mile.app.ready();
  }, []);

  const meta = TITLES[view];
  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div key={view} className="view-enter flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
            <ViewHeader title={meta.title} caption={meta.caption} />
            {view === "dashboard" && (
              <Dashboard
                onRequestAdd={noop}
                highlightPort={null}
                onHighlightConsumed={noop}
                onOpenLogs={noop}
                onFocusService={noop}
              />
            )}
            {view === "services" && (
              <Services
                onOpenLogs={noop}
                onOpenTerminal={noop}
                focus={null}
                pendingAdd={null}
                onPendingConsumed={noop}
                pendingKind={null}
                onPendingKindConsumed={noop}
                onOpenPlanner={noop}
              />
            )}
            {view === "planner" && <Planner onGoServices={noop} focus={null} onFocusConsumed={noop} />}
            {view === "terminal" && <TerminalWorkspace />}
            {view === "settings" && <Settings />}
            {view === "about" && <About />}
          </div>
        </main>
      </div>
      <ConfirmHost />
      <ToastHost />
    </div>
  );
}
