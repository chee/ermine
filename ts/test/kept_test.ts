// A kept mirror: two stacks on one in-memory channel. A owns and serves a
// subtree; B runs a kept mirror process (src/link/kept.ts) that copies it
// into B's graph as ordinary nodes, which B's keeper keeps, sees B's changes
// there through subscriptions, and sends them to A.

import { assert, assertEquals } from "@std/assert";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { schedule, type Scheduler } from "../src/schedule.ts";
import { builtin, type ComputeGiven, type EffectGiven } from "../src/loaders.ts";
import { keep, load, memory } from "../src/keeper.ts";
import type { Event, Interface, Json, PlaceOp, ValueItem, WriteOp } from "../src/types.ts";
import { hub } from "../src/link/wire.ts";
import { serve } from "../src/link/serve.ts";
import { kept } from "../src/link/kept.ts";

const a = { agent: "ay" };
const b = { agent: "bee" };

async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const values = (items: unknown[]) =>
  (items as ValueItem[]).filter((i) => "value" in i).map((i) => i.value);

/** A's stack: shared {title} with doc and locked, writes to locked refused; and a process with a window. */
function owner() {
  const ga = graph("root");
  // a window, as the C terminal's: a process whose screen is an ephemeral node it made
  const win = {
    compute: () => null,
    effect: ({ name, lasting, handler }: EffectGiven) => {
      lasting.place({
        address: [name],
        name: "screen",
        id: `${name}/screen`,
        value: { lines: ["count: 0"] },
        ephemeral: true,
      } as PlaceOp);
      handler("count", (n) =>
        lasting.write({
          address: [name, "screen"],
          patches: [{ type: "snapshot", value: { lines: [`count: ${n}`] } }],
        } as WriteOp));
    },
  };
  const A = schedule(
    protect(
      ga,
      (_agent, _process, op, args) =>
        !(op === "write" && (args as { node?: string }).node === "locked") || {
          rule: "locked",
        },
    ),
    { host: builtin({ win }) },
    { graph: ga },
  );
  A.place({ ...a, address: [], name: "loaders", id: "loaders", value: null });
  A.place({ ...a, address: ["loaders"], name: "host", id: "l/host", value: { loader: "host" } });
  A.place({ ...a, address: [], name: "programs", id: "programs", value: null });
  A.place({
    ...a,
    address: ["programs"],
    name: "win",
    id: "p/win",
    value: { kind: "host", compute: "win", effect: "win" },
  });
  A.place({ ...a, address: [], name: "shared", id: "shared", value: { title: "notes" } });
  A.place({ ...a, address: ["shared"], name: "doc", id: "doc", value: "hello" });
  A.place({ ...a, address: ["shared"], name: "locked", id: "locked", value: "no" });
  return A;
}

/** B: a graph kept in backend (as it was, if given), with the kept mirror's program. */
function mirrorer(
  h: ReturnType<typeof hub>,
  backend = memory(),
  was?: Awaited<ReturnType<typeof load>>,
) {
  let peer = "";
  const box: { top?: Scheduler } = {};
  const m = kept({
    connect: () => {
      const t = h.peer();
      peer = t.self;
      return t;
    },
    agent: "bee-mirror",
    api: () => box.top as Interface,
  });
  const gb = graph("root", was);
  const keeper = keep(gb, backend, "root", was ? { kept: was } : {});
  const table = {
    "mirror-kept": m.program,
    watch: {
      compute: ({ api, pending }: ComputeGiven) => {
        const items = api.read({ address: ["remote", "doc"] });
        return items.length ? items[0].value : pending;
      },
    },
  };
  const B = schedule(keeper, { host: builtin(table) }, {
    graph: gb,
    ...(was ? { time: was.time } : {}),
  });
  box.top = B;
  if (!was) {
    B.place({ ...b, address: [], name: "loaders", id: "loaders", value: null });
    B.place({ ...b, address: ["loaders"], name: "host", id: "l/host", value: { loader: "host" } });
    B.place({ ...b, address: [], name: "programs", id: "programs", value: null });
    for (const name of ["mirror-kept", "watch"]) {
      B.place({
        ...b,
        address: ["programs"],
        name,
        id: `p/${name}`,
        value: { kind: "host", compute: name, ...(name === "watch" ? {} : { effect: name }) },
      });
    }
  }
  const start = () =>
    (B.start({
      ...b,
      address: [],
      program: ["programs", "mirror-kept"],
      value: { channel: "test", name: "remote" },
    }).change as { id: string }).id;
  return { B, m, keeper, backend, start, peer: () => peer };
}

