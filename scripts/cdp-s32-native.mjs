/**
 * S32 原生集成的真实窗口验收（CDP over WebView2）：导航守卫、条目脱敏、工作组事件、
 * 对话框接线、全局快捷键提示、关闭收托盘 + 第二实例唤回、退出清理。
 * 托盘菜单、系统通知点击、按下全局快捷键要人工过一遍（CLAUDE.md §9）。
 *
 * 用法：
 *   1. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" bun run dev
 *   2. MILE_EXE="<.mygo/dev 下的 exe>" WINVIS_PS1=scripts/winvis.ps1 bun run scripts/cdp-s32-native.mjs
 *      加 QUIT_TEST=1 时最后会关窗触发退出清理（看 dev 日志里的「退出清理」两行）。
 */

const PORT = Number(process.env.MYGO_CDP_PORT ?? 9223);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      // 浏览器刚起来，端点可能还没就绪
    }
    await sleep(300);
  }
  throw new Error("没有找到 page 类型的 CDP target");
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const consoleErrors = [];
  let seq = 0;

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params.exceptionDetails?.text ?? "exceptionThrown");
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleErrors.push(msg.params.entry.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(
        msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")
      );
    }
  };

  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`无法连接 CDP：${url}`));
  });

  const send = (method, params = {}) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      );
    }
    return r.result.value;
  };

  const waitFor = async (expression, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`等待超时：${label}（最后一次结果：${JSON.stringify(last)}）`);
  };

  return { ws, ready, send, evaluate, waitFor, consoleErrors };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}




