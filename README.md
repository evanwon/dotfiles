# dotfiles

These are my personal dotfiles and other configs I like. Maybe you'll like them too.

## Claude Code status line and status bar

Both show the same things at a glance: the repo and branch you're in, how much of the
context window you've used, how close you are to your rate limits, what the session has
cost so far, and whether the prompt cache is still warm. One is for the terminal, the
other for the desktop app.

### Terminal: `.claude/statusline-command.sh`

A two-line status line. Requires bash 5, git, jq and GNU coreutils (Linux, or Git Bash
on Windows). Copy it to `~/.claude/` and add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/statusline-command.sh",
  "refreshInterval": 60
}
```

### Desktop: `.claude/mods/status-bar`

One line above the prompt in Claude Code Desktop. It stays gray until something needs
your attention: context past 50%, or a rate limit past 60%. Click any label to see the
exact numbers.

It needs `git` and `jq` on your `PATH`. Install it once per machine:

```bash
claude plugin install status-bar --marketplace evanwon/dotfiles
```

Or, in the desktop app: **+** next to the prompt box → **Plugins** → **Add marketplace**
`evanwon/dotfiles` → **Add plugin** on `status-bar`.

The cache timer assumes a one-hour cache. If you use five-minute caching, add
`--config cacheTtl=5m` to the install command, or change it later with
`claude plugin configure status-bar`.

To update: `claude plugin update status-bar`. To remove: `claude plugin uninstall status-bar`.

## Claude Code cache alert: `.claude/mods/cache-alert`

A notification ten minutes before a session's prompt cache goes cold, so you can reply
while the cache is still warm. Once the cache expires, the next message has to send the
whole context again at full price.

It only alerts when both of these are true:

- **The session is waiting on you.** Its last turn ended on a question (the desktop
  app's next-step question, or a final line ending in `?`), is still showing a question
  or a plan for you to approve, stopped with steps left on its task list, or failed on
  an API error. A turn that ends with just a summary counts as done. Only a message from
  you counts as an answer: a turn something else started, like a background task's
  notice, keeps the session waiting.
- **The context is large**: at least 75,000 tokens by default. Below that, rebuilding
  the cache costs little.

You get at most one alert each time a session goes idle. On Windows it's a toast from
the Claude app that stays on screen until you click it (which opens Claude) or press
**Dismiss**. Elsewhere it goes through Claude Code's own terminal notification.

Type `/cache-alert` in a session to see whether it would get an alert and to send a
test notification.

If the cache has already gone cold, the mod asks before your next message goes out:
it names how long ago the cache went cold and how much context the message re-sends,
with **Send** and **Cancel**. Cancel holds the message back, and the desktop app keeps
it in the message box. It only asks when the context meets the same 75,000-token
threshold, and it skips slash commands, messages typed while Claude is still working,
and runs where nobody can answer (`claude -p`). Turn it off with `coldGate=false`.

When a session's process starts over, for example when the desktop app relaunches,
the mod rebuilds what it knew from the session's transcript, so an alert that's still
due still comes. If you reopen a session inside its last ten minutes, it doesn't alert,
since you're already there. The rebuild needs `jq` on your `PATH`.

Install it once per machine:

```bash
claude plugin install cache-alert --marketplace evanwon/dotfiles
```

Like the status bar, it assumes a one-hour cache. Change that with `cacheTtl=5m`, which
alerts two minutes ahead instead, and the token threshold with `minContextTokens`. Pass
either as `--config` to the install command, or change it later with
`claude plugin configure cache-alert`.

## Shell and terminal

| File | What it does |
|---|---|
| `shell/evanw.zsh-theme` | An oh-my-zsh prompt: an arrow that turns red after a failed command, the git branch with a mark when there are uncommitted changes, and the current directory on the right. |
| `shell/inputrc` | Turns off the terminal bell, which flashes the screen in Windows Terminal. |
| `iterm2/profile.json` | My iTerm2 profile with the Dracula colors. Import it from **Settings → Profiles → Other Actions → Import JSON Profiles**. |

Link or copy them where your tools expect them, for example:

```bash
ln -s ~/src/dotfiles/shell/inputrc ~/.inputrc
ln -s ~/src/dotfiles/shell/evanw.zsh-theme ~/.oh-my-zsh/custom/themes/
```

## Checks before a push

`scripts/hooks/pre-push` checks each commit being pushed, exported from git so
uncommitted changes don't count: `claude plugin validate`, `claude plugin test` and
`tsc` for each mod, `bash -n` on the status line script, and that
`.claude-plugin/marketplace.json` parses and names folders that exist. A failure
refuses the push. It takes about 20 seconds and needs `claude`, `jq` and Node (`npx`)
on your `PATH`. There's no CI: this hook is the check.

A Claude Code session in this repo turns it on (`.claude/settings.json` sets
`core.hooksPath` when the session starts). Elsewhere, turn it on once with:

```bash
git config core.hooksPath scripts/hooks
```

`tsc` needs this Claude Code version's mod types. There's no command that writes them:
the engine writes them to a temp folder when the `plugin-authoring` skill loads. The hook keeps a copy in `~/.cache/dotfiles/` once it finds them. Until then it
skips `tsc` and says so; loading the skill once (ask a session to make or change a mod)
fixes that, and again after each Claude Code update.

## License

MIT. See [LICENSE](LICENSE).
