// S08 对拍用的模块钩子：让 node 能直接加载原版 src/main/platform/win32/*.ts。
//
// 原版文件只读，不改。这里只在内存里做三件事：
//   1. 无扩展名的相对 import（'./process'）补成 .ts，原版按 electron-vite 打包，node 自己解析不了
//   2. win32 目录下对 node:child_process / node:fs 的 import 换成两个桩：
//      记录 execFile / spawn 的 argv 与选项，不真的起进程；文件是否存在由生成脚本指定
//      （服务层的 node:fs 不换：S09 的 ConfigStore 对拍要在临时目录里真读真写）
//   2a. PlannerService.ts 的 node:crypto 换成 platform-stub-crypto.mjs（randomUUID 给可预测的 id）
//   2c. ScannerService.ts 的 '../platform' / pidusage / node:os 换成 platform-stub-scanner.mjs
//   2d. DetectService.ts 的 '../platform' 换成 platform-stub-detect.mjs（S16）
//   2e. PrecheckService.ts 的 '../platform' 同 2d；node:fs/promises 与 ../lib/portScanner 换成 platform-stub-precheck.mjs（S17）
//   2f. SessionService.ts 的 node-pty / node:os / '../platform' 换成 platform-stub-session.mjs（S18）
//   2g. EntryService.ts 的 '../platform' 换成 platform-stub-entry.mjs，node:crypto 换成 platform-stub-crypto.mjs（S21a）
//   2b. 任何位置的 electron 换成 platform-stub-electron.mjs；@shared/* 别名指回原版 src/shared
//   3. process.ts 末尾追加 export { parseNetstat, META_SCRIPT }（原版是模块私有）
//
// 用法：在生成脚本最前面 import './platform-hooks.mjs'，再动态 import 原版模块。

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const ORIGINAL_WIN32 = resolve(here, '../../../mile-terminal-management/src/main/platform/win32')
const win32URL = pathToFileURL(ORIGINAL_WIN32).href + '/'
const stubs = {
  'node:child_process': pathToFileURL(resolve(here, 'platform-stub-child-process.mjs')).href,
  'node:fs': pathToFileURL(resolve(here, 'platform-stub-fs.mjs')).href,
}

