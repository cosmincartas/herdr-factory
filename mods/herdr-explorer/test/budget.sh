#!/bin/sh
# Render-budget check for one scenario.
#
#   sh test/budget.sh SCENARIO
#
# Copies this mod (without test/) to a temp folder, renames main.js to explorer.js, installs
# test/budget/SCENARIO.js as main.js (it subclasses Explorer and seeds state), then runs
# `herdr-app check` on that folder. Prints what check printed and exits with its status: the
# host's uncatchable interrupt is the oracle, so exit 1 with "interrupted" means the seeded work
# is over the render/init budget. The temp folder is removed; ~/.config/herdr-app is not touched.
set -u

scenario="${1:-}"
if [ -z "$scenario" ]; then
  echo "usage: sh test/budget.sh SCENARIO" >&2
  exit 2
fi

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mod=$(CDPATH= cd -- "$here/.." && pwd)
script="$here/budget/$scenario.js"
if [ ! -f "$script" ]; then
  echo "budget: no scenario test/budget/$scenario.js" >&2
  exit 2
fi
if ! command -v herdr-app >/dev/null 2>&1; then
  echo "budget: herdr-app is not on PATH" >&2
  exit 2
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/herdr-explorer-budget.XXXXXX") || exit 2
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

# The mod, minus test/: dotfiles included, nothing else filtered.
for entry in "$mod"/* "$mod"/.[!.]* "$mod"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name=${entry##*/}
  [ "$name" = test ] && continue
  cp -R "$entry" "$tmp/$name" || exit 2
done
mv "$tmp/main.js" "$tmp/explorer.js" || exit 2
cp "$script" "$tmp/main.js" || exit 2

if output=$(herdr-app check "$tmp" 2>&1); then
  status=0
else
  status=$?
fi
printf '%s\n' "$output"
exit "$status"
