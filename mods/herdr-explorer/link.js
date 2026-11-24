// Ctrl+click on a file path in a terminal: open it in that tab's Helix, the way the explorer
// does (router.js), at the clicked :line:column. With no Helix in the tab, a new hx pane opens
// beside the clicked terminal. The layout turns this on with "link_handlers": ["herdr-explorer"].
import { exec, notify } from "herdr";
import { Router } from "./router.js";

/** Left to Herdr's usual opener: pictures, PDFs, media, archives and binaries. */
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic|pdf|mp3|mp4|m4a|mov|mkv|webm|avi|wav|ogg|flac|zip|gz|tgz|bz2|xz|zst|7z|rar|dmg|iso|deb|rpm|exe|dll|so|dylib|o|a|class|jar|wasm|woff2?|ttf|otf|sqlite|db)$/i;

/** @type {import("herdr").HandleLink} */
export async function handleLink({ link, source }) {
  // A null path: remote, unresolved or not UTF-8. Herdr handles those as before.
  if (link.kind !== "file" || !link.path || NOT_TEXT.test(link.path)) return "pass";
  if ((await exec("test", ["-d", link.path]).catch(() => null))?.code === 0) return "pass";  // folders too
  const at = link.line ? `:${link.line}${link.column ? `:${link.column}` : ""}` : "";
  try {
    await new Router().open(link.path + at, { folder: source.cwd ?? undefined, tab: source.tab, beside: source.pane });
    return "handled";
  } catch (e) {
    notify({ level: "error", title: "Couldn't open in Helix", body: String(e?.message ?? e) });
    return "pass";  // the file still opens the usual way
  }
}
