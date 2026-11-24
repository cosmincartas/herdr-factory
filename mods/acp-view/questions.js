// ACP form elicitations (`elicitation/create`, mode "form") as a list of fields
// the view can draw, and the answers back as the response's `content`.
//
// Claude's AskUserQuestion arrives this way (claude-agent-acp, elicitation.js):
// `question_<n>` is a select (a string with a titled `oneOf`, or an array whose
// items have a titled `anyOf` for multi-select) and `question_<n>_custom` is its
// optional free-text "Other" box. MCP servers and the adapter's own dialogs
// send other schemas, so plain string, number, integer and boolean fields work
// too. An option's `_meta["_claude/askUserQuestionOption"].preview` is Markdown
// the tool attaches to that option.

const PREVIEW_KEY = "_claude/askUserQuestionOption";

// [{ key, kind: "single"|"multi"|"text"|"number"|"integer"|"boolean", title,
//    description, required, options: [{ value, label, description, preview }],
//    other: { key, title, description } | null, default }]
export function formFields(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const fields = [];
  const companions = new Set();
  for (const [key, p] of Object.entries(props)) {
    if (!p || typeof p !== "object") continue;
    const options = selectOptions(p);
    let kind;
    if (p.type === "array") kind = "multi";
    else if (options) kind = "single";
    else if (p.type === "boolean") kind = "boolean";
    else if (p.type === "number" || p.type === "integer") kind = p.type;
    else kind = "text";
    fields.push({ key, kind, title: p.title ?? null, description: p.description ?? null, required: required.has(key), options: options ?? [], other: null, default: p.default });
  }
  // A select's "Other" box rides with its select rather than as a field of its own.
  for (const f of fields) {
    if (f.kind !== "single" && f.kind !== "multi") continue;
    const c = fields.find((x) => x.key === `${f.key}_custom` && x.kind === "text");
    if (!c) continue;
    f.other = { key: c.key, title: c.title ?? "Other", description: c.description };
    companions.add(c.key);
  }
  return fields.filter((f) => !companions.has(f.key));
}

function selectOptions(p) {
  const src = p.type === "array" ? p.items ?? {} : p;
  const titled = src.oneOf ?? src.anyOf;
  if (Array.isArray(titled)) {
    return titled.filter((o) => o && o.const !== undefined).map((o) => ({
      value: o.const,
      label: o.title ?? String(o.const),
      description: o.description ?? null,
      preview: o._meta?.[PREVIEW_KEY]?.preview ?? null,
    }));
  }
  if (Array.isArray(src.enum)) {
    const names = Array.isArray(src.enumNames) ? src.enumNames : [];
    return src.enum.map((v, i) => ({ value: v, label: names[i] ?? String(v), description: null, preview: null }));
  }
  return null;
}

// The starting answer state: picks by field key (a value, or an array for multi).
export function initialPicks(fields) {
  const picks = {};
  for (const f of fields) {
    if (f.kind === "multi") picks[f.key] = Array.isArray(f.default) ? [...f.default] : [];
    else if (f.kind === "boolean") picks[f.key] = typeof f.default === "boolean" ? f.default : false;
    else if (f.kind === "single" && f.default !== undefined) picks[f.key] = f.default;
  }
  return picks;
}

// Picks a select option: single replaces, multi toggles.
export function pick(picks, field, value) {
  if (field.kind === "multi") {
    const cur = picks[field.key] ?? [];
    picks[field.key] = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  } else if (field.kind === "single") {
    picks[field.key] = picks[field.key] === value ? undefined : value;
  } else if (field.kind === "boolean") {
    picks[field.key] = !picks[field.key];
  }
}

// The `content` of an accept: picks plus typed text (`texts[key]`), empty ones left out.
export function formContent(fields, picks, texts) {
  const out = {};
  for (const f of fields) {
    const v = picks[f.key];
    if (f.kind === "multi") { if (v?.length) out[f.key] = v; }
    else if (f.kind === "single") { if (v !== undefined && v !== null) out[f.key] = v; }
    else if (f.kind === "boolean") out[f.key] = Boolean(v);
    else {
      const s = (texts[f.key] ?? "").trim();
      if (!s) continue;
      if (f.kind === "text") out[f.key] = s;
      else {
        const n = Number(s);
        if (Number.isFinite(n)) out[f.key] = f.kind === "integer" ? Math.trunc(n) : n;
      }
    }
    if (f.other) {
      const s = (texts[f.other.key] ?? "").trim();
      if (s) out[f.other.key] = s;
    }
  }
  return out;
}

// Required fields still without an answer (their titles), for a hint by Submit.
export function missing(fields, content) {
  return fields.filter((f) => f.required && content[f.key] === undefined && !(f.other && content[f.other.key])).map((f) => f.title ?? f.key);
}

// One line per answered field, for the transcript card once it's answered.
export function answerLines(fields, answer) {
  if (!answer) return [];
  if (answer.action !== "accept") return [{ title: null, text: answer.action === "decline" ? "Skipped" : "Cancelled" }];
  const c = answer.content ?? {};
  const lines = [];
  for (const f of fields) {
    const label = (v) => f.options.find((o) => o.value === v)?.label ?? String(v);
    const v = c[f.key];
    const parts = [];
    if (Array.isArray(v)) parts.push(v.map(label).join(", "));
    else if (v !== undefined) parts.push(f.kind === "boolean" ? (v ? "Yes" : "No") : label(v));
    if (f.other && c[f.other.key]) parts.push(`“${c[f.other.key]}”`);
    lines.push({ title: f.title ?? f.description ?? f.key, text: parts.length ? parts.join(" · ") : "—" });
  }
  return lines;
}
