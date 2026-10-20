import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionContextBreakdown, SessionRateLimit, TurnStepChunk, TurnStepInput, TurnStepResult, UiNotifyResult } from 'claude-code'

const START = Date.parse('2026-10-19T10:00:00Z')

const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-19T12:05:00Z' },
  { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-22T14:00:00Z' },
]

const props = (over: Partial<{ hasSurvey: boolean; isWorking: boolean; bodyColumns: number }> = {}) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
  ...over,
})

// 引擎自己画的横条在树里是一个占位节点
const ENGINE = { type: 'engine' as const, ref: 0 }

type World = {
  limits?: SessionRateLimit[]
  env?: Record<string, string>
  notify?: UiNotifyResult
  // 自动压缩的触发点；不给时 breakdown 缺席，模拟会话还没绑定
  compactAt?: number
  // $.store 一开始的内容，用来模拟进程重启后读到上次存下的值
  store?: Record<string, unknown>
}

// 引擎底下的世界：用量、时钟、存储、环境变量、通知；记录发出的通知和 toast
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: START })
  const sent: string[] = []
  const toasts: string[] = []
  mock.store(on, w.store)
  on('session.id', () => ({ value: 's1' }))
  mock.env(on, w.env ?? { LANG: 'en_US.UTF-8' })
  on('session.usage', (_$, e) => {
    const breakdown = e.breakdown && w.compactAt ? ({ rawMaxTokens: w.compactAt } as unknown as SessionContextBreakdown) : undefined
    const context = { window: 200_000, tokens: 40_000, percent: 20, ...(breakdown ? { breakdown } : {}) }
    return { value: { startedAt: 0, context, rateLimits: w.limits ?? LIMITS, cost: { usd: 1.5 } } }
  })
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId, resume: e.resume }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.notify', (_$, e) => {
    sent.push(e.text)
    return { value: w.notify ?? { isSent: true as const, channel: 'terminal_bell' as const } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, sent, toasts }
}

const turn = (reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string) => ({
  answer: 'ok',
  durationMs: 10,
  isAborted: reason === 'aborted',
  turnId: 't',
  reason,
  ...(agentId ? { agentId } : {}),
})

const measure = (rateLimits: SessionRateLimit[]) => ({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits' as const] })

const SURFACES = ['terminal', 'desktop'] as const

for (const surface of SURFACES) {
  test(`${surface}：画出 5h 和周额度，不嵌套引擎占位节点`, async ($, on) => {
    world(on)
    on('ui.render', () => ENGINE)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props() })
    expect(JSON.stringify(await ui.drawn())).not.toContain('"engine"')
    if (surface === 'desktop') {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg?.props.alt).toContain('5h 42%')
      expect(svg?.props.alt).toContain('Week 85%')
      expect(String(svg?.props.source)).toContain('<svg')
    } else {
      expect(await ui.find({ type: 'Svg' })).toBe(undefined)
      expect(await ui.find({ type: 'Text', text: '42%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '85%' })).toBeDefined()
    }
  })

  test(`${surface}：别的 mod 的横条在上，自己在最后`, async ($, on) => {
    world(on)
    on('ui.render', ($$, e) => {
      const { Text } = $$.ui.resolve(e)
      return <Text>other band</Text>
    })
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props() })
    const tree = (await ui.drawn()) as unknown as { children: { type: string; children?: unknown[] }[] }
    expect(tree.children[0]?.children).toEqual(['other band'])
    expect(tree.children.at(-1)?.type).toBe(surface === 'desktop' ? 'Svg' : 'Box')
  })

  test(`${surface}：窄屏时换成多行`, { options: { show_context: true, show_cost: true } }, async ($, on) => {
    world(on)
    on('ui.render', () => ENGINE)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    const rows = async (bodyColumns: number) => {
      const m = await $.ui.mount({ plugin: 'usage-bar', surface, component: 'AbovePrompt', props: props({ bodyColumns }) })
      // 桌面版每行一张 Svg；终端每行一个带 row- 前缀 key 的 Box
      if (surface === 'desktop') return (await m.findAll({ type: 'Svg' })).length
      return (await m.findAll({ type: 'Box' })).filter(f => f.key?.startsWith('row-')).length
    }
    expect(await rows(220)).toBe(1)
    expect(await rows(40)).toBeGreaterThan(1)
  })
}

test('有问卷时让位，没有任何项时什么都不画', async ($, on) => {
  world(on, { limits: [] })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect(await ui.find({ type: 'Svg' })).toBe(undefined)
  const survey = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props({ hasSurvey: true }) })
  expect(await survey.find({ type: 'Svg' })).toBe(undefined)
})

