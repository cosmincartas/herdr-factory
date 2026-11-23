// Pictures for the acp-view mod: Mermaid diagrams, agent image blocks, and
// files or URLs referenced from Markdown. Every one becomes an immutable,
// content-named PNG/JPEG/GIF/WebP file in a folder under the Herdr app home,
// because GPUI's image() only reads files from there.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import { renderMermaid } from "beautiful-mermaid";
import { Resvg } from "@resvg/resvg-js";

export const FOLDER = "mods/acp-view-assets";
const MAX_BYTES = 25 * 1024 * 1024;
const RASTER_ZOOM = 2;

export class Assets {
  constructor(appHome, cwd) {
    this.appHome = appHome;
    this.cwd = cwd;
    this.dir = `${appHome}/${FOLDER}`;
    this.ready = this.prepare();
    this.cache = new Map();
  }

  async prepare() {
    await mkdir(this.dir, { recursive: true });
    const tag = `${this.dir}/CACHEDIR.TAG`;
    if (!(await exists(tag))) {
      await writeFile(tag, "Signature: 8a477f597d28d172789f06886806bc55\n# rendered pictures from the acp-view Herdr mod\n");
    }
  }

  // Raw bytes -> { path (relative to app home), width, height }.
  async save(buf, hint = "") {
    await this.ready;
    let kind = sniff(buf);
    if (!kind && (hint.includes("svg") || looksLikeSvg(buf))) kind = "svg";
    if (!kind) throw new Error("unsupported image type");
    if (kind === "svg") return this.saveSvg(buf.toString("utf8"));
    const size = imageSize(buf, kind);
    const name = `${hash(buf)}.${kind}`;
    const abs = `${this.dir}/${name}`;
    if (!(await exists(abs))) await writeFile(abs, buf);
    return { path: `${FOLDER}/${name}`, width: size?.width ?? 0, height: size?.height ?? 0 };
  }

  async saveSvg(svg, background) {
    await this.ready;
    const flat = flattenSvg(svg);
    const resvg = new Resvg(flat, {
      fitTo: { mode: "zoom", value: RASTER_ZOOM },
      font: { loadSystemFonts: true, defaultFontFamily: "Noto Sans" },
      ...(background ? { background } : {}),
    });
    const png = resvg.render().asPng();
    const name = `${hash(png)}.png`;
    const abs = `${this.dir}/${name}`;
    if (!(await exists(abs))) await writeFile(abs, png);
    return { path: `${FOLDER}/${name}`, width: Math.round(resvg.width), height: Math.round(resvg.height) };
  }

  async mermaid(src, colors = {}) {
    const key = `m:${hash(Buffer.from(src + JSON.stringify(colors)))}`;
    return this.memo(key, async () => {
      const svg = await renderMermaid(src, { ...clean(colors), font: "Noto Sans" });
      return this.saveSvg(svg, colors.bg);
    });
  }

  // A Markdown image reference: absolute or ~ path, path relative to the
  // session folder, file:// URL, http(s) URL or data: URL.
  async file(src) {
    const key = `f:${src}`;
    return this.memo(key, async () => {
      if (/^data:/i.test(src)) {
        const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(src);
        if (!m) throw new Error("bad data URL");
        const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
        return this.save(buf, m[1]);
      }
      if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src, { signal: AbortSignal.timeout(15000), redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > MAX_BYTES) throw new Error("image too large");
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error("image too large");
        return this.save(buf, res.headers.get("content-type") ?? src);
      }
      let p = src.replace(/^file:\/\//i, "");
      try { p = decodeURI(p); } catch {}
      if (p.startsWith("~/")) p = `${homedir()}/${p.slice(2)}`;
      if (!isAbsolute(p)) p = resolve(this.cwd, p);
      const buf = await readFile(p);
      if (buf.length > MAX_BYTES) throw new Error("image too large");
      return this.save(buf, p);
    });
  }

  memo(key, make) {
    if (!this.cache.has(key)) {
      const p = make();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return this.cache.get(key);
  }
}

const hash = (buf) => createHash("sha1").update(buf).digest("hex").slice(0, 20);
const exists = (p) => access(p).then(() => true, () => false);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k, v.length === 9 && v.startsWith("#") ? v.slice(0, 7) : v]));
const looksLikeSvg = (buf) => /<svg[\s>]/i.test(buf.subarray(0, 2048).toString("utf8"));

function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return null;
}

export function imageSize(b, kind = sniff(b)) {
  try {
    switch (kind) {
      case "png": return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      case "gif": return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      case "bmp": return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
      case "webp": {
        const chunk = b.toString("ascii", 12, 16);
        if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
        if (chunk === "VP8L") { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      case "jpg": {
        let i = 2;
        while (i < b.length) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
          i += 2 + b.readUInt16BE(i + 2);
        }
      }
    }
  } catch {}
  return null;
}

// --- SVG flattening ------------------------------------------------------
// resvg/usvg (and GPUI, which uses them) support neither CSS custom
// properties nor color-mix(). beautiful-mermaid relies on both, so resolve
// them into literal colors before rasterizing.

const toRgb = (c) => {
  c = c.trim();
  if (/^#[0-9a-f]{3}$/i.test(c)) c = "#" + [...c.slice(1)].map((x) => x + x).join("");
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
};
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function matching(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")" && --d === 0) return i;
  }
  return s.length - 1;
}

export function flattenSvg(svg) {
  const vars = {};
  const decl = (block) => { for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) vars[m[1]] = m[2].trim(); };
  const root = /<svg[^>]*style="([^"]*)"/.exec(svg);
  if (root) decl(root[1]);
  for (const m of svg.matchAll(/(?:svg|:root)\s*\{([^}]*)\}/g)) decl(m[1].replace(/\/\*[\s\S]*?\*\//g, ""));

  const resolveExpr = (expr, depth = 0) => {
    if (depth > 20) return expr;
    let out = "", i = 0;
    while (i < expr.length) {
      const isVar = expr.startsWith("var(", i), isMix = expr.startsWith("color-mix(", i);
      if (!isVar && !isMix) { out += expr[i++]; continue; }
      const open = expr.indexOf("(", i), close = matching(expr, open);
      const args = splitTop(expr.slice(open + 1, close));
      if (isVar) {
        const [name, fallback] = args;
        out += vars[name] !== undefined ? resolveExpr(vars[name], depth + 1)
          : fallback !== undefined ? resolveExpr(fallback, depth + 1) : "none";
      } else {
        const parse = (a) => {
          const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(resolveExpr(a, depth + 1).trim());
          return [toRgb(m[1]), m[2] !== undefined ? +m[2] / 100 : null];
        };
        const [ca, pa] = parse(args[1] ?? "");
        const [cb, pb] = parse(args[2] ?? "");
        const wa = pa ?? (pb !== null ? 1 - pb : 0.5);
        out += ca && cb ? toHex(ca.map((x, k) => x * wa + cb[k] * (1 - wa))) : "none";
      }
      i = close + 1;
    }
    return out;
  };

  return svg
    .replace(/@import[^;]*;/g, "")
    .replace(/(?:--[\w-]+\s*:[^;"}]*;?\s*)+/g, (m) => (m.includes("\n") ? "\n" : ""))
    .replace(/(fill|stroke|stop-color|color|flood-color)="([^"]*(?:var|color-mix)\([^"]*)"/g, (_, a, v) => `${a}="${resolveExpr(v)}"`)
    .replace(/style="([^"]*)"/g, (_, v) => `style="${resolveExpr(v)}"`)
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_, a, css, b) => a + resolveExpr(css) + b);
}
