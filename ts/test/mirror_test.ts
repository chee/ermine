// A mirror: two stacks on one in-memory channel. A owns and serves a
// subtree; B runs a mirror process that copies it into B's graph, where it
// is read synchronously, and sends B's writes to A.

import { assert, assertEquals } from "@std/assert";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { schedule, type Scheduler } from "../src/schedule.ts";
import { builtin, type ComputeGiven, type EffectGiven } from "../src/loaders.ts";
import type { Event, Json, PlaceOp, ValueItem, WriteOp } from "../src/types.ts";
import { hub } from "../src/link/wire.ts";
import { serve } from "../src/link/serve.ts";
import { mirrors } from "../src/link/mirror.ts";

const a = { agent: "ay" };
const b = { agent: "bee" };

/** Waits until f is true, checking every few ms. */
async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const values = (items: unknown[]) =>
  (items as ValueItem[]).filter((i) => "value" in i).map((i) => i.value);

/** A: shared {title} with doc and locked, writes to locked refused. B: a mirror of shared at /remote. */
function setup(options: { shuffle?: boolean } = {}) {
  const h = hub(options);
  const ga = graph("root");
  const A = schedule(
    protect(
      ga,
      (_agent, _process, op, args) =>
        !(op === "write" && (args as { node?: string }).node === "locked") || {
          rule: "locked",
        },
    ),
    {},
    { graph: ga },
  );
  A.place({ ...a, address: [], name: "shared", id: "shared", value: { title: "notes" } });
  A.place({ ...a, address: ["shared"], name: "doc", id: "doc", value: "hello" });
  A.place({ ...a, address: ["shared"], name: "locked", id: "locked", value: "no" });
  const ownerT = h.peer();
  const served = serve(A, ["shared"], ownerT);

  /** the mirror's id on the channel: the peer A stamps B's changes with */
  let peer = "";
  const m = mirrors({
    connect: () => {
      const t = h.peer();
      peer = t.self;
      return t;
    },
    agent: "bee-mirror",
  });
  const gb = graph("root");
  const table = {
    mirror: m.program,
    // a derived value: what /remote/doc reads, pending until it reads something
    watch: {
      compute: ({ api, pending }: ComputeGiven) => {
        const items = api.read({ address: ["remote", "doc"] });
        return items.length ? items[0].value : pending;
      },
    },
  };
  const B = m.wrap(schedule(gb, { host: builtin(table) }, { graph: gb }));
  B.place({ ...b, address: [], name: "loaders", id: "loaders", value: null });
  B.place({ ...b, address: ["loaders"], name: "host", id: "l/host", value: { loader: "host" } });
  B.place({ ...b, address: [], name: "programs", id: "programs", value: null });
  for (const name of ["mirror", "watch"]) {
    B.place({
      ...b,
      address: ["programs"],
      name,
      id: `p/${name}`,
      value: { kind: "host", compute: name, ...(name === "mirror" ? { effect: name } : {}) },
    });
  }
  const pid = (B.start({
    ...b,
    address: [],
    program: ["programs", "mirror"],
    value: { channel: "test", name: "remote" },
  }).change as { id: string }).id;
  const status = () =>
    values(B.read({ ...b, address: [pid, "link"] }))[0] as {
      [k: string]: Json;
    };
  const stop = async () => {
    try {
      B.unplace({ ...b, address: [], name: pid, id: pid });
    } catch { /* already */ }
    await served.close();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  };
  return { A, B, pid, status, served, stop, ownerT, h, peer: () => peer };
}

const read = (B: Scheduler, ...address: string[]) => B.read({ ...b, address });

