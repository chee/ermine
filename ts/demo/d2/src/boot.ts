// The host's boot, DOM-free: seed on a first visit; after a load, unplace the
// process nodes the last session left (kept, never running: only start
// starts); then the boot image, which starts the page and the desk.

import { isPid, type World } from "./stack.ts";
import { seed } from "./seed.ts";

/** The pid-named entries a load brought back, each with the path of the node it is in. */
export function leftovers(w: World): { path: string[]; name: string }[] {
  const out: { path: string[]; name: string }[] = [];
  const kept = w.k.kept();
  for (const [id, node] of kept.nodes) {
    if (w.where.get(id)?.some((p) => isPid(p.name) && p.name === id)) continue; // inside one
    for (const [name, ids] of node.directory) {
      if (!isPid(name) || !ids.includes(name)) continue;
      const path = w.pathOf(id);
      if (path) out.push({ path, name });
    }
  }
  return out;
}

export function boot(w: World) {
  if (!w.loaded) {
    w.act("seed: the desk as a first visit finds it", () => seed(w.s, w.actor));
  } else {
    const old = leftovers(w);
    if (old.length) {
      w.act(
        `sweep: ${old.length} kept process nodes, never running (only start starts)`,
        () =>
          w.s.batch(() => {
            for (const { path, name } of old) {
              w.s.unplace({ agent: w.actor, address: path, name, id: name });
            }
          }),
      );
    }
  }
  w.act(
    "boot image: start page at /",
    () => w.s.start({ agent: w.actor, address: [], program: ["programs", "page"] }),
  );
  w.act(
    "boot image: start desk at /desk",
    () => w.s.start({ agent: w.actor, address: ["desk"], program: ["programs", "desk"] }),
  );
}
