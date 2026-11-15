// S12 对拍桩：替换原版 PlannerService.ts 的 node:crypto。randomUUID 改成可预测的 id-1、id-2……，
// Go 测试用同一个计数器，两边生成的 id 逐个对得上。计数器由生成脚本每组用例前重置（globalThis.__idSeq = 0）。

export function randomUUID() {
  globalThis.__idSeq = (globalThis.__idSeq ?? 0) + 1
  return `id-${globalThis.__idSeq}`
}
