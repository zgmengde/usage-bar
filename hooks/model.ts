// 纯函数：解析配置、算颜色、格式化、排版。不碰 $，方便单测。

export type Lang = 'en' | 'zh'
export type Layout = 'auto' | 'one-line' | 'two-lines'
export type BarStyle = 'dither' | 'solid' | 'none'
export type ColorMode = 'by-percent' | 'threshold' | 'mono'
export type IconName = 'clock' | 'calendar' | 'flame' | 'flake' | 'layers' | 'coin' | 'limit' | 'bolt' | 'hourglass' | 'target' | 'cross'

export type Config = {
  showFiveHour: boolean
  showWeekly: boolean
  showCache: boolean
  showOtherLimits: boolean
  showContext: boolean
  showCost: boolean
  showReset: boolean
  showSpeed: boolean
  showFirstToken: boolean
  showCacheHit: boolean
  showFailures: boolean
  conditionalThreshold: number
  layout: Layout
  bar: BarStyle
  color: ColorMode
  stops: ColorStop[]
  icons: boolean
  cacheTtlMs: number
  notifyAt: number[]
  language: 'auto' | Lang
}

export type ColorStop = { at: number; hex: string }

// 状态栏里的一项。percent 为空时不画进度条。
// group 决定排在哪一行：usage 是额度类，perf 是请求性能类
export type Item = {
  key: string
  group: 'usage' | 'perf'
  icon: IconName
  label: string
  percent: number | null
  value: string
  detail: string
  // 覆盖按百分比算出的颜色，例如缓存变冷时用蓝色；图标、进度条和数值都用它
  color?: string
  // 只给数值上色，图标保持灰色：第二行按阈值分好、中、差三档
  valueColor?: string
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// 本会话的请求性能。速度和首字按 dsh（DeepSeek Harness，github.com/deepseek-ai/deepseek-harness）
// 的 session-stats 口径累计主线程请求：
// 速度 = Σ 输出 token ÷ Σ（结束 − 首 token），首字 = Σ（首 token − 开始）÷ 步数。
// 命中率取主线程最近一次请求，失败次数累计全部请求（含子代理）
export type Perf = {
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  hitPercent: number | null
  // 这次写缓存比读缓存多：会话第一次请求或缓存过期后都会这样，属于正常情况
  hitWrite: boolean
  failures: number
}

export type Snapshot = {
  now: number
  isWorking: boolean
  limits: Limit[]
  contextPercent: number | null
  costUsd: number | null
  lastTurnAt: number | null
  // 本会话还没发过请求时为空，这时整行性能项都不画
  perf: Perf | null
}

export type StepUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// 一次模型请求测到的数据
export type Step = {
  isMain: boolean
  failed: boolean
  // 请求发出到第一个数据块（模型开始回应）的毫秒数；什么都没收到时为空
  firstTokenMs: number | null
  // 第一个数据块到请求结束的毫秒数。输出 token 含看不到的思考，所以按整段生成时长算速度
  streamMs: number | null
  usage: StepUsage | null
}

export function nextPerf(prev: Perf | null, step: Step): Perf {
  const base: Perf = prev ?? { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, hitPercent: null, hitWrite: false, failures: 0 }
  const out: Perf = { ...base, failures: base.failures + (step.failed ? 1 : 0) }
  // 子代理在后台跑，它的延迟不影响你等多久，所以只记它的失败
  if (!step.isMain || step.failed) return out
  const u = step.usage
  // 和 dsh 一样：有首 token 才计首字；再有用量才计解码时长和 token。单次异常靠累计摊平，不另设阈值
  if (step.firstTokenMs !== null) {
    out.ttftMs += step.firstTokenMs
    out.ttftSteps += 1
    if (u && step.streamMs !== null) {
      out.decodeMs += step.streamMs
      out.decodeTokens += u.output_tokens
    }
  }
  if (u) {
    // input_tokens 只算没走缓存的部分，所以分母要把三项加起来
    const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    // 既没读也没写缓存：多半是不支持 prompt cache 的网关，显示成 —，别当成 0% 报警
    if (u.cache_read_input_tokens + u.cache_creation_input_tokens === 0) {
      out.hitPercent = null
      out.hitWrite = false
    } else if (total > 0) {
      out.hitPercent = (u.cache_read_input_tokens / total) * 100
      out.hitWrite = u.cache_creation_input_tokens > u.cache_read_input_tokens
    }
  }
  return out
}

export const DEFAULT_STOPS = '0:#46a758,60:#d97757,100:#e5484d'

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d)
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d

