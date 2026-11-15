/**
 * S31 应用外壳的真实窗口验收（CDP over WebView2）。断言口径照原版 verify-ui / verify-m6-palette /
 * verify-review-keys；键盘与点击一律走 CDP Input.dispatch*（真实输入），不用合成事件。
 *
 * 用法：
 *   1. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" bun run dev
 *   2. bun run scripts/cdp-s31-shell.mjs
 *
 * 不含要登记夹具项目、真的启动服务的那几条（原版 verify-review-palette2 的启停断言），留给 S33 端到端回归。
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
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
await cdp.waitFor("!!document.querySelector('nav')", "外壳挂载", 15000);

const ev = cdp.evaluate;
const VK = { k: 75, Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13 };

/** 真实键盘输入。ctrl 用修饰位 2；Enter 要带 text 才会触发 keypress 语义。 */
async function key(k, { ctrl = false } = {}) {
  const digit = /^[0-9]$/.test(k);
  const base = {
    key: k,
    code: digit ? `Digit${k}` : k.length === 1 ? `Key${k.toUpperCase()}` : k,
    windowsVirtualKeyCode: digit ? 48 + Number(k) : (VK[k] ?? 0),
    modifiers: ctrl ? 2 : 0,
  };
  const text = k === "Enter" ? "\r" : undefined;
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(250);
}

/** 「?」= Shift + /，修饰位 8 是 Shift。 */
async function question() {
  const base = { key: "?", code: "Slash", windowsVirtualKeyCode: 191, modifiers: 8 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: "?" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(300);
}

async function typeText(s) {
  await cdp.send("Input.insertText", { text: s });
  await sleep(300);
}

async function clearInput() {
  await ev(`(() => {
    const i = document.activeElement;
    if (!i || i.tagName !== "INPUT") return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "");
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
}

async function clickReal(selector) {
  const r = await ev(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  })()`);
  if (!r) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: r[0], y: r[1], button: "left", clickCount: 1 });
  }
  await sleep(300);
  return true;
}

const h1 = () => ev(`(document.querySelector("main h1") || {}).textContent?.trim() ?? ""`);
const paletteOpen = () => ev(`!!document.querySelector('[role="dialog"][aria-label="命令面板"]')`);
const options = () => ev(`[...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim())`);
const selected = () =>
  ev(`[...document.querySelectorAll('[role="option"]')].findIndex((o) => o.getAttribute("aria-selected") === "true")`);
const keysOpen = () => ev(`!!document.querySelector(".ui-keys")`);
const blur = () => ev(`(document.activeElement?.blur(), true)`);
const mileCall = (expr) => ev(`import("/src/lib/mile.ts").then(({ mile }) => ${expr})`);

console.log("=== 标题栏 ===");
const tb = await ev(`(() => {
  const h = document.querySelector(".ui-titlebar");
  const region = (el) => getComputedStyle(el).getPropertyValue("--app-region").trim();
  const btns = [...h.querySelectorAll(".ui-chrome")].map((b) => {
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute("aria-label"), w: r.width, h: r.height, right: Math.round(innerWidth - r.right), region: region(b.closest(".no-drag") || b) };
  });
  return { height: h.getBoundingClientRect().height, region: region(h), search: region(document.querySelector(".ui-search-trigger")), btns };
})()`);
check("标题栏高 40", tb.height === 40, String(tb.height));
check("标题栏是拖拽区（--app-region: drag）", tb.region === "drag", tb.region);
check("搜索入口不参与拖拽（no-drag）", tb.search === "no-drag", tb.search);
check("三个窗口控件：最小化 / 最大化 / 关闭", tb.btns.map((b) => b.label).join(",") === "最小化,最大化,关闭", tb.btns.map((b) => b.label).join(","));
check("窗口控件 46×40", tb.btns.every((b) => Math.abs(b.w - 46) < 0.01 && Math.abs(b.h - 40) < 0.01), JSON.stringify(tb.btns.map((b) => [b.w, b.h])));
check("关闭按钮贴右边", tb.btns.at(-1)?.right === 0, String(tb.btns.at(-1)?.right));
check("窗口控件不参与拖拽", tb.btns.every((b) => b.region === "no-drag"), JSON.stringify(tb.btns.map((b) => b.region)));

// 最大化：真实点击。按钮文案随 Go 推的 windowMaximizeChanged 切换；再点一次还原
await clickReal('.ui-chrome[aria-label="最大化"]');
const maxed = await cdp
  .waitFor(`!!document.querySelector('.ui-chrome[aria-label="还原"]')`, "最大化后按钮变还原", 5000)
  .catch(() => false);
check("点最大化后按钮变「还原」（windowMaximizeChanged 事件到达）", maxed === true);
await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
await clickReal('.ui-chrome[aria-label="还原"]');
const restored = await cdp
  .waitFor(`!!document.querySelector('.ui-chrome[aria-label="最大化"]')`, "还原后按钮变最大化", 5000)
  .catch(() => false);
