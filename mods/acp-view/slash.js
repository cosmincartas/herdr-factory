// The `/` panel's matching: which of the session's slash commands (ACP
// `available_commands_update`, kept in Transcript.commands) fit what is typed.

// The commands to offer for the composer's text, best first, or null when the
// panel has nothing to do: the text isn't `/` and a command name being typed
// (a space or a new line means the name is done and arguments follow).
export function slashMatches(commands, text) {
  const m = /^\/(\S*)$/.exec(text);
  if (!m || !commands?.length) return null;
  const q = m[1].toLowerCase();
  const rank = (c) => {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    // A word inside the name: `review` finds `security-review`, `docs` finds `stripe:stripe-docs`.
    if (name.split(/[-:_]/).some((w) => w.startsWith(q))) return 1;
    if (name.includes(q)) return 2;
    if ((c.description ?? "").toLowerCase().includes(q)) return 3;
    return -1;
  };
  return commands
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .map((x) => x.c);
}

// What choosing a command puts in the composer: its name, and a space after it
// when it takes input, so the arguments can be typed straight away.
export function completion(command) {
  return `/${command.name}${command.input ? " " : ""}`;
}