function setup(options: { shuffle?: boolean } = {}) {
  const h = hub(options);
  const A = owner();
  const served = serve(A, ["shared"], h.peer());
  const side = mirrorer(h);
  const pid = side.start();
  const B = side.B;
  const status = (at = pid) =>
    values(B.read({ ...b, address: [at, "link"] }))[0] as { [k: string]: Json };
  const stop = async () => {
    for (const p of B.read({ ...b, address: [] }).length ? [pid] : []) {
      try {
        B.unplace({ ...b, address: [], name: p, id: p });
      } catch { /* already */ }
    }
    await served.close();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  };
  return { h, A, B, pid, status, served, stop, side };
}

const read = (B: Scheduler, ...address: string[]) => B.read({ ...b, address });

Deno.test("kept: B reads A's values as ordinary nodes, the agent its own and A's change in the cause", async () => {
  const { A, B, stop } = setup();
  try {
    assertEquals(read(B, "remote"), []);
    await until(() => read(B, "remote", "doc").length > 0);
    assertEquals(values(read(B, "remote")), [{ title: "notes" }]);
    assertEquals(values(read(B, "remote", "doc")), ["hello"]);
    const doc = read(B, "remote", "doc")[0];
    assert(!doc.ephemeral, "a kept copy is an ordinary node: B's keeper keeps it");
    assertEquals(doc.from.route.at(-1)?.node, "remote:doc");
    // the mirror's process made it, as its own agent; the owner's change is in its cause
    assert(doc.change?.process !== undefined);
    assert(doc.change?.agent !== "ay");
    const theirs = A.read({ ...a, address: ["shared", "doc"] })[0];
    const cause = doc.change?.cause as { owner: { node: string; time: number; agent: Json } };
    assertEquals(cause.owner.node, "doc");
    assertEquals(cause.owner.time, theirs.change!.time);
    assertEquals(cause.owner.agent, "ay");
  } finally {
    await stop();
  }
});

Deno.test("kept: a write in B shows as a layer in front of the copy, then A's change replaces it", async () => {
  const { A, B, side, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    B.write({
      ...b,
      cause: { site: "b's" },
      address: ["remote", "doc"],
      patches: [{ type: "snapshot", value: "world" }],
    });
    // the written value at once; once the mirror has seen it, as a layer, the copy behind it the owner's
    assertEquals(values(read(B, "remote", "doc"))[0], "world");
    await tick();
    const now = read(B, "remote", "doc");
    assertEquals(values(now), ["world", "hello"]);
    assert(now[0].ephemeral, "the layer is ephemeral");
    assertEquals(now[0].change?.cause, {
      sending: "write",
      address: ["doc"],
      agent: "bee",
      cause: { site: "b's" },
    });
    await until(() => read(B, "remote", "doc").length === 1);
    assertEquals(A.read({ ...a, address: ["shared", "doc"] })[0].value, "world");
    const doc = read(B, "remote", "doc")[0];
    assertEquals(doc.value, "world");
    const cause = doc.change?.cause as { owner: { agent: Json } };
    assertEquals(cause.owner.agent, { actor: "bee", peer: side.peer() });
  } finally {
    await stop();
  }
});