export function parseStops(text: unknown): ColorStop[] {
  const parse = (s: string) =>
    s
      .split(',')
      .map(p => p.trim().match(/^(\d{1,3})\s*:\s*(#[0-9a-fA-F]{6})$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => ({ at: Math.min(100, Number(m[1])), hex: (m[2] ?? '').toLowerCase() }))
      .sort((a, b) => a.at - b.at)
  const stops = typeof text === 'string' ? parse(text) : []
  return stops.length >= 2 ? stops : parse(DEFAULT_STOPS)
}

export function parseNotifyAt(text: unknown): number[] {
  if (typeof text !== 'string') return [80, 95]
  return [...new Set(text.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0 && n <= 100))].sort(
    (a, b) => b - a,
  )
}

export function parseConfig(o: Record<string, unknown>): Config {
  const raw = o.conditional_threshold
  const threshold = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN
  return {
    showFiveHour: bool(o.show_five_hour, true),
    showWeekly: bool(o.show_weekly, true),
    showCache: bool(o.show_cache, true),
    showOtherLimits: bool(o.show_other_limits, true),
    showContext: bool(o.show_context, false),
    showCost: bool(o.show_cost, false),
    showReset: bool(o.show_reset, true),
    showSpeed: bool(o.show_speed, true),
    showFirstToken: bool(o.show_first_token, true),
    showCacheHit: bool(o.show_cache_hit, true),
    showFailures: bool(o.show_failures, true),
    conditionalThreshold: Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 50,
    layout: pick(o.layout, ['auto', 'one-line', 'two-lines'] as const, 'auto'),
    bar: pick(o.bar, ['dither', 'solid', 'none'] as const, 'dither'),
    color: pick(o.color, ['by-percent', 'threshold', 'mono'] as const, 'by-percent'),
    stops: parseStops(o.color_stops),
    icons: pick(o.icons, ['on', 'off'] as const, 'on') === 'on',
    cacheTtlMs: pick(o.cache_ttl, ['1h', '5m'] as const, '1h') === '5m' ? 5 * 60_000 : 60 * 60_000,
    notifyAt: parseNotifyAt(o.notify_at),
    language: pick(o.language, ['auto', 'en', 'zh'] as const, 'auto'),
  }
}

export function resolveLang(setting: Config['language'], envLang: string | undefined): Lang {
  if (setting !== 'auto') return setting
  return /^zh/i.test(envLang ?? '') ? 'zh' : 'en'
}

const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    five_hour: '5h', seven_day: 'Week', spend_limit: 'Extra', cache: 'Cache', context: 'Context', cost: 'Cost', cold: 'Cold', live: 'Live',
    speed: 'Speed', first_token: 'TTFT', cache_hit: 'Cache hit', failures: 'Failed', write: 'Write',
  },
  zh: {
    five_hour: '5h', seven_day: '周', spend_limit: '超额', cache: '缓存', context: '上下文', cost: '费用', cold: '已冷', live: '活跃',
    speed: '速度', first_token: '首字', cache_hit: '命中', failures: '失败', write: '写入',
  },
}

// 英文标签首字母大写（Context、Cache hit），和桌面版界面文字一致；表里没有的额度类型按同样规则显示
export const label = (lang: Lang, key: string) => {
  const raw = key.replace(/_/g, ' ')
  return LABELS[lang][key] ?? raw.charAt(0).toUpperCase() + raw.slice(1)
}

// ---- 颜色：按色相在锚点之间插值，中间经过黄色，不会发灰 ----

type Hsl = [number, number, number]

function hexToHsl(hex: string): Hsl {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
  return [h, s, l]
}

function hslToHex([h, s, l]: Hsl): string {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
}

