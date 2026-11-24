// Folder listings and git marks, read through `exec` so remote spaces work too.
import { exec } from "herdr";

export const PER_FOLDER = 500, TOTAL = 5000;

// Prints "kind\0name\0" per entry (d: folder, f: anything else), skipping .git.
const LIST = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; '
  + 'name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then k=d; else k=f; fi; '
  + 'printf "%s\\0%s\\0" "$k" "$name"; n=$((n+1)); [ "$n" -gt ' + PER_FOLDER + ' ] && break; done; test -d "$1"';

/** The entries of one folder, folders first, then by name. */
export async function listFolder(path, on) {
  const r = await exec("sh", ["-c", LIST, "herdr-explorer", path], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot list ${path}`);
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** The git checkout holding `path`, or null. */
export async function gitTop(path, on) {
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: path, on }).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : null;
}

/** Changed files under `top` as { marks: {absPath: "M"|"A"|"D"|"U"}, dirty: Set<absDir> }. */
export async function gitMarks(top, on) {
  const marks = {}, dirty = new Set();
  // No index lock or fsmonitor cookie: writing under .git would wake the folder watch.
  const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status",
    "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: top, on }).catch(() => null);
  if (r?.code !== 0) return { marks, dirty };
  for (const entry of r.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
    const xy = entry.slice(0, 2), path = `${top}/${entry.slice(3)}`;
    marks[path] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
    for (let d = path.slice(0, path.lastIndexOf("/")); d.length > top.length; d = d.slice(0, d.lastIndexOf("/"))) dirty.add(d);
  }
  return { marks, dirty };
}
