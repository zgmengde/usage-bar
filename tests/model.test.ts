import { expect, test } from 'claude-code/testing'

import { BAR_MIN, blend, buildItems, cacheLevel, colorFor, duration, firstTokenLevel, hitLevel, hitText, layoutRows, levelColor, nextPerf, speedLevel, parseConfig, parseNotifyAt, parseStops, resolveLang, textWidth } from '../hooks/model'
import type { Perf, Snapshot, Step } from '../hooks/model'
import { rowSvg } from '../hooks/svg'

const NOW = Date.parse('2026-10-19T10:00:00Z')
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  isWorking: false,
  limits: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-19T12:05:00Z' },
    { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-22T14:00:00Z' },
  ],
  contextPercent: 30,
  costUsd: 1.234,
  lastTurnAt: NOW - 20 * 60_000,
  perf: null,
  ...over,
})

test('配置：缺省值和非法值都回到默认', () => {
  const cfg = parseConfig({ layout: 'weird', conditional_threshold: 'x', color_stops: 'bad' })
  expect(cfg.layout).toBe('auto')
  expect(cfg.conditionalThreshold).toBe(50)
  expect(cfg.stops).toHaveLength(3)
  expect(cfg.showContext).toBe(false)
  expect(cfg.cacheTtlMs).toBe(3_600_000)
})

test('锚点按位置排序，提醒阈值降序去重', () => {
  expect(parseStops('100:#ff0000,0:#00ff00').map(s => s.at)).toEqual([0, 100])
  expect(parseNotifyAt('80, 95,80,0,abc')).toEqual([95, 80])
})

test('语言：auto 按 LANG 判断', () => {
  expect(resolveLang('auto', 'zh_CN.UTF-8')).toBe('zh')
  expect(resolveLang('auto', 'en_US.UTF-8')).toBe('en')
  expect(resolveLang('zh', undefined)).toBe('zh')
})

test('颜色：两端是锚点色，中间按色相走、不发灰', () => {
  const stops = parseStops(undefined)
  expect(blend(stops, 0)).toBe('#46a758')
  expect(blend(stops, 60)).toBe('#d97757')
  expect(blend(stops, 100)).toBe('#e5484d')
  // 30% 处在绿和橙之间，应偏黄绿，红绿分量都高、蓝分量低
  const mid = blend(stops, 30)
  expect(parseInt(mid.slice(5, 7), 16)).toBeLessThan(0x80)
  const cfg = parseConfig({ color: 'threshold' })
  expect(colorFor(cfg, 50)).toBe('#46a758')
  expect(colorFor(cfg, 85)).toBe('#d97757')
  expect(colorFor(cfg, 99)).toBe('#e5484d')
  expect(colorFor(parseConfig({ color: 'mono' }), 99)).toBe('#5b8def')
})

