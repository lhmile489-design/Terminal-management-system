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
