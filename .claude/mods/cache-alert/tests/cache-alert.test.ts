import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MINUTE = 60_000
const START = Date.parse('2026-10-26T15:00:00Z')

type Sent = { title?: string; text: string }

// The engine beneath the plugin: a session in C:\src\dotfiles with `ctx` tokens of
// context, a model that answers each step, tools that return at once (but an
// AskUserQuestion, held until `answer()`), and a notification channel that keeps
// what it's sent. No OS variable unless given, so not Windows.
function engine(on: On, { ctx = 240_000, env = {} }: { ctx?: number; env?: Record<string, string> } = {}) {
  const clock = mock.clock(on, { now: START })
  mock.env(on, env)
  const sent: Sent[] = []
  let answer = () => {}
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\src\\dotfiles' }))
  on('session.usage', () => ({
    value: { startedAt: START, context: { tokens: ctx, window: 1_000_000, percent: ctx / 10_000 }, rateLimits: [] },
  }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, model: e.model },
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) =>
    e.tool === 'AskUserQuestion' ? new Promise(resolve => (answer = () => resolve({ result: {} }))) : { result: {} },
  )
  on('ui.notify', (_, e) => {
    sent.push({ title: e.title, text: e.text })
    return { value: { isSent: true as const, channel: 'iterm2' as const } }
  })
  return { clock, sent, answer: () => answer() }
}

let turns = 0

type Origin = 'composer' | 'task-notification'

// One main-loop turn: a prompt (the person's unless `from` says otherwise), one
// response, the tool calls it makes, its end
async function turn($: Engine, calls: Record<string, unknown>[], answer = '', from: Origin = 'composer') {
  const turnId = `t${++turns}`
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: from } })
  await $.turn.start({ text: 'go', turnId })
  const step = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of step);
  for (const c of calls) await $.tool.call(c as never)
  await $.turn.complete({ turnId, answer, durationMs: 1000, isAborted: false, reason: 'answer' })
}

const wrapUp = (ask?: string) => ({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Did the thing.', ...(ask ? { ask } : {}) })

test('a turn that ends on a question gets one alert, ten minutes before expiry', async ($, on) => {
  const { clock, sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Build the cache-expiry alert mod?')])

  await clock.advance(49 * MINUTE)
  expect(sent).toEqual([])
  await clock.advance(1 * MINUTE)
  expect(sent).toEqual([
    {
      title: 'Prompt cache expiring',
      text: 'dotfiles · 10 min left on a 240k-token cache\nBuild the cache-expiry alert mod?',
    },
  ])
  await clock.advance(30 * MINUTE)
  expect(sent.length).toBe(1)
})

test('a turn that ends with a recap alone is done: no alert', async ($, on) => {
  const { clock, sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp()], 'All done. Want me to do anything else?')
  await clock.advance(60 * MINUTE)
  expect(sent).toEqual([])
})

test('a small context is cheap to rebuild: no alert', async ($, on) => {
  const { clock, sent } = engine(on, { ctx: 40_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(60 * MINUTE)
  expect(sent).toEqual([])
})

test('answering before the alert moves it to the new turn', async ($, on) => {
  const { clock, sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(30 * MINUTE)
  await turn($, [wrapUp()])
  await clock.advance(60 * MINUTE)
  expect(sent).toEqual([])
})

test("a turn the person didn't start keeps the question waiting", async ($, on) => {
  const { clock, sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(20 * MINUTE)
  // A background task finishes and the model says so, asking nothing new
  await turn($, [], 'The build finished.', 'task-notification')
  await clock.advance(49 * MINUTE)
  expect(sent).toEqual([])
  await clock.advance(1 * MINUTE)
  expect(sent.map(s => s.text.split('\n')[1])).toEqual(['Commit?'])
})

test('an open AskUserQuestion counts as waiting', async ($, on) => {
  const { clock, sent, answer } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'go', turnId: 'q' })
  for await (const _ of $.turn.step({ turnId: 'q', index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
  const asking = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which TTL?', header: 'TTL', options: [{ label: '1h', description: '' }, { label: '5m', description: '' }], multiSelect: false }],
  })
  await clock.advance(50 * MINUTE)
  expect(sent.map(s => s.text)).toEqual(['dotfiles · 10 min left on a 240k-token cache\nWhich TTL?'])
  answer()
  await asking
})

test('a turn with no wrap-up: a trailing question or an unfinished task list counts', async ($, on) => {
  const { clock, sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await turn($, [], 'Here is the plan.\nShould I go ahead?')
  await clock.advance(50 * MINUTE)
  expect(sent.map(s => s.text.split('\n')[1])).toEqual(['Should I go ahead?'])

  await turn($, [
    { tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] },
    { tool: 'mcp__ccd_turn__update_plan', advance: true },
  ])
  await clock.advance(50 * MINUTE)
  expect(sent.map(s => s.text.split('\n')[1])).toEqual([
    'Should I go ahead?',
    'Stopped with steps left on its task list',
  ])
})

test('/cache-alert reports where the session stands and sends a test', async ($, on) => {
  const { clock, sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(20 * MINUTE)
  const out = await $.command.run({
    command: 'cache-alert',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(out.text).toBe(
    [
      'Waiting on you: Commit?',
      'Cache goes cold in 40 min (1h TTL); the alert comes 10 min before.',
      'Context: 240k tokens; alerts start at 75k.',
      'Test notification sent through the iterm2 channel.',
    ].join('\n'),
  )
  expect(sent.map(s => s.title)).toEqual(['Prompt cache alert (test)'])
})

test('on Windows the alert is a toast through PowerShell', async ($, on) => {
  const { clock, sent } = engine(on, { env: { OS: 'Windows_NT' } })
  const runs: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, env: e.init?.env })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(50 * MINUTE)

  expect(sent).toEqual([])
  expect(runs.length).toBe(1)
  expect(runs[0]?.argv[0]).toBe('powershell.exe')
  // A reminder stays on screen until dismissed
  expect(runs[0]?.argv.at(-1)).toContain("<toast scenario='reminder'>")
  expect(runs[0]?.env).toEqual({
    CACHE_ALERT_TITLE: 'Prompt cache expiring',
    CACHE_ALERT_BODY: 'dotfiles · 10 min left on a 240k-token cache\nCommit?',
  })
})

test('the five-minute TTL alerts two minutes ahead', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const { clock, sent } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(3 * MINUTE)
  expect(sent.map(s => s.text.split('\n')[0])).toEqual(['dotfiles · 2 min left on a 240k-token cache'])
})