Deno.test("kept: several writes in flight go to the layer and settle to A's", async () => {
  const { A, B, stop } = setup({ shuffle: true });
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    for (const ch of ["!", "?", "."]) {
      B.write({
        ...b,
        address: ["remote", "doc"],
        patches: [{ type: "splice", path: [], range: [5, 5], value: ch }],
      });
      await tick();
    }
    assertEquals(values(read(B, "remote", "doc"))[0], "hello.?!");
    await until(() => read(B, "remote", "doc").length === 1);
    assertEquals(values(read(B, "remote", "doc")), ["hello.?!"]);
    assertEquals(A.read({ ...a, address: ["shared", "doc"] })[0].value, "hello.?!");
  } finally {
    await stop();
  }
});

Deno.test("kept: a write A refuses: the layer goes, and the mirror process shows the error", async () => {
  const { B, pid, status, stop } = setup();
  try {
    await until(() => read(B, "remote", "locked").length > 0);
    const seen: Event[] = [];
    B.subscribe({ ...b, address: ["remote", "locked"], send: (e) => seen.push(e) });
    B.write({ ...b, address: ["remote", "locked"], patches: [{ type: "snapshot", value: "yes" }] });
    await tick();
    assertEquals(values(read(B, "remote", "locked")), ["yes", "no"]);
    await until(() => status().refused !== undefined);
    await until(() => read(B, "remote", "locked").length === 1);
    assertEquals(values(read(B, "remote", "locked")), ["no"]);
    const gone = seen.map((e) => "change" in e ? e.change : undefined)
      .find((c) => c?.kind === "unplace");
    const why = gone?.cause as { answered: string; refused: { kind: string } };
    assertEquals([why.answered, why.refused.kind], ["write", "refused"]);
    // the mirror's compute throws the owner's error: an error item on its process
    await until(() => read(B, pid).some((i) => "error" in i));
    const item = read(B, pid).find((i) => "error" in i) as unknown as {
      error: { kind: string; why: { rule: string } };
    };
    assertEquals([item.error.kind, item.error.why.rule], ["refused", "locked"]);
    // something the owner takes clears it
    B.write({ ...b, address: ["remote", "doc"], patches: [{ type: "snapshot", value: "ok" }] });
    await until(() => status().refused === undefined && !read(B, pid).some((i) => "error" in i));
  } finally {
    await stop();
  }
});

Deno.test("kept: A's own writes reach B's readers: a subscription and a compute", async () => {
  const { A, B, stop } = setup();
  try {
    const watch = (B.start({ ...b, address: [], program: ["programs", "watch"] }).change as {
      id: string;
    }).id;
    await until(() => values(read(B, watch)).includes("hello"));
    const events: Event[] = [];
    B.subscribe({ ...b, address: ["remote", "doc"], send: (e) => events.push(e) });
    A.write({ ...a, address: ["shared", "doc"], patches: [{ type: "snapshot", value: "from A" }] });
    await until(() => values(read(B, "remote", "doc"))[0] === "from A");
    assert(events.some((e) => "change" in e && e.change.kind === "write"));
    assertEquals(values(read(B, watch)), ["from A"]);
  } finally {
    await stop();
  }
});

Deno.test("kept: anyone places in the copy; it goes to A, and A's places come back", async () => {
  const { A, B, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    B.place({ ...b, address: ["remote"], name: "todo", id: "todo", value: [1, 2] });
    // an ordinary node here at once, and A makes it with the same id
    assertEquals(values(read(B, "remote", "todo")), [[1, 2]]);
    await until(() => A.read({ ...a, address: ["shared", "todo"] }).length > 0);
    assertEquals(A.read({ ...a, address: ["shared", "todo"] })[0].value, [1, 2]);
    // B's node is A's node's copy: one item, not two
    A.place({ ...a, address: ["shared", "todo"], name: "first", id: "first", value: "milk" });
    await until(() => read(B, "remote", "todo", "first").length > 0);
    assertEquals(values(read(B, "remote", "todo")), [[1, 2]]);
    assertEquals(read(B, "remote", "todo")[0].from.route.at(-1)?.node, "todo");
    assertEquals(read(B, "remote", "todo", "first")[0].from.route.at(-1)?.node, "remote:first");
    // an unplace in B, by the copy's id, goes to A
    B.unplace({ ...b, address: ["remote"], name: "doc", id: "remote:doc" });
    assertEquals(read(B, "remote", "doc"), []);
    await until(() => A.read({ ...a, address: ["shared", "doc"] }).length === 0);
    // A unplaces: B's copy follows
    A.unplace({ ...a, address: ["shared", "todo"], name: "first", id: "first" });
    await until(() => read(B, "remote", "todo", "first").length === 0);
  } finally {
    await stop();
  }
});

