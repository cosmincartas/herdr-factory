#!/bin/sh
# Claude Code SessionStart hook: records which session runs in which hc
# terminal, so acp-view can resume that session over ACP (and hand it back).
# Fires on startup, /resume, /clear and compaction. Prints nothing: a
# SessionStart hook's output would be added to Claude's context.
[ -n "${HC_TERMINAL_ID-}" ] || { cat >/dev/null; exit 0; }
# Claude under an acp-view bridge: its terminal is the bridge's, not a claude TUI.
[ -z "${HERDR_ACP_VIEW_BRIDGE-}" ] || { cat >/dev/null; exit 0; }
dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-acp-view/terminals"
mkdir -p "$dir" 2>/dev/null || { cat >/dev/null; exit 0; }
tmp="$dir/.$HC_TERMINAL_ID.$$"
cat >"$tmp" && mv -f "$tmp" "$dir/$HC_TERMINAL_ID.json"
exit 0
