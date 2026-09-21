/**
 * Spring Boot 启动能力验证。
 *
 * 覆盖三条链路，全部走真实主进程 + 真实 out/ 产物：
 *   1. 识别：pom.xml 含 spring-boot 的目录被认成 framework='spring-boot'、registerOnly=false，
 *      并探测出默认启动方式与端口。gradle 目录同理。
 *   2. 命令构造 + 端口捕获：用一个**假的 mvnw.cmd**（真批处理，打印一行 Tomcat 端口后退出）
 *      端到端跑一遍 entry.start —— 这样真实走过 buildSpringBootCommand → SessionService →
 *      absorb 的端口捕获，而不需要装 Java / 真跑 Maven。
 *   3. 安全：jar 路径含 .. / launchMode 非法值经 edit 被拒且不落盘；缺 wrapper 时预检 fail。
 *
 * 为什么不真跑 mvn：会编译、要联网下依赖、慢且不确定。假 mvnw.cmd 只验我们自己的命令构造
 * 与端口正则是否对得上，这正是本次改动引入的逻辑。真 Maven 的行为不是我们要测的东西。
 *
 * harness 必须在 require 主进程包之前 setPath('appData')，否则会写真实用户配置。
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = join(tmpdir(), `mile-springboot-${process.pid}`)
mkdirSync(join(SANDBOX, 'mile-terminal'), { recursive: true })
app.setPath('appData', SANDBOX)
const CONFIG = join(SANDBOX, 'mile-terminal', 'config.json')

// 从 src 读当前配置版本，不写死 —— 版本号会随迁移演进
const TYPES = readFileSync(join(ROOT, 'src', 'shared', 'types.ts'), 'utf8')
const CONFIG_VERSION = Number((TYPES.match(/CONFIG_VERSION\s*=\s*(\d+)/) || [])[1] || 1)

// ── 夹具项目 ────────────────────────────────────────────────────────────────

/** Maven Spring Boot 项目：pom.xml 含 spring-boot + 一个假 mvnw.cmd + application.properties */
const MVN_PROJECT = join(SANDBOX, 'sb-maven')
mkdirSync(join(MVN_PROJECT, 'src', 'main', 'resources'), { recursive: true })
writeFileSync(
  join(MVN_PROJECT, 'pom.xml'),
  `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <artifactId>demo</artifactId>
</project>`,
  'utf8'
)
writeFileSync(
  join(MVN_PROJECT, 'src', 'main', 'resources', 'application.properties'),
  'server.port=18080\n',
  'utf8'
)
// 假 mvnw.cmd：打印一行标准 Tomcat 启动日志（端口 18080），然后**保持运行**。
// 关键：真实 Spring Boot 服务打印端口后会持续运行，不会立刻退出。假进程若打印后
// 立刻 exit，会制造真实场景不存在的「exit 与末行 data 竞争」（见 CLAUDE.md 平台细节），
// 端口行可能在采集到之前就随进程消失。用 ping 延时把进程按住 ~7s，供 harness 捕获后再停。
writeFileSync(
  join(MVN_PROJECT, 'mvnw.cmd'),
  `@echo off\r\necho Tomcat started on port(s): 18080 (http) with context path ''\r\nping -n 8 127.0.0.1 >nul\r\nexit /b 0\r\n`,
  'utf8'
)

/** Gradle Spring Boot 项目：build.gradle 含 org.springframework.boot + 假 gradlew.bat */
const GRADLE_PROJECT = join(SANDBOX, 'sb-gradle')
mkdirSync(GRADLE_PROJECT, { recursive: true })
writeFileSync(
  join(GRADLE_PROJECT, 'build.gradle'),
  `plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n`,
  'utf8'
)
writeFileSync(
  join(GRADLE_PROJECT, 'gradlew.bat'),
  `@echo off\r\necho Netty started on port 19090\r\nexit /b 0\r\n`,
  'utf8'
)

/** 纯 Maven（非 Spring Boot）：pom.xml 不含 spring-boot，不应被认成 spring-boot */
const PLAIN_MVN = join(SANDBOX, 'plain-maven')
mkdirSync(PLAIN_MVN, { recursive: true })
writeFileSync(
  join(PLAIN_MVN, 'pom.xml'),
  `<?xml version="1.0"?><project><artifactId>plain</artifactId></project>`,
  'utf8'
)

