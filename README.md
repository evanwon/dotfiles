dotfiles
========

These are my dotfiles. I probably didn't create all of these.

Claude Code
-----------

`.claude/statusline-command.sh` is the terminal status line; copy it to `~/.claude/` and
enable it as its header comment describes.

`.claude/mods/status-bar` is its counterpart for Claude Code Desktop: a band above the
prompt with git state, context, rate limits, cost, tokens and prompt-cache warmth. It
stays gray until a gauge passes its threshold; click a label (`ctx`, `5h`, the branch,
the cost) to see that piece's exact figures.

### Installing the status bar

Needs `git` and `jq` on the `PATH` (jq reads the session's token totals from its
transcript). This repo is a plugin marketplace, so the mod installs from GitHub and
Claude Code keeps its own copy: it doesn't matter where, or whether, this repo is checked
out. Once per machine, from a shell:

```
claude plugin install status-bar --marketplace evanwon/dotfiles
```

Answer `y` to add the `evanwon/dotfiles` marketplace. It installs at user scope, so every
session loads it, desktop sessions included; the band draws in the desktop app only, as
the terminal has the script.

From the desktop app instead: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `evanwon/dotfiles`, then **Add plugin** on `status-bar`.

The cache countdown assumes a 1-hour prompt-cache lifetime. On 5-minute caching, add
`--config cacheTtl=5m` to the install, or change it later with
`claude plugin configure status-bar`.

### Updating and removing

After pushing a change to `main`, `claude plugin update status-bar` picks it up in new
sessions. `claude plugin uninstall status-bar` removes it.
