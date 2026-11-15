/**
 * S33 mygo 一侧的采集驱动：CDP over WebView2 跑 scripts/s33-probe.cjs，结果写到 build/s33/mygo/。
 *
 * 用法（在 mygo/console 下）：
 *   1. bun run scripts/cdp-s33-visual.mjs seed <沙箱目录>     # 写与原版一侧相同的 v1 配置
 *   2. MILE_CONSOLE_DATA_DIR=<沙箱目录> WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" bun run dev
 *   3. bun run scripts/cdp-s33-visual.mjs
 *
 * 沙箱目录对应原版 harness 的 setPath('appData', tmpdir)：不读写真实 %APPDATA%\mile-console\。
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const probe = require("./s33-probe.cjs");
const ORIG = resolve(import.meta.dir, "..", "..", "..", "mile-terminal-management");

if (process.argv[2] === "seed") {
  const dir = process.argv[3];
  if (!dir) throw new Error("缺沙箱目录");
  mkdirSync(dir, { recursive: true });
  const fix = join(ORIG, "scripts", "fixture").replace(/\\/g, "/");
  const fixt = join(ORIG, "scripts", "fixture-task").replace(/\\/g, "/");
  writeFileSync(join(dir, "config.json"), JSON.stringify(probe.seedConfig(fix, fixt), null, 2), "utf8");
  console.log("seeded " + dir);
  process.exit(0);
}

const PORT = Number(process.env.MYGO_CDP_PORT ?? 9223);
const OUT = resolve(import.meta.dir, "..", "build", "s33", "mygo");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      // 端点还没就绪
    }
    await sleep(300);
  }
  throw new Error("没有找到 page 类型的 CDP target");
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP 连不上")); });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await send("Page.enable");

const driver = {
  eval: evaluate,
  send,
  prepare: () => evaluate(`import("/src/lib/mile.ts").then(({ mile }) => { window.__mile = mile; return true })`),
};
const files = { write: (rel, data) => writeFileSync(join(OUT, rel), data) };
const summary = await probe.run(driver, files, (m) => console.log("[mygo] " + m));
console.log("[mygo] done, press=" + JSON.stringify(summary.press));
ws.close();