check("点还原后按钮变回「最大化」", restored === true);
await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);

console.log("\n=== 导航 ===");
const ORDER = ["总览", "服务", "进度", "终端", "设置", "关于"];
const nav = await ev(`[...document.querySelectorAll("nav button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim()).filter(Boolean)`);
check("导航含 6 个视图", ORDER.every((l) => nav.some((n) => n.includes(l))), nav.join(" | "));
await blur();
for (let i = 1; i <= 6; i++) {
  await key(String(i), { ctrl: true });
  const t = await h1();
  check(`Ctrl+${i} 切到「${ORDER[i - 1]}」`, t === ORDER[i - 1], t);
}

console.log("\n=== 命令面板 ===");
await key("k", { ctrl: true });
check("Ctrl+K 唤起面板", await paletteOpen());
check("面板是模态对话框", (await ev(`document.querySelector('[role="dialog"][aria-label="命令面板"]')?.getAttribute("aria-modal")`)) === "true");
check("输入框自动聚焦", await ev(`document.activeElement === document.querySelector('[aria-label="命令面板输入"]')`));
const empty = await options();
check("空查询即给出内置动作", empty.some((l) => l.includes("添加服务")), empty.slice(0, 5).join(" | "));
await question();
check("面板输入框里按 ? 不弹快捷键浮层", !(await keysOpen()));
await clearInput();
await key("Escape");
check("Escape 关闭面板", !(await paletteOpen()));

await key("k", { ctrl: true });
await typeText(">");
const acts = await options();
check("「>」进入动作模式", acts.some((l) => l.includes("添加服务")), acts.slice(0, 5).join(" | "));
await typeText(" 主题");
const themes = await options();
check("动作可按名筛选（三项主题）", themes.length === 3 && themes.every((l) => l.includes("主题")), JSON.stringify(themes));
const s0 = await selected();
await key("ArrowDown");
const s1 = await selected();
await key("ArrowUp");
const s2 = await selected();
check("ArrowDown / ArrowUp 移动选中项", s0 >= 0 && s1 === s0 + 1 && s2 === s0, `${s0} → ${s1} → ${s2}`);

const themeBefore = await ev(`document.documentElement.getAttribute("data-theme")`);
const prefBefore = await mileCall(`mile.theme.get().then((s) => s.preference)`);
await clearInput();
await typeText(themeBefore === "dark" ? "> 主题：浅色" : "> 主题：深色");
await key("Enter");
await sleep(600);
check("回车后面板自动关闭", !(await paletteOpen()));
const themeAfter = await ev(`document.documentElement.getAttribute("data-theme")`);
check("主题动作真的生效", themeAfter !== themeBefore, `${themeBefore} → ${themeAfter}`);
const shotTheme = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
await Bun.write(new URL(`../build/s31-theme-${themeAfter}.jpg`, import.meta.url), Buffer.from(shotTheme.data, "base64"));
// 恢复用户原来的偏好（主题动作会落盘）
await mileCall(`mile.theme.set(${JSON.stringify(prefBefore)}).then(() => true)`);
await ev(`location.reload(), true`);
await sleep(1500);
await cdp.waitFor("!!document.querySelector('nav')", "重载后外壳挂载", 15000);
await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
check("主题偏好已恢复", (await mileCall(`mile.theme.get().then((s) => s.preference)`)) === prefBefore, prefBefore);

await blur();
await key("k", { ctrl: true });
await typeText("> 前往服务");
await key("Enter");
await sleep(500);
check("「前往服务」切换了视图", (await h1()) === "服务", await h1());

console.log("\n=== 快捷键浮层 ===");
await blur();
await question();
check("? 打开快捷键浮层", await keysOpen());
await key("Escape");
check("Escape 关闭快捷键浮层", !(await keysOpen()));
const focused = await ev(`(() => { const i = document.querySelector("main input"); if (!i) return false; i.focus(); return document.activeElement === i })()`);
check("前提：服务页有输入框可聚焦", focused);
await question();
check("输入框里按 ? 不弹快捷键浮层", !(await keysOpen()));
await clearInput();
await blur();

console.log("\n=== 整窗 ===");
const scroll = await ev(`(() => { const d = document.documentElement, b = document.body; return d.scrollHeight > d.clientHeight + 1 || b.scrollHeight > b.clientHeight + 1 })()`);
check("整窗无滚动条", !scroll);
const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
await Bun.write(new URL("../build/s31-shell.jpg", import.meta.url), Buffer.from(shot.data, "base64"));
check("控制台无错误", cdp.consoleErrors.length === 0, cdp.consoleErrors.join(" | ").slice(0, 400));

await cdp.send("Emulation.clearDeviceMetricsOverride");
cdp.ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
