/**
 * S33 对拍：读 build/s33/orig/ 与 build/s33/mygo/ 的指纹和汇总，逐页列出差异。
 * 用法：bun run scripts/s33-diff.mjs [视图键，如 light-services]
 *
 * 指纹按 (标签+类名+自身文字) 做 LCS 对齐；文字里的数字归一成 #（监听数、负载、时间这类动态值）。
 * 盒子容差 ±1px；样式逐项比。只配上一边的元素单列。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "build", "s33");
const load = (side, f) => JSON.parse(readFileSync(join(ROOT, side, f), "utf8"));
const only = process.argv[2];

const key = (n) => n.k + "|" + n.t.replace(/\d+/g, "#");
const STYLE = ["c", "bg", "bc", "bw", "fs", "fw", "ff", "br", "sh", "op", "bi"];

function lcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [], onlyA = [], onlyB = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) onlyA.push(i++);
    else onlyB.push(j++);
  }
  while (i < n) onlyA.push(i++);
  while (j < m) onlyB.push(j++);
  return { pairs, onlyA, onlyB };
}

const files = readdirSync(join(ROOT, "orig")).filter((f) => /^(light|dark)-.*\.json$/.test(f));
let total = 0;
for (const f of files) {
  const view = f.replace(/\.json$/, "");
  if (only && view !== only) continue;
  const A = load("orig", f), B = load("mygo", f);
  const { pairs, onlyA, onlyB } = lcs(A.map(key), B.map(key));
  const lines = [];
  for (const [i, j] of pairs) {
    const a = A[i], b = B[j], d = [];
    for (const p of ["x", "y", "w", "h"]) if (Math.abs(a[p] - b[p]) > 1) d.push(`${p} ${a[p]}→${b[p]}`);
    for (const p of STYLE) if (a[p] !== b[p]) d.push(`${p} ${a[p]}→${b[p]}`);
    if (d.length) lines.push(`  ~ ${a.k.slice(0, 70)} "${a.t}"  ${d.join("; ")}`);
  }
  for (const i of onlyA) lines.push(`  - orig ${A[i].k.slice(0, 70)} "${A[i].t}" @${A[i].x},${A[i].y} ${A[i].w}×${A[i].h}`);
  for (const j of onlyB) lines.push(`  + mygo ${B[j].k.slice(0, 70)} "${B[j].t}" @${B[j].x},${B[j].y} ${B[j].w}×${B[j].h}`);
  total += lines.length;
  console.log(`== ${view}: ${A.length} vs ${B.length} 元素，对上 ${pairs.length}，差异 ${lines.length}`);
  for (const l of lines.slice(0, only ? 400 : 25)) console.log(l);
  if (!only && lines.length > 25) console.log(`  …还有 ${lines.length - 25} 条`);
}

if (!only) {
  const sa = load("orig", "summary.json"), sb = load("mygo", "summary.json");
  console.log("\n== m7 / 视图汇总");
  for (const k of Object.keys(sa.views)) {
    const a = JSON.stringify(sa.views[k]), b = JSON.stringify(sb.views[k]);
    console.log(`  ${a === b ? "=" : "≠"} ${k} ${a === b ? a : "\n      orig " + a + "\n      mygo " + b}`);
  }
  console.log("\n== 1180×760 MEASURE");
  for (const k of Object.keys(sa.small)) {
    const a = { ...sa.small[k] }, b = { ...sb.small[k] };
    const same = JSON.stringify(a) === JSON.stringify(b);
    console.log(`  ${same ? "=" : "≠"} ${k}${same ? "" : "\n      orig " + JSON.stringify(a) + "\n      mygo " + JSON.stringify(b)}`);
  }
  console.log("\n== 按压");
  console.log("  orig " + JSON.stringify(sa.press) + "\n  mygo " + JSON.stringify(sb.press));
  console.log(`\n指纹差异合计 ${total}`);
}
