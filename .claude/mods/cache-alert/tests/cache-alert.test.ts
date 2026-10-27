import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MINUTE = 60_000
const START = Date.parse('2026-10-26T15:00:00Z')

type Sent = { title?: string; text: string }

const TRANSCRIPT = 'C:/Users/me/.claude/projects/C--src-dotfiles/s1.jsonl'

// The engine beneath the plugin: a session in C:\src\dotfiles with `ctx` tokens of
// context, a model that answers each step, tools that return at once (but an
// AskUserQuestion, held until `answer()`), and a notification channel that keeps
// what it's sent. No OS variable unless given, so not Windows. With `transcript`,
// the session has one on disk, and jq reads it as those records.
function engine(
  on: On,
  { ctx = 240_000, env = {}, transcript }: { ctx?: number; env?: Record<string, string>; transcript?: object[] } = {},
) {
  const clock = mock.clock(on, { now: START })
  mock.env(on, transcript ? { ...env, USERPROFILE: 'C:\\Users\\me' } : env)
  const jq = { runs: 0 }
  if (transcript) {
    on('session.id', () => ({ value: 's1' }))
    on('session.root', () => ({ value: 'C:\\src\\dotfiles' }))
    on('fs.exists', (_, e) => ({ value: e.path.replace(/\\/g, '/') === TRANSCRIPT }))
    on('fs.list', () => ({ value: [] }))
    on('process.run', (_, e) => {
      if (e.argv[0] === 'jq' && e.argv.at(-1) === TRANSCRIPT) jq.runs += 1
      const stdout = transcript.map(r => JSON.stringify(r)).join('\n')
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  }
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
  return { clock, sent, jq, answer: () => answer() }
}

// Transcript records as the mod's jq pass emits them
const prompt = (turn: number, person = true) => ({ k: 'prompt', person, turn })
const response = (minsAgo: number) => ({ k: 'response', at: new Date(START - minsAgo * MINUTE).toISOString() })
const call = (input: { tool: string }) => {
  const { tool, ...rest } = input
  return { k: 'call', tool, input: rest }
}
const said = (text: string) => ({ k: 'text', text })

// /cache-alert's first two lines: whether it's waiting, and the cache's time left
async function standing($: Engine): Promise<string[]> {
  const out = await $.command.run({
    command: 'cache-alert',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  return (out.text ?? '').split('\n').slice(0, 2)
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

// A new process (the desktop app relaunched) starts with no state: the transcript
// stands in for the hooks that ran before it

test('after a restart, the transcript brings back a question left waiting', async ($, on) => {
  const { clock, sent } = engine(on, {
    transcript: [prompt(1), response(30), call(wrapUp('Commit?')), said('Done.')],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(19 * MINUTE)
  expect(sent).toEqual([])
  await clock.advance(1 * MINUTE)
  expect(sent.map(s => s.text)).toEqual(['dotfiles · 10 min left on a 240k-token cache\nCommit?'])
})

test("the replay keeps the hooks' rules: a turn the person didn't start leaves the question", async ($, on) => {
  const { clock, sent } = engine(on, {
    transcript: [
      prompt(1), response(40), call(wrapUp('Commit?')),
      prompt(2, false), response(35), call(wrapUp()), said('The build finished.'),
    ],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(15 * MINUTE)
  expect(sent.map(s => s.text.split('\n')[1])).toEqual(['Commit?'])
})

test("the person's own later turn, ending on a recap, leaves nothing waiting", async ($, on) => {
  const { clock, sent } = engine(on, {
    transcript: [prompt(1), response(40), call(wrapUp('Commit?')), prompt(2), response(30), call(wrapUp())],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(await standing($)).toEqual([
    'Not waiting on you, so no alert.',
    'Cache goes cold in 30 min (1h TTL); the alert comes 10 min before.',
  ])
  await clock.advance(60 * MINUTE)
  expect(sent.filter(s => s.title === 'Prompt cache expiring')).toEqual([])
})

test('a last turn that died on an API error is recovered as waiting', async ($, on) => {
  const { clock, sent } = engine(on, {
    transcript: [prompt(1), response(30), { k: 'error' }],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(20 * MINUTE)
  expect(sent.map(s => s.text.split('\n')[1])).toEqual(['Stopped on an API error'])
})

test('an interrupted last turn leaves nothing waiting', async ($, on) => {
  const { clock, sent } = engine(on, {
    transcript: [prompt(1), response(30), said('Should I go ahead?'), { k: 'abort' }],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(await standing($)).toEqual([
    'Not waiting on you, so no alert.',
    'Cache goes cold in 30 min (1h TTL); the alert comes 10 min before.',
  ])
  await clock.advance(30 * MINUTE)
  expect(sent.filter(s => s.title === 'Prompt cache expiring')).toEqual([])
})

test('reopened inside the alert window: the state is back, but no alert', async ($, on) => {
  const { clock, sent } = engine(on, {
    transcript: [prompt(1), response(55), call(wrapUp('Commit?'))],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(4 * MINUTE)
  expect(sent).toEqual([])
  expect(await standing($)).toEqual([
    'Waiting on you: Commit?',
    'Cache goes cold in 1 min (1h TTL); the alert comes 10 min before.',
  ])
})

test('a session that already holds its state skips the transcript', async ($, on) => {
  const { clock, jq } = engine(on, { transcript: [] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(jq.runs).toBe(1)
  await turn($, [wrapUp('Commit?')])
  // A hot reload runs session.start again with the state in place
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(jq.runs).toBe(1)
})
