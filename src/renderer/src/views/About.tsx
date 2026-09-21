import { useEffect, useState } from 'react'
import {
  ArrowSquareOut,
  GithubLogo,
  BookOpen,
  Rocket,
  Terminal,
  Gauge,
  Stethoscope,
  ListMagnifyingGlass,
  Gear,
  Command,
  ShieldCheck,
  Package
} from '@phosphor-icons/react'

const GITHUB_URL = 'https://github.com/lhmile489-design/Terminal-management-system'

/** 使用教程的每个步骤 */
const GUIDE_STEPS: { icon: React.ReactNode; title: string; desc: string }[] = [
  {
    icon: <Rocket size={16} weight="bold" />,
    title: '添加项目到启动台',
    desc: '打开「启动台」，点击"添加服务"（或按 Ctrl+K 搜索）→ 选择项目目录 → 应用只读识别 package.json，选择启动脚本后保存。'
  },
  {
    icon: <Terminal size={16} weight="bold" />,
    title: '启动并查看日志',
    desc: '在服务卡片上点击「启动」，预检通过后进程启动；卡片实时显示运行状态与捕获到的端口。点击「日志」跳转到对应终端会话。'
  },
  {
    icon: <Gauge size={16} weight="bold" />,
    title: '工作台：查看本机端口',
    desc: '「工作台」每 2 秒刷新当前用户的所有监听端口、CPU、内存与运行时长，分「我的服务」和「应用后台」两组显示。'
  },
  {
    icon: <Package size={16} weight="bold" />,
    title: '打包任务：多脚本下拉',
    desc: '任务条目（如 Electron 打包）有多个脚本时，「运行」按钮右侧出现下拉箭头，可直接选择 build:win / build:mac 等脚本执行。任务成功后「查看产物」按钮高亮，点击即在资源管理器中定位产物文件。'
  },
  {
    icon: <Command size={16} weight="bold" />,
    title: '全局命令面板',
    desc: '按 Ctrl+K 呼出命令面板：输入服务名快速启停、输入端口号定位监听项、以 > 开头搜索内置操作（切换主题、跳转视图等）。'
  },
  {
    icon: <Stethoscope size={16} weight="bold" />,
    title: '预检与诊断',
    desc: '启动前自动检查目录、脚本、运行时和端口冲突。失败时直接给修复入口。卡片上的「诊断」按钮可随时重新收集诊断信息。'
  },
  {
    icon: <ListMagnifyingGlass size={16} weight="bold" />,
    title: '日志中心',
    desc: '「日志」视图汇总所有会话的输出，可按会话、级别（信息/警告/错误）和关键字筛选。日志只保留在内存，最多 5000 行。'
  },
  {
    icon: <Gear size={16} weight="bold" />,
    title: '设置',
    desc: '可调整采集周期（1/2/5/10 秒）、浅色/深色/跟随系统主题、终端字号与回滚行数、退出行为和任务完成通知。'
  }
]

const DESIGN_PRINCIPLES: { title: string; desc: string }[] = [
  {
    title: '不安装依赖，不执行项目代码',
    desc: '识别项目类型只读文件，不运行 npm install 或任何版本查询命令。缺依赖时只提示，由你主动点击创建安装会话。'
  },
  {
    title: '归属可证才能终止进程',
    desc: '只对通过「运行 token + 进程组 + 当前用户」三重校验的受控进程执行停止。不因端口相同就杀外部进程。'
  },
  {
    title: '失败前置',
    desc: '启动前静态检查所有可预检的问题，直接给出修复入口，不让你先失败一次再看报错。'
  },
  {
    title: '日志只留内存',
    desc: '跨会话日志是环形缓冲，不落盘。用于查看当下这轮跑得怎么样，不做持久审计。'
  }
]