// 两个色相之间走较短的那一圈，所以 14°（Claude 橙）到 358°（红）不会绕过绿和蓝
function lerpHue(a: number, b: number, t: number) {
  let d = b - a
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return a + d * t
}

// stops 至少有两个锚点：parseStops 保证了这一点
export function blend(stops: ColorStop[], percent: number): string {
  const p = Math.max(0, Math.min(100, percent))
  const first = stops[0]!
  if (p <= first.at) return first.hex
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!
    const b = stops[i]!
    if (p <= b.at) {
      const t = b.at === a.at ? 1 : (p - a.at) / (b.at - a.at)
      const [ha, sa, la] = hexToHsl(a.hex)
      const [hb, sb, lb] = hexToHsl(b.hex)
      return hslToHex([lerpHue(ha, hb, t), sa + (sb - sa) * t, la + (lb - la) * t])
    }
  }
  return stops[stops.length - 1]!.hex
}

export const MONO = '#5b8def'
export const COLD = '#6cb6ff'

export type Level = 'good' | 'warn' | 'bad'

// 三档颜色取锚点的头、中、尾，默认是绿、Claude 橙、红；mono 模式下都用同一个颜色
export function levelColor(cfg: Config, level: Level): string {
  if (cfg.color === 'mono') return MONO
  const stops = cfg.stops
  if (level === 'good') return stops[0]!.hex
  if (level === 'bad') return stops[stops.length - 1]!.hex
  return stops.length > 2 ? stops[Math.floor(stops.length / 2)]!.hex : blend(stops, 50)
}

// 第二行的阈值（按显示出来的数判断，免得显示 90 却是橙色）：
// 速度 ≥90 好、70–89 中、<70 差；首字 <3s 好、3–5s 中、>5s 差；命中 ≥90% 好、85%–90% 中（不含 90）、<85% 差
export const speedLevel = (tps: number): Level => (tps >= 90 ? 'good' : tps >= 70 ? 'warn' : 'bad')
export const firstTokenLevel = (s: number): Level => (s < 3 ? 'good' : s <= 5 ? 'warn' : 'bad')
export const hitLevel = (percent: number): Level => (percent >= 90 ? 'good' : percent >= 85 ? 'warn' : 'bad')
// 缓存倒计时按剩余占 TTL 的比例：≥50% 好、10%–50% 中、<10% 差，1h 和 5m 两种 TTL 都适用
export const cacheLevel = (leftRatio: number): Level => (leftRatio >= 0.5 ? 'good' : leftRatio >= 0.1 ? 'warn' : 'bad')

export function colorFor(cfg: Config, percent: number): string {
  if (cfg.color === 'mono') return MONO
  if (cfg.color === 'threshold') {
    const first = cfg.stops[0]!.hex
    const last = cfg.stops[cfg.stops.length - 1]!.hex
    const middle = cfg.stops.length > 2 ? cfg.stops[Math.floor(cfg.stops.length / 2)]!.hex : blend(cfg.stops, 50)
    return percent >= 95 ? last : percent >= 80 ? middle : first
  }
  return blend(cfg.stops, percent)
}

