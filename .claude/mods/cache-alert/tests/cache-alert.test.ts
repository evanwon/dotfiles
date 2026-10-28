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
// what it's sent. With `pick`, an AskUserQuestion is answered with that label at
// once ('dismiss' closes it instead); `asked` keeps the questions, `copied` what
// reached the clipboard. It draws on the desktop unless `surfaces`
// says otherwise. No OS variable unless given, so not Windows. With `transcript`,
// the session has one on disk, and jq reads it as those records.
function engine(
  on: On,
  {
    ctx = 240_000,
    env = {},
    transcript,
    surfaces = ['desktop'],
    pick,
  }: {
    ctx?: number
    env?: Record<string, string>
    transcript?: object[]
    surfaces?: ('desktop' | 'terminal')[]
    pick?: string
  } = {},
) {
  const clock = mock.clock(on, { now: START })
  on('session.surfaces', () => ({ value: surfaces }))
  mock.env(on, transcript ? { ...env, USERPROFILE: 'C:\\Users\\me' } : env)
  const jq = { runs: 0 }
  on('session.id', () => ({ value: 's1' }))
  if (transcript) {
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
  const asked: string[] = []
  const copied: string[] = []
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    if (pick === undefined) return new Promise(resolve => (answer = () => resolve({ result: {} })))
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    if (pick === 'dismiss') throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [question]: pick } } }
  })
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.notify', (_, e) => {
    sent.push({ title: e.title, text: e.text })
    return { value: { isSent: true as const, channel: 'iterm2' as const } }
  })
  return { clock, sent, jq, asked, copied, answer: () => answer() }
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

// On Windows: the toast script's runs, as the environment each got, every one ending
// with `exitCode`
function windows(on: On, exitCode = 0) {
  const runs: Record<string, string>[] = []
  const scripts: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'powershell.exe') {
      runs.push(e.init?.env ?? {})
      scripts.push(e.argv.at(-1) ?? '')
    }
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, scripts, modes: () => runs.map(r => r.CACHE_ALERT_MODE) }
}