Deno.test("B reads A's values: nothing first, then the copy, saying who and why", async () => {
  const { A, B, status, stop } = setup();
  try {
    // synchronous, and nothing known yet
    assertEquals(read(B, "remote"), []);
    assertEquals(status().state, "dialing");
    await until(() => read(B, "remote", "doc").length > 0);
    assertEquals(values(read(B, "remote")), [{ title: "notes" }]);
    assertEquals(values(read(B, "remote", "doc")), ["hello"]);
    assertEquals(status().state, "mounted");
    // the copy's change has A's agent, and A's time in its cause
    const doc = read(B, "remote", "doc")[0];
    const theirs = A.read({ ...a, address: ["shared", "doc"] })[0];
    assertEquals(doc.change?.agent, "ay");
    assertEquals((doc.change?.cause as { time: number }).time, theirs.change!.time);
    assert(doc.ephemeral, "a copy is ephemeral: B's keeper does not keep it");
  } finally {
    await stop();
  }
});

Deno.test("a write in B shows at once as a layer, then A's change replaces it", async () => {
  const { A, B, peer, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    B.write({
      ...b,
      cause: { site: "b's" },
      address: ["remote", "doc"],
      patches: [{ type: "snapshot", value: "world" }],
    });
    // at once: the layer in front, the copy behind; its cause names who sent it, and why
    const now = read(B, "remote", "doc");
    assertEquals(values(now), ["world", "hello"]);
    assertEquals(now[0].change?.cause, {
      sending: "write",
      address: ["doc"],
      agent: "bee",
      cause: { site: "b's" },
    });
    // A has it, and B's copy takes A's change: one item, with A's time
    await until(() => read(B, "remote", "doc").length === 1);
    const theirs = A.read({ ...a, address: ["shared", "doc"] })[0];
    assertEquals(theirs.value, "world");
    const doc = read(B, "remote", "doc")[0];
    assertEquals(doc.value, "world");
    // as A stamped it: the agent B claimed, and B's mirror's key on the channel
    assertEquals(doc.change?.agent, { actor: "bee", peer: peer() });
    assertEquals((doc.change?.cause as { time: number }).time, theirs.change!.time);
  } finally {
    await stop();
  }
});

Deno.test("several writes in flight stack on one layer and settle to A's", async () => {
  const { A, B, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    for (const ch of ["!", "?", "."]) {
      B.write({
        ...b,
        address: ["remote", "doc"],
        patches: [{ type: "splice", path: [], range: [5, 5], value: ch }],
      });
    }
    assertEquals(values(read(B, "remote", "doc"))[0], "hello.?!");
    await until(() => read(B, "remote", "doc").length === 1);
    assertEquals(values(read(B, "remote", "doc")), ["hello.?!"]);
    assertEquals(A.read({ ...a, address: ["shared", "doc"] })[0].value, "hello.?!");
  } finally {
    await stop();
  }
});

Deno.test("a write A refuses: the layer goes, and the refusal is in the status", async () => {
  const { B, status, stop } = setup();
  try {
    await until(() => read(B, "remote", "locked").length > 0);
    const seen: Event[] = [];
    B.subscribe({ ...b, address: ["remote", "locked"], send: (e) => seen.push(e) });
    B.write({ ...b, address: ["remote", "locked"], patches: [{ type: "snapshot", value: "yes" }] });
    assertEquals(values(read(B, "remote", "locked")), ["yes", "no"]);
    await until(() => (status().refused as Json[]).length > 0);
    assertEquals(values(read(B, "remote", "locked")), ["no"]);
    // the layer going is a change, and its cause says the owner refused
    const gone = seen.map((e) => "change" in e ? e.change : undefined)
      .find((c) => c?.kind === "unplace");
    const why = gone?.cause as { answered: string; refused: { kind: string } };
    assertEquals([why.answered, why.refused.kind], ["write", "refused"]);
    const [refused] = status().refused as { cmd: string; address: string[]; error: Json }[];
    assertEquals(refused.cmd, "write");
    assertEquals(refused.address, ["locked"]);
    const error = refused.error as { kind: string; why: { rule: string } };
    assertEquals([error.kind, error.why.rule], ["refused", "locked"]);
    assertEquals(status().sending, 0);
  } finally {
    await stop();
  }
});

