// A share serves its subtree and nothing else: a mounter cannot place, by
// its id, a node of the owner's from outside the subtree into it, though it
// can move and mount what it can already reach.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { graph } from "../src/graph.ts";
import { schedule } from "../src/schedule.ts";
import { builtin } from "../src/loaders.ts";
import { hub } from "../src/link/wire.ts";
import { mount } from "../src/link/mount.ts";
import { Refused } from "../src/types.ts";
import { shares } from "../src/link/share.ts";

const a = { agent: "ay" };
const m = { agent: "em" };

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test("a mounter cannot bring a node from outside the share into it", async () => {
  const h = hub();
  const g = graph("root");
  let top: ReturnType<typeof schedule> | undefined;
  const sharing = shares({ connect: () => h.peer(), api: () => top! });
  const A = schedule(g, { host: builtin({ share: sharing.program }) }, { graph: g });
  top = A;
  A.place({ ...a, address: [], name: "loaders", id: "loaders", value: null });
  A.place({ ...a, address: ["loaders"], name: "host", id: "l/host", value: { loader: "host" } });
  A.place({ ...a, address: [], name: "programs", id: "programs", value: null });
  A.place({
    ...a,
    address: ["programs"],
    name: "share",
    id: "p/share",
    value: { kind: "host", compute: "share", effect: "share" },
  });
  A.place({ ...a, address: [], name: "outside", id: "outside", value: "private" });
  A.place({ ...a, address: [], name: "shared", id: "shared", value: {} });
  A.place({ ...a, address: ["shared"], name: "doc", id: "doc", value: "hello" });
  const pid = (A.start({
    ...a,
    address: [],
    program: ["programs", "share"],
    value: { channel: "c", address: ["shared"] },
  }).change as { id: string }).id;
  await until(() => sharing.served.has(pid));
  const r = await mount(h.peer());
  try {
    const e = await assertRejects(
      () => r.place({ ...m, address: [], name: "x", id: "outside" }),
      Refused,
    );
    assertEquals(e.why.rule, "served");
    assertEquals(await r.read({ ...m, address: ["x"] }), []);
    assertEquals(A.read({ ...a, address: ["outside"] })[0].value, "private");
    // what it can reach, it can place again: doc in a second slot
    await r.place({ ...m, address: [], name: "again", id: "doc" });
    const items = await r.read({ ...m, address: ["again"] });
    assertEquals(items.map((i) => i.value), ["hello"]);
    // and a new node is made as ever
    await r.place({ ...m, address: [], name: "new", id: "n", value: 1 });
    assert(A.read({ ...a, address: ["shared", "new"] }).length === 1);
  } finally {
    await r.close();
    A.unplace({ ...a, address: [], name: pid, id: pid });
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  }
});