test('on Windows the alert is a toast handed to Windows for its time', async ($, on) => {
  const { clock, sent } = engine(on, { env: { OS: 'Windows_NT' } })
  const { runs, scripts, modes } = windows(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.settle()

  // The person's turn takes back whatever an earlier process left, then its end hands one over
  expect(modes()).toEqual(['unschedule', 'schedule'])
  expect(runs[1]).toEqual({
    CACHE_ALERT_MODE: 'schedule',
    CACHE_ALERT_SESSION: 's1',
    CACHE_ALERT_TITLE: 'Prompt cache expiring',
    CACHE_ALERT_BODY: 'dotfiles · 10 min left on a 240k-token cache\nCommit?',
    CACHE_ALERT_AT: String(START + 50 * MINUTE),
  })
  // A reminder stays on screen until dismissed; Windows holds it until then
  expect(scripts[1]).toContain("<toast scenario='reminder'$launch>")
  expect(scripts[1]).toContain('ScheduledToastNotification')

  // Windows raises it, so nothing here does
  await clock.advance(60 * MINUTE)
  expect(sent).toEqual([])
  expect(runs.length).toBe(2)
})

test("on Windows the person's next message takes the toast back, or down once it's shown", async ($, on) => {
  const { clock } = engine(on, { env: { OS: 'Windows_NT' } })
  const { modes } = windows(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(20 * MINUTE)
  await turn($, [wrapUp('Push?')])
  await clock.settle()
  expect(modes()).toEqual(['unschedule', 'schedule', 'unschedule', 'schedule'])

  // Past its time the toast is on screen, so the answer also clears it
  await clock.advance(55 * MINUTE)
  await turn($, [wrapUp()])
  await clock.settle()
  expect(modes().slice(4)).toEqual(['clear'])
})

test("on Windows a turn the person didn't start moves the toast to its own end", async ($, on) => {
  const { clock } = engine(on, { env: { OS: 'Windows_NT' } })
  const { runs, modes } = windows(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(20 * MINUTE)
  await turn($, [], 'The build finished.', 'task-notification')
  await clock.settle()
  expect(modes()).toEqual(['unschedule', 'schedule', 'unschedule', 'schedule'])
  expect(runs[3]?.CACHE_ALERT_AT).toBe(String(START + 70 * MINUTE))
})

test("when Windows won't take the toast, a timer here raises the alert", async ($, on) => {
  const { clock, sent } = engine(on, { env: { OS: 'Windows_NT' } })
  windows(on, 1)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, [wrapUp('Commit?')])
  await clock.advance(49 * MINUTE)
  expect(sent).toEqual([])
  await clock.advance(1 * MINUTE)
  expect(sent.map(s => s.text)).toEqual(['dotfiles · 10 min left on a 240k-token cache\nCommit?'])
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

// The gate before a prompt on a cold cache

const COLD_Q = 'The prompt cache went cold 10 min ago, so this message re-sends the 240k-token context uncached. Send it anyway?'

const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('a prompt on a cold cache asks first, and Send sends it', async ($, on) => {
  const { clock, asked } = engine(on, { pick: 'Send' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await turn($, [wrapUp()])
  await clock.advance(70 * MINUTE)
  expect(await say($, 'Carry on')).toEqual({ text: 'Carry on' })
  expect(asked).toEqual([COLD_Q])
})

test('Cancel holds the prompt back and leaves the clipboard alone', async ($, on) => {
  const { clock, copied } = engine(on, { pick: 'Cancel' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await turn($, [wrapUp()])
  await clock.advance(70 * MINUTE)
  expect(await say($, 'Carry on')).toEqual({ drop: 'Not sent: the prompt cache is cold.' })
  expect(copied).toEqual([])
})

test('closing the dialog cancels', async ($, on) => {
  const { clock } = engine(on, { pick: 'dismiss' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await turn($, [wrapUp()])
  await clock.advance(70 * MINUTE)
  expect(await say($, 'Carry on')).toEqual({ drop: 'Not sent: the prompt cache is cold.' })
})

test('no question while warm, for a command, a notice or a prompt typed mid-turn', async ($, on) => {
  const { clock, asked } = engine(on, { pick: 'Cancel' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await turn($, [wrapUp()])
  await clock.advance(59 * MINUTE)
  expect(await say($, 'Still warm')).toEqual({ text: 'Still warm' })
  await clock.advance(11 * MINUTE)
  const command = await $.prompt.submit({ text: '/clear', wait: false, origin: { kind: 'composer' }, command: { name: 'clear', args: '' } } as never)
  expect(command).toEqual({ text: '/clear' })
  const notice = await $.prompt.submit({ text: 'Task done', wait: false, origin: { kind: 'task-notification' } } as never)
  expect(notice).toEqual({ text: 'Task done' })
  const midTurn = await $.prompt.submit({ text: 'Also this', wait: false, origin: { kind: 'composer' }, turnId: 't9' } as never)
  expect(midTurn).toEqual({ text: 'Also this' })
  expect(asked).toEqual([])
})

test('a small context goes through without a question', async ($, on) => {
  const { clock, asked } = engine(on, { ctx: 40_000, pick: 'Cancel' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await turn($, [wrapUp()])
  await clock.advance(70 * MINUTE)
  expect(await say($, 'Carry on')).toEqual({ text: 'Carry on' })
  expect(asked).toEqual([])
})

test('with nobody to ask (a -p run), the prompt goes through', async ($, on) => {
  const { clock, asked } = engine(on, { surfaces: [], pick: 'Cancel' })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await turn($, [wrapUp()])
  await clock.advance(70 * MINUTE)
  expect(await say($, 'Carry on')).toEqual({ text: 'Carry on' })
  expect(asked).toEqual([])
})

test('the coldGate setting turns it off', { options: { coldGate: false } }, async ($, on) => {
  const { clock, asked } = engine(on, { pick: 'Cancel' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  await turn($, [wrapUp()])
  await clock.advance(70 * MINUTE)
  expect(await say($, 'Carry on')).toEqual({ text: 'Carry on' })
  expect(asked).toEqual([])
})