test('时长格式', () => {
  expect(duration(41 * 60_000)).toBe('41m')
  expect(duration(125 * 60_000)).toBe('2h05m')
  expect(duration((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
  expect(duration(-5)).toBe('0m')
})

test('默认开关：5h、周、缓存，顺序固定', () => {
  const items = buildItems(parseConfig({}), 'en', snap())
  expect(items.map(i => i.key)).toEqual(['five_hour', 'seven_day', 'cache'])
  expect(items[0]?.detail).toBe('2h05m')
  expect(items[2]?.value).toBe('40m')
})

test('关掉的项不显示，打开的按需项会显示', () => {
  const cfg = parseConfig({ show_five_hour: false, show_cache: false, show_context: true, show_cost: true, show_reset: false })
  const items = buildItems(cfg, 'zh', snap())
  expect(items.map(i => i.key)).toEqual(['context', 'seven_day', 'cost'])
  expect(items[1]?.label).toBe('周')
  expect(items[0]?.detail).toBe('')
  expect(items[2]?.value).toBe('$1.23')
})

test('缓存：工作中显示活跃（含新会话第一轮），过期显示已冷，空闲且没跑过一轮就不显示', () => {
  const cfg = parseConfig({})
  expect(buildItems(cfg, 'zh', snap({ isWorking: true })).find(i => i.key === 'cache')?.value).toBe('活跃')
  const cold = buildItems(cfg, 'zh', snap({ lastTurnAt: NOW - 61 * 60_000 })).find(i => i.key === 'cache')
  expect(cold?.value).toBe('已冷')
  expect(cold?.icon).toBe('flake')
  expect(buildItems(cfg, 'en', snap({ lastTurnAt: null })).some(i => i.key === 'cache')).toBe(false)
  expect(buildItems(cfg, 'zh', snap({ lastTurnAt: null, isWorking: true })).find(i => i.key === 'cache')?.value).toBe('活跃')
  const short = parseConfig({ cache_ttl: '5m' })
  expect(buildItems(short, 'en', snap({ lastTurnAt: NOW - 2 * 60_000 })).find(i => i.key === 'cache')?.value).toBe('3m')
})

test('其他额度只在不小于阈值时显示', () => {
  const limits = [...snap().limits, { kind: 'spend_limit', percentUsed: 30 }]
  expect(buildItems(parseConfig({}), 'en', snap({ limits })).some(i => i.key === 'spend_limit')).toBe(false)
  const high = [...snap().limits, { kind: 'spend_limit', percentUsed: 70 }]
  expect(buildItems(parseConfig({}), 'en', snap({ limits: high })).some(i => i.key === 'spend_limit')).toBe(true)
})

test('排版：宽时一行，窄时两行，强制模式按设置', () => {
  const cfg = parseConfig({ show_context: true, show_cost: true })
  const items = buildItems(cfg, 'en', snap())
  expect(layoutRows(items, cfg, 1400)).toHaveLength(1)
  const narrow = layoutRows(items, cfg, 420)
  expect(narrow).toHaveLength(2)
  expect(narrow.flatMap(r => r.items).map(i => i.key)).toEqual(items.map(i => i.key))
  expect(layoutRows(items, parseConfig({ layout: 'one-line' }), 300)).toHaveLength(1)
  expect(layoutRows(items, parseConfig({ layout: 'two-lines' }), 2000)).toHaveLength(2)
  expect(layoutRows([], cfg, 800)).toEqual([])
})

test('阈值为空串时用默认值 50', () => {
  expect(parseConfig({ conditional_threshold: '' }).conditionalThreshold).toBe(50)
  expect(parseConfig({ conditional_threshold: 70 }).conditionalThreshold).toBe(70)
})

test('项很多、屏很窄时可以超过两行，每行都放得下', () => {
  const cfg = parseConfig({ show_context: true, show_cost: true, conditional_threshold: 0 })
  const limits = [...snap().limits, { kind: 'spend_limit', percentUsed: 70 }]
  const items = buildItems(cfg, 'en', snap({ limits }))
  expect(items).toHaveLength(6)
  const rows = layoutRows(items, cfg, 300)
  expect(rows.length).toBeGreaterThan(2)
  expect(rows.flatMap(r => r.items)).toHaveLength(6)
})

test('窗口已过期按 0%，重置时间非法时不显示倒计时', () => {
  const cfg = parseConfig({})
  const items = buildItems(cfg, 'en', snap({ limits: [
    { kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-19T09:00:00Z' },
    { kind: 'seven_day', percentUsed: 50, resetsAt: 'garbage' },
  ] }))
  expect(items[0]?.value).toBe('0%')
  expect(items[1]?.detail).toBe('')
})

// 两步合计：首字平均 1.2s，速度 684 ÷ 10s = 68 tok/s
const PERF: Perf = { ttftMs: 2400, ttftSteps: 2, decodeMs: 10_000, decodeTokens: 684, hitPercent: 97, hitWrite: false, failures: 0 }
const usage = (over: Partial<NonNullable<Step['usage']>> = {}) => ({
  input_tokens: 100, output_tokens: 600, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 900, ...over,
})
const step = (over: Partial<Step> = {}): Step => ({ isMain: true, failed: false, firstTokenMs: 800, streamMs: 10_000, usage: usage(), ...over })

test('性能：首字和速度累计，命中率取最近一次主线程请求', () => {
  const p = nextPerf(null, step())
  expect([p.ttftMs, p.ttftSteps, p.decodeMs, p.decodeTokens]).toEqual([800, 1, 10_000, 600])
  const q = nextPerf(p, step({ firstTokenMs: 1_600, streamMs: 5_000, usage: usage({ output_tokens: 900 }) }))
  expect([q.ttftMs, q.ttftSteps, q.decodeMs, q.decodeTokens]).toEqual([2_400, 2, 15_000, 1_500])
  const items = buildItems(parseConfig({}), 'en', snap({ perf: q }))
  expect(items.find(it => it.key === 'speed')?.value).toBe('100 tok/s')
  expect(items.find(it => it.key === 'first_token')?.value).toBe('1.2s')
  expect(p.hitPercent).toBe(90)
  expect(p.hitWrite).toBe(false)
  expect(p.failures).toBe(0)
})

test('性能：写缓存为主时标出写入', () => {
  const p = nextPerf(PERF, step({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 9_000 }) }))
  expect(p.hitPercent).toBe(0)
  expect(p.hitWrite).toBe(true)
})

test('性能：子代理只计失败，失败的请求不改其他项', () => {
  const sub = nextPerf(PERF, step({ isMain: false, firstTokenMs: 9_000, failed: true }))
  expect(sub.failures).toBe(1)
  expect(sub.ttftSteps).toBe(2)
  const failed = nextPerf(sub, step({ failed: true, usage: null, firstTokenMs: null }))
  expect(failed.failures).toBe(2)
  expect(failed.hitPercent).toBe(97)
})

test('性能项：第二行 4 项，失败为 0 也显示，没有数据时不画', () => {
  const cfg = parseConfig({})
  const items = buildItems(cfg, 'zh', snap({ perf: PERF }))
  const perf = items.filter(it => it.group === 'perf')
  expect(perf.map(it => `${it.label} ${it.value}`)).toEqual(['速度 68 tok/s', '首字 1.2s', '失败 0', '命中 97%'])
  // 图标不跟着变色
  expect(perf.every(it => it.color === undefined)).toBe(true)
  expect(buildItems(cfg, 'zh', snap()).some(it => it.group === 'perf')).toBe(false)
  const bad = buildItems(cfg, 'en', snap({ perf: { ...PERF, hitPercent: 40, failures: 2, decodeMs: 0, ttftSteps: 0 } }))
  expect(bad.find(it => it.key === 'speed')?.value).toBe('—')
  expect(bad.find(it => it.key === 'first_token')?.value).toBe('—')
  expect(bad.find(it => it.key === 'speed')?.valueColor).toBe(undefined)
  expect(bad.find(it => it.key === 'cache_hit')?.valueColor).toBe('#e5484d')
  expect(bad.find(it => it.key === 'failures')?.valueColor).toBe('#e5484d')
  const write = buildItems(cfg, 'en', snap({ perf: { ...PERF, hitPercent: 0, hitWrite: true } })).find(it => it.key === 'cache_hit')
  expect(write?.detail).toBe('Write')
  expect(write?.valueColor).toBe('#e5484d')
})

test('排版：额度一行、性能一行，列宽对齐', () => {
  const cfg = parseConfig({ show_context: true })
  const items = buildItems(cfg, 'zh', snap({ perf: PERF }))
  const rows = layoutRows(items, cfg, 1400)
  expect(rows).toHaveLength(2)
  expect(rows.map(r => r.items.map(it => it.group))).toEqual([Array(4).fill('usage'), Array(4).fill('perf')])
  expect(rows[0]!.slots).toEqual(rows[1]!.slots)
  // 第二行没有进度条，不能把第一行的进度条压成 0
  expect(rows[0]!.barW).toBeGreaterThanOrEqual(40)
  expect(rows[0]!.slots).toHaveLength(4)
  // one-line 仍然只画一行
  expect(layoutRows(items, { ...cfg, layout: 'one-line' }, 1400)).toHaveLength(1)
  // 太窄时每组自己再拆，不再对齐
  const narrow = layoutRows(items, cfg, 300)
  expect(narrow.length).toBeGreaterThan(2)
  expect(narrow.every(r => r.slots === undefined)).toBe(true)
})

test('性能：既没读也没写缓存时命中率显示为 —', () => {
  const p = nextPerf(PERF, step({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) }))
  expect(p.hitPercent).toBe(null)
  const item = buildItems(parseConfig({}), 'en', snap({ perf: p })).find(it => it.key === 'cache_hit')
  expect(item?.value).toBe('—')
  expect(item?.valueColor).toBe(undefined)
})

test('命中率按 dsh 取整：一般取整数，没全中时不会显示成 100%', () => {
  expect(hitText(95.32)).toBe('95%')
  expect(hitText(99.4)).toBe('99%')
  expect(hitText(99.52)).toBe('99.5%')
  expect(hitText(99.96)).toBe('99.96%')
  expect(hitText(99.9994)).toBe('99.999%')
  expect(hitText(100)).toBe('100%')
  const item = buildItems(parseConfig({}), 'en', snap({ perf: { ...PERF, hitPercent: 99.73 } })).find(it => it.key === 'cache_hit')
  expect(item?.value).toBe('99.7%')
})

test('速度：一次几十毫秒的异常请求被累计摊平，不会冲到上万 tok/s', () => {
  const p = nextPerf(PERF, step({ streamMs: 45, usage: usage({ output_tokens: 1000 }) }))
  const speed = buildItems(parseConfig({}), 'en', snap({ perf: p })).find(it => it.key === 'speed')?.value
  // (684 + 1000) ÷ 10.045s ≈ 168
  expect(speed).toBe('168 tok/s')
})

test('第二行按阈值分三档，边界值归属正确', () => {
  expect([69, 70, 89, 90].map(speedLevel)).toEqual(['bad', 'warn', 'warn', 'good'])
  expect([2.9, 3, 5, 5.1].map(firstTokenLevel)).toEqual(['good', 'warn', 'warn', 'bad'])
  expect([84.9, 85, 89.9, 90].map(hitLevel)).toEqual(['bad', 'warn', 'warn', 'good'])
  const cfg = parseConfig({})
  expect(['good', 'warn', 'bad'].map(l => levelColor(cfg, l as 'good'))).toEqual(['#46a758', '#d97757', '#e5484d'])
  expect(levelColor(parseConfig({ color: 'mono' }), 'bad')).toBe(levelColor(parseConfig({ color: 'mono' }), 'good'))
  // 按显示出来的数判断：89.6 显示 90，就用绿色
  const items = buildItems(cfg, 'en', snap({ perf: { ...PERF, decodeTokens: 896, decodeMs: 10_000, ttftMs: 5_040, ttftSteps: 1 } }))
  expect(items.find(it => it.key === 'speed')?.value).toBe('90 tok/s')
  expect(items.find(it => it.key === 'speed')?.valueColor).toBe('#46a758')
  expect(items.find(it => it.key === 'first_token')?.value).toBe('5.0s')
  expect(items.find(it => it.key === 'first_token')?.valueColor).toBe('#d97757')
  // 命中 89.6% 显示 90%，也按绿色
  const hit = buildItems(cfg, 'en', snap({ perf: { ...PERF, hitPercent: 89.6 } })).find(it => it.key === 'cache_hit')
  expect(hit?.value).toBe('90%')
  expect(hit?.valueColor).toBe('#46a758')
  expect(items.find(it => it.key === 'failures')?.valueColor).toBe('#46a758')
})

test('缓存倒计时按剩余比例分三档，已冷保持蓝色', () => {
  expect([0.5, 0.49, 0.1, 0.09].map(cacheLevel)).toEqual(['good', 'warn', 'warn', 'bad'])
  const cfg = parseConfig({})
  const cache = (lastTurnAt: number, isWorking = false) => buildItems(cfg, 'en', snap({ lastTurnAt, isWorking })).find(it => it.key === 'cache')
  expect(cache(NOW - 20 * 60_000)?.valueColor).toBe('#46a758')
  expect(cache(NOW - 40 * 60_000)?.valueColor).toBe('#d97757')
  expect(cache(NOW - 57 * 60_000)?.valueColor).toBe('#e5484d')
  expect(cache(NOW, true)?.valueColor).toBe('#46a758')
  const cold = cache(NOW - 61 * 60_000)
  expect(cold?.value).toBe('Cold')
  expect(cold?.color).toBe('#6cb6ff')
  // 倒计时只给数值上色，图标不变
  expect(cache(NOW - 57 * 60_000)?.color).toBe(undefined)
})

test('上下文排第一；缓存和命中都在第 4 列，上下对齐', () => {
  const cfg = parseConfig({ show_context: true })
  const items = buildItems(cfg, 'zh', snap({ contextPercent: 30, lastTurnAt: 0, perf: PERF }))
  const row = (g: string) => items.filter(it => it.group === g).map(it => it.key)
  expect(row('usage')).toEqual(['context', 'five_hour', 'seven_day', 'cache'])
  expect(row('perf')).toEqual(['speed', 'first_token', 'failures', 'cache_hit'])
  expect(items[0]?.icon).toBe('layers')
})

test('排版：对齐放不下时先缩短进度条，缩到最短仍放不下才不对齐', () => {
  const cfg = parseConfig({ show_context: true })
  const items = buildItems(cfg, 'zh', snap({ contextPercent: 26, lastTurnAt: null, perf: { ...PERF, hitPercent: 99.7 } }))
  const wide = layoutRows(items, cfg, 900)
  expect(wide[0]?.slots).toBeDefined()
  const tight = layoutRows(items, cfg, 680)
  expect(tight).toHaveLength(2)
  expect(tight[0]?.slots).toBeDefined()
  expect(tight[0]!.barW).toBeLessThan(wide[0]!.barW)
  expect(tight[0]!.barW).toBeGreaterThanOrEqual(BAR_MIN)
  expect(tight[1]!.barW).toBe(tight[0]!.barW)
})

test('画布比内容宽时，内容居中，几行平移量一样，左右留白相等', () => {
  const cfg = parseConfig({ show_context: true })
  const items = buildItems(cfg, 'zh', snap({ contextPercent: 49, lastTurnAt: NOW - 60_000, perf: PERF }))
  const rows = layoutRows(items, cfg, 760)
  const content = Math.max(...rows.map(r => rowSvg(r, cfg).width))
  const drawn = rows.map(r => rowSvg(r, cfg, 900, content))
  // 图标自己也用 translate，这里只看紧跟在样式后面、包住整行的那一层
  const shift = (src: string) => /<\/style><g transform="translate\((\d+),0\)">/.exec(src)?.[1]
  const dx = drawn.map(d => Number(shift(d.source)))
  expect(drawn.every(d => d.width === 900)).toBe(true)
  expect(dx[0]).toBe(Math.floor((900 - content) / 2))
  expect(dx[1]).toBe(dx[0])
  // 画布不比内容宽时不平移
  expect(shift(rowSvg(rows[0]!, cfg, 0, content).source)).toBe(undefined)
})

test('文字宽度按 Chrome 实测表估算：误差不超过 2px，半粗体更宽', () => {
  // 实测值来自 Chrome 中 13px 的 -apple-system
  expect(Math.abs(textWidth('context') - 45.1)).toBeLessThanOrEqual(2)
  expect(Math.abs(textWidth('113 tok/s', 13, 600) - 55.8)).toBeLessThanOrEqual(2)
  expect(textWidth('上下文')).toBe(39)
  expect(textWidth('cache hit', 13, 600)).toBeGreaterThan(textWidth('cache hit'))
})
