/**
 * 真实窗口验收（CDP over WebView2）。
 *
 * 用法：
 *   1. 先带调试端口启动开发窗口：
 *      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" mygo dev
 *   2. 另开终端：
 *      bun run scripts/cdp-verify.mjs
 *
 * 验证项：页面加载、Go 绑定调用（Greeter.Info / Greeter.Greet）、tick 事件推送、
 * 控制台无报错，并把窗口截图写到 build/verify-window.jpg（build/ 已 gitignore）。
 * 任何一项失败都会以非零码退出，供后续接入 CI 或人工走查使用。
 */

const PORT = Number(process.env.MYGO_CDP_PORT ?? 9223);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT = new URL("../build/verify-window.jpg", import.meta.url);

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
await cdp.send("Page.bringToFront");

await cdp.waitFor("document.readyState === 'complete'", "document.readyState");

const title = await cdp.evaluate("document.title");
check("窗口标题", title === "Mile Console", title);

// Go 绑定：Greeter.Info() 在页面加载时被调用，结果写进 #info
const info = await cdp.waitFor(
  "document.querySelector('#info')?.textContent?.trim()",
  "#info 有内容"
);
check(
  "Go 绑定 Greeter.Info",
  /^windows\/amd64 · go1\.27/.test(info),
  info
);

// tick 事件：每秒更新 #clock
const clock1 = await cdp.waitFor(
  "document.querySelector('#clock')?.textContent?.trim() !== '--:--:--' && document.querySelector('#clock').textContent.trim()",
  "#clock 收到 tick"
);
await sleep(1200);
const clock2 = await cdp.evaluate("document.querySelector('#clock').textContent.trim()");
check("Event tick 持续推送", clock1 !== clock2, `${clock1} → ${clock2}`);

// Go 绑定：提交表单，问候语由 Go 返回
await cdp.evaluate(`(() => {
  const input = document.querySelector('#name');
  input.value = 'Mile';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#greet').requestSubmit();
  return true;
})()`);
const greeting = await cdp.waitFor(
  "document.querySelector('#greeting')?.textContent?.trim()",
  "#greeting 有内容"
);
check(
  "Go 绑定 Greeter.Greet",
  greeting.includes("Hello, Mile!") && greeting.includes("from Go"),
  greeting
);

// 截图（JPEG：窗口隐藏时 PNG 可能卡住）
const shot = await cdp.send("Page.captureScreenshot", {
  format: "jpeg",
  quality: 85
});
await Bun.write(SHOT, Buffer.from(shot.data, "base64"));
check("窗口截图", true, SHOT.pathname);

check("控制台无错误", cdp.consoleErrors.length === 0, cdp.consoleErrors.join(" | "));

cdp.ws.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
