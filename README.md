dotfiles
========

These are my dotfiles. I probably didn't create all of these.

Claude Code
-----------

`.claude/statusline-command.sh` is the terminal status line; copy it to `~/.claude/` and
enable it as its header comment describes.

`.claude/mods/status-bar` is its counterpart for Claude Code Desktop: a band above the
prompt with git state, context, rate limits, cost, tokens and prompt-cache warmth. This
repo is a plugin marketplace for it. Install it once per machine:

```
claude plugin install status-bar --marketplace evanwon/dotfiles
```

After pushing a change, `claude plugin update status-bar` picks it up. It reads token
totals from the session transcript with `jq`, which needs to be on the `PATH`.
