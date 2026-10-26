#!/bin/bash

# Claude Code status line (Git Bash on Windows). Two lines:
#   repo  branch ✓  ·  "session name"  ·  Opus 5.5 ◆high
#   ctx ▰▱▱▱▱▱▱▱▱▱ 6%/1M │ 5h ▱▱▱▱▱ 2% ↻ 1h24m │ 7d ▰▰▰▰▱ 89% ↻ 5h33m │ ≈$1.02 · 1.3M in · 18k out · 5m │ cache ● 52m
# Forks are slow under Git Bash, so it keeps them few (one jq, one git, one stat, plus a
# tail/jq per transcript that grew) and the helpers set REPLY instead of being called
# through $(...).
# Cost is the API-price estimate Claude Code reports; on a subscription it's a measure of
# session weight, not a bill, so it's never colored as a warning.
#
# Needs bash 5, jq, git and GNU coreutils (Git Bash or Linux). Enable in ~/.claude/settings.json:
#   "statusLine": {
#     "type": "command",
#     "command": "bash ~/.claude/statusline-command.sh",
#     "refreshInterval": 60
#   }
# refreshInterval keeps the countdowns ticking while idle. Token totals are kept per session
# in ~/.claude/statusline-state/ (pruned after 30 days).

input=$(cat)

RST=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; ITAL=$'\033[3m'
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
MAGENTA=$'\033[35m'; CYAN=$'\033[36m'
SEP=" ${DIM}│${RST} "

