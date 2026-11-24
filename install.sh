#!/usr/bin/env bash
# Links this repo's layout and mods into Herdr's home, so Herdr reads them
# from here, and herdr-explorer's Helix helper into ~/.local/bin. Safe to run
# again. A link that points elsewhere is replaced; anything else already there
# is moved to <home>/.pre-herdr-factory/<time>/ (outside mods/, so Herdr
# doesn't load the backup as a mod).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
bin="$HOME/.local/bin"
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$home/.pre-herdr-factory/$stamp"

# link <source> <destination> <label>
link() {
  local src="$1" dst="$2" label="$3"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "ok      $label"
    return
  fi
  if [ -L "$dst" ]; then
    rm "$dst"
  elif [ -e "$dst" ]; then
    mkdir -p "$backup/$(dirname "$label")"
    mv "$dst" "$backup/$label"
    echo "moved   $label -> $backup/$label"
  fi
  ln -s "$src" "$dst"
  echo "linked  $label"
}

for f in "$repo"/layouts/*; do link "$f" "$home/layouts/$(basename "$f")" "layouts/$(basename "$f")"; done
for d in "$repo"/mods/*/; do
  name="$(basename "$d")"
  link "$repo/mods/$name" "$home/mods/$name" "mods/$name"
done
link "$repo/mods/herdr-explorer/bin/herdr-explorer" "$bin/herdr-explorer" "bin/herdr-explorer"

echo
echo "Switch to it: herdr-app do layout.switch '{\"name\":\"herdr-factory\"}'  (or ctrl-shift-l)"
