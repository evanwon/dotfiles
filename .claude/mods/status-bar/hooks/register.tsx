import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Git, Tokens, Usage } from '../types'

// The desktop counterpart of ~/.claude/statusline-command.sh: one calm line above
// the prompt, where you are on the left and the gauges on the right.
//   dotfiles  claude-statusline ✓        ctx ━━──── 24%   5h ━─── 9%  7d ━━━━ 90% · 4h40m   ≈$4.77 · 1.3M in · 18k out · 15m   ● 52m
// It stays gray until something needs you: a gauge turns amber or red past its
// threshold (context 50/80%, limits 60/85%), and a limit shows its reset countdown
// only then. Groups wrap whole as the window narrows (5h and 7d together, cost and
// cache together).
// Clicking a piece's label shows its exact figures on a line above the band, so the
// band's own line doesn't move; clicking it again hides them. The model, effort and
// session title are left out: the app shows them already. The terminal keeps the
// script, so the band draws on desktop alone.
// Cost is the API-price estimate Claude Code reports; on a subscription it's a
// measure of session weight, not a bill, so it's never colored as a warning.
// Token totals are read once from the session's transcript with jq (it can be far
// past the 4 MiB a mod may read itself), then summed from each model request's
// usage as the session goes, subagents included.

const MINUTE = 60_000
// Tools after which the working tree may have changed
const WRITERS = new Set(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const git = atom({ plugin: 'status-bar', key: 'git' } as const, null)
const usage = atom({ plugin: 'status-bar', key: 'usage' } as const, null)
const tokens = atom({ plugin: 'status-bar', key: 'totals' } as const, null)
const lastResponseAt = atom({ plugin: 'status-bar', key: 'lastResponseAt' } as const, null)
const now = atom({ plugin: 'status-bar', key: 'now' } as const, 0)
// Which piece's detail line is showing
const open = atom({ plugin: 'status-bar', key: 'open' } as const, null)

// Thresholds per gauge: [amber, red]
const CTX_LEVELS = [50, 80] as const
const LIMIT_LEVELS = [60, 85] as const

// Bar colors that read on light and dark alike; the track is the calm color, faded
const CALM = '#8a8a8a'
const AMBER = '#d99a1e'
const RED = '#e24b4a'

// --- Formatting ---

// Compact duration from seconds: 40s, 12m, 1h24m, 3d4h
function fmtDur(s: number): string {
  s = Math.max(0, Math.floor(s))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`
}

// Compact token count: 950, 18k, 1.3M
function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`
  return `${Math.floor(n / 1_000_000)}.${Math.floor((n % 1_000_000) / 100_000)}M`
}

// 1234567 -> 1,234,567
function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Local clock time, with the weekday when it's more than ~20h away: 3:10 PM, Sat 3:10 PM
function fmtClock(ms: number, from: number): string {
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  if (Math.abs(ms - from) < 20 * 60 * MINUTE) return time
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${time}`
}

// 0 calm, 1 amber, 2 red
function level(p: number, [amber, red]: readonly [number, number]): 0 | 1 | 2 {
  return p >= red ? 2 : p >= amber ? 1 : 0
}

// A thin bar, `width` CSS pixels wide; any nonzero usage shows at least a sliver
function barSvg(p: number, width: number, lvl: 0 | 1 | 2): string {
  const fill = p <= 0 ? 0 : Math.max(2, Math.round((Math.min(p, 100) / 100) * width))
  const color = [CALM, AMBER, RED][lvl]
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="4" viewBox="0 0 ${width} 4">` +
    `<rect width="${width}" height="4" rx="2" fill="${CALM}" fill-opacity="0.3"/>` +
    `<rect width="${fill}" height="4" rx="2" fill="${color}"/></svg>`
  )
}

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '$' }

// --- Gathering ---

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').at(-1) ?? path
}

const slash = (p: string) => p.replace(/\\/g, '/')

