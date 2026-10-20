// usage-bar：在桌面版输入框上方横条的最后一行画额度、缓存等状态。
// 目前只支持桌面版：终端等其他界面不画横条，也不发额度提醒。
// 只读会话自己的用量数据，不联网、不跑命令。$.store 里只存 4 样：提醒过的额度、
// 最近一次的额度、每个会话最近一轮的结束时间、每个会话的请求性能，
// 后三样用来在重启后先显示上次的值。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnStepChunk, TurnStepResult } from 'claude-code'

import { buildItems, layoutRows, nextPerf, parseConfig, resolveLang } from './model'
import type { Config, Lang, Perf, Snapshot, Step } from './model'
import { ROW_H, rowAlt, rowSvg } from './svg'

const lastTurnAt = atom({ plugin: 'usage-bar', key: 'lastTurnAt' } as const, null)
const tick = atom({ plugin: 'usage-bar', key: 'tick' } as const, 0)
const perfAtom = atom({ plugin: 'usage-bar', key: 'perf' } as const, null)

const WARNED_KEY = 'warned'
const LIMITS_KEY = 'limits'
const TURNS_KEY = 'turns'
const PERF_KEY = 'perf'
// 每个会话一条，只留最近的这么多条
const TURNS_KEEP = 20

// 桌面版每个 bodyColumns 约 8 CSS px
const PX_PER_COLUMN = 8

// 热重载和改配置都会重跑 register，但不会再触发 session.start，
// 所以计时器、语言和压缩窗口放在这里，由每个钩子按需准备
type Runtime = {
  cfg: Config
  lang: Lang | null
  minute: Timer | null
  expiry: Timer | null
  // 性能数据延迟写进 $.store 的计时器
  persist: Timer | null
  compact: { model: string; tokens: number } | null
  // 横条在桌面版画过：只支持桌面版，提醒也只在这之后发
  onDesktop: boolean
}

const bump = ($: EngineInterface) => void update($, tick, n => n + 1).catch(() => undefined)

// 自动压缩的触发点（/context 的 rawMaxTokens）。它可能比模型窗口小，
// 例如 settings 里设了 autoCompactWindow；按模型缓存，换模型时重新取
async function compactWindow($: EngineInterface, rt: Runtime): Promise<number | null> {
  const model = await $.session.model()
  if (rt.compact?.model === model) return rt.compact.tokens
  const usage = await $.session.usage({ breakdown: 'summary' })
  const tokens = usage.context.breakdown?.rawMaxTokens ?? null
  // 会话还没绑定时拿不到，下次再取
  if (tokens) rt.compact = { model, tokens }
  return tokens
}

type Limits = Snapshot['limits']
type Turns = Record<string, number>

const isLimits = (v: unknown): v is Limits =>
  Array.isArray(v) && v.every(l => l && typeof l.kind === 'string' && typeof l.percentUsed === 'number')

const asTurns = (v: unknown): Turns =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((kv): kv is [string, number] => typeof kv[1] === 'number'))
    : {}

// 额度只跟着模型响应来，新进程第一次响应之前是空的；这时先用上次存下的值。
// 额度是整个账号的，所以不分会话
async function savedLimits($: EngineInterface): Promise<Limits> {
  const stored = (await $.store.get(LIMITS_KEY).catch(() => null)) as { limits?: unknown } | null
  return isLimits(stored?.limits) ? stored.limits : []
}

async function saveLimits($: EngineInterface, limits: Limits) {
  if (limits.length > 0) await $.store.set(LIMITS_KEY, { limits })
}

// $.state 在进程重启后就没了，最近一轮的结束时间另存一份，按会话分开
async function savedTurn($: EngineInterface): Promise<number | null> {
  const id = await $.session.id()
  return asTurns(await $.store.get(TURNS_KEY).catch(() => null))[id] ?? null
}