// 任何位置都要换掉的：electron（原版服务层 import { app }），以及 electron-vite 的 @shared 别名
const ORIGINAL_SRC = resolve(here, '../../../mile-terminal-management/src')
const everywhere = {
  electron: pathToFileURL(resolve(here, 'platform-stub-electron.mjs')).href,
  '@shared/types': pathToFileURL(resolve(ORIGINAL_SRC, 'shared/types.ts')).href,
  '@shared/planner': pathToFileURL(resolve(ORIGINAL_SRC, 'shared/planner.ts')).href,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    if (everywhere[specifier]) {
      return { url: everywhere[specifier], shortCircuit: true }
    }
    if (specifier === 'node:crypto' && parent.split('?')[0].endsWith('/services/PlannerService.ts')) {
      return { url: pathToFileURL(resolve(here, 'platform-stub-crypto.mjs')).href, shortCircuit: true }
    }
    // 2c. ScannerService.ts 的平台、pidusage、node:os 换成 platform-stub-scanner.mjs（S15）
    if (parent.split('?')[0].endsWith('/services/ScannerService.ts') &&
      (specifier === '../platform' || specifier === 'pidusage' || specifier === 'node:os')) {
      const url = new URL(pathToFileURL(resolve(here, 'platform-stub-scanner.mjs')).href)
      url.search = new URL(parent).search // 每个场景一份新实例（原版 prevTicks 是模块级变量）
      return { url: url.href, shortCircuit: true }
    }
    // 2d. DetectService.ts 的 '../platform' 换成 platform-stub-detect.mjs（S16）：原版 index.ts 同时 import darwin，
    // darwin 的 node:child_process / node:fs 不在桩范围内；detect 只用 wrapperFile 与 unsupportedLaunchModes
    if (parent.split('?')[0].endsWith('/services/DetectService.ts') && specifier === '../platform') {
      return { url: pathToFileURL(resolve(here, 'platform-stub-detect.mjs')).href, shortCircuit: true }
    }
    // 2e. PrecheckService.ts（S17）：'../platform' 用原版 win32（同 2d）；statfs 与 findFreePort 换成可控的桩
    if (parent.split('?')[0].endsWith('/services/PrecheckService.ts')) {
      if (specifier === '../platform') {
        return { url: pathToFileURL(resolve(here, 'platform-stub-detect.mjs')).href, shortCircuit: true }
      }
      if (specifier === 'node:fs/promises' || specifier === '../lib/portScanner') {
        return { url: pathToFileURL(resolve(here, 'platform-stub-precheck.mjs')).href, shortCircuit: true }
      }
    }
    // 2f. SessionService.ts（S18）：node-pty / node:os / '../platform' 换成 platform-stub-session.mjs
    if (parent.split('?')[0].endsWith('/services/SessionService.ts') &&
      (specifier === 'node-pty' || specifier === 'node:os' || specifier === '../platform')) {
      return { url: pathToFileURL(resolve(here, 'platform-stub-session.mjs')).href, shortCircuit: true }
    }
    // 2g. EntryService.ts（S21a）：平台换成可控的假平台；randomUUID 换成可预测的 id-N
    if (parent.split('?')[0].endsWith('/services/EntryService.ts')) {
      if (specifier === '../platform') {
        return { url: pathToFileURL(resolve(here, 'platform-stub-entry.mjs')).href, shortCircuit: true }
      }
      if (specifier === 'node:crypto') {
        return { url: pathToFileURL(resolve(here, 'platform-stub-crypto.mjs')).href, shortCircuit: true }
      }
    }
    if (parent.startsWith(win32URL) && stubs[specifier]) {
      return { url: stubs[specifier], shortCircuit: true }
    }
    if (parent.startsWith('file:') && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const candidate = new URL(specifier + '.ts', parent)
      // 父模块带 ?v=N 时子模块也带上：原版有模块级缓存（cachedShell、psPath），每组用例要一份新实例
      candidate.search = new URL(parent).search
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
      // 目录导入（'../platform'）：electron-vite 解析成 index.ts，node 不支持
      const index = new URL(specifier + '/index.ts', parent)
      index.search = new URL(parent).search
      if (existsSync(fileURLToPath(index))) return { url: index.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.split('?')[0] === win32URL + 'process.ts') {
      const source = String(result.source) + '\nexport { parseNetstat, META_SCRIPT }\n'
      return { ...result, source, shortCircuit: true }
    }
    // S16：DetectService.ts 的模块私有纯函数追加导出
    if (url.split('?')[0].endsWith('/services/DetectService.ts')) {
      const source = String(result.source) + '\nexport { parseIconHrefs, tryReadIcon, toStringRecord }\n'
      return { ...result, source, shortCircuit: true }
    }
    // S21a：EntryService.ts 文件末尾的纯函数是模块私有的，追加导出供直接对拍
    if (url.split('?')[0].endsWith('/services/EntryService.ts')) {
      const source = String(result.source) +
        '\nexport { capturePort, taskStatus, byOrder, isSafeRelative, normalizePath, isDirectory, isFile, isRunnable }\n'
      return { ...result, source, shortCircuit: true }
    }
    // S15：ScannerService.ts 文件末尾的纯函数是模块私有的，追加导出供直接对拍
    if (url.split('?')[0].endsWith('/services/ScannerService.ts')) {
      const source = String(result.source) +
        '\nexport { changed, normalizeKeywords, truncate, matchEntry, countConflicts, guessCwd }\n'
      return { ...result, source, shortCircuit: true }
    }
    return result
  },
})
