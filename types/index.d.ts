// usage-bar 在 $.state 里保存的值
declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      // 主对话最近一轮结束的时间（$.clock.now() 的毫秒），用来算缓存还剩多久
      lastTurnAt: number | null
      // 每分钟加一，让倒计时在空闲时也会重画
      tick: number
      // 本会话的请求性能，字段和 hooks/model.ts 的 Perf 一致
      perf: {
        ttftMs: number
        ttftSteps: number
        decodeMs: number
        decodeTokens: number
        hitPercent: number | null
        hitWrite: boolean
        failures: number
      } | null
    }
  }
}