// The repo and git state of the session's directory, from one `git status`.
async function readGit($: EngineInterface): Promise<Git> {
  const [cwd, root, repo] = await Promise.all([$.session.cwd(), $.session.root(), $.session.repo()])
  const cur = slash(cwd)
  const proj = slash(root)
  const repoName = repo ? basename(slash(repo.root)) : ''

  let where: string
  if (cur === proj) where = repoName || basename(cur)
  else if (cur.startsWith(proj + '/')) where = `${repoName || basename(proj)}/${cur.slice(proj.length + 1)}`
  else where = basename(cur) // outside the project, so the session's repo isn't this one

  const empty: Git = { where, branch: '', upstream: '', changes: 0, ahead: 0, behind: 0 }
  const out = await $.process
    .run(['git', '-C', cwd, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 10_000 })
    .catch(() => null)
  if (!out || out.exitCode !== 0) return { ...empty, where: basename(cur) }

  let oid = ''
  const found = { ...empty }
  for (const raw of out.stdout.split('\n')) {
    const l = raw.replace(/\r$/, '')
    if (l.startsWith('# branch.head ')) found.branch = l.slice(14)
    else if (l.startsWith('# branch.oid ')) oid = l.slice(13)
    else if (l.startsWith('# branch.upstream ')) found.upstream = l.slice(18)
    else if (l.startsWith('# branch.ab ')) {
      const [, , a = '+0', b = '-0'] = l.split(' ')
      found.ahead = Number(a.slice(1)) || 0
      found.behind = Number(b.slice(1)) || 0
    } else if (l && !l.startsWith('#')) found.changes += 1
  }
  if (found.branch === '(detached)') found.branch = `@${oid.slice(0, 7)}`
  return found
}

async function readUsage($: EngineInterface): Promise<Usage> {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  return {
    startedAt: u.startedAt,
    ctxTokens: u.context.tokens ?? null,
    ctxPercent: u.context.percent ?? null,
    ctxWindow: u.context.window,
    autoCompactAt: b?.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
    slices: (b?.categories ?? [])
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .sort((x, y) => y.tokens - x.tokens)
      .slice(0, 3)
      .map(c => ({ name: c.name, tokens: c.tokens })),
    limits: u.rateLimits.map(r => {
      const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
      return { kind: r.kind, percent: Math.floor(r.percentUsed), resetsAt: Number.isNaN(at) ? null : at }
    }),
    costUsd: u.cost?.usd ?? null,
  }
}

// Sums assistant usage over transcript lines: "in out last-timestamp". A message is
// logged once per content block with identical usage, so a repeat of the previous id
// counts once; a line that doesn't parse (one still being written) is skipped.
const TOK_JQ = `reduce inputs as $l ({last: null, in: 0, out: 0, at: ""};
  ($l | try fromjson catch null) as $j
  | if $j.type == "assistant" and $j.message.usage and $j.message.id != .last then
      .last = $j.message.id
      | .in += ($j.message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0))
      | .out += ($j.message.usage.output_tokens // 0)
      | .at = ($j.timestamp // .at)
    else . end)
| "\\(.in) \\(.out) \\(.at)"`