const page = await target();
console.log(`target: ${page.title} ${page.url}`);
const cdp = connect(page.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");
await cdp.waitFor("document.readyState === 'complete'", "document.readyState");
await cdp.waitFor("!!document.querySelector('nav')", "外壳挂载", 15000);

const ev = cdp.evaluate;
const mileCall = (expr) => ev(`import("/src/lib/mile.ts").then(({ mile }) => ${expr})`);
const ORIGIN = await ev("location.origin");

// 事件探针：订阅挂在 window 上，之后按次数读
await mileCall(`(() => {
  const w = window;
  // 上一次运行的订阅还挂着会重复计数，先退订
  (w.__s32off ?? []).forEach((off) => off());
  w.__s32 = { changed: [], groups: [], warnings: [], settings: [] };
  w.__s32off = [
    mile.entry.onChange((l) => w.__s32.changed.push(l)),
    mile.group.onChange((l) => w.__s32.groups.push(l)),
    mile.entry.onWarning((t) => w.__s32.warnings.push(t)),
    mile.settings.onChange((s) => w.__s32.settings.push(s)),
  ];
  return true;
})()`);

console.log("=== 导航守卫 / window.open ===");
await ev(`(location.href = "https://example.com/", true)`).catch(() => undefined);
await sleep(1200);
check("页面改 location 去外站被拦下", (await ev("location.origin")) === ORIGIN, await ev("location.href"));
check("window.open 外站被拒（返回 null）", (await ev(`window.open("https://example.com/") === null`)) === true);

console.log("\n=== 条目脱敏（entryChanged 与返回值） ===");
const path = await mileCall(`mile.entry.detect(${JSON.stringify(process.cwd())}).then((d) => d.path)`);
const added = await mileCall(`mile.entry.add({
  kind: "task", name: "S32 脱敏探针", path: ${JSON.stringify(path)}, framework: "node",
  packageManager: "bun", script: "typecheck", scripts: { typecheck: "tsc --noEmit" },
  env: { S32_SECRET: "should-not-leak" }
})`);
check("add 返回值 env 只剩键名", JSON.stringify(added.env) === JSON.stringify({ S32_SECRET: "" }), JSON.stringify(added.env));
await cdp.waitFor(`window.__s32.changed.length > 0`, "entryChanged 到达", 5000).catch(() => false);
const lastChanged = await ev(`window.__s32.changed.at(-1)?.find((e) => e.id === ${JSON.stringify(added.id)}) ?? null`);
check("entryChanged 事件到达且含新条目", !!lastChanged, String(await ev("window.__s32.changed.length")));
check("entryChanged 里 env 值为空串", lastChanged && lastChanged.env.S32_SECRET === "", JSON.stringify(lastChanged?.env));
const listed = await mileCall(`mile.entry.list().then((l) => l.find((e) => e.id === ${JSON.stringify(added.id)}))`);
check("entry.list 里 env 值为空串", listed?.env?.S32_SECRET === "", JSON.stringify(listed?.env));
const leak = await ev(`JSON.stringify(window.__s32.changed).includes("should-not-leak")`);
check("任何 entryChanged 负载里都没有明文值", leak === false);
await mileCall(`mile.entry.remove(${JSON.stringify(added.id)}).then(() => true)`);

console.log("\n=== 工作组事件 ===");
const g0 = await ev("window.__s32.groups.length");
const g = await mileCall(`mile.group.add({ name: "S32 探针组", env: "dev" })`);
await cdp.waitFor(`window.__s32.groups.length > ${g0}`, "groupChanged 到达", 5000).catch(() => false);
check("新建工作组后 groupChanged 到达", (await ev(`window.__s32.groups.at(-1)?.some((x) => x.id === ${JSON.stringify(g.id)}) ?? false`)) === true);
const g1 = await ev("window.__s32.groups.length");
await mileCall(`mile.group.remove(${JSON.stringify(g.id)}).then(() => true)`);
await cdp.waitFor(`window.__s32.groups.length > ${g1}`, "删除后 groupChanged", 5000).catch(() => false);
check("删除工作组后 groupChanged 到达且不含该组", (await ev(`window.__s32.groups.at(-1)?.some((x) => x.id === ${JSON.stringify(g.id)}) ?? true`)) === false);

console.log("\n=== 对话框绑定（不弹框，只验接线） ===");
const dlg = await ev(`import("/src/mygo.ts").then((m) => [typeof m.DialogService?.pickDirectory, typeof m.DialogService?.pickImportRoot, typeof m.ConfigService?.export, typeof m.ConfigService?.import].join(","))`);
check("DialogService / ConfigService 已绑定", dlg === "function,function,function,function", dlg);
check("config.export 不接受页面传入路径（无参数）", (await ev(`import("/src/mygo.ts").then((m) => m.ConfigService.export.length)`)) === 0);

console.log("\n=== 全局快捷键冲突提示 ===");
const settings0 = await mileCall("mile.settings.get()");
const w0 = await ev("window.__s32.warnings.length");
await mileCall(`mile.settings.patch({ globalHotkey: false })`);
await mileCall(`mile.settings.patch({ globalHotkey: true })`);
await sleep(600);
const warns = await ev(`window.__s32.warnings.slice(${w0})`);
// 前提先验：原版 Mile Terminal 在跑时它已占住同一个组合键，这时提示才是正确结果
const held = /Mile Terminal\.exe/i.test(
  new TextDecoder().decode(Bun.spawnSync(["tasklist.exe", "/fo", "csv", "/nh"]).stdout),
);
console.log(`前提：原版 Mile Terminal ${held ? "在运行（组合键已被占用）" : "未运行"}`);
if (held) {
  check("组合键被别的程序占用时推一条实时动态提示", warns.some((t) => t === "全局快捷键 Ctrl+Alt+M 已被其他程序占用，未能注册"), JSON.stringify(warns));
} else {
  check("组合键注册成功，没有占用提示", warns.length === 0, JSON.stringify(warns));
}
check("设置保存不受快捷键注册结果影响", (await mileCall("mile.settings.get().then((s) => s.globalHotkey)")) === true);
await mileCall(`mile.settings.patch({ globalHotkey: ${settings0.globalHotkey} })`);

console.log("\n=== 关闭收到托盘 + 第二实例唤回 ===");
// WebView2 隐藏宿主窗口时 document.visibilityState 仍是 visible，所以用 Win32 IsWindowVisible 量
const exe = process.env.MILE_EXE;
const probe = process.env.WINVIS_PS1;
const appPid = /"Mile Console Dev\.exe","(\d+)"/.exec(
  new TextDecoder().decode(Bun.spawnSync(["tasklist.exe", "/fo", "csv", "/nh"]).stdout),
)?.[1];
const nativeVisible = () => {
  const out = new TextDecoder().decode(Bun.spawnSync(["powershell.exe", "-NoProfile", "-File", probe, appPid]).stdout);
  return /Mile Console visible=True/.test(out);
};
if (exe && probe && appPid) {
  check("前提：关窗前主窗口可见", nativeVisible());
  await mileCall(`mile.settings.patch({ closeToTray: true })`);
  await mileCall(`(mile.window.close(), true)`);
  await sleep(800);
  check("closeToTray 开启时关窗只隐藏", !nativeVisible());
  check("隐藏后页面仍在（进程与页面没销毁）", (await ev("1 + 1")) === 2);
  const t0 = Date.now();
  const child = Bun.spawn([exe], { stdout: "ignore", stderr: "ignore" });
  const code = await child.exited;
  check("第二个实例自己退出", Date.now() - t0 < 10_000, `exit ${code}，${Date.now() - t0}ms`);
  await sleep(800);
  check("第一个实例把窗口带回前台", nativeVisible());
} else {
  check("前提：MILE_EXE / WINVIS_PS1 已给出且找到应用进程", false, `${exe} ${probe} ${appPid}`);
}
await mileCall(`mile.settings.patch({ closeToTray: ${settings0.closeToTray} })`);

check("控制台无错误", cdp.consoleErrors.length === 0, cdp.consoleErrors.join(" | ").slice(0, 400));

console.log("\n=== 退出清理（日志证据见 dev 日志） ===");
if (process.env.QUIT_TEST && !settings0.closeToTray) {
  await mileCall(`mile.settings.patch({ killOwnedOnQuit: true })`);
  const s = await mileCall(`mile.session.create({ kind: "shell", title: "S32 退出探针" })`);
  check("前提：起了一个活会话", !!s?.id, s?.id);
  await sleep(1500);
  await mileCall(`mile.settings.patch({ killOwnedOnQuit: ${settings0.killOwnedOnQuit} })`).catch(() => undefined);
  // killOwnedOnQuit 原值为假时恢复后就不清理了，所以只有原值为真才走这一段
  if (settings0.killOwnedOnQuit) {
    const alive = (pid) =>
      new RegExp(`","${pid}",`).test(new TextDecoder().decode(Bun.spawnSync(["tasklist.exe", "/fo", "csv", "/nh"]).stdout));
    check("前提：会话的 shell 进程在跑", !!s?.pid && alive(s.pid), `pid ${s?.pid}`);
    await ev(`import("/src/lib/mile.ts").then(({ mile }) => { mile.window.close(); return true })`).catch(() => undefined);
    console.log("已关窗，等应用退出");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (alive(appPid) || alive(s.pid))) await sleep(300);
    check("应用已退出", !alive(appPid), `pid ${appPid}`);
    check("退出清理杀掉了会话的 shell 进程树", !alive(s.pid), `pid ${s.pid}`);
  }
}

cdp.ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