async function saveTurn($: EngineInterface, sessionId: string, at: number | null) {
  const turns = asTurns(await $.store.get(TURNS_KEY).catch(() => null))
  delete turns[sessionId]
  if (at !== null) turns[sessionId] = at
  const kept = Object.entries(turns).sort((a, b) => b[1] - a[1]).slice(0, TURNS_KEEP)
  await $.store.set(TURNS_KEY, Object.fromEntries(kept))
}

type PerfEntry = { at: number; perf: Perf }
type PerfMap = Record<string, PerfEntry>

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown) => v === null || num(v)
const nonNeg = (v: unknown) => num(v) && (v as number) >= 0
const isPerf = (v: unknown): v is Perf => {
  const p = v as Perf | null
  return !!p && typeof p === 'object' && nonNeg(p.ttftMs) && nonNeg(p.ttftSteps) && nonNeg(p.decodeMs) && nonNeg(p.decodeTokens) &&
    (p.hitPercent === null || (nonNeg(p.hitPercent) && p.hitPercent <= 100)) && typeof p.hitWrite === 'boolean' && nonNeg(p.failures)
}
const asPerfMap = (v: unknown): PerfMap =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, PerfEntry>).filter(([, e]) => e && typeof e === 'object' && num(e.at) && isPerf(e.perf)),
      )
    : {}

async function savedPerf($: EngineInterface): Promise<Perf | null> {
  const id = await $.session.id()
  return asPerfMap(await $.store.get(PERF_KEY).catch(() => null))[id]?.perf ?? null
}

async function savePerf($: EngineInterface, sessionId: string, perf: Perf | null) {
  const map = asPerfMap(await $.store.get(PERF_KEY).catch(() => null))
  delete map[sessionId]
  if (perf) map[sessionId] = { at: await $.clock.now(), perf }
  const kept = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, TURNS_KEEP)
  await $.store.set(PERF_KEY, Object.fromEntries(kept))
}

async function flushPerf($: EngineInterface) {
  const perf = await read($, perfAtom)
  if (perf) await savePerf($, await $.session.id(), perf)
}

// 一次请求结束后并进本会话的性能数据。写 $.store 交给 1 秒后的计时器：
// 不拖慢这次请求，几个子代理同时结束时也只写一次最新值
async function recordStep($: EngineInterface, rt: Runtime, step: Step) {
  // reload 后 $.state 还在，里面可能是旧版本的格式，不合格的当成没有
  const live = await read($, perfAtom)
  const saved = isPerf(live) ? null : await savedPerf($).catch(() => null)
  await update($, perfAtom, prev => nextPerf(isPerf(prev) ? prev : saved, step))
  rt.persist?.cancel()
  rt.persist = $.clock.after(1_000, () => void flushPerf($).catch(() => undefined))
}

async function snapshot($: EngineInterface, rt: Runtime, isWorking: boolean): Promise<Snapshot> {
  const [usage, now, live, livePerf] = await Promise.all([$.session.usage(), $.clock.now(), read($, lastTurnAt), read($, perfAtom)])
  const last = live ?? (await savedTurn($).catch(() => null))
  const liveLimits: Limits = usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  const limits = liveLimits.length > 0 ? liveLimits : await savedLimits($)
  // 上下文占比按自动压缩的触发点算，和 /context 一致；拿不到时退回按模型窗口算
  let contextPercent = usage.context.percent ?? null
  if (rt.cfg.showContext && usage.context.tokens !== undefined) {
    const max = await compactWindow($, rt).catch(() => null)
    if (max) contextPercent = Math.min(100, Math.round((usage.context.tokens / max) * 100))
  }
  return {
    now,
    isWorking,
    limits,
    contextPercent,
    costUsd: usage.cost?.usd ?? null,
    lastTurnAt: last,
    perf: isPerf(livePerf) ? livePerf : await savedPerf($).catch(() => null),
  }
}

const NOTIFY_NAME: Record<Lang, Record<string, string>> = {
  en: { five_hour: '5-hour', seven_day: 'Weekly' },
  zh: { five_hour: '5 小时', seven_day: '每周' },
}
const NOTIFY_TEXT: Record<Lang, (name: string, percent: number) => string> = {
  en: (name, percent) => `${name} limit at ${percent}%`,
  zh: (name, percent) => `${name}额度已用 ${percent}%`,
}

