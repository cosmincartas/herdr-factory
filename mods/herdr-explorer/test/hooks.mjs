// Node test preload: runs before every test file and before the mod's own modules.
//
// Herdr runs mods in QuickJS, where `herdr`, `gpui-kit` and `gpui-base` are host modules and
// `localStorage` is a global. Node has neither, so the mod is loaded here against the stubs in
// test/stubs/:
//
//   node --import ./test/hooks.mjs --test test/
import { registerHooks } from "node:module";

const stub = name => new URL(`./stubs/${name}`, import.meta.url).href;
const MODULES = new Map([
  ["herdr", stub("herdr.mjs")],
  ["gpui-kit", stub("ui.mjs")],
  ["gpui-base", stub("ui.mjs")],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = MODULES.get(specifier);
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// router.js keeps its Helix pairings in localStorage. The store is per test file (each test file
// gets its own process); a test may call localStorage.clear() between cases.
const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(String(key)) ? store.get(String(key)) : null),
  setItem: (key, value) => { store.set(String(key), String(value)); },
  removeItem: key => { store.delete(String(key)); },
  clear: () => { store.clear(); },
  key: index => [...store.keys()][index] ?? null,
  get length() { return store.size; },
};
