// Splits Markdown into what TextView draws (Markdown), what it can't
// (```mermaid blocks, image references) so the view can show those as pictures,
// and ```html blocks, which the view draws as HTML text.

// Fenced blocks that become segments of their own, by info string.
const OWN = new Set(["mermaid", "html"]);

const IMG = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function segments(text) {
  const out = [];
  let md = [];
  const flush = () => {
    if (md.length) splitImages(md.join("\n"), out);
    md = [];
  };
  let fence = null;
  for (const line of text.split("\n")) {
    if (!fence) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
      if (m) {
        const lang = m[2].toLowerCase();
        if (OWN.has(lang)) {
          flush();
          fence = { marker: m[1], own: lang, lines: [] };
        } else {
          fence = { marker: m[1], own: null };
          md.push(line);
        }
        continue;
      }
      md.push(line);
      continue;
    }
    const tl = line.trim();
    const closes = tl.length >= fence.marker.length && [...tl].every((ch) => ch === fence.marker[0]);
    if (fence.own) {
      if (closes) {
        out.push({ kind: fence.own, src: fence.lines.join("\n").trim(), closed: true });
        fence = null;
      } else fence.lines.push(line);
    } else {
      md.push(line);
      if (closes) fence = null;
    }
  }
  if (fence?.own) out.push({ kind: fence.own, src: fence.lines.join("\n").trim(), closed: false });
  flush();
  return out;
}

// Images outside code: split the Markdown around them.
function splitImages(text, out) {
  let fence = null;
  let buf = [];
  const push = () => {
    const s = buf.join("\n");
    if (s.trim()) out.push({ kind: "md", text: s });
    buf = [];
  };
  for (const line of text.split("\n")) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      buf.push(line);
      if (f && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (f) { fence = f[1]; buf.push(line); continue; }
    IMG.lastIndex = 0;
    if (!IMG.test(line)) { buf.push(line); continue; }
    IMG.lastIndex = 0;
    let at = 0, m;
    while ((m = IMG.exec(line))) {
      const before = line.slice(at, m.index);
      if (before.trim()) buf.push(before);
      push();
      out.push({ kind: "img", alt: m[1], src: m[2] });
      at = m.index + m[0].length;
    }
    const rest = line.slice(at);
    if (rest.trim()) buf.push(rest);
  }
  push();
}

// FNV-1a, for asset keys.
export function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
