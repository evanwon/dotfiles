import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'status-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse('2026-10-25T15:00:00Z')
const TRANSCRIPT = 'C:/Users/me/.claude/projects/C--Users-me-src-dotfiles/s1.jsonl'

const GIT_STATUS = [
  '# branch.oid 4c20d63aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '# branch.head claude-statusline',
  '# branch.upstream origin/claude-statusline',
  '# branch.ab +1 -0',
  '1 .M N... 100644 100644 100644 aaa bbb .claude/statusline-command.sh',
  '? notes.txt',
  '',
].join('\n')

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('the band is one calm line, colored only where a limit is close', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  const clock = mock.clock(on, { now: START })
  mock.env(on, { USERPROFILE: 'C:\\Users\\me' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: 'C:\\Users\\me\\src\\dotfiles\\.claude' }))
  on('session.root', () => ({ value: 'C:\\Users\\me\\src\\dotfiles' }))
  on('session.repo', () => ({
    value: { root: 'C:\\Users\\me\\src\\dotfiles', remote: null, internal: false, name: null },
  }))
  // The engine hands paths on in the platform's spelling
  on('fs.exists', (_, e) => ({ value: e.path.replace(/\\/g, '/') === TRANSCRIPT }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_, e) =>
    e.argv[0] === 'jq' ? ran(`1300000 18000 ${new Date(START - 8 * MINUTE).toISOString()}\n`) : ran(GIT_STATUS),
  )
  on('session.usage', () => ({
    value: {
      startedAt: START - 15 * MINUTE,
      context: { tokens: 240_000, window: 1_000_000, percent: 24 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 9, resetsAt: new Date(START + 30 * MINUTE).toISOString() },
        { kind: 'seven_day', percentUsed: 90, resetsAt: new Date(START + 4 * HOUR + 40 * MINUTE).toISOString() },
      ],
      cost: { usd: 4.77 },
    },
  }))
  // The engine's own band: what the terminal keeps
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

  const label = async (key: string) => (await ui.find({ key }))?.text

  expect(await text(/^dotfiles/)).toBe('dotfiles/.claude')
  expect(await label('git')).toBe('claude-statusline ±2 ↑1')
  expect(await text(/^ 24%$/)).toBe(' 24%')
  // A calm limit hides its countdown; one past its threshold shows it
  expect(await text(/^ 9%$/)).toBe(' 9%')
  expect(await text(/^ 90% · /)).toBe(' 90% · 4h40m')
  // Totals come from the transcript, and its last response warms the cache
  expect(await label('session')).toBe('≈$4.77 · 1.3M in · 18k out · 15m')
  expect(await text(/^●$/)).toBe('●')
  expect(await label('cache')).toBe('52m')
  expect(await ui.find({ type: 'Svg' })).toBeDefined()

  // Details show on a click, one piece at a time, and hide on a second click
  expect(await text(/of 1,000,000 tokens/)).toBeUndefined()
  await ui.press({ key: 'ctx' })
  expect(await text(/^240,000 of 1,000,000 tokens/)).toBeDefined()
  await ui.press({ key: 'limit-five_hour' })
  expect(await text(/of 1,000,000 tokens/)).toBeUndefined()
  expect(await text(/resets .* \(in 30m\)/)).toBeDefined()
  await ui.press({ key: 'limit-five_hour' })
  expect(await text(/resets/)).toBeUndefined()
  await ui.press({ key: 'session' })
  expect(await text(/^Session started .*, 15m ago/)).toBeDefined()
  await ui.press({ key: 'close' })
  expect(await text(/^Session started/)).toBeUndefined()
  await ui.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await term.unmount()
})
