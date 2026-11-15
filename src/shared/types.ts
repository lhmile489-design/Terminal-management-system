// 原版 `@shared/types` 的落点。
//
// 类型全部由 `mygo generate` 从 Go 的 contract 包生成，所以这里只做一次转出，
// 不手写第二份；搬过来的渲染层照旧 `import type { ... } from '@shared/types'`。

export type * from "../mygo";

/** 原版 `SpringBootLaunchMode` 是 `LaunchMode` 的子集；Go 侧只有 `SpringBootLaunchModes` 列表，
 *  这里按同一组取值补一个联合类型（与 contract 逐字一致）。 */
export type SpringBootLaunchMode =
  | "maven-wrapper"
  | "gradle-wrapper"
  | "jar"
  | "system-maven"
  | "system-gradle";

/** 原版 WEB_FRAMEWORKS：会产出网站首页、因此有本地 favicon 可读的前端生态。 */
export const WEB_FRAMEWORKS = [
  "next",
  "nuxt",
  "angular",
  "vue-vite",
  "vue-cli",
  "react-vite",
  "react-cra",
  "svelte",
  "electron",
  "hexo",
  "uniapp",
  "hugo",
  "jekyll",
  "static",
] as const;

/** 即原版 isWebFramework。 */
export function isWebFramework(f: string): boolean {
  return (WEB_FRAMEWORKS as readonly string[]).includes(f);
}

/** 即原版 GROUP_ENV_LABEL。 */
export const GROUP_ENV_LABEL: Record<string, string> = {
  dev: "开发",
  sandbox: "沙箱",
  prod: "生产",
};

/** 原版 MavenGoal；Go 侧是 MavenGoals 列表，这里补联合类型。 */
export type MavenGoal = "clean" | "compile" | "package" | "test" | "install" | "verify";

/** Go 侧把 `scripts` 生成成 unknown（保序对象），渲染层按契约 §1.3 断言成普通记录。 */
export type Scripts = Record<string, string>;

/** 取条目脚本表，形状与原版的 Record<string, string> 一致。 */
export function scriptsOf(e: { scripts?: unknown }): Scripts {
  return (e.scripts ?? {}) as Scripts;
}
