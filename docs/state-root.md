# Where gstack keeps its state

gstack keeps everything it remembers — config, analytics, sessions, projects,
learnings, review logs, the egress ledger, the trust-policy store, hook error
logs — under one directory, the **state root**. By default that is
`~/.gstack`. Set `GSTACK_HOME` to put it somewhere else.

One rule picks the root, and every gstack script, hook and skill uses it. The
rule lives in two owner files that a parity test keeps identical:
`bin/gstack-state-root.sh` (bash) and `lib/state-root.ts` (TypeScript).

## How the root is chosen

The first variable in this list with a non-empty value wins. Empty values count
as unset.

| Order | Source | When to use it |
|------:|--------|----------------|
| 1 | `GSTACK_STATE_ROOT` | `gstack-paths`' own output. It is also honored as input, so re-reading it in the same environment returns the same root. Do not set it by hand. |
| 2 | `GSTACK_HOME` | **The one variable to set** when you want your state somewhere other than `~/.gstack`. |
| 3 | `GSTACK_STATE_DIR` | Legacy alias, honored for compatibility. |
| 4 | `CLAUDE_PLUGIN_DATA` | Only when `CLAUDE_PLUGIN_ROOT` contains `gstack` (any case), so another plugin's data directory never captures gstack state. |
| 5 | `$HOME/.gstack` | The default. On Windows shells, `USERPROFILE` stands in when `HOME` is unset. |
| 6 | `.gstack` | Last resort when there is no home directory at all (some containers). |

## See which root is in use

```bash
~/.claude/skills/gstack/bin/gstack-paths --explain
```

Real output with `GSTACK_HOME` set while `~/.gstack` still holds older state:

```
state root: /home/you/work-state (selected by GSTACK_HOME)
chain (first non-empty wins):
  GSTACK_STATE_ROOT    unset
  GSTACK_HOME          /home/you/work-state  selected
  GSTACK_STATE_DIR     unset
  CLAUDE_PLUGIN_DATA   unset
  default              /home/you/.gstack  ignored
default root /home/you/.gstack also holds gstack state: yes
merged privacy keys (most restrictive value across roots wins):
  telemetry:        off (from /home/you/.gstack/config.yaml)
  memorable_recall: not set (default applies)
  codex_reviews:    not set (default applies)
  update_check:     not set (default applies)
docs: https://github.com/garrytan/gstack/blob/main/docs/state-root.md
```

`--explain` only reads; it writes nothing and exits 0. `gstack-config list`
also prints a one-line note when `GSTACK_STATE_ROOT`, `GSTACK_HOME` and
`GSTACK_STATE_DIR` name different directories.

## Move your state

gstack never moves state for you. To relocate it:

```bash
cp -a ~/.gstack /new/place/gstack-state
export GSTACK_HOME=/new/place/gstack-state   # add this to your shell profile
~/.claude/skills/gstack/bin/gstack-paths --explain   # confirm: selected by GSTACK_HOME
```

Keep or delete the old `~/.gstack` once you have checked the new root works.
Until you delete it, its privacy settings still count (next section).

## Privacy settings never get looser when the root moves

Four config keys are opt-outs: `telemetry` (off < anonymous < community),
`memorable_recall` (off < on), `codex_reviews` (disabled < enabled) and
`update_check` (false < true). gstack reads each of them from the resolved root
**and** from `~/.gstack`, and uses the most restrictive value. So turning
telemetry off once in `~/.gstack` keeps it off after you set `GSTACK_HOME`.
Every other key, including `proactive` and `founder_resources`, reads the
resolved root only.

When `gstack-config set` writes a merged key but the other root still holds a
more restrictive value, it tells you which root overrides it and prints the
command that changes that root, for example:

```bash
GSTACK_STATE_ROOT='/home/you/.gstack' ~/.claude/skills/gstack/bin/gstack-config set codex_reviews enabled
```

`gstack-config list` shows the winning root for merged keys, for example
`telemetry: off (set, /home/you/.gstack)`.

Trust-policy deny tiers merge the same way: a `deny` or `read-only` entry in
`~/.gstack/gbrain-repo-policy.json` still applies when your resolved root is
elsewhere. Nothing is ever written to the other root.

## Uninstall

`gstack-uninstall` deletes state only at `~/.gstack`.

- It first refuses (exit 2) when `~/.gstack` resolves — following symlinks —
  to `/`, your home directory or one of its parents, the gstack checkout, the
  current git repository, or a parent of either. The message names the reason
  and a `fix:` line.
- When the resolved root is somewhere else (you set `GSTACK_HOME`, for
  example), uninstall leaves it in place and prints
  `left in place: <path> (selected by <VAR>=<value>)` plus the exact
  `rm -rf -- '<path>'` command to run after you have checked it.
- `--keep-state` never deletes any state. `--force` only skips the prompt.

## If gstack-paths is missing

Skill blocks resolve the root with

```bash
eval "$(~/.claude/skills/gstack/bin/gstack-paths)"; : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
```

The second half stops the block instead of writing under `/` if the resolver
is broken. If you see `gstack-paths failed` or
`cannot resolve the gstack state root`, reinstall: run `./setup` in the gstack
checkout, or `/gstack-upgrade`.

## Claude Code plugin installs

gstack does not ship an official Claude Code plugin distribution today (no
`.claude-plugin` manifest has ever been on `main`; some forks publish one), and
telemetry does not report plugin-mode installs. When gstack does run as a
plugin, `CLAUDE_PLUGIN_ROOT` names gstack and state lives in
`CLAUDE_PLUGIN_DATA`, while a terminal run outside the plugin session uses
`~/.gstack`. Those are two different roots; run `gstack-paths --explain` in
each environment to see which one is active. Cross-environment support (a
pointer from `~/.gstack` to the plugin root) is deferred until a plugin
distribution exists.

## For contributors

- Bash: executables source `bin/gstack-state-root.sh` beside them and call
  `gstack_state_root_select` (sets `$_gstack_sr_root`), or `eval` gstack-paths
  with the guard above. Hooks must source the twin; never spawn gstack-paths
  from a hook.
- TypeScript: `resolveStateRoot()` and `readConfigKey()` from
  `lib/state-root.ts`.
- `test/state-root-ratchet.test.ts` fails on a hand-rolled chain, an
  executable `~/.gstack` in a template bash block, an unguarded gstack-paths
  eval or `export GSTACK_STATE_ROOT` in prose. Its allowlist
  (`test/state-root-ratchet.allowlist.json`) needs a reason per entry.
