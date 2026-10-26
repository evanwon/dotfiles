import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Waiting } from '../types'

// A native notification shortly before the prompt cache goes cold, for a session
// that's waiting on you and big enough that a cold cache costs something:
//   Prompt cache expiring
//   dotfiles · 10 min left on a 240k-token cache
//   Build the cache-expiry alert mod?
// "Waiting on you" is read from how the last turn ended: on a question (the desktop
// app's wrap-up ask, a trailing "?" where there's no wrap-up), with a dialog still
// open (AskUserQuestion, a plan to approve), stopped partway through its task list,
// or on an API error. A turn that ended with a recap alone is taken as done.
// One alert per idle stretch: any response re-arms the timer, and only a message from
// the person clears the waiting state. A turn something else started (a background
// task's notice, another session, a scheduled prompt) keeps it, unless that turn
// ends on a question of its own. On Windows the alert is a toast from the Claude app; elsewhere
// it goes through $.ui.notify, which reaches a terminal.

const MINUTE = 60_000
const WRAP_UP = 'mcp__ccd_turn__wrap_up'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'

const lastResponseAt = atom({ plugin: 'cache-alert', key: 'lastResponseAt' } as const, null)
const waiting = atom({ plugin: 'cache-alert', key: 'waiting' } as const, null)
const alertedFor = atom({ plugin: 'cache-alert', key: 'alertedFor' } as const, null)

let ttlMs = 60 * MINUTE
let leadMs = 10 * MINUTE
let minTokens = 75_000
let timer: Timer | null = null

// This turn's wrap-up: whether there was one, and the question it asked
let wrapped = false
let ask: string | null = null
// The task list's step statuses, as the update_plan calls left them
type Status = 'pending' | 'in_progress' | 'completed'
let steps: Status[] = []
// A dialog open on the person right now, which holds the turn open
let dialog: string | null = null
// Whether the person sent the prompt the next main-loop turn starts from
let fromPerson = false

// Where a prompt the person sent comes from: the composer, Remote Control, an SDK
// host, a Slack ping. Everything else (notifications, peers, schedules, follow-ups
// to a command) is the engine's or another agent's.
const PERSON = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

// Compact token count: 950, 18k, 1.3M
function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`
  return `${Math.floor(n / 1_000_000)}.${Math.floor((n % 1_000_000) / 100_000)}M`
}

function clip(s: string, max = 140): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) ?? path
}

// Follows update_plan's own rules: `items` replaces the list, `advance` completes the
// step in progress and starts the next pending one, `done`/`start` are 1-based.
function applyPlan(e: Record<string, unknown>) {
  if (Array.isArray(e.items)) {
    steps = e.items.map(i => ((i as { status?: Status }).status ?? 'pending'))
  }
  if (e.advance === true) {
    const cur = steps.indexOf('in_progress')
    if (cur >= 0) steps[cur] = 'completed'
    const nextPending = steps.indexOf('pending', Math.max(cur, 0))
    if (nextPending >= 0) steps[nextPending] = 'in_progress'
  }
  if (Array.isArray(e.done)) {
    for (const n of e.done) if (typeof n === 'number' && steps[n - 1]) steps[n - 1] = 'completed'
  }
  if (typeof e.start === 'number' && steps[e.start - 1]) steps[e.start - 1] = 'in_progress'
}

// What the turn that just ended left the person to do
function readEnding(reason: string, answer: string): Waiting {
  if (reason === 'aborted') return null // they stopped it, so they're there
  if (reason === 'error') return { reason: 'Stopped on an API error' }
  if (ask) return { reason: clip(ask) }
  if (wrapped) return null
  if (steps.some(s => s !== 'completed')) return { reason: 'Stopped with steps left on its task list' }
  const lastLine = answer.trim().split('\n').at(-1) ?? ''
  if (lastLine.trim().endsWith('?')) return { reason: clip(lastLine) }
  return null
}

// A Windows toast, sent as the Claude app so a click opens it. The reminder scenario
// keeps it on screen until it's clicked or dismissed (Windows needs a button for
// that, so it has Dismiss). The text travels in environment variables, so nothing in
// it is read as PowerShell.
const TOAST_PS = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$lines = @($env:CACHE_ALERT_TITLE) + ($env:CACHE_ALERT_BODY -split "\\n")
$texts = ($lines | ForEach-Object { "<text>$([System.Security.SecurityElement]::Escape($_))</text>" }) -join ''
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$dismiss = "<actions><action activationType='system' arguments='dismiss' content=''/></actions>"
$xml.LoadXml("<toast scenario='reminder'><visual><binding template='ToastGeneric'>$texts</binding></visual>$dismiss</toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude_pzs8sxrjxfjjc!Claude').Show($toast)
`

