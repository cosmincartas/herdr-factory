#!/usr/bin/env bash
# Human evidence capture for DoD-2 (C-H2): the "Port forwards" dialog lists,
# adds and stops a forward.
#
# The user opens the dialog, fills the form and clicks Stop. This script drives
# the dialog and captures each state, saving evidence outside the repository.
# It exits 2 with a `prerequisite:` line when the capture cannot run.
set -uo pipefail

REMOTE_PORT=18766
LOCAL_PORT=28766
WAIT_S="${PF_WAIT_S:-180}"
EVIDENCE_DIR="${HOME}/.local/state/herdr-factory/port-forward-evidence"
FORWARD=""

prereq() {
  printf 'prerequisite: %s\n' "$*"
  exit 2
}

# Print the addresses of the live port-forward terminals for a local port.
# Fails when the listing cannot be read or has an unexpected shape, so that an
# empty result is only trusted when the query itself succeeded.
forward_addresses() {
  local port="$1"
  hc ls --json --label "port-forward.local=${port}" 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      let doc;
      try { doc = JSON.parse(input); } catch { process.exit(1); }
      if (!Array.isArray(doc.terminals)) process.exit(1);
      for (const terminal of doc.terminals) {
        if (terminal && typeof terminal.address === "string" && terminal.address) {
          console.log(terminal.address);
        }
      }
    });
  '
}

# Whether a live terminal carries the labels of this capture's forward.
forward_matches() {
  local address="$1" local_port="$2" remote_port="$3"
  hc get "$address" --json 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      let doc;
      try { doc = JSON.parse(input); } catch { process.exit(1); }
      const labels = doc.labels || {};
      const want = {
        "port-forward": "1",
        "port-forward.machine": process.argv[1],
        "port-forward.local": process.argv[2],
        "port-forward.host": "localhost",
        "port-forward.remote": process.argv[3],
      };
      for (const [key, value] of Object.entries(want)) {
        if (String(labels[key] || "") !== value) process.exit(1);
      }
      if (doc.state !== "live") process.exit(1);
    });
  ' "$PF_MACHINE" "$local_port" "$remote_port"
}

# The address of a new live forward for this capture, or nothing.
capture_forward() {
  local local_port="$1" remote_port="$2" address addresses
  addresses="$(forward_addresses "$local_port")" || return 1
  while IFS= read -r address; do
    [ -n "$address" ] || continue
    if forward_matches "$address" "$local_port" "$remote_port"; then
      printf '%s' "$address"
      return 0
    fi
  done <<<"$addresses"
  return 0
}

# Whether a local port is listened on.
port_listened() {
  [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]
}

# Save a forward listing as evidence, and require a successful, readable query.
save_forward_listing() {
  local port="$1" file="$2"
  hc ls --json --label "port-forward.local=${port}" > "$file" || return 1
  node -e '
    const fs = require("node:fs");
    let doc;
    try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    if (!Array.isArray(doc.terminals)) process.exit(1);
  ' "$file"
}

# The dialog's row state is not exposed to herdr-app, so the person confirms it
# before the screenshot, within the PF_WAIT_S bound.
confirm_row() {
  local what="$1" ignored
  printf 'Confirm in the Port forwards dialog: %s\nPress Enter when it does, or wait up to %ss: ' "$what" "$WAIT_S"
  if ! IFS= read -r -t "$WAIT_S" ignored; then
    printf '\n'
    return 1
  fi
  return 0
}

cleanup() {
  local status=$?
  trap - EXIT

  if [ -n "${FORWARD}" ]; then
    hc kill "$FORWARD" >/dev/null 2>&1 || true
    hc rm "$FORWARD" >/dev/null 2>&1 || true
    if hc get "$FORWARD" >/dev/null 2>&1; then
      printf 'cleanup failed: terminal %s still exists\n' "$FORWARD" >&2
      [ "$status" -eq 0 ] && status=1
    fi
  fi

  exit "$status"
}

[ -n "${PF_MACHINE:-}" ] || prereq "set PF_MACHINE to a reachable SSH machine (see hc machine ls)"
command -v curl >/dev/null 2>&1 || prereq "curl is missing"
command -v ss >/dev/null 2>&1 || prereq "ss is missing"

machine_fields="$(
  hc machine ls --json 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      const wanted = process.argv[1];
      let doc;
      try { doc = JSON.parse(input); } catch { return; }
      const machine = (doc.machines || []).find((m) => m.name === wanted);
      if (!machine) return;
      const fields = [
        String(machine.state || ""),
        machine.via === true ? "true" : "false",
        String(machine.target || ""),
      ];
      process.stdout.write(fields.join("\t"));
    });
  ' "$PF_MACHINE" 2>/dev/null || true
)"
IFS=$'\t' read -r machine_state machine_via machine_target <<<"$machine_fields"
[ "$machine_state" = "ready" ] || prereq "machine ${PF_MACHINE} is not ready (state: ${machine_state:-unknown})"
[ "$machine_via" = "false" ] || prereq "machine ${PF_MACHINE} is not an SSH machine (via: ${machine_via:-unknown})"
case "$machine_target" in
  "" | -*) prereq "machine ${PF_MACHINE} has no usable SSH target" ;;
esac

herdr-app status >/dev/null 2>&1 || prereq "Herdr is not running (herdr-app status failed)"