Deno.test("A's own writes reach B's readers: a subscription and a compute", async () => {
  const { A, B, stop } = setup();
  try {
    const started = B.start({ ...b, address: [], program: ["programs", "watch"] });
    const watch = (started.change as { id: string }).id;
    await until(() => read(B, "remote", "doc").length > 0);
    await until(() => values(read(B, watch)).includes("hello"));
    const events: Event[] = [];
    B.subscribe({ ...b, address: ["remote", "doc"], send: (e) => events.push(e) });
    A.write({ ...a, address: ["shared", "doc"], patches: [{ type: "snapshot", value: "from A" }] });
    await until(() => values(read(B, "remote", "doc"))[0] === "from A");
    assertEquals(read(B, "remote", "doc")[0].change?.agent, "ay");
    assert(events.some((e) => "change" in e && e.change.kind === "write"));
    // the compute that read the copy was marked and ran again
    assertEquals(values(read(B, watch)), ["from A"]);
  } finally {
    await stop();
  }
});

Deno.test("places and unplaces go to A; a new node shows at once", async () => {
  const { A, B, peer, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    B.place({ ...b, address: ["remote"], name: "todo", id: "todo", value: [1, 2] });
    const now = read(B, "remote", "todo");
    assertEquals(values(now), [[1, 2]]);
    assertEquals((now[0].change?.cause as { sending: string }).sending, "place");
    await until(() => A.read({ ...a, address: ["shared", "todo"] }).length > 0);
    await until(() => !("sending" in (read(B, "remote", "todo")[0]?.change?.cause as object)));
    assertEquals(values(read(B, "remote", "todo")), [[1, 2]]);
    assertEquals(read(B, "remote", "todo")[0].change?.agent, { actor: "bee", peer: peer() });
    // A places something itself
    A.place({ ...a, address: ["shared", "todo"], name: "first", id: "first", value: "milk" });
    await until(() => read(B, "remote", "todo", "first").length > 0);
    assertEquals(values(read(B, "remote", "todo", "first")), ["milk"]);
    // an unplace from B, by the copy's id, shows when A's change comes back
    const id = B.directory({ ...b, address: ["remote"], name: "doc" });
    const local = ("items" in id ? id.items : [])[0].id;
    B.unplace({ ...b, address: ["remote"], name: "doc", id: local });
    await until(() => read(B, "remote", "doc").length === 0);
    assertEquals(A.read({ ...a, address: ["shared", "doc"] }), []);
  } finally {
    await stop();
  }
});

Deno.test("the owner going leaves the mirror's place reading nothing, and says gone", async () => {
  const { B, status, served, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    await served.close("closing time");
    await until(() => status().state === "gone");
    assertEquals(read(B, "remote"), []);
    assert(String(status().why).includes("closing time"));
  } finally {
    await stop();
  }
});

Deno.test("stopping the mirror ends the link and lets the copy go", async () => {
  const { B, pid, served, stop } = setup();
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    B.unplace({ ...b, address: [], name: pid, id: pid });
    assertEquals(read(B, "remote"), []);
    await until(() => served.peers().length === 0);
    // writing there now is writing to nothing
    let threw = false;
    try {
      B.write({ ...b, address: ["remote", "doc"], patches: [] });
    } catch {
      threw = true;
    }
    assert(threw);
  } finally {
    await stop();
  }
});