// ---- 格式化 ----

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`
}

const pct = (n: number) => `${Math.round(n)}%`
const DASH = '—'

// 命中率的显示，照 dsh 的 formatCacheHitPercent：先四舍五入到整数；
// 没全中却会进位成 100 时，逐位加小数，直到和 100 区分开（99.5、99.96）
export function hitText(percent: number): string {
  if (percent >= 100) return '100%'
  const whole = Math.round(percent)
  if (whole < 100) return `${whole}%`
  for (let places = 1; places <= 6; places++) {
    const scale = 10 ** places
    const rounded = Math.round(percent * scale) / scale
    if (rounded < 100) return `${rounded.toFixed(places)}%`
  }
  return '99.999999%'
}

// ---- 从快照算出要画的项，顺序固定 ----

export function buildItems(cfg: Config, lang: Lang, s: Snapshot): Item[] {
  const items: Item[] = []
  const limitItem = (l: Limit, icon: IconName): Item => {
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    // 窗口已经重置、但还没收到新的响应：按 0% 显示，别让旧数字吓人
    const used = Number.isFinite(resetsAt) && resetsAt <= s.now ? 0 : l.percentUsed
    return {
      key: l.kind,
      icon,
      label: label(lang, l.kind),
      percent: used,
      value: pct(used),
      detail: cfg.showReset && Number.isFinite(resetsAt) && resetsAt > s.now ? duration(resetsAt - s.now) : '',
      group: 'usage',
    }
  }

  // 上下文放第一列；第一行第 4 列是缓存，第二行第 4 列是命中，上下对齐
  if (cfg.showContext && s.contextPercent !== null) {
    items.push({ key: 'context', icon: 'layers', label: label(lang, 'context'), percent: s.contextPercent, value: pct(s.contextPercent), detail: '', group: 'usage' })
  }
  const five = s.limits.find(l => l.kind === 'five_hour')
  if (cfg.showFiveHour && five) items.push(limitItem(five, 'clock'))
  const week = s.limits.find(l => l.kind === 'seven_day')
  if (cfg.showWeekly && week) items.push(limitItem(week, 'calendar'))

  // 新会话第一轮还没结束时也算活跃：请求已经在读写缓存，只是还没有计时起点
  if (cfg.showCache && (s.isWorking || s.lastTurnAt !== null)) {
    const left = s.lastTurnAt === null ? 0 : cfg.cacheTtlMs - (s.now - s.lastTurnAt)
    if (s.isWorking)
      items.push({ key: 'cache', icon: 'flame', label: label(lang, 'cache'), percent: null, value: label(lang, 'live'), detail: '', valueColor: levelColor(cfg, 'good'), group: 'usage' })
    else if (left <= 0)
      items.push({ key: 'cache', icon: 'flake', label: label(lang, 'cache'), percent: null, value: label(lang, 'cold'), detail: '', color: COLD, group: 'usage' })
    else {
      const valueColor = levelColor(cfg, cacheLevel(left / cfg.cacheTtlMs))
      items.push({ key: 'cache', icon: 'flame', label: label(lang, 'cache'), percent: null, value: duration(left), detail: '', valueColor, group: 'usage' })
    }
  }

  if (cfg.showOtherLimits) {
    for (const l of s.limits) {
      if (l.kind === 'five_hour' || l.kind === 'seven_day') continue
      if (l.percentUsed >= cfg.conditionalThreshold) items.push(limitItem(l, 'limit'))
    }
  }

  if (cfg.showCost && s.costUsd !== null) {
    items.push({ key: 'cost', icon: 'coin', label: label(lang, 'cost'), percent: null, value: `$${s.costUsd.toFixed(2)}`, detail: '', group: 'usage' })
  }

  const p = s.perf
  if (p) {
    const perf = (key: string, icon: IconName, value: string, level: Level | null, detail = ''): Item => ({
      key, icon, label: label(lang, key), percent: null, value, detail, group: 'perf',
      ...(level ? { valueColor: levelColor(cfg, level) } : {}),
    })
    if (cfg.showSpeed) {
      const tps = p.decodeMs > 0 ? Math.round(p.decodeTokens / (p.decodeMs / 1000)) : null
      items.push(perf('speed', 'bolt', tps === null ? DASH : `${tps} tok/s`, tps === null ? null : speedLevel(tps)))
    }
    if (cfg.showFirstToken) {
      const secs = p.ttftSteps > 0 ? Math.round(p.ttftMs / p.ttftSteps / 100) / 10 : null
      items.push(perf('first_token', 'hourglass', secs === null ? DASH : `${secs.toFixed(1)}s`, secs === null ? null : firstTokenLevel(secs)))
    }
    // 为 0 时也显示，第二行才能和第一行对齐；大于 0 就标红
    if (cfg.showFailures) items.push(perf('failures', 'cross', String(p.failures), p.failures > 0 ? 'bad' : 'good'))
    if (cfg.showCacheHit) {
      const hit = p.hitPercent
      // 写缓存为主时另外标出“写入”，颜色照样按命中率分档；和速度、首字一样按显示出来的数分档
      const text = hit === null ? DASH : hitText(hit)
      const level = hit === null ? null : hitLevel(Number.parseFloat(text))
      items.push(perf('cache_hit', 'target', text, level, p.hitWrite ? label(lang, 'write') : ''))
    }
  }
  return items
}

// ---- 排版：估算宽度，一行放不下时拆成两行 ----

// 文字宽度估算。桌面版用 Chromium 画 SVG，字体是 -apple-system（中文落到苹方）；
// 下面两张表是在 Chrome 里实测的 ASCII 字符宽度（单位 em，从空格到 ~），常规体和半粗体各一张。
// 中日文和全角符号按 1em，其余字符按 0.6em
const ASCII_400 = [0.33,0.33,0.43,0.6,0.6,0.97,0.73,0.24,0.33,0.33,0.51,0.61,0.26,0.61,0.26,0.5,0.6,0.4,0.6,0.6,0.6,0.6,0.6,0.55,0.6,0.6,0.26,0.26,0.61,0.61,0.61,0.54,0.86,0.66,0.68,0.73,0.71,0.64,0.58,0.75,0.72,0.24,0.52,0.69,0.59,0.88,0.72,0.77,0.64,0.77,0.68,0.63,0.62,0.71,0.64,0.93,0.64,0.66,0.62,0.33,0.5,0.33,0.52,0.5,0.33,0.56,0.59,0.55,0.59,0.56,0.37,0.59,0.56,0.26,0.27,0.53,0.24,0.86,0.56,0.59,0.59,0.59,0.37,0.51,0.36,0.56,0.48,0.76,0.51,0.5,0.49,0.33,0.2,0.33,0.5]
const ASCII_600 = [0.33,0.33,0.49,0.6,0.6,1,0.75,0.28,0.33,0.33,0.52,0.61,0.28,0.61,0.28,0.5,0.6,0.41,0.6,0.6,0.6,0.6,0.6,0.55,0.6,0.6,0.28,0.28,0.61,0.61,0.61,0.56,0.87,0.68,0.69,0.73,0.72,0.64,0.58,0.76,0.74,0.26,0.54,0.71,0.59,0.9,0.73,0.78,0.66,0.78,0.7,0.65,0.62,0.73,0.66,0.95,0.66,0.69,0.64,0.33,0.5,0.33,0.55,0.5,0.33,0.57,0.6,0.56,0.6,0.57,0.38,0.6,0.58,0.28,0.28,0.55,0.25,0.88,0.58,0.6,0.6,0.6,0.37,0.53,0.36,0.58,0.51,0.78,0.54,0.53,0.51,0.33,0.21,0.33,0.5]

export function textWidth(text: string, size = 13, weight: 400 | 600 = 400): number {
  const table = weight === 600 ? ASCII_600 : ASCII_400
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 32 && code < 127) w += table[code - 32]!
    else if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) w += 1
    else w += 0.6
  }
  return Math.ceil(w * size)
}

export const ICON_W = 20
export const GAP = 22
// 进度条短一点，空槽不会喧宾夺主
export const BAR_MAX = 80
export const BAR_MIN = 40

// 一项除进度条之外的宽度
export function fixedWidth(item: Item, cfg: Config): number {
  return (cfg.icons ? ICON_W : 0) + textWidth(item.label) + 6 + textWidth(item.value, 13, 600) + (item.detail ? 8 + textWidth(item.detail, 12) : 0)
}

const hasBar = (item: Item, cfg: Config) => cfg.bar !== 'none' && item.percent !== null

export function rowWidth(items: Item[], cfg: Config, barW: number): number {
  return items.reduce((w, it, i) => w + (i > 0 ? GAP : 0) + fixedWidth(it, cfg) + (hasBar(it, cfg) ? barW + 8 : 0), 0)
}

// 给定可用宽度，求这一行能用的进度条宽度；放不下返回 null
export function fitBar(items: Item[], cfg: Config, avail: number): number | null {
  const bars = items.filter(it => hasBar(it, cfg)).length
  // barW 为 0 时，rowWidth 已经算进每根进度条两侧的 8px 间距
  const fixed = rowWidth(items, cfg, 0)
  if (bars === 0) return fixed <= avail ? 0 : null
  const per = Math.floor((avail - fixed) / bars)
  if (per < BAR_MIN) return null
  return Math.min(BAR_MAX, per)
}

// slots[i] 是第 i 项至少占的宽度，用来让两行的列对齐；没有时按内容紧排
export type Row = { items: Item[]; barW: number; slots?: number[] }

export function itemWidth(item: Item, cfg: Config, barW: number): number {
  return fixedWidth(item, cfg) + (hasBar(item, cfg) ? barW + 8 : 0)
}

// 把 items 按原顺序切成 k 行，让最宽的那行尽量窄（项数很少，直接递归枚举）
function balance(items: Item[], cfg: Config, k: number): Item[][] {
  if (k <= 1 || items.length <= 1) return [items]
  let best: Item[][] = [items]
  let bestW = Infinity
  for (let cut = 1; cut <= items.length - k + 1; cut++) {
    const rest = balance(items.slice(cut), cfg, k - 1)
    const rows = [items.slice(0, cut), ...rest]
    const w = Math.max(...rows.map(r => rowWidth(r, cfg, BAR_MIN)))
    if (w < bestW) {
      bestW = w
      best = rows
    }
  }
  return best
}

// 每行进度条都取最短时，按顺序装箱需要几行
function rowsNeeded(items: Item[], cfg: Config, avail: number): number {
  let rows = 1
  let line: Item[] = []
  for (const it of items) {
    if (line.length > 0 && rowWidth([...line, it], cfg, BAR_MIN) > avail) {
      rows++
      line = []
    }
    line.push(it)
  }
  return rows
}

function wrap(items: Item[], cfg: Config, avail: number, min: number): Row[] {
  const one = (list: Item[]): Row => ({ items: list, barW: fitBar(list, cfg, avail) ?? BAR_MIN })
  const k = Math.max(Math.min(min, items.length), rowsNeeded(items, cfg, avail))
  return balance(items, cfg, k).map(one)
}

// 两行逐列取较宽的一项作为这一列的宽度。对齐后放不下时先把进度条缩短，
// 缩到最短仍放不下才不对齐；否则窗口稍窄一点，整行就会在对齐和紧排之间来回跳
function align(rows: [Row, Row], cfg: Config, avail: number): Row[] {
  // 没有进度条的行 barW 是 0，不能参与取最小值
  const withBars = rows.filter(r => r.items.some(it => hasBar(it, cfg)))
  const start = withBars.length > 0 ? Math.min(...withBars.map(r => r.barW)) : 0
  const cols = Math.min(rows[0].items.length, rows[1].items.length)
  for (let barW = start; barW >= Math.min(start, BAR_MIN); barW--) {
    const slots = Array.from({ length: cols }, (_, i) =>
      Math.max(itemWidth(rows[0].items[i]!, cfg, barW), itemWidth(rows[1].items[i]!, cfg, barW)),
    )
    const width = (r: Row) =>
      r.items.reduce((w, it, i) => w + (i > 0 ? GAP : 0) + (i < cols ? slots[i]! : itemWidth(it, cfg, barW)), 0)
    if (rows.every(r => width(r) <= avail)) return rows.map(r => ({ ...r, barW, slots }))
  }
  return rows
}

export function layoutRows(items: Item[], cfg: Config, avail: number): Row[] {
  if (items.length === 0) return []
  if (cfg.layout === 'one-line') return [{ items, barW: fitBar(items, cfg, avail) ?? BAR_MIN }]
  const usage = items.filter(it => it.group === 'usage')
  const perf = items.filter(it => it.group === 'perf')
  // 只有一组时按原来的规则换行
  if (usage.length === 0 || perf.length === 0) return wrap(items, cfg, avail, cfg.layout === 'two-lines' ? 2 : 1)
  // 两组各占一行：额度在上，性能在下；某一组一行放不下时，这一组自己再拆
  const rows = [...wrap(usage, cfg, avail, 1), ...wrap(perf, cfg, avail, 1)]
  return rows.length === 2 ? align(rows as [Row, Row], cfg, avail) : rows
}

// 进度条点阵用的确定性噪声，同一位置每次画出来一样
export function noise(c: number, r: number): number {
  const x = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453
  return x - Math.floor(x)
}