# --- Parse JSON ---
# One record, unit-separator delimited so empty fields don't shift the rest; newlines and
# separators inside values are blanked so they can't either.
US=$'\x1f'
parsed=$(jq -r '[
  (.model.display_name // "Claude"),
  (.effort.level // ""),
  (.fast_mode // false),
  (.session_name // ""),
  (.workspace.current_dir // .cwd // ""),
  (.workspace.project_dir // ""),
  (.workspace.repo.name // ""),
  (.context_window.used_percentage // 0 | floor),
  (.context_window.context_window_size // 0),
  (.rate_limits.five_hour.used_percentage // "" | if . == "" then . else floor end),
  (.rate_limits.five_hour.resets_at // ""),
  (.rate_limits.seven_day.used_percentage // "" | if . == "" then . else floor end),
  (.rate_limits.seven_day.resets_at // ""),
  ((.cost.total_cost_usd // 0) * 100 | round),
  ((.cost.total_duration_ms // 0) / 1000 | floor),
  (.session_id // ""),
  (.transcript_path // ""),
  (.prompt_cache.warm | if . == null then "" else . end),
  (.prompt_cache.expires_at // "")
] | map(tostring | gsub("[\r\n\u001f]"; " ")) | join("\u001f")' <<< "$input" 2>/dev/null)
parsed=${parsed%$'\r'}

IFS="$US" read -r model effort fast session cur_dir proj_dir repo_name \
  ctx_pct ctx_size h5_pct h5_reset d7_pct d7_reset \
  cost_cents dur_s session_id transcript cache_warm cache_exp <<< "$parsed"

now=${EPOCHSECONDS:-$(date +%s)}
cur_dir=${cur_dir//\\//}
proj_dir=${proj_dir//\\//}
transcript=${transcript//\\//}
[ -z "$cur_dir" ] && cur_dir=$PWD
: "${model:=Claude}" "${ctx_pct:=0}" "${ctx_size:=0}" "${cost_cents:=0}" "${dur_s:=0}"

# --- Helpers (result in REPLY) ---
# Compact duration from seconds: 40s, 12m, 1h24m, 3d4h
fmt_dur() {
  local s=$1
  if   [ "$s" -lt 60 ];    then printf -v REPLY '%ds' "$s"
  elif [ "$s" -lt 3600 ];  then printf -v REPLY '%dm' $((s / 60))
  elif [ "$s" -lt 86400 ]; then printf -v REPLY '%dh%02dm' $((s / 3600)) $((s % 3600 / 60))
  else                          printf -v REPLY '%dd%dh' $((s / 86400)) $((s % 86400 / 3600))
  fi
}

# Color for percentage $1 with yellow/red thresholds $2/$3
pct_color() {
  if   [ "$1" -ge "$3" ]; then REPLY=$RED
  elif [ "$1" -ge "$2" ]; then REPLY=$YELLOW
  else                         REPLY=$GREEN
  fi
}

# Bar of $2 cells for percentage $1; any nonzero usage shows at least one cell
bar() {
  local filled=$(( ($1 * $2 + 50) / 100 )) i
  [ "$1" -gt 0 ] && [ "$filled" -eq 0 ] && filled=1
  [ "$filled" -gt "$2" ] && filled=$2
  REPLY=""
  for ((i = 0; i < $2; i++)); do
    if [ "$i" -lt "$filled" ]; then REPLY+="▰"; else REPLY+="▱"; fi
  done
}

# Compact token count: 950, 18k, 1.3M
fmt_tok() {
  local n=$1
  if   [ "$n" -lt 1000 ];    then REPLY=$n
  elif [ "$n" -lt 1000000 ]; then REPLY="$((n / 1000))k"
  else                            REPLY="$((n / 1000000)).$((n % 1000000 / 100000))M"
  fi
}

# Folds newly appended transcript lines into byte offset / last message id / token sums.
# "in" is non-cached input: fresh + cache-write, leaving out the cheap re-sent cache reads.
# A message is logged once per content block with identical usage, so a repeat of the
# previous id counts once. A line that doesn't parse is held back (it's usually still being
# written) and skipped only once a later line shows it was garbage.
TOK_JQ='reduce inputs as $l ({off: 0, pend: null, last: $last, in: 0, out: 0};
  (if .pend then .off += .pend | .pend = null else . end)
  | ($l | try fromjson catch null) as $j
  | if $j == null and $l != "" then .pend = ($l | utf8bytelength) + 1
    else .off += ($l | utf8bytelength) + 1
      | if $j.type == "assistant" and $j.message.usage and $j.message.id != .last then
          .last = $j.message.id
          | .in += ($j.message.usage | (.input_tokens // 0) + (.cache_creation_input_tokens // 0))
          | .out += ($j.message.usage.output_tokens // 0)
        else . end
    end)
  | "\(.off) \(.last) \(.in) \(.out)"'

# Session token totals (main transcript + subagents) into tok_in / tok_out. Reads only the
# bytes appended since the last refresh; per-file offsets and sums persist in a state file.
count_tokens() {
  tok_in=0 tok_out=0
  [ -n "$session_id" ] && [ -f "$transcript" ] || return
  local dir=~/.claude/statusline-state state size path off last i o d_off d_in d_out rows=""
  local -A s_off s_last s_in s_out
  [ -d "$dir" ] || mkdir -p "$dir"
  state="$dir/$session_id"
  if [ -f "$state" ]; then
    while IFS=$'\t' read -r off last i o path; do
      s_off[$path]=$off s_last[$path]=$last s_in[$path]=$i s_out[$path]=$o
    done < "$state"
  else
    find "$dir" -type f -mtime +30 -delete 2>/dev/null  # once per session
  fi

  local files=("$transcript") sub=${transcript%.jsonl}/subagents
  [ -d "$sub" ] && files+=("$sub"/*.jsonl)
  while read -r size path; do
    off=${s_off[$path]:-0} last=${s_last[$path]:--} i=${s_in[$path]:-0} o=${s_out[$path]:-0}
    # Offset can sit one past EOF (complete last line, newline not yet written)
    [ $((size + 1)) -lt "$off" ] && off=0 last=- i=0 o=0  # file was rewritten: recount
    if [ "$size" -gt "$off" ]; then
      # jq reads a pipe several times slower than a file under Git Bash, so a first read
      # (possibly a resumed session's whole transcript) gives jq the file itself
      if [ "$off" -eq 0 ]; then
        read -r d_off last d_in d_out < <(jq -R -r -n --arg last "$last" "$TOK_JQ" "$path" 2>/dev/null)
      else
        read -r d_off last d_in d_out < <(tail -c +$((off + 1)) "$path" \
          | jq -R -r -n --arg last "$last" "$TOK_JQ" 2>/dev/null)
      fi
      d_out=${d_out%$'\r'}
      off=$((off + ${d_off:-0})) i=$((i + ${d_in:-0})) o=$((o + ${d_out:-0})) last=${last:--}
    fi
    tok_in=$((tok_in + i)) tok_out=$((tok_out + o))
    rows+="$off"$'\t'"$last"$'\t'"$i"$'\t'"$o"$'\t'"$path"$'\n'
  done < <(stat -c '%s %n' "${files[@]}" 2>/dev/null)
  printf '%s' "$rows" > "$state"
}

# --- Line 1: where you are ---
git_out=$(git -C "$cur_dir" --no-optional-locks status --porcelain=v2 --branch 2>/dev/null)
if [ -n "$git_out" ]; then
  branch="" oid="" ahead=0 behind=0 changes=0
  while IFS= read -r l; do
    l=${l%$'\r'}
    case "$l" in
      "# branch.head "*) branch=${l#\# branch.head } ;;
      "# branch.oid "*)  oid=${l#\# branch.oid } ;;
      "# branch.ab "*)   read -r _ _ a b <<< "$l"; ahead=${a#+}; behind=${b#-} ;;
      "#"*) ;;
      ?*) changes=$((changes + 1)) ;;
    esac
  done <<< "$git_out"
  [ "$branch" = "(detached)" ] && branch="@${oid:0:7}"

  if [ -z "$proj_dir" ] || [ "$cur_dir" = "$proj_dir" ]; then
    where=${repo_name:-${cur_dir##*/}}
  elif [ "${cur_dir#"$proj_dir"/}" != "$cur_dir" ]; then
    where="${repo_name:-${proj_dir##*/}}/${cur_dir#"$proj_dir"/}"
  else
    where=${cur_dir##*/}  # outside the project, so the payload's repo name isn't this repo
  fi

  if [ "$changes" -gt 0 ]; then state="${YELLOW}±${changes}${RST}"; else state="${GREEN}✓${RST}"; fi
  [ "$ahead" -gt 0 ] 2>/dev/null && state+=" ${CYAN}↑${ahead}${RST}"
  [ "$behind" -gt 0 ] 2>/dev/null && state+=" ${RED}↓${behind}${RST}"
  line1="${BOLD}${CYAN}${where}${RST}  ${MAGENTA}${branch}${RST} ${state}"
else
  line1="${BOLD}${CYAN}${cur_dir##*/}${RST}"
fi

[ -n "$session" ] && line1+="  ${DIM}·  ${ITAL}\"${session}\"${RST}"

line1+="  ${DIM}·${RST}  ${BOLD}${model}${RST}"
[ -n "$effort" ] && line1+=" ${DIM}◆${effort}${RST}"
[ "$fast" = "true" ] && line1+=" ${YELLOW}⚡fast${RST}"

# --- Line 2: gauges ---
if   [ "$ctx_size" -ge 1000000 ]; then size_lbl="${DIM}/$((ctx_size / 1000000))M${RST}"
elif [ "$ctx_size" -gt 0 ];       then size_lbl="${DIM}/$((ctx_size / 1000))k${RST}"
else size_lbl=""
fi
pct_color "$ctx_pct" 50 80; c=$REPLY
bar "$ctx_pct" 10
line2="${DIM}ctx${RST} ${c}${REPLY} ${ctx_pct}%${RST}${size_lbl}"

# ':' isn't IFS whitespace, so a missing percentage stays empty instead of taking the reset
for lim in "5h:$h5_pct:$h5_reset" "7d:$d7_pct:$d7_reset"; do
  IFS=: read -r label pct reset <<< "$lim"
  [ -z "$pct" ] && continue
  pct_color "$pct" 60 85; c=$REPLY
  bar "$pct" 5
  line2+="${SEP}${DIM}${label}${RST} ${c}${REPLY} ${pct}%${RST}"
  if [ -n "$reset" ] && [ "$reset" -gt "$now" ] 2>/dev/null; then
    fmt_dur $((reset - now)); line2+=" ${DIM}↻ ${REPLY}${RST}"
  fi
done

printf -v REPLY '≈$%d.%02d' $((cost_cents / 100)) $((cost_cents % 100))
line2+="${SEP}${REPLY}"
count_tokens
if [ "$tok_in" -gt 0 ]; then
  fmt_tok "$tok_in";  line2+=" ${DIM}·${RST} ${REPLY} ${DIM}in${RST}"
  fmt_tok "$tok_out"; line2+=" ${DIM}·${RST} ${REPLY} ${DIM}out${RST}"
fi
fmt_dur "$dur_s"
line2+=" ${DIM}· ${REPLY}${RST}"

if [ "$cache_warm" = "true" ] && [ -n "$cache_exp" ] && [ "$cache_exp" -gt "$now" ] 2>/dev/null; then
  fmt_dur $((cache_exp - now))
  line2+="${SEP}${DIM}cache${RST} ${GREEN}●${RST} ${DIM}${REPLY}${RST}"
elif [ -n "$cache_warm" ]; then
  line2+="${SEP}${DIM}cache${RST} ${YELLOW}○ cold${RST}"
fi

printf '%s\n%s' "$line1" "$line2"
