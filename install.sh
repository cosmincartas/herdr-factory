#!/usr/bin/env bash
# Links this repo's layout and mods into Herdr's home, so Herdr reads them
# from here. Safe to run again. Anything already there that isn't a link to
# this repo is moved aside as <name>.pre-herdr-factory-<time>.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
stamp="$(date +%Y%m%d-%H%M%S)"

link() {
  local src="$repo/$1" dst="$home/$1"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "ok      $1"
    return
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    mv "$dst" "$dst.pre-herdr-factory-$stamp"
    echo "moved   $1 -> $1.pre-herdr-factory-$stamp"
  fi
  ln -s "$src" "$dst"
  echo "linked  $1"
}

for f in "$repo"/layouts/*; do link "layouts/$(basename "$f")"; done
for d in "$repo"/mods/*/; do link "mods/$(basename "$d")"; done

echo
echo "Switch to it: herdr-app do layout.switch '{\"name\":\"herdr-factory\"}'  (or ctrl-shift-l)"