writeFileSync(
  CONFIG,
  JSON.stringify(
    { version: CONFIG_VERSION, entries: [], ignoredListeners: [], settings: {} },
    null,
    2
  ),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.log('FAIL 没有取到窗口')
    app.exit(1)
    return
  }

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    const js = (code) => win.webContents.executeJavaScript(code, true)

    // ── 1. 识别 ──────────────────────────────────────────────────────────
    console.log('\n=== 1. 识别 ===')

    const mvnDetect = await js(
      `window.mile.entry.detect(${JSON.stringify(MVN_PROJECT)})`
    )
    check('Maven 项目识别为 spring-boot', mvnDetect.framework === 'spring-boot', mvnDetect.framework)
    check('Maven 项目可启动（registerOnly=false）', mvnDetect.registerOnly === false)
    check(
      'Maven 项目默认启动方式为 maven-wrapper',
      mvnDetect.detectedLaunchMode === 'maven-wrapper',
      String(mvnDetect.detectedLaunchMode)
    )
    check('Maven 项目探测到端口 18080', mvnDetect.detectedPort === 18080, String(mvnDetect.detectedPort))

    const gradleDetect = await js(
      `window.mile.entry.detect(${JSON.stringify(GRADLE_PROJECT)})`
    )
    check('Gradle 项目识别为 spring-boot', gradleDetect.framework === 'spring-boot', gradleDetect.framework)
    check(
      'Gradle 项目默认启动方式为 gradle-wrapper',
      gradleDetect.detectedLaunchMode === 'gradle-wrapper',
      String(gradleDetect.detectedLaunchMode)
    )

    const plainDetect = await js(`window.mile.entry.detect(${JSON.stringify(PLAIN_MVN)})`)
    check(
      '纯 Maven 项目不被认成 spring-boot',
      plainDetect.framework !== 'spring-boot',
      plainDetect.framework
    )

    // ── 2. 命令构造 + 端口捕获（端到端） ──────────────────────────────────
    console.log('\n=== 2. 启动：命令构造 + 端口捕获 ===')

    // 用假 mvnw.cmd 的 Maven 项目建一个服务条目（maven-wrapper 模式）
    const added = await js(`window.mile.entry.add({
      kind: 'service',
      name: 'SB Maven',
      path: ${JSON.stringify(MVN_PROJECT)},
      framework: 'spring-boot',
      packageManager: 'npm',
      script: null,
      scripts: {},
      env: {},
      launchMode: 'maven-wrapper',
      registerOnly: false,
      pinned: false
    })`)
    check('新增 Spring Boot 服务条目', !!added && added.framework === 'spring-boot')
    const entryId = added.id

    // 启动它：假 mvnw.cmd 会打印 Tomcat 端口行然后退出。
    // 走真实 start → precheck → spawnSession（buildSpringBootCommand）→ SessionService。
    const startResult = await js(`window.mile.entry.start(${JSON.stringify(entryId)})`)
    check('预检通过并启动', startResult.ok === true, JSON.stringify(startResult.precheck?.ok))

    // 轮询运行态，等端口捕获到（假进程打印后即退，端口应从那一行抓到 18080）。
    // 不用固定 sleep：会话建立 + 输出 + absorb 有不定延迟。
    const capturedPort = await (async (ms = 10000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const runtimes = await js(`window.mile.entry.runtimes()`)
        const rt = runtimes.find((r) => r.entryId === entryId)
        if (rt && rt.port) return rt.port
        await sleep(150)
      }
      return null
    })()
    check('端口从 Tomcat 日志捕获为 18080', capturedPort === 18080, String(capturedPort))

    // ── 3. 安全：非法值被拒且不落盘 ──────────────────────────────────────
    console.log('\n=== 3. 安全校验 ===')

    // 先停掉运行中的条目，否则改身份字段会被运行中锁挡（那是另一条正确路径，但会干扰本节）
    await js(`window.mile.entry.stop(${JSON.stringify(entryId)})`)
    await sleep(500)

    // jar 路径含 .. 必须被拒
    const jarEscape = await js(`
      window.mile.entry.edit(${JSON.stringify(entryId)}, { jarPath: '../evil.jar' })
        .then(() => 'ACCEPTED')
        .catch((e) => 'REJECTED: ' + e.message)
    `)
    check('jar 路径含 .. 被拒', String(jarEscape).startsWith('REJECTED'), String(jarEscape))

    // 非 .jar 结尾被拒
    const jarBadExt = await js(`
      window.mile.entry.edit(${JSON.stringify(entryId)}, { jarPath: 'target/app.txt' })
        .then(() => 'ACCEPTED')
        .catch((e) => 'REJECTED: ' + e.message)
    `)
    check('jar 路径非 .jar 结尾被拒', String(jarBadExt).startsWith('REJECTED'), String(jarBadExt))

    // 非法 launchMode 被拒
    const badMode = await js(`
      window.mile.entry.edit(${JSON.stringify(entryId)}, { launchMode: 'rm-rf' })
        .then(() => 'ACCEPTED')
        .catch((e) => 'REJECTED: ' + e.message)
    `)
    check('非法 launchMode 被拒', String(badMode).startsWith('REJECTED'), String(badMode))

    // 落盘里不应出现任何非法值
    const disk = JSON.parse(readFileSync(CONFIG, 'utf8'))
    const sbEntry = disk.entries.find((e) => e.id === entryId)
    check('落盘条目存在', !!sbEntry)
    check('落盘 jarPath 未被非法值污染', !sbEntry.jarPath || /\.jar$/i.test(sbEntry.jarPath))
    check(
      '落盘 launchMode 仍合法',
      ['maven-wrapper', 'gradle-wrapper', 'jar', 'system-maven', 'system-gradle'].includes(
        sbEntry.launchMode
      ),
      String(sbEntry.launchMode)
    )

    // ── 4. 预检：缺前提文件时 fail ────────────────────────────────────────
    console.log('\n=== 4. 预检前提 ===')

    // 建一个 gradle-wrapper 模式但目录里其实没有 gradlew.bat 的条目（用 Maven 项目目录）
    const misconfig = await js(`window.mile.entry.add({
      kind: 'service',
      name: 'SB Misconfig',
      path: ${JSON.stringify(MVN_PROJECT)},
      framework: 'spring-boot',
      packageManager: 'npm',
      script: null,
      scripts: {},
      env: {},
      launchMode: 'gradle-wrapper',
      registerOnly: false,
      pinned: false
    })`)
    const precheck = await js(`window.mile.entry.precheck(${JSON.stringify(misconfig.id)})`)
    const launchItem = precheck.items.find((i) => i.id === 'launchMode')
    check('预检项数 > 0', precheck.items.length > 0, `items=${precheck.items.length}`)
    check(
      '缺 gradlew.bat 时预检 fail',
      precheck.ok === false && launchItem && launchItem.level === 'fail',
      `ok=${precheck.ok} launch=${launchItem?.level}`
    )
  } catch (err) {
    console.log('HARNESS ERROR', err)
    fail++
  }

  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    console.log(`  (沙箱残留，交由系统清理：${SANDBOX})`)
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
})
