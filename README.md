# dotfiles

My configuration for the tools I use every day, plus two add-ons for Claude Code.
Take whatever is useful.

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

## License

MIT. See [LICENSE](LICENSE).
