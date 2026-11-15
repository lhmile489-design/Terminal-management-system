// S21a 对拍桩：替换原版 EntryService.ts 的 '../platform'。
//
// 用一个可预测的假平台对象，而不是真的 win32：「这台系统上暂不支持该启动方式」那条分支
// 在 win32 上是空集，永远走不到，只有换成可控的桩才测得到。pathKey 与 Go 测试里的假平台
// 用同一算法，normalizePath 的对拍才有意义。
//
// 字段只列 EntryService 模块顶层与 sanitizeEdit / edit 真正读到的那些。

export const platform = {
  wrapperFile: { maven: 'mvnw.cmd', gradle: 'gradlew.bat' },
  // 与 win32 的候选名同序（whichAny 按 PATH 目录顺序、目录内按候选顺序取第一个命中的）
  binaries: {
    npm: ['npm.cmd', 'npm.exe'],
    pnpm: ['pnpm.cmd', 'pnpm.exe'],
    yarn: ['yarn.cmd', 'yarn.exe'],
    bun: ['bun.exe'],
    java: ['java.exe'],
    mvn: ['mvn.cmd', 'mvn.bat', 'mvn'],
    gradle: ['gradle.cmd', 'gradle.bat', 'gradle'],
    python: ['python.exe', 'python3.exe', 'py.exe', 'python', 'python3'],
    go: ['go.exe', 'go'],
    cargo: ['cargo.exe', 'cargo']
  },
  // 故意留一个「本平台不支持」的启动方式，用来覆盖那一条报错分支
  unsupportedLaunchModes: new Set(['django']),
  requiresExecBit: false,
  hbuilderxCandidates: () => [],
  // 批处理文件的执行包装：与 Go 侧 fakePlatform.WrapBatch 同一形状
  wrapBatch: (file, args) => ({ file: 'cmd.exe', args: ['/d', '/s', '/c', file, ...args] }),
  // Windows 路径比较键：统一分隔符、去掉尾部斜杠、转小写
  pathKey: (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}
