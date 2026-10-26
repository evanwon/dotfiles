// Where you are: the repo (and subdirectory) and its git state. `branch` is
// empty outside a git repository.
export type Git = {
  where: string
  branch: string
  upstream: string
  changes: number
  ahead: number
  behind: number
}

export type RateLimit = { kind: string; percent: number; resetsAt: number | null }

export type ContextSlice = { name: string; tokens: number }

// $.session.usage()'s figures, flattened to what the band draws.
export type Usage = {
  startedAt: number
  ctxTokens: number | null
  ctxPercent: number | null
  ctxWindow: number
  autoCompactAt: number | null
  slices: ContextSlice[]
  limits: RateLimit[]
  costUsd: number | null
}

// "in" is non-cached input: fresh + cache-write, leaving out the cheap re-sent
// cache reads, as the terminal status line counts it. `fromStart` is false when the
// transcript couldn't be read and the totals only cover the time since the mod loaded.
export type Tokens = { in: number; out: number; fromStart: boolean }

declare module 'claude-code' {
  interface PluginState {
    'status-bar': {
      git: Git | null
      usage: Usage | null
      totals: Tokens | null
      lastResponseAt: number | null
      now: number
      open: string | null
    }
  }
}