Deno.test("a write to a node and a place under it, in flight together, both land", async () => {
  const { A, B, stop } = setup({ shuffle: true });
  try {
    await until(() => read(B, "remote", "doc").length > 0);
    B.write({
      ...b,
      address: ["remote"],
      patches: [{ type: "set", path: [], key: "title", value: "plans" }],
    });
    B.place({ ...b, address: ["remote"], name: "new", id: "new", value: 7 });
    B.write({ ...b, address: ["remote", "doc"], patches: [{ type: "snapshot", value: "bye" }] });
    // all three at once, the copies behind the layers
    assertEquals(values(read(B, "remote")), [{ title: "plans" }, { title: "notes" }]);
    assertEquals(values(read(B, "remote", "new")), [7]);
    assertEquals(values(read(B, "remote", "doc")), ["bye", "hello"]);
    await until(() =>
      read(B, "remote").length === 1 && read(B, "remote", "doc").length === 1 &&
      !("sending" in (read(B, "remote", "new")[0]?.change?.cause as object ?? {}))
    );
    assertEquals(values(read(B, "remote")), [{ title: "plans" }]);
    assertEquals(values(read(B, "remote", "new")), [7]);
    assertEquals(values(read(B, "remote", "doc")), ["bye"]);
    assertEquals(A.read({ ...a, address: ["shared"] })[0].value, { title: "plans" });
    assertEquals(A.read({ ...a, address: ["shared", "new"] })[0].value, 7);
  } finally {
    await stop();
  }
});

Deno.test("the owner's ephemeral nodes, as a terminal's windows have them, are copied and kept in step", async () => {
  const h = hub({ shuffle: true });
  const ga = graph("root");
  // a window, as the C terminal's: a process node whose screen and keys are ephemeral nodes it made
  const win = {
    compute: () => null,
    effect: ({ name, lasting, handler }: EffectGiven) => {
      for (const [slot, value] of [["screen", { lines: ["count: 0"] }], ["keys", ""]] as const) {
        lasting.place({
          address: [name],
          name: slot,
          id: `${name}/${slot}`,
          value,
          ephemeral: true,
        } as PlaceOp);
      }
      handler("count", (n) =>
        lasting.write({
          address: [name, "screen"],
          patches: [{ type: "snapshot", value: { lines: [`count: ${n}`] } }],
        } as WriteOp));
    },
  };
  const A = schedule(ga, { host: builtin({ win }) }, { graph: ga });
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
  A.place({ ...a, address: [], name: "windows", id: "windows", value: null });
  const start = () =>
    (A.start({ ...a, address: ["windows"], program: ["programs", "win"] }).change as {
      id: string;
    }).id;
  const one = start();
  const served = serve(A, ["windows"], h.peer());
  const m = mirrors({ connect: () => h.peer(), agent: "bee-mirror" });
  const gb = graph("root");
  const B = m.wrap(schedule(gb, { host: builtin({ mirror: m.program }) }, { graph: gb }));
  B.place({ ...b, address: [], name: "loaders", id: "loaders", value: null });
  B.place({ ...b, address: ["loaders"], name: "host", id: "l/host", value: { loader: "host" } });
  B.place({ ...b, address: [], name: "programs", id: "programs", value: null });
  B.place({
    ...b,
    address: ["programs"],
    name: "mirror",
    id: "p/mirror",
    value: { kind: "host", compute: "mirror", effect: "mirror" },
  });
  const pid = (B.start({
    ...b,
    address: [],
    program: ["programs", "mirror"],
    value: { channel: "c", name: "remote" },
  }).change as { id: string }).id;
  const screen = (w: string) => values(B.read({ ...b, address: ["remote", w, "screen"] }));
  try {
    await until(() => screen(one).length > 0);
    assertEquals(screen(one), [{ lines: ["count: 0"] }]);
    assertEquals(values(B.read({ ...b, address: ["remote", one, "keys"] })), [""]);
    A.fire({ ...a, process: one, handler: "count", input: 5 });
    await until(() => JSON.stringify(screen(one)) === '[{"lines":["count: 5"]}]');
    // a window started after the mount comes with its screen
    const two = start();
    await until(() => screen(two).length > 0);
    assertEquals(screen(two), [{ lines: ["count: 0"] }]);
  } finally {
    B.unplace({ ...b, address: [], name: pid, id: pid });
    await served.close();
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
  }
});
