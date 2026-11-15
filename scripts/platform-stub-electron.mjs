// 对拍桩：替换原版服务层 import 的 electron。只提供 app.getPath('appData') 与 app.isPackaged，
// 指向生成脚本设的临时目录（globalThis.__appData），绝不指向真实 %APPDATA%。

export const app = {
  // PlannerService 模块顶部读 !app.isPackaged 决定是否认测试钩子；生成脚本不设那两个环境变量
  isPackaged: false,
  getPath(name) {
    if (name !== 'appData') throw new Error(`桩只支持 appData，收到 ${name}`)
    if (!globalThis.__appData) throw new Error('未设置 globalThis.__appData')
    return globalThis.__appData
  },
}

// ImageService.ts 在模块顶层 `import { nativeImage } from 'electron'`（S20 迁移的是 Go 侧，
// 原版仍要加载）。S21a 的对拍不碰图片，给一个不做事的最小桩即可。
export const nativeImage = {
  createFromBuffer() {
    return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }
  }
}
