#!/usr/bin/env bash
# Human evidence capture for DoD-1 (C-H1): a Ctrl+click on a remote loopback URL
# starts a forward and opens the page in the local browser.
#
# The user does the click. This script starts the remote marker page, waits for
# the forward, and saves the evidence outside the repository. It exits 2 with a
# `prerequisite:` line when the capture cannot run.
set -uo pipefail

LOCAL_PORT=18765
REMOTE_PORT=18765
READY_S=20
WAIT_S="${PF_WAIT_S:-180}"
EVIDENCE_DIR="${HOME}/.local/state/herdr-factory/port-forward-evidence"
SPACE_NAME=""
MARKER_TERMINAL=""
FORWARD=""

prereq() {
  printf 'prerequisite: %s\n' "$*"
  exit 2
}

# A terminal from herdr-app ls is a bare address on its machine; hc wants the
# machine name in front for a terminal that is not local to this core.
qualified_terminal() {
  case "$1" in
    */*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$PF_MACHINE" "$1" ;;
  esac
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

# Whether a path holds a JSON object.
valid_json() {
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$1"
}

cleanup() {
  local status=$?
  trap - EXIT

  if [ -n "${MARKER_TERMINAL}" ]; then
    hc kill "$MARKER_TERMINAL" >/dev/null 2>&1 || true
    hc rm "$MARKER_TERMINAL" >/dev/null 2>&1 || true
    if hc get "$MARKER_TERMINAL" >/dev/null 2>&1; then
      printf 'cleanup failed: terminal %s still exists\n' "$MARKER_TERMINAL" >&2
      [ "$status" -eq 0 ] && status=1
    fi
  fi

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

# Refuse a port the person already uses, before asking for the click, so that
# the capture never adopts, screenshots or removes an existing forward.
existing="$(forward_addresses "$LOCAL_PORT")" || {
  echo "could not list port forwards for local port ${LOCAL_PORT}"
  exit 1
}
[ -z "$existing" ] || prereq "local port ${LOCAL_PORT} already has a port forward; stop it and run again"
port_listened "$LOCAL_PORT" && prereq "local port ${LOCAL_PORT} is already in use; free it and run again"

mkdir -p "$EVIDENCE_DIR"
trap cleanup EXIT

MARKER="pf-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
PAGE="<!doctype html><meta charset=\"utf-8\"><title>port-forward capture</title><p id=\"marker\">${MARKER}</p>"

# 1. The remote marker page.
if ! printf '%s\n' "$PAGE" | hc exec --on "$PF_MACHINE" --stdin sh -c 'mkdir -p /tmp/pf-e2e && cat > /tmp/pf-e2e/index.html'; then
  echo "could not write the marker page to /tmp/pf-e2e on ${PF_MACHINE}"
  exit 1
fi

# 2. A space on that machine running the page; its terminal prints the URL.
SPACE_NAME="pf-e2e-$(date +%s)-$$"
space_reply="$(
  herdr-app do space.new --machine "$PF_MACHINE" --name "$SPACE_NAME" \
    --argv '["python3","-m","http.server","18765","--bind","127.0.0.1","--directory","/tmp/pf-e2e"]'
)" || {
  echo "could not open the evidence space on ${PF_MACHINE}"
  exit 1
}
# Keep the exact terminal this script started, so cleanup removes only that one
# even if the window closes or the person adds terminals to the space.
MARKER_TERMINAL="$(
  printf '%s' "$space_reply" | node -e '
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      let doc;
      try { doc = JSON.parse(input); } catch { return; }
      if (typeof doc.terminal === "string") process.stdout.write(doc.terminal);
    });
  '
)"
[ -n "$MARKER_TERMINAL" ] || {
  echo "herdr-app do space.new did not report the marker terminal"
  exit 1
}
MARKER_TERMINAL="$(qualified_terminal "$MARKER_TERMINAL")"

# 3. The person's click.
cat <<EOF
Ctrl+click this URL in the terminal Herdr opened on ${PF_MACHINE}:
  http://127.0.0.1:${LOCAL_PORT}/
Waiting up to ${WAIT_S}s for a port forward on local port ${LOCAL_PORT}...
EOF

# 4. Wait for the forward the click should create. Only a forward whose labels
# match this capture is accepted.
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

# 5. Wait for that forward to accept connections and serve this script's page
# before taking the evidence or ending it.
ready_deadline=$((SECONDS + READY_S))
served=0
while [ "$SECONDS" -lt "$ready_deadline" ]; do
  page=""
  if port_listened "$LOCAL_PORT"; then
    page="$(curl -s --max-time 2 "http://localhost:${LOCAL_PORT}/" 2>/dev/null)" || true
  fi
  case "$page" in
    *"$MARKER"*)
      served=1
      break
      ;;
  esac
  sleep 1
done
if [ "$served" -ne 1 ]; then
  echo "local port ${LOCAL_PORT} did not serve the marker page within ${READY_S}s"
  exit 1
fi

# 6. Evidence. Each mandatory artifact needs a successful command.
herdr-app shot "$EVIDENCE_DIR/click-app.png" >/dev/null || {
  echo "herdr-app shot failed"
  exit 1
}
[ -s "$EVIDENCE_DIR/click-app.png" ] || {
  echo "herdr-app shot wrote an empty $EVIDENCE_DIR/click-app.png"
  exit 1
}
if ! curl -s -S --max-time 15 "http://localhost:${LOCAL_PORT}/" > "$EVIDENCE_DIR/click-curl.txt"; then
  echo "curl could not fetch http://localhost:${LOCAL_PORT}/"
  exit 1
fi
if ! ss -ltnH "sport = :${LOCAL_PORT}" > "$EVIDENCE_DIR/click-ss.txt"; then
  echo "ss failed for local port ${LOCAL_PORT}"
  exit 1
fi
[ -s "$EVIDENCE_DIR/click-ss.txt" ] || {
  echo "ss showed no listener on local port ${LOCAL_PORT}"
  exit 1
}
if ! hc get "$FORWARD" --json > "$EVIDENCE_DIR/click-forward.json"; then
  echo "hc get ${FORWARD} failed"
  exit 1
fi
if [ ! -s "$EVIDENCE_DIR/click-forward.json" ] ||
  ! valid_json "$EVIDENCE_DIR/click-forward.json"; then
  echo "hc get ${FORWARD} printed no terminal metadata"
  exit 1
fi

# 7. The forwarded page must be the page this script served.
if ! grep -qF -- "$MARKER" "$EVIDENCE_DIR/click-curl.txt"; then
  echo "the page fetched from localhost:${LOCAL_PORT} did not contain the marker"
  exit 1
fi
echo "evidence saved"