async function notifyLimits($: EngineInterface, cfg: Config, lang: Lang, limits: Snapshot['limits']) {
  if (cfg.notifyAt.length === 0) return
  const stored = await $.store.get(WARNED_KEY)
  const seen = Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []
  const due: { key: string; text: string }[] = []
  for (const l of limits) {
    if (l.kind !== 'five_hour' && l.kind !== 'seven_day') continue
    const at = cfg.notifyAt.find(t => l.percentUsed >= t)
    if (at === undefined) continue
    // 同一个窗口、同一个阈值只提醒一次。重置时间按 5 分钟取整，
    // 免得同一窗口里时间戳的细微抖动被当成新窗口；窗口重置后会重新提醒
    const resetsAt = l.resetsAt ? Math.round(Date.parse(l.resetsAt) / 300_000) : 'none'
    const key = `${l.kind}@${at}@${resetsAt}`
    if (seen.includes(key)) continue
    due.push({ key, text: NOTIFY_TEXT[lang](NOTIFY_NAME[lang][l.kind] ?? l.kind, Math.round(l.percentUsed)) })
  }
  if (due.length === 0) return
  // 先记下再发，两个会话同时测到时少发一次重复提醒
  await $.store.set(WARNED_KEY, [...seen, ...due.map(d => d.key)].slice(-50))
  for (const d of due) {
    const sent = await $.ui.notify(d.text, { title: 'usage-bar' }).catch(() => null)
    // 用户关掉了通知就不打扰；桌面版没有系统通知通道，改用停留久一点的 toast
    if (sent && !sent.isSent && sent.reason !== 'disabled') $.ui.toast(d.text, { timeoutMs: 15_000 })
  }
}


async function resolveLangOnce($: EngineInterface, rt: Runtime): Promise<Lang> {
  if (!rt.lang) rt.lang = resolveLang(rt.cfg.language, (await $.env.get('LC_ALL')) || (await $.env.get('LANG')))
  return rt.lang
}

async function ensure($: EngineInterface, rt: Runtime): Promise<Lang> {
  // 倒计时按分钟走，所以每分钟让横条重画一次
  if (!rt.minute) rt.minute = $.clock.every(60_000, () => bump($))
  return resolveLangOnce($, rt)
}

// 到期那一刻再重画一次，不用等下一分钟才变成“已冷”
function scheduleExpiry($: EngineInterface, rt: Runtime) {
  rt.expiry?.cancel()
  rt.expiry = $.clock.after(rt.cfg.cacheTtlMs + 1_000, () => bump($))
}

function stop(rt: Runtime) {
  rt.minute?.cancel()
  rt.expiry?.cancel()
  rt.minute = null
  rt.expiry = null
}