// The session's transcript: ~/.claude/projects/<project slug>/<session id>.jsonl, the
// slug being the directory it started in with every other character a '-'. A session
// that has moved since is found by looking through the project folders.
async function findTranscript($: EngineInterface, id: string): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) return null
  const projects = `${slash(home)}/.claude/projects`
  const guess = `${projects}/${slash(await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
  if (await $.fs.exists(guess)) return guess
  for (const dir of await $.fs.list(projects).catch(() => [])) {
    const path = `${projects}/${dir.name}/${id}.jsonl`
    if (dir.kind === 'dir' && (await $.fs.exists(path))) return path
  }
  return null
}

async function sumTranscripts($: EngineInterface, files: string[]) {
  const out = await $.process
    .run(['jq', '-R', '-r', '-n', TOK_JQ, ...files], { timeoutMs: 120_000 })
    .catch(() => null)
  if (!out || out.exitCode !== 0) return null
  const [i = '0', o = '0', at = ''] = out.stdout.trim().split(' ')
  return { in: Number(i) || 0, out: Number(o) || 0, at: at ? Date.parse(at) : NaN }
}

// The session's token totals so far (main transcript and subagents') and when the
// main thread last had a response, read once when the mod first loads in a session.
async function backfill($: EngineInterface) {
  const id = await $.session.id()
  const main = await findTranscript($, id)
  let found: Tokens = { in: 0, out: 0, fromStart: false }
  let last: number | null = null
  if (main) {
    const subDir = main.replace(/\.jsonl$/, '/subagents')
    const subs = (await $.fs.list(subDir).catch(() => []))
      .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
      .map(f => `${subDir}/${f.name}`)
    const [m, s] = await Promise.all([
      sumTranscripts($, [main]),
      subs.length > 0 ? sumTranscripts($, subs) : { in: 0, out: 0, at: NaN },
    ])
    if (m && s) {
      found = { in: m.in + s.in, out: m.out + s.out, fromStart: true }
      if (!Number.isNaN(m.at)) last = m.at
    }
  }
  // Live counting waits for this (tokens is null until now): the transcript holds the
  // requests answered while jq ran
  await update($, tokens, () => found)
  if (last !== null) await update($, lastResponseAt, held => (held !== null && held > last ? held : last))
}

let ttlMs = 60 * MINUTE
let gitBusy = false
let gitAgain = false

// One `git status` at a time; a request while one runs queues a single rerun.
async function refreshGit($: EngineInterface) {
  if (gitBusy) {
    gitAgain = true
    return
  }
  gitBusy = true
  try {
    do {
      gitAgain = false
      const g = await readGit($)
      await update($, git, () => g)
    } while (gitAgain)
  } finally {
    gitBusy = false
  }
}

async function refreshUsage($: EngineInterface) {
  const u = await readUsage($)
  await update($, usage, () => u)
}

export const register: Register = (on, options) => {
  ttlMs = (options.cacheTtl === '5m' ? 5 : 60) * MINUTE

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const t = await $.clock.now()
    await update($, now, () => t)
    // A reload keeps the session's state; only a first load reads the transcript
    if ((await read($, tokens)) === null) void backfill($)
    void refreshGit($)
    void refreshUsage($)
    // Keeps the countdowns ticking while idle, and catches git changes made elsewhere
    $.clock.every(MINUTE, () => {
      void $.clock.now().then(t => update($, now, () => t))
      void refreshGit($)
    })
    return started
  })

  on('session.measure', async ($, e, next) => {
    void refreshUsage($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      const fresh = u.input_tokens + u.cache_creation_input_tokens
      await update($, tokens, t =>
        t === null ? t : { ...t, in: t.in + fresh, out: t.out + u.output_tokens },
      )
      if (e.agentId === undefined) {
        const at = await $.clock.now()
        await update($, lastResponseAt, () => at)
        await update($, now, () => at)
      }
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (WRITERS.has(String(e.tool))) void refreshGit($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) void refreshGit($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const [g, u, t, last, t0, shown] = await Promise.all([
      read($, git),
      read($, usage),
      read($, tokens),
      read($, lastResponseAt),
      read($, now),
      read($, open),
    ])
    const details: Record<string, string> = {}
    const tone = (lvl: 0 | 1 | 2) => (lvl === 2 ? 'error' : lvl === 1 ? 'warning' : undefined)

    // A piece's dim label, which shows or hides its detail line. Only the label is a
    // button: the desktop draws a button's text in its own style, so colored values
    // stay outside it.
    const toggle = (key: string, detail: string, label: string) => {
      details[key] = detail
      return (
        <Button key={key} plain dimColor onPress={() => update($, open, cur => (cur === key ? null : key))}>
          {label}
        </Button>
      )
    }
    // The pieces of one group, tight together: a button's own padding spaces its label
    const row = (...children: (JSX.Element | false | null)[]) => (
      <Box flexDirection="row" alignItems="center">
        {children}
      </Box>
    )

    // A label, its bar and its percentage, colored only past its amber threshold
    const gauge = (
      key: string,
      detail: string,
      label: string,
      p: number | null,
      width: number,
      lvl: 0 | 1 | 2,
      extra?: string,
    ) =>
      row(
        toggle(key, detail, label),
        <Svg source={barSvg(p ?? 0, width, lvl)} alt={`${label} ${p ?? 0}%`} width={width} height={4} />,
        <Text tabular color={tone(lvl)} dimColor={lvl === 0}>
          {p === null ? ' –' : ` ${p}%`}
          {extra}
        </Text>,
      )

    // --- Where you are ---
    const where =
      g &&
      row(
        <Text weight="medium">{g.where}</Text>,
        g.branch !== '' &&
          toggle(
            'git',
            [
              g.changes === 0 ? 'Working tree clean' : `${g.changes} changed ${g.changes === 1 ? 'path' : 'paths'}`,
              g.upstream ? `${g.ahead} ahead, ${g.behind} behind ${g.upstream}` : 'no upstream branch',
            ].join(' · '),
            `${g.branch} ${g.changes > 0 ? `±${g.changes}` : '✓'}${g.ahead > 0 ? ` ↑${g.ahead}` : ''}`,
          ),
        g.behind > 0 && <Text color="warning">↓{g.behind}</Text>,
      )

    // --- Context ---
    const ctx =
      u &&
      gauge(
        'ctx',
        [
          u.ctxTokens === null
            ? 'No response yet in this context window'
            : `${fmtInt(u.ctxTokens)} of ${fmtInt(u.ctxWindow)} tokens`,
          u.autoCompactAt === null
            ? 'auto-compact off'
            : `auto-compacts at ${fmtInt(u.autoCompactAt)} (${Math.round((u.autoCompactAt / u.ctxWindow) * 100)}%)`,
          ...u.slices.map(s => `${s.name} ${fmtTok(s.tokens)}`),
        ].join(' · '),
        'ctx',
        u.ctxPercent,
        40,
        u.ctxPercent === null ? 0 : level(u.ctxPercent, CTX_LEVELS),
      )

    // --- Rate limits, kept together ---
    const limits = u && u.limits.length > 0 && (
      <Box flexDirection="row" columnGap={3}>
        {u.limits.map(l => {
          const lvl = level(l.percent, LIMIT_LEVELS)
          const left = l.resetsAt !== null && l.resetsAt > t0 ? fmtDur((l.resetsAt - t0) / 1000) : null
          return gauge(
            `limit-${l.kind}`,
            `${l.percent}% of the ${l.kind.replace(/_/g, ' ')} limit used · ` +
              (l.resetsAt === null ? 'reset time unknown' : `resets ${fmtClock(l.resetsAt, t0)}`) +
              (left === null ? '' : ` (in ${left})`),
            LIMIT_LABELS[l.kind] ?? l.kind,
            l.percent,
            28,
            lvl,
            lvl > 0 && left ? ` · ${left}` : undefined,
          )
        })}
      </Box>
    )

    // --- Session weight: all of it muted, so all of it is the label ---
    const cents = Math.round((u?.costUsd ?? 0) * 100)
    const session = toggle(
      'session',
      (u ? `Session started ${fmtClock(u.startedAt, t0)}, ${fmtDur((t0 - u.startedAt) / 1000)} ago · ` : '') +
        (t === null
          ? 'reading the transcript for token totals'
          : `${fmtInt(t.in)} input (fresh + cache-write) · ${fmtInt(t.out)} output tokens` +
            (t.fromStart ? '' : ', counted since the band loaded')) +
        ' · cost is an API-price estimate: on a subscription, session weight rather than a bill',
      `≈$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` +
        (t !== null && t.in > 0 ? ` · ${fmtTok(t.in)} in · ${fmtTok(t.out)} out` : '') +
        (u ? ` · ${fmtDur((t0 - u.startedAt) / 1000)}` : ''),
    )

    // --- Prompt cache ---
    const expires = last === null ? 0 : last + ttlMs
    const isWarm = expires > t0
    const cache =
      last !== null &&
      row(
        <Text color={isWarm ? 'success' : 'warning'}>{isWarm ? '●' : '○'}</Text>,
        toggle(
          'cache',
          `Prompt cache · last response ${fmtClock(last, t0)} · ` +
            (isWarm ? `expires ${fmtClock(expires, t0)}` : 'the next request re-writes it') +
            ` · ${ttlMs === 5 * MINUTE ? '5m' : '1h'} TTL (plugin setting)`,
          isWarm ? fmtDur((expires - t0) / 1000) : 'cold',
        ),
      )

    // The open piece's detail, above the band so the band's own line doesn't move
    const detail = shown !== null ? details[shown] : undefined

    return (
      <Box flexDirection="column">
        {detail !== undefined && (
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Text dimColor size="footnote">
              {detail}
            </Text>
            <Button key="close" role="dismiss" label="Hide details" onPress={() => update($, open, () => null)} />
          </Box>
        )}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={4}>
          {where}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={3}>
            {ctx}
            {limits}
            {/* Cost and cache wrap as a pair, so neither is left alone on a line */}
            <Box flexDirection="row" alignItems="center" columnGap={3}>
              {session}
              {cache}
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
}