export function About(): React.JSX.Element {
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    void window.mile.app.info().then((info) => setVersion(info.version))
  }, [])

  return (
    <div className="flex flex-col gap-8 pb-8">

      {/* ── 顶部 Hero 卡 ── */}
      <div className="surface-card flex flex-col gap-4 px-6 py-6">
        <div className="flex items-start gap-4">
          <span className="icon-tile h-14 w-14 shrink-0 text-[22px]">
            <BookOpen size={28} weight="bold" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-baseline gap-3">
              <h2 className="text-[20px] font-bold text-ink-strong">Mile Terminal</h2>
              {version && (
                <span className="rounded-[5px] border border-accent/50 px-2 py-0.5 font-mono text-[11px] font-semibold text-accent">
                  v{version}
                </span>
              )}
            </div>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Windows 本地终端与前端项目管理工作台。把「本机现在跑着什么」和「我常跑的那几个项目」
              收口进一个界面——查监听端口、集中启停服务与任务、跨会话回看日志、启动前诊断。
            </p>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.open(GITHUB_URL, '_blank')}
                className="pressable flex items-center gap-1.5 rounded-[6px] bg-raised px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-line"
              >
                <GithubLogo size={14} weight="bold" aria-hidden />
                GitHub 仓库
                <ArrowSquareOut size={12} aria-hidden className="text-ink-faint" />
              </button>
              <span className="font-mono text-[11px] text-ink-faint">
                个人自用 · Windows 11 · 开源
              </span>
            </div>
          </div>
        </div>

        {/* 技术栈徽标行 */}
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          {[
            'Electron 43', 'React 19', 'TypeScript', 'Vite 7',
            'Tailwind 4', 'node-pty', 'xterm.js 6', 'Zustand'
          ].map((tech) => (
            <span
              key={tech}
              className="rounded-[5px] bg-raised px-2 py-0.5 font-mono text-[11px] text-ink-muted"
            >
              {tech}
            </span>
          ))}
        </div>
      </div>

      {/* ── 使用教程 ── */}
      <section aria-labelledby="about-guide-heading">
        <h3 id="about-guide-heading" className="eyebrow mb-3">
          使用教程
        </h3>
        <div className="surface-card divide-y divide-line">
          {GUIDE_STEPS.map((step, i) => (
            <div key={i} className="flex gap-3 px-5 py-4">
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-accent/10 text-accent">
                {step.icon}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-[13px] font-semibold text-ink-strong">{step.title}</p>
                <p className="text-[12px] leading-relaxed text-ink-muted">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 设计原则 ── */}
      <section aria-labelledby="about-principles-heading">
        <h3 id="about-principles-heading" className="eyebrow mb-3">
          设计原则
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {DESIGN_PRINCIPLES.map((p, i) => (
            <div key={i} className="surface-card flex flex-col gap-1.5 px-4 py-3.5">
              <div className="flex items-center gap-2">
                <ShieldCheck size={13} weight="bold" className="shrink-0 text-accent" aria-hidden />
                <p className="text-[12px] font-semibold text-ink-strong">{p.title}</p>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-muted">{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 快捷键 ── */}
      <section aria-labelledby="about-shortcuts-heading">
        <h3 id="about-shortcuts-heading" className="eyebrow mb-3">
          常用快捷键
        </h3>
        <div className="surface-card divide-y divide-line">
          {[
            { keys: 'Ctrl+K', desc: '打开全局命令面板' },
            { keys: 'Ctrl+↑ / ↓', desc: '键盘调整服务卡片顺序' },
            { keys: 'Esc', desc: '关闭命令面板 / 弹层' }
          ].map((row) => (
            <div key={row.keys} className="flex items-center justify-between px-5 py-3">
              <span className="text-[13px] text-ink-muted">{row.desc}</span>
              <kbd className="rounded-[5px] border border-line bg-raised px-2.5 py-1 font-mono text-[11px] font-semibold text-ink-strong">
                {row.keys}
              </kbd>
            </div>
          ))}
        </div>
      </section>

      {/* ── 底部链接 ── */}
      <div className="flex items-center justify-between rounded-[10px] border border-line px-4 py-3">
        <span className="text-[12px] text-ink-faint">
          遇到问题或有想法？欢迎在 GitHub 提 Issue
        </span>
        <button
          type="button"
          onClick={() => window.open(`${GITHUB_URL}/issues`, '_blank')}
          className="pressable flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-semibold text-accent hover:bg-accent/10"
        >
          <GithubLogo size={13} weight="bold" aria-hidden />
          提交 Issue
          <ArrowSquareOut size={11} aria-hidden />
        </button>
      </div>

    </div>
  )
}