Deno.test("kept: the owner's ephemeral nodes (a window's screen) are copied and kept in step", async () => {
  const h = hub();
  const A = owner();
  A.place({ ...a, address: [], name: "windows", id: "windows", value: null });
  const win = (A.start({ ...a, address: ["windows"], program: ["programs", "win"] }).change as {
    id: string;
  }).id;
  const served = serve(A, ["windows"], h.peer());
  const side = mirrorer(h);
  const pid = side.start();
  const B = side.B;
  try {
    await until(() => read(B, "remote", win, "screen").length > 0);
    assertEquals(values(read(B, "remote", win, "screen")), [{ lines: ["count: 0"] }]);
    A.fire({ ...a, process: win, handler: "count", input: 3 });
    await until(() =>
      values(read(B, "remote", win, "screen"))[0]?.toString() !== undefined &&
      JSON.stringify(values(read(B, "remote", win, "screen"))) === '[{"lines":["count: 3"]}]'
    );
  } finally {
    B.unplace({ ...b, address: [], name: pid, id: pid });
    await served.close();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  }
});

Deno.test("kept: the owner going leaves the copy as it was, and says gone", async () => {
  const { B, status, served, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    await served.close("closing time");
    await until(() => status().state === "gone");
    assertEquals(values(read(B, "remote", "doc")), ["hello"]);
    assert(String(status().why).includes("closing time"));
  } finally {
    await stop();
  }
});

Deno.test("kept: stopping the mirror ends the link and unplaces the copy's root", async () => {
  const { B, pid, served, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    B.unplace({ ...b, address: [], name: pid, id: pid });
    await tick();
    assertEquals(read(B, "remote"), []);
    await until(() => served.peers().length === 0);
  } finally {
    await stop();
  }
});

Deno.test("kept: a reload keeps the copy, and the mirror started again makes nothing twice", async () => {
  const h = hub();
  const A = owner();
  const served = serve(A, ["shared"], h.peer());
  const first = mirrorer(h);
  first.start();
  try {
    await until(() => read(first.B, "remote", "doc").length > 0);
    await first.keeper.flush();
    // the page goes: nothing is killed, the link just ends
    const was = await load(first.backend);
    assert(was, "B kept its graph");
    // meanwhile A changes, and B's next page has the copy as it was
    A.write({ ...a, address: ["shared", "doc"], patches: [{ type: "snapshot", value: "later" }] });
    A.unplace({ ...a, address: ["shared"], name: "locked", id: "locked" });
    const again = mirrorer(h, first.backend, was);
    assertEquals(values(read(again.B, "remote", "doc")), ["hello"]);
    // the boot image starts the mirror again, where it was
    const pid = again.start();
    await until(() => values(read(again.B, "remote", "doc"))[0] === "later");
    await until(() => read(again.B, "remote", "locked").length === 0);
    const listing = again.B.directory({ ...b, address: ["remote"] });
    assert("directory" in listing);
    assertEquals(
      listing.directory.map(([n, items]) => [n, items.map((i) => i.id)]),
      [["doc", ["remote:doc"]]],
    );
    const root = again.B.directory({ ...b, address: [], name: "remote" });
    assertEquals("items" in root && root.items.length, 1);
    again.B.unplace({ ...b, address: [], name: pid, id: pid });
  } finally {
    await served.close();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  }
});