export const register: Register = (on, options) => {
  const cfg = parseConfig(options as Record<string, unknown>)
  const rt: Runtime = { cfg, lang: cfg.language === 'auto' ? null : cfg.language, minute: null, expiry: null, persist: null, compact: null, onDesktop: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    stop(rt)
    // 无头运行没有输入框，用不着重画
    if (e.isInteractive) await ensure($, rt)
    return started
  })

  // 会话结束时清掉内存里的状态。只有 /clear 才删存下的记录：
  // 正常退出或 resume 后，下次打开同一会话还要显示这些值
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    stop(rt)
    await update($, lastTurnAt, () => null).catch(() => undefined)
    await update($, perfAtom, () => null).catch(() => undefined)
    if (e.reason === 'clear') {
      rt.persist?.cancel()
      await saveTurn($, e.sessionId, null).catch(() => undefined)
      await savePerf($, e.sessionId, null).catch(() => undefined)
    }
    return ended
  })

  // 主对话每轮结束时记下时间：缓存从这一刻开始计时。
  // 报错的轮次可能没有成功请求，不刷新缓存
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.reason !== 'error') {
      await ensure($, rt)
      const now = await $.clock.now()
      await update($, lastTurnAt, () => now)
      await saveTurn($, await $.session.id(), now).catch(() => undefined)
      scheduleExpiry($, rt)
    }
    return done
  })

  // 每次模型请求：记下首字时间和输出速度，结束后算命中率、数失败。
  // 数据块原样往下传，这个钩子只计时
  on('turn.step', async function* ($, e, next) {
    const started = await $.clock.now()
    let first: number | null = null
    const stream = next(e)
    // closed：引擎提前关掉了这个流，多半是用户打断
    const done = async (result: TurnStepResult | null, closed = false) => {
      const ended = await $.clock.now()
      // 用户按 Esc 打断的请求不算失败
      const failed = !closed && !next.signal.aborted && (result === null || result.stopReason === null)
      await recordStep($, rt, {
        isMain: !e.agentId,
        failed,
        firstTokenMs: first === null ? null : first - started,
        streamMs: first === null ? null : ended - first,
        usage: result?.usage ?? null,
      }).catch(() => undefined)
    }
    let finished = false
    try {
      // 手动迭代：最后一次 next() 的返回值就是这次请求的结果
      for (;;) {
        let r: IteratorResult<TurnStepChunk, TurnStepResult>
        try {
          r = await stream.next()
        } catch (err) {
          finished = true
          await done(null)
          throw err
        }
        if (r.done) {
          finished = true
          await done(r.value)
          return r.value
        }
        // 任何数据块都算，engine 块也算：思考内容不推给插件，但响应开头的信封会立刻到，
        // 只认可见内容的话，首字会把整段思考时间算进去，速度的分母又只剩最后一小段
        if (first === null) first = await $.clock.now().catch(() => null)
        yield r.value
      }
    } finally {
      // 引擎在 yield 处关掉了这个流：把关闭传给下层，这次请求只记首字
      if (!finished) {
        await stream.return(undefined as unknown as TurnStepResult).catch(() => undefined)
        await done(null, true)
      }
    }
  })

  // 额度变化时重画，并检查要不要发提醒
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    const current = await ensure($, rt)
    $.ui.invalidate('ui.render')
    await saveLimits($, e.rateLimits).catch(() => undefined)
    if (rt.onDesktop) await notifyLimits($, cfg, current, e.rateLimits).catch(() => undefined)
    return measured
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // 只支持桌面版，其他界面原样交给下一层
    if (e.surface !== 'desktop') return next(e)
    rt.onDesktop = true
    if (e.props.hasSurvey) return next(e)
    await read($, tick)
    const lang = await resolveLangOnce($, rt)

    const items = buildItems(cfg, lang, await snapshot($, rt, e.props.isWorking))
    if (items.length === 0) return next(e)

    // 先拿其他 mod 画的内容放在上面，自己排在最后一行，紧贴输入框。
    // Claude Code 自己的占位节点不能嵌套，桌面版会丢掉嵌套了它的横条。
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const above = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Svg: any }
    const { Box, Svg } = ui
    // 元素表里没有 Svg 的桌面版画不了，交回下一层
    if (!Svg) return next(e)
    const columns = e.props.bodyColumns || 100
    // 每列约 8px 是估算，再留出卡片内边距，避免撑破横条
    const width = Math.max(240, Math.min(1600, columns * PX_PER_COLUMN - 32))

    const rows = layoutRows(items, cfg, width)
    // 插件拿不到横条的真实像素宽度，估算的 width 只用来排版。画布只取内容宽度、
    // 不写 width，横条会把它居中，左右留白才一样；几行共用同一个内容宽度，列才对得上
    const content = Math.max(...rows.map(r => rowSvg(r, cfg).width))
    const ours = rows.map((row, i) => {
      const svg = rowSvg(row, cfg, content, content)
      return <Svg key={`row-${i}`} source={svg.source} alt={rowAlt(row)} height={ROW_H} />
    })

    return (
      <Box flexDirection="column">
        {above}
        {ours}
      </Box>
    )
  })
}