test('窗口已经重置时按 0% 显示', async ($, on) => {
  world(on, { limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-19T09:00:00Z' }] })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('5h 0%')
})

test('中文：标签和通知都用中文', { options: { notify_at: '80' } }, async ($, on) => {
  const { sent } = world(on, { env: { LANG: 'zh_CN.UTF-8' } })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('周 85%')
  await $.session.measure(measure(LIMITS))
  expect(sent).toEqual(['每周额度已用 85%'])
})

test('一轮结束后显示缓存倒计时，到期那一刻变冷', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turn())
  await clock.advance(20 * 60_000)
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Cache 40m')
  // 到期后 1 秒就重画，不等下一个整分钟
  await clock.advance(40 * 60_000 + 2_000)
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Cache Cold')
})

test('子代理和报错的轮次不刷新缓存计时，中断的轮次算数', async ($, on) => {
  world(on)
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turn('answer', 'agent-1'))
  await $.turn.complete(turn('error'))
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).not.toContain('Cache')
  await $.turn.complete(turn('aborted'))
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Cache 1h00m')
})

test('/clear 之后清掉旧对话的缓存计时', async ($, on) => {
  world(on)
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.turn.complete(turn())
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Cache')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).not.toContain('Cache')
})

test('没有 session.start（热重载后）也会按分钟刷新', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', () => ENGINE)
  await $.turn.complete(turn())
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Cache 1h00m')
  await clock.advance(3 * 60_000)
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Cache 57m')
})

test('提醒：每档一次，升档再提醒，窗口重置后重新提醒', { options: { notify_at: '80,95' } }, async ($, on) => {
  const { sent } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(LIMITS))
  await $.session.measure(measure(LIMITS))
  expect(sent).toEqual(['Weekly limit at 85%'])
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 96, resetsAt: '2026-10-22T14:00:00Z' }]))
  expect(sent).toEqual(['Weekly limit at 85%', 'Weekly limit at 96%'])
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 81, resetsAt: '2026-10-29T14:00:00Z' }]))
  expect(sent.at(-1)).toBe('Weekly limit at 81%')
})

test('notify_at 为空时不提醒', { options: { notify_at: '' } }, async ($, on) => {
  const { sent } = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(LIMITS))
  expect(sent).toEqual([])
})

test('桌面版发不出通知时改用 toast', { options: { notify_at: '80' } }, async ($, on) => {
  const { toasts } = world(on, { notify: { isSent: false, reason: 'no-surface' } })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(LIMITS))
  expect(toasts).toEqual(['Weekly limit at 85%'])
})

test('用户关了通知时不弹 toast', { options: { notify_at: '80' } }, async ($, on) => {
  const { sent, toasts } = world(on, { notify: { isSent: false, reason: 'disabled' } })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.session.measure(measure(LIMITS))
  expect(sent).toHaveLength(1)
  expect(toasts).toEqual([])
})

test('上下文占比按自动压缩的触发点算', { options: { show_context: true } }, async ($, on) => {
  world(on, { compactAt: 100_000 })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Context 40%')
})

test('拿不到压缩触发点时按模型窗口算', { options: { show_context: true } }, async ($, on) => {
  world(on)
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Context 20%')
})

test('重启后额度为空时，先显示上次存下的额度', async ($, on) => {
  world(on, { limits: [], store: { limits: { limits: LIMITS } } })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('5h 42%')
})

test('重启后从 store 恢复本会话的缓存计时', async ($, on) => {
  world(on, { store: { turns: { s1: START - 10 * 60_000, other: START } } })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Cache 50m')
})

test('收到额度后存起来，下次额度为空时能读回', async ($, on) => {
  world(on, { limits: [] })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect(await ui.find({ type: 'Svg' })).toBe(undefined)
  await $.session.measure(measure(LIMITS))
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('Week 85%')
})

test('/clear 之后不会从 store 恢复旧的缓存计时', async ($, on) => {
  world(on, { store: { turns: { s1: START - 10 * 60_000 } } })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).not.toContain('Cache')
})

// 底下的模型：先等 firstMs 再吐第一个数据块，再过 streamMs 结束。
// engine 数据块只有引擎能发，测试里没法模拟，所以只发 text
type Reply = { firstMs: number; streamMs: number; result: Partial<TurnStepResult> }
function model(on: On, clock: { advance: (ms: number) => Promise<unknown> }, replies: Reply[]) {
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    const r = replies.shift()!
    await clock.advance(r.firstMs)
    yield { kind: 'text', index: 0, text: 'hi' }
    await clock.advance(r.streamMs)
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: null, ...r.result } as TurnStepResult
  })
}

const stepInput = (agentId?: string): TurnStepInput => ({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })

async function runStep($: { turn: { step: (e: TurnStepInput) => AsyncGenerator<TurnStepChunk, TurnStepResult> & { result: Promise<TurnStepResult> } } }, input: TurnStepInput) {
  const s = $.turn.step(input)
  const chunks: TurnStepChunk[] = []
  // 手动迭代，直接拿生成器的返回值
  for (;;) {
    const r = await s.next()
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

const USAGE = { input_tokens: 100, output_tokens: 600, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 900, model: 'claude-test' }

test('请求结束后第二行显示速度、首字、命中率和失败次数', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', () => ENGINE)
  model(on, clock, [{ firstMs: 800, streamMs: 10_000, result: { usage: USAGE } }])
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const { chunks, result } = await runStep($, stepInput())
  // 数据块和结果原样传下去
  expect(chunks.map(c => c.kind)).toEqual(['text'])
  expect(result.answer).toBe('hi')
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  const rows = await ui.findAll({ type: 'Svg' })
  expect(rows).toHaveLength(2)
  expect(rows[1]?.props.alt).toBe('Speed 60 tok/s, TTFT 0.8s, Failed 0, Cache hit 90%')
  // 不写 width，交给横条居中；两行画布一样宽，列才对得上
  expect(rows.every(r => r.props.width === undefined)).toBe(true)
  const canvas = (src: string) => /<svg[^>]* width="(\d+)"/.exec(src)?.[1]
  expect(canvas(String(rows[0]!.props.source))).toBe(canvas(String(rows[1]!.props.source)))
})

test('没收到响应的请求算失败，子代理的也算', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', () => ENGINE)
  model(on, clock, [
    { firstMs: 500, streamMs: 2_000, result: { usage: USAGE } },
    { firstMs: 100, streamMs: 100, result: { stopReason: null } },
  ])
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await runStep($, stepInput())
  await runStep($, stepInput('agent-1'))
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.findAll({ type: 'Svg' }))[1]?.props.alt).toContain('Failed 1')
  // 子代理的请求不改首字
  expect((await ui.findAll({ type: 'Svg' }))[1]?.props.alt).toContain('TTFT 0.5s')
})

test('重启后从 store 恢复本会话的性能数据，/clear 后清掉', async ($, on) => {
  const perf = { ttftMs: 3_000, ttftSteps: 2, decodeMs: 10_000, decodeTokens: 420, hitPercent: 95, hitWrite: false, failures: 3 }
  world(on, { store: { perf: { s1: { at: START, perf } } } })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.findAll({ type: 'Svg' }))[1]?.props.alt).toBe('Speed 42 tok/s, TTFT 1.5s, Failed 3, Cache hit 95%')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
})

test('终端：两行按列补空格对齐', async ($, on) => {
  const perf = { ttftMs: 3_000, ttftSteps: 2, decodeMs: 10_000, decodeTokens: 420, hitPercent: 95, hitWrite: false, failures: 0 }
  world(on, { store: { perf: { s1: { at: START, perf } } } })
  on('ui.render', () => ENGINE)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'terminal', component: 'AbovePrompt', props: props() })
  const rows = (await ui.findAll({ type: 'Box' })).filter(f => f.key?.startsWith('row-'))
  expect(rows).toHaveLength(2)
  const text = JSON.stringify(await ui.drawn())
  expect(text).toContain('Speed ')
  expect(text).toMatch(/"\s{2,}"/)
})

test('请求结束 1 秒后写进 store，正常退出不删，再打开还能显示', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', () => ENGINE)
  model(on, clock, [{ firstMs: 800, streamMs: 10_000, result: { usage: USAGE } }])
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await runStep($, stepInput())
  await clock.advance(1_500)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  // 内存里的值已清掉，这里显示的是从 store 读回的
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.findAll({ type: 'Svg' }))[1]?.props.alt).toBe('Speed 60 tok/s, TTFT 0.8s, Failed 0, Cache hit 90%')
})

test('reload 后内存里是旧格式的性能数据时丢掉，不会算出 NaN', async ($, on) => {
  const { clock } = world(on)
  on('ui.render', () => ENGINE)
  model(on, clock, [{ firstMs: 800, streamMs: 10_000, result: { usage: USAGE } }])
  // 模拟 reload 前旧版本留在 $.state 里的值：前两次读取拿到旧格式
  const OLD = { firstTokenMs: 1, tokensPerSec: 22188, hitPercent: 99, hitWrite: false, failures: 0 }
  let reads = 0
  on('state.get', (_$, e, next) => (e.key === 'perf' && reads++ < 2 ? { value: { value: OLD, version: 0 } } : next(e)) as never)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await runStep($, stepInput())
  const ui = await $.ui.mount({ plugin: 'usage-bar', surface: 'desktop', component: 'AbovePrompt', props: props() })
  expect((await ui.findAll({ type: 'Svg' }))[1]?.props.alt).toBe('Speed 60 tok/s, TTFT 0.8s, Failed 0, Cache hit 90%')
})
