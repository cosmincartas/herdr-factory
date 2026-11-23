#!/usr/bin/env bash
# Live reload for the linked layout and mods. Herdr watches its own folders,
# and changes inside a symlinked folder don't reach it, so this touches the
# link in Herdr's home whenever a file under it changes here. Leave it running
# while editing (Ctrl+C stops it). Needs inotify-tools.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

command -v inotifywait >/dev/null || { echo "watch.sh needs inotifywait (inotify-tools)" >&2; exit 1; }
echo "Watching $repo/{layouts,mods} -> $home"

inotifywait -mrq -e close_write,moved_to,create,delete \
  --exclude '/(node_modules|\.git)/' --format '%w%f' "$repo/layouts" "$repo/mods" |
while read -r path; do
  rel="${path#"$repo"/}"
  case "$rel" in
    mods/*)    item="mods/$(echo "$rel" | cut -d/ -f2)" ;;
    layouts/*) item="$rel" ;;
    *)         continue ;;
  esac
  if [ -L "$home/$item" ]; then
    touch -h "$home/$item"
    echo "$(date +%T) reload $item"
  fi
done
