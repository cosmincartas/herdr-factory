// Budget scenario: four Find files queries over 50,000 paths stay inside the host's init budget
// (C-3a).
//
// `sh test/budget.sh find-50k` installs this file as the mod's main.js, with the real one renamed
// to explorer.js. It seeds a 50,000-path file list and runs findFiles('s') four times in init:
// herdr-app check interrupts a script call at about 500 ms, so four calls that cost 230 ms each
// today cannot finish, and each must average under about 110 ms to pass.
import Explorer from "./explorer.js";
import { findFiles } from "./search.js";

const FILES = 50000;
const paths = [];
for (let i = 0; i < FILES; i++) {
  // Names that look like a real checkout: every path holds an 's', so 's' matches all of them.
  const kind = i % 2 ? "client" : "server";
  paths.push(`packages/app-${i % 500}/src/${kind}-${i}/index-${i}.ts`);
}

export default class Find50k extends Explorer {
  init(props, cx) {
    super.init(props, cx);
    for (let i = 0; i < 4; i++) {
      const found = findFiles("s", paths);
      if (found.length !== 200) throw new Error(`find-50k: call ${i} returned ${found.length} matches`);
    }
  }
}
