/**
 * S30 六个视图的真实窗口验收（CDP over WebView2）。页面挂的是 ViewHarness，按 #hash 切视图。
 *
 * 用法：
 *   1. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" bun run dev
 *   2. bun run scripts/cdp-s30-views.mjs
 *
 * 每页断言：视图头标题与原版 TITLES 一致；整窗没有滚动条（滚动只在视图自己的滚动区）；
 * 视图有实际内容；控制台无错误。每页截一张 build/s30-<view>.jpg。
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

const VIEWS = [
  ["dashboard", "总览"],
  ["services", "服务"],
  ["terminal", "终端"],
  ["planner", "进度"],
  ["settings", "设置"],
  ["about", "关于"],
];

// 卡片口径是 1440×900。高 DPI 屏上 1440×900 DIP 的窗口放不下会被系统缩小，
// 所以用设备指标覆盖把布局视口固定下来；S30_NATIVE=1 时保留窗口原尺寸。
if (!process.env.S30_NATIVE) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}
const vp = await cdp.evaluate("[innerWidth, innerHeight]");
console.log(`viewport: ${vp[0]}x${vp[1]}`);

for (const [id, title] of VIEWS) {
  const before = cdp.consoleErrors.length;
  await cdp.evaluate(`(location.hash = "#${id}", true)`);
  const got = await cdp.waitFor(
    `(() => { const h = document.querySelector("main h1, main h2"); return h && h.textContent.trim() === ${JSON.stringify(title)} && h.textContent.trim(); })()`,
    `${id} 视图头`
  ).catch(() => null);
  check(`${id}：视图头「${title}」`, got === title, String(got));
  await sleep(1500);
  const m = await cdp.evaluate(`(() => {
    const d = document.documentElement, b = document.body;
    const scroller = document.querySelector("main > div");
    return {
      docScroll: d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1,
      bodyScroll: b.scrollHeight > b.clientHeight + 1 || b.scrollWidth > b.clientWidth + 1,
      text: (scroller?.innerText ?? "").length,
      nodes: scroller ? scroller.querySelectorAll("*").length : 0,
    };
  })()`);
  check(`${id}：整窗无滚动条`, !m.docScroll && !m.bodyScroll, JSON.stringify({ doc: m.docScroll, body: m.bodyScroll }));
  check(`${id}：有内容`, m.nodes > 10 && m.text > 10, `节点 ${m.nodes}，文字 ${m.text}`);
  const errs = cdp.consoleErrors.slice(before);
  check(`${id}：控制台无错误`, errs.length === 0, errs.join(" | ").slice(0, 400));
  const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
  await Bun.write(new URL(`../build/s30-${id}.jpg`, import.meta.url), Buffer.from(shot.data, "base64"));
}


// Dashboard 端口表按采集周期刷新、行不闪（S15 移过来的一项）：
// 给每一行打一个 DOM 属性做标记，等过三个采集周期（默认 2 秒）后再看——
// 行节点若被整表重建，标记会丢；采集若没在跑，扫描快照的 at 不会前进。
await cdp.evaluate(`(location.hash = "#dashboard", true)`);
await cdp.waitFor("document.querySelectorAll('[data-listener-pid]').length > 0", "端口表有行", 10000);
const at0 = await cdp.evaluate("window.__s30at0 = Date.now(), document.querySelectorAll('[data-listener-pid]').forEach((r) => (r.__s30 = 1)), document.querySelectorAll('[data-listener-pid]').length");
const snap0 = await cdp.evaluate("import('/src/lib/mile.ts').then((m) => m.mile.scanner.snapshot()).then((s) => s?.at ?? 0)");
await sleep(6500);
const after = await cdp.evaluate(`(() => {
  const rows = [...document.querySelectorAll("[data-listener-pid]")];
  return { total: rows.length, kept: rows.filter((r) => r.__s30 === 1).length };
})()`);
const snap1 = await cdp.evaluate("import('/src/lib/mile.ts').then((m) => m.mile.scanner.snapshot()).then((s) => s?.at ?? 0)");
check("dashboard：采集按周期前进", snap1 > snap0, `快照时刻 ${snap0} → ${snap1}`);
check("dashboard：端口表行不重建", after.kept > 0 && after.kept === Math.min(at0, after.total), `标记前 ${at0} 行，之后 ${after.total} 行，保留标记 ${after.kept}`);

if (!process.env.S30_NATIVE) await cdp.send("Emulation.clearDeviceMetricsOverride");
cdp.ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`
结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