// Raises the alert and says how it went out. `$.ui.notify` writes to a terminal, and
// the desktop app has none (there it only runs the Notification hooks), so Windows
// gets a toast of its own, falling back to `$.ui.notify` when that fails.
async function send($: EngineInterface, title: string, body: string): Promise<string> {
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const out = await $.process
      .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TOAST_PS], {
        env: { CACHE_ALERT_TITLE: title, CACHE_ALERT_BODY: body },
        timeoutMs: 20_000,
      })
      .catch(() => null)
    if (out?.exitCode === 0) return 'a Windows notification'
  }
  const sent = await $.ui.notify(body, { title })
  return sent.isSent ? `the ${sent.channel} channel` : `nothing (${sent.reason})`
}

// What the session is waiting on you for, if anything
async function readWaiting($: EngineInterface): Promise<Waiting> {
  return (await read($, waiting)) ?? (dialog === null ? null : { reason: dialog })
}

async function check($: EngineInterface) {
  const last = await read($, lastResponseAt)
  if (last === null || (await read($, alertedFor)) === last) return
  const why = await readWaiting($)
  if (why === null) return
  const [now, usage, cwd] = await Promise.all([$.clock.now(), $.session.usage(), $.session.cwd()])
  const left = last + ttlMs - now
  const ctx = usage.context.tokens ?? 0
  if (left <= 0 || ctx < minTokens) return

  await update($, alertedFor, () => last)
  const mins = Math.max(1, Math.round(left / MINUTE))
  await send($, 'Prompt cache expiring', `${basename(cwd)} · ${mins} min left on a ${fmtTok(ctx)}-token cache\n${why.reason}`)
}

// /cache-alert: where this session stands, and a test notification
async function status($: EngineInterface): Promise<string> {
  const [last, why, now, usage] = await Promise.all([
    read($, lastResponseAt),
    readWaiting($),
    $.clock.now(),
    $.session.usage(),
  ])
  const ctx = usage.context.tokens ?? 0
  const left = last === null ? 0 : last + ttlMs - now
  const via = await send($, 'Prompt cache alert (test)', 'Notifications from cache-alert arrive like this one')
  return [
    why === null ? 'Not waiting on you, so no alert.' : `Waiting on you: ${why.reason}`,
    last === null
      ? 'No response seen yet.'
      : left > 0
        ? `Cache goes cold in ${Math.ceil(left / MINUTE)} min (${ttlMs === 5 * MINUTE ? '5m' : '1h'} TTL); the alert comes ${leadMs / MINUTE} min before.`
        : 'Cache is already cold.',
    `Context: ${fmtTok(ctx)} tokens; alerts start at ${fmtTok(minTokens)}.`,
    `Test notification sent through ${via}.`,
  ].join('\n')
}

// Sets the one timer for `last`'s expiry, less the lead time
async function arm($: EngineInterface, last: number) {
  timer?.cancel()
  const wait = last + ttlMs - leadMs - (await $.clock.now())
  timer = $.clock.after(Math.max(0, wait), () => void check($))
}

export const register: Register = (on, options) => {
  ttlMs = (options.cacheTtl === '5m' ? 5 : 60) * MINUTE
  leadMs = options.cacheTtl === '5m' ? 2 * MINUTE : 10 * MINUTE
  if (typeof options.minContextTokens === 'number') minTokens = options.minContextTokens

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'cache-alert',
      description: "Show whether this session would get a cache-expiry alert, and send a test one",
    })
    // A reload keeps the session's state but cancels the old timer
    const last = await read($, lastResponseAt)
    if (last !== null) await arm($, last)
    return started
  })

  on('command.run', { command: 'cache-alert' }, async $ => ({ text: await status($) }))

  on('prompt.submit', async ($, e, next) => {
    if (PERSON.has(e.origin.kind)) fromPerson = true
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      wrapped = false
      ask = null
      if (fromPerson) await update($, waiting, () => null)
      fromPerson = false
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage && e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, lastResponseAt, () => at)
      await arm($, at)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.tool === WRAP_UP) {
      wrapped = true
      ask = typeof e.ask === 'string' && e.ask.trim() !== '' ? e.ask : null
      steps = steps.map(() => 'completed')
      return next(e)
    }
    if (e.tool === UPDATE_PLAN) {
      applyPlan(e)
      return next(e)
    }
    if (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') {
      dialog = e.tool === 'ExitPlanMode' ? 'A plan is waiting for your approval' : clip(e.questions[0]?.question ?? 'A question is waiting for you')
      try {
        return await next(e)
      } finally {
        dialog = null
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      // A turn the person didn't start leaves what it found unless it asks anew;
      // an interrupt means they're there either way
      const w = readEnding(e.reason, e.answer)
      await update($, waiting, held => (e.reason === 'aborted' ? null : (w ?? held)))
    }
    return next(e)
  })
}
