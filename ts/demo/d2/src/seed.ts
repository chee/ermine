// The desk as a first visit finds it: every node placed from here, as the
// host "you", through the top of the stack, so each placement carries a site
// in this file (d2.js once built).
//
// /
// ├─ loaders/host     {"loader":"host"}
// ├─ programs/page    the host's own program
// ├─ rules            protect's rules, read on every operation
// ├─ secret
// └─ desk/
//    ├─ loaders/js, loaders/steps
//    ├─ programs/      desk, note, numbers, photo, hush, tally
//    ├─ theme          a union: dusk, paper
//    ├─ status         written by the tally process
//    └─ cards/         hello, twin (= hello), samples, picture, count, later, hush

import type { Json, Scheduler } from "d2/ermine";
import { png } from "./png.ts";
import * as programs from "./programs.ts";

export const ROOT = "root";

/** protect's rules (PROTECT.tex, Rules): the first whose fields all match wins. */
export const RULES = [
  { agent: "guest", op: "write", node: "hello.text", allow: false },
  { agent: "guest", op: "directory", node: ROOT, allow: false },
];

export const SECRET = "the cake is in the fridge";

/** The picture: 32×32, a calm gradient with a dot. */
export function picture(): ArrayBuffer {
  return png(32, 32, (x, y) => {
    const d = Math.hypot(x - 21, y - 11);
    if (d < 5) return [236, 196, 120];
    return [40 + y * 3, 60 + x * 2, 110 + y * 2];
  });
}

/** 32 samples of a slow wave. */
export function samples(): Float64Array {
  return Float64Array.from({ length: 32 }, (_, i) => Math.sin(i / 4) * 3 + i / 16);
}

/** Places the seed tree. Each place is one change, with its site here. */
export function seed(s: Scheduler, agent: Json = "you") {
  const at = (address: string[], name: string, id: string, value?: Json) =>
    s.place({ agent, address, name, id, ...(value === undefined ? {} : { value }) });
  s.batch(() => {
    at([], "loaders", "loaders", {});
    at(["loaders"], "host", "loaders.host", { loader: "host" });
    at([], "programs", "programs", {});
    at(["programs"], "page", "programs.page", programs.page);
    at([], "rules", "rules", RULES);
    at([], "secret", "secret", SECRET);

    at([], "desk", "desk", {});
    at(["desk"], "loaders", "desk.loaders", {});
    at(["desk", "loaders"], "js", "desk.loaders.js", { loader: "same-thread" });
    at(["desk", "loaders"], "steps", "desk.loaders.steps", { loader: "steps" });
    at(["desk"], "programs", "desk.programs", {});
    for (const name of ["desk", "note", "numbers", "photo", "hush", "tally"] as const) {
      at(["desk", "programs"], name, `program.${name}`, programs[name] as unknown as Json);
    }
    at(["desk"], "theme", "theme.dusk", {
      accent: "#c2703d",
      ink: "#2b2622",
    });
    at(["desk"], "theme", "theme.paper", {
      accent: "#4f6f8f",
      ink: "#1f2a33",
      paper: "#fbf8f1",
      font: "Georgia, 'Iowan Old Style', serif",
    });
    at(["desk"], "status", "status", { cards: 0 });
    at(["desk"], "cards", "cards", {});

    at(["desk", "cards"], "hello", "hello", { show: "note" });
    at(["desk", "cards", "hello"], "text", "hello.text", "hello");
    at(["desk", "cards"], "twin", "hello"); // the same node, placed again
    at(["desk", "cards"], "samples", "samples", { show: "numbers" });
    at(["desk", "cards", "samples"], "samples", "samples.data", samples());
    at(["desk", "cards"], "picture", "picture", { show: "photo" });
    at(["desk", "cards", "picture"], "image", "picture.image", picture());
    at(["desk", "cards"], "count", "count", { show: "tally" });
    at(["desk", "cards"], "later", "later", { show: "note" });
    at(["desk", "cards", "later"], "text", "later.text", "this note's loader is nearer, and slow");
    at(["desk", "cards", "later"], "loaders", "later.loaders", {});
    at(["desk", "cards", "later", "loaders"], "js", "later.loaders.js", { loader: "slow" });
    at(["desk", "cards"], "hush", "hush", { show: "hush" });
  });
}
