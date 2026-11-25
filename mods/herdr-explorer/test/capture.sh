#!/bin/sh
# H-1: capture the explorer's three lists and the window's status for human review.
#
#   HERDR_APP_HOME=/path/to/scratch/herdr-home sh test/capture.sh
#
# The script never talks to the person's own ~/.config/herdr-app: HERDR_APP_HOME is required and
# selects the running window (herdr-app's socket lives in that home), so the same command captures
# a scratch home, a review window or a CI window.
#
# Run it against a window whose explorer has just started, in its default tree view: capture.sh
# cannot send Escape (no key or pointer automation), and the explorer only shows the tree while
# its Find query is empty. The script then drives Find files and Search through the mod's own
# commands. Evidence lands in test/evidence/:
#
#   tree.png    the tree (and the note above it)
#   find.png    Find files, with a query whose matches fill the list
#   search.png  Search (file contents), likewise
#   status.txt  herdr-app status, errors included
#
# Exit 1 with "missing: virtual lists" while a list still renders every row eagerly (H-1 is RED
# until Task 6). Exit 2 for a missing herdr-app, window or HERDR_APP_HOME.
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mod=$(CDPATH= cd -- "$here/.." && pwd)
main=$mod/main.js
evidence=$here/evidence

# H-1 passes when the tree, Find files and Search results are all lazy lists. Today the three
# row areas are plain scroll areas built with overflow_y_scrollbar(); once virtual they are
# v_virtual_list and no plain row scroll area is left in main.js.
if ! grep -q 'v_virtual_list' "$main" || grep -q 'overflow_y_scrollbar' "$main"; then
  echo "missing: virtual lists"
  exit 1
fi

if [ -z "${HERDR_APP_HOME:-}" ]; then
  echo "capture: set HERDR_APP_HOME to the Herdr home of the window to capture" >&2
  exit 2
fi
if ! command -v herdr-app >/dev/null 2>&1; then
  echo "capture: herdr-app is not on PATH" >&2
  exit 2
fi
if ! herdr-app status >/dev/null 2>&1; then
  echo "capture: no running window answers at HERDR_APP_HOME=$HERDR_APP_HOME" >&2
  exit 2
fi

mkdir -p "$evidence" || exit 2

# A term that matches most paths and most lines, so each captured list has rows to virtualize.
# Override with CAPTURE_QUERY.
query=${CAPTURE_QUERY:-e}
# Listing and ripgrep are asynchronous; give the panel time to fill before each frame.
find_wait=${CAPTURE_FIND_WAIT:-1}
search_wait=${CAPTURE_SEARCH_WAIT:-3}

herdr-app do herdr-explorer.focus >/dev/null 2>&1 || true
sleep 0.5
herdr-app shot "$evidence/tree.png" >/dev/null || exit 1

herdr-app do "herdr-explorer.find-files:$query" >/dev/null 2>&1 || true
sleep "$find_wait"
herdr-app shot "$evidence/find.png" >/dev/null || exit 1

herdr-app do "herdr-explorer.search:$query" >/dev/null 2>&1 || true
sleep "$search_wait"
herdr-app shot "$evidence/search.png" >/dev/null || exit 1

herdr-app status > "$evidence/status.txt" 2>&1 || true

status=0
for error in "$HERDR_APP_HOME"/*.error; do
  [ -e "$error" ] || continue
  echo "capture: $error" >&2
  status=1
done
if grep -q 'herdr-explorer' "$evidence/status.txt" && grep -qi 'error' "$evidence/status.txt"; then
  echo "capture: status.txt mentions an error; read $evidence/status.txt" >&2
fi
exit "$status"
