// Ctrl+click on a loopback URL printed by a program on a remote machine:
// forward the port over SSH and open it in the browser. This file only adapts
// herdr's functions into the core's Deps; forward.js holds the behavior.
// The layout turns this on with "link_handlers": ["herdr-explorer", "port-forward"].

import { exec, hc, notify } from "herdr";
import { handleClick } from "./forward.js";

/** The effects forward.js performs, from herdr and the system (spec Deps).
 * @type {import("./forward.js").Deps} */
const deps = {
  hc: (args) => hc(args),
  exec: (command, args, options) => exec(command, args, options),
  notify: (n) => notify(n),
  // A link handler has no cx timer and mods have no setTimeout, so the core's
  // readiness sleep is a process.
  sleep: async (ms) => {
    await exec("sleep", [String(ms / 1000)]);
  },
  now: () => Date.now(),
};

/** @type {import("herdr").HandleLink} */
export async function handleLink(click) {
  return handleClick(click, deps);
}