# Refuse a port the person already uses, before asking for a form entry, so that
# the capture never prompts Stop for an existing row or removes it later.
existing="$(forward_addresses "$LOCAL_PORT")" || {
  echo "could not list port forwards for local port ${LOCAL_PORT}"
  exit 1
}
[ -z "$existing" ] || prereq "local port ${LOCAL_PORT} already has a port forward; stop it and run again"
port_listened "$LOCAL_PORT" && prereq "local port ${LOCAL_PORT} is already in use; free it and run again"

# mod.open toggles, so keep an already open dialog open instead of closing it.
overlay_state="$(
  herdr-app status 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      let doc;
      try { doc = JSON.parse(input); } catch { process.exit(1); }
      if (!Array.isArray(doc.overlays)) process.exit(1);
      process.stdout.write(doc.overlays.includes("port-forward") ? "open" : "closed");
    });
  '
)" || {
  echo "could not read Herdr's overlays"
  exit 1
}

mkdir -p "$EVIDENCE_DIR"
trap cleanup EXIT

# 1. Open the dialog and capture it.
if [ "$overlay_state" = "open" ]; then
  echo "The Port forwards dialog is already open; leaving it open."
else
  if ! herdr-app do mod.open '{"name":"port-forward"}'; then
    echo "could not open the Port forwards dialog"
    exit 1
  fi
fi
sleep 1
herdr-app shot "$EVIDENCE_DIR/dialog-open.png" >/dev/null || {
  echo "herdr-app shot failed"
  exit 1
}
[ -s "$EVIDENCE_DIR/dialog-open.png" ] || {
  echo "herdr-app shot wrote an empty $EVIDENCE_DIR/dialog-open.png"
  exit 1
}

# 2. The person's form entry and Add click.
cat <<EOF
In the Port forwards dialog, choose the machine ${PF_MACHINE}, enter remote port
${REMOTE_PORT} and local port ${LOCAL_PORT}, then click Add.
Waiting up to ${WAIT_S}s for a port forward on local port ${LOCAL_PORT}...
EOF

# 3. Wait for Add to create the forward. Only a forward whose labels match this
# capture is accepted.
deadline=$((SECONDS + WAIT_S))
while :; do
  if ! FORWARD="$(capture_forward "$LOCAL_PORT" "$REMOTE_PORT")"; then
    echo "could not list port forwards for local port ${LOCAL_PORT}"
    exit 1
  fi
  [ -n "$FORWARD" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "no port forward for local port ${LOCAL_PORT} appeared"
    exit 1
  fi
  sleep 1
done

# 4. Wait for the refreshed list to show the new row before its screenshot.
confirm_row "the new row for local port ${LOCAL_PORT} is listed" || {
  echo "the new row for local port ${LOCAL_PORT} was not confirmed in the dialog"
  exit 1
}

# 5. Evidence of the added forward.
herdr-app shot "$EVIDENCE_DIR/dialog-added.png" >/dev/null || {
  echo "herdr-app shot failed"
  exit 1
}
[ -s "$EVIDENCE_DIR/dialog-added.png" ] || {
  echo "herdr-app shot wrote an empty $EVIDENCE_DIR/dialog-added.png"
  exit 1
}
save_forward_listing "$LOCAL_PORT" "$EVIDENCE_DIR/dialog-added.json" || {
  echo "could not capture ${EVIDENCE_DIR}/dialog-added.json"
  exit 1
}
node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const found = (doc.terminals || []).some((t) => t && t.address === process.argv[2]);
  process.exit(found ? 0 : 1);
' "$EVIDENCE_DIR/dialog-added.json" "$FORWARD" || {
  echo "dialog-added.json does not list ${FORWARD}"
  exit 1
}

# 6. The person's Stop click.
cat <<EOF
Click Stop on the row for local port ${LOCAL_PORT}.
Waiting up to ${WAIT_S}s for that forward to go away...
EOF

deadline=$((SECONDS + WAIT_S))
while :; do
  if ! remaining="$(capture_forward "$LOCAL_PORT" "$REMOTE_PORT")"; then
    echo "could not list port forwards for local port ${LOCAL_PORT}"
    exit 1
  fi
  [ -z "$remaining" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "port forward ${LOCAL_PORT} was not stopped"
    exit 1
  fi
  sleep 1
done

# 7. Wait for the refreshed list to drop the row before its screenshot.
confirm_row "the row for local port ${LOCAL_PORT} is gone" || {
  echo "the removed row for local port ${LOCAL_PORT} was not confirmed in the dialog"
  exit 1
}

# 8. Evidence that the row is gone.
herdr-app shot "$EVIDENCE_DIR/dialog-stopped.png" >/dev/null || {
  echo "herdr-app shot failed"
  exit 1
}
[ -s "$EVIDENCE_DIR/dialog-stopped.png" ] || {
  echo "herdr-app shot wrote an empty $EVIDENCE_DIR/dialog-stopped.png"
  exit 1
}
save_forward_listing "$LOCAL_PORT" "$EVIDENCE_DIR/dialog-stopped.json" || {
  echo "could not capture ${EVIDENCE_DIR}/dialog-stopped.json"
  exit 1
}
node -e '
  const fs = require("node:fs");
  const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit((doc.terminals || []).length === 0 ? 0 : 1);
' "$EVIDENCE_DIR/dialog-stopped.json" || {
  echo "dialog-stopped.json still lists a forward on local port ${LOCAL_PORT}"
  exit 1
}

# The Stop click removed that forward, so cleanup has nothing left to remove.
FORWARD=""

echo "evidence saved"
