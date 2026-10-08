import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { IDBFactory } from "fake-indexeddb";
import { type Graph, graph, type Kept } from "../../../../core/graph/typescript/graph.ts";
import { protect } from "../../../../core/protect/typescript/protect.ts";
import { type Backend, keep, type Keeper, KeepError, load, memory, META } from "./keeper.ts";
import { indexeddb } from "./indexeddb.ts";
import { files } from "./deno/files.ts";
import {
  type Address,
  type Interface,
  Invalid,
  type Json,
} from "../../../../core/graph/typescript/types.ts";

const site = { file: "keeper_test.ts", line: 1, column: 1 };

/** Something only the host holds. */
class Camera {}

/** A host: a graph made new or from what was kept, the keeper over it, and a clock. */
function host(backend: Backend, kept?: Kept, wrap = (api: Interface) => api) {
  const g = graph("root", kept);
  const k = keep(g, backend, "root", { kept, auto: false });
  const api = wrap(k);
  let t = kept?.time ?? 0;
  // letting an ephemeral node go takes times of its own; the host's clock goes past them
  const next = () => (t = Math.max(t, k.kept().time) + 1);
  const as = (more: { process?: string } = {}) => ({ agent: "host", cause: site, ...more });
  return {
    g,
    k,
    api,
    next,
    write: (address: Address, patches: unknown[], more = {}) =>
      api.write({ ...as(more), address, patches: patches as never, time: next() }),
    place: (
      address: Address,
      name: string,
      id: string,
      more: { position?: number; value?: Json | Camera; ephemeral?: boolean; process?: string } =
        {},
    ) => api.place({ ...as(more), address, name, id, ...(more as object), time: next() }),
    unplace: (address: Address, name: string, id: string, more = {}) =>
      api.unplace({ ...as(more), address, name, id, time: next() }),
  };
}

type Host = ReturnType<typeof host>;

/** Every id the scenario makes or mounts. */
const IDS = ["d1", "d2", "d3", "x1", "u1", "o1", "e1", "e2", "e3", "e4", "m1"];
const EPHEMERAL = ["e1", "e2", "e3", "e4", "m1"];

/**
 * Ordinary and ephemeral nodes side by side: unions, positions among
 * ephemeral ids, the id of an ephemeral node that went mounted again, an
 * ordinary node only reachable through an ephemeral one, an unreachable
 * ordinary node, and an ephemeral tree let go. Gives the time of the change
 * that let it go and how many ids it took out.
 */
function scenario(h: Host) {
  const p = { process: "@1-dabot" };
  h.place([], "docs", "d1", {
    value: {
      title: "a",
      n: -0,
      nan: NaN,
      big: 1e300,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      f: new Float32Array([1.5, NaN]),
      i: new BigInt64Array([-5n]),
    },
  });
  h.write(["docs"], [{ type: "set", path: [], key: "more", value: [1, "two", null, true] }]);
  h.place([], "docs", "d2", { value: "second" });
  h.place(["docs"], "x", "x1", { value: "hello" });
  h.write(["docs", "x"], [{ type: "splice", path: [], range: [5, 5], value: " world" }]);
  // an ephemeral node, live, holding an ephemeral one and an ordinary one
  h.place([], "cam", "e1", { value: new Camera(), ephemeral: true, ...p });
  h.place(["cam"], "out", "e2", { value: { frame: 1 }, ephemeral: true, ...p });
  h.place(["cam"], "held", "x1", p);
  h.write(["cam", "out"], [{ type: "snapshot", value: { frame: 2 } }], p);
  // an ephemeral node made in the union, then an ordinary node placed after it
  h.place([], "docs", "e4", { position: 1, value: "among", ephemeral: true, ...p });
  h.place([], "docs", "d3", { position: 2, value: 3 });
  // an ephemeral node gone, then its id mounted: a node that is not here
  h.place([], "eph", "m1", { value: "fleeting", ephemeral: true, ...p });
  assertEquals(h.unplace([], "eph", "m1", p).gone, ["m1"]);
  h.place([], "later", "m1");
  // an ordinary node made, then unplaced: here but unreachable
  h.place([], "u", "u1", { value: { v: 1 } });
  h.write(["u"], [{ type: "set", path: [], key: "v", value: 2 }]);
  h.unplace([], "u", "u1");
  // a slot whose last change is ordinary, then an ephemeral one into it
  h.place([], "mix", "o1", { value: "ordinary" });
  h.place([], "mix", "e3", { value: "live", ephemeral: true, ...p });
  h.place([], "mix", "e3", { position: 0, ...p });
  // let e1 go from its one slot: x1 is taken out of held, then e2 out of out
  const letting = h.unplace([], "cam", "e1", p);
  assertEquals(letting.gone, ["e2", "e1"]);
  return { at: letting.change.time, out: 0 };
}

/** What the graph gives for each address down from the root, a few levels deep. */
function tree(g: Graph, address: Address = [], depth = 4): Json {
  const as = { agent: "probe" };
  const listing = g.directory({ ...as, address });
  const names = "directory" in listing ? listing.directory : [];
  return {
    read: g.read({ ...as, address }),
    directory: names,
    below: depth
      ? Object.fromEntries(names.map(([n]) => [n, tree(g, [...address, n], depth - 1)]))
      : null,
  } as unknown as Json;
}

/** Each id mounted under a name of its own, and what it reads as there. */
function probe(g: Graph, ids: string[], from: number): Json {
  let t = from;
  const out: { [id: string]: Json } = {};
  for (const id of ids) {
    const name = `probe ${id}`;
    g.place({ agent: "probe", cause: site, address: [], name, id, time: ++t });
    out[id] = {
      read: g.read({ agent: "probe", address: [name] }),
      directory: g.directory({ agent: "probe", address: [name] }),
      slot: g.directory({ agent: "probe", address: [], name }),
    } as unknown as Json;
  }
  return out;
}

/** The graph as it reads, then with every id mounted, starting at a time after from. */
function reads(g: Graph, from: number) {
  return { tree: tree(g), probed: probe(g, IDS, from) };
}

Deno.test("a kept graph loaded back reads as the graph does once it is kept", async () => {
  const backend = memory();
  const h = host(backend);
  scenario(h);
  await h.k.flush();
  const kept = await load(backend);
  assert(kept);
  const d1 = kept.nodes.get("d1")!.value as { n: number; nan: number };
  assert(Object.is(d1.n, -0) && Number.isNaN(d1.nan));
  h.g.reload();
  const loaded = graph("root", kept);
  const time = kept.time + 100;
  assertEquals(reads(loaded, time), reads(h.g, time));
});

Deno.test("what is kept is what the graph's own reload keeps, before and after flushing", async () => {
  const backend = memory();
  const h = host(backend);
  scenario(h);
  const before = h.k.kept();
  await h.k.flush();
  assertEquals(await load(backend), before);
});

Deno.test("ephemeral nodes and changes are gone after a load", async () => {
  const backend = memory();
  const h = host(backend);
  scenario(h);
  await h.k.flush();
  const kept = (await load(backend))!;
  for (const id of EPHEMERAL) assert(!kept.nodes.has(id), id);
  const g = graph("root", kept);
  const as = { agent: "probe" };
  // no slot holds an id an ephemeral change put there
  const docs = g.directory({ ...as, address: [], name: "docs" });
  assertEquals("items" in docs && docs.items.map((i) => i.id), ["d1", "d3", "d2"]);
  assertEquals(g.directory({ ...as, address: [], name: "eph" }), { items: [] });
  // the ordinary node e1 held is here, and reached again by mounting it
  assertEquals(g.directory({ ...as, address: [], name: "cam" }), { items: [] });
  g.place({ agent: "a", cause: site, address: [], name: "back", id: "x1", time: kept.time + 1 });
  assertEquals(g.read({ ...as, address: ["back"] })[0].value, "hello world");
  // the ephemeral write left nothing; the ordinary node's slots are its own
  assertEquals(g.directory({ ...as, address: ["back"] }), { directory: [] });
});

Deno.test("a mount of the id of an ephemeral node that went is kept, pending", async () => {
  const backend = memory();
  const h = host(backend);
  scenario(h);
  const mount = h.g.directory({ agent: "probe", address: [], name: "later" });
  assert("items" in mount);
  assertEquals(mount.items.map((i) => [i.id, i.pending, i.ephemeral]), [["m1", true, undefined]]);
  await h.k.flush();
  const g = graph("root", (await load(backend))!);
  const items = g.directory({ agent: "probe", address: [], name: "later" });
  assert("items" in items);
  assertEquals(items.items.map((i) => [i.id, i.pending]), [["m1", true]]);
  assertEquals(items.items[0].change, mount.items[0].change);
});

Deno.test("each slot keeps its last change that was not ephemeral", async () => {
  const backend = memory();
  const h = host(backend);
  const made = h.place([], "mix", "o1", { value: "ordinary" });
  h.place([], "mix", "e3", { value: "live", ephemeral: true, process: "p" });
  h.place([], "mix", "e3", { position: 0, process: "p" });
  const docs = h.place([], "docs", "d1", { value: 1 });
  h.place([], "docs", "e1", { value: 2, ephemeral: true, process: "p" });
  h.unplace([], "docs", "e1", { process: "p" });
  const gone = h.place([], "gone", "g1", { value: 3 });
  h.unplace([], "gone", "g1");
  await h.k.flush();
  const g = graph("root", (await load(backend))!);
  const slot = (name: string) => {
    const l = g.directory({ agent: "probe", address: [], name });
    return "items" in l ? l.items : [];
  };
  assertEquals(slot("mix").map((i) => [i.id, i.change?.time]), [["o1", made.change.time]]);
  assertEquals(slot("docs").map((i) => [i.id, i.change?.time]), [["d1", docs.change.time]]);
  assertEquals(slot("gone"), []);
  assert(gone.change.time > 0);
});

Deno.test("the clock carries on after a load, from the last change", async () => {
  const backend = memory();
  const h = host(backend);
  const { at, out } = scenario(h);
  await h.k.flush();
  const kept = (await load(backend))!;
  assertEquals(kept.time, at + out);
  const g = graph("root", kept);
  const write = (time: number) =>
    g.write({ agent: "a", cause: site, address: [], patches: [], time });
  assertThrows(() => write(kept.time), Invalid, "not after");
  write(kept.time + 1);
  // the graph that was kept says the same
  const was = (time: number) =>
    h.g.write({ agent: "a", cause: site, address: [], patches: [], time });
  assertThrows(() => was(kept.time), Invalid, "not after");
  was(kept.time + 1);
});

Deno.test("a loaded graph keeps on being kept", async () => {
  const backend = memory();
  const h1 = host(backend);
  scenario(h1);
  await h1.k.flush();
  const kept = (await load(backend))!;
  const h2 = host(backend, kept);
  h2.write(["docs"], [{ type: "set", path: [], key: "title", value: "b" }]);
  h2.place(["docs"], "y", "y1", { value: [1, 2] });
  h2.place([], "cam", "e9", { value: new Camera(), ephemeral: true, process: "p" });
  h2.place(["cam"], "x", "y1", { process: "p" });
  h2.place([], "u", "u1");
  await h2.k.flush();
  const again = (await load(backend))!;
  h2.g.reload();
  const time = again.time + 100;
  assertEquals(reads(graph("root", again), time), reads(h2.g, time));
  assertEquals(again.nodes.get("u1")?.value, { v: 2 });
});

Deno.test("an incremental flush writes only the nodes that changed", async () => {
  const backend = memory();
  const h = host(backend);
  scenario(h);
  await h.k.flush();
  const keys: string[][] = [];
  const spy: Backend = {
    read: () => backend.read(),
    write: (batch, whole) => {
      keys.push([...batch.keys()].sort());
      return backend.write(batch, whole);
    },
  };
  const kept = (await load(backend))!;
  const g = graph("root", kept);
  const k = keep(g, spy, "root", { kept, auto: false });
  k.write({ agent: "a", cause: site, address: ["docs"], patches: [], time: kept.time + 1 });
  k.place({
    agent: "a",
    cause: site,
    process: "p",
    address: [],
    name: "e",
    id: "e5",
    value: 1,
    ephemeral: true,
    time: kept.time + 2,
  });
  await k.flush();
  await k.flush();
  assertEquals(keys, [["meta", "node:d1"]]);
});

Deno.test("changes made while another is made, by a subscriber, are kept in time order", async () => {
  const backend = memory();
  const h = host(backend);
  h.api.subscribe({
    agent: "watcher",
    address: ["n"],
    send: (event) => {
      if ("change" in event && event.reaches?.length && event.change.kind === "place") {
        h.write(["n"], [{ type: "set", path: [], key: "seen", value: true }], {
          process: "w",
        });
      }
    },
  });
  h.place([], "n", "n1", { value: {} });
  await h.k.flush();
  const kept = (await load(backend))!;
  assertEquals(kept.nodes.get("n1")?.value, { seen: true });
  h.g.reload();
  assertEquals(reads(graph("root", kept), 1000), reads(h.g, 1000));
});

Deno.test("a keeper beneath protect learns what passes through it", async () => {
  const backend = memory();
  const h = host(backend, undefined, (api) => protect(api, (_a, _p, op) => op !== "unplace"));
  h.place([], "a", "a1", { value: 1 });
  assertThrows(() => h.unplace([], "a", "a1"));
  await h.k.flush();
  const kept = (await load(backend))!;
  assertEquals(kept.nodes.get("a1")?.value, 1);
});

Deno.test("a change applied through the keeper, as an arrival is, is kept", async () => {
  const backend = memory();
  const h = host(backend);
  h.place([], "n", "n1");
  const at = h.next();
  h.k.apply!("n1", {
    kind: "write",
    patches: [{ type: "snapshot", value: "arrived" }],
    agent: "a",
    cause: site,
    time: at,
  });
  assertEquals(h.k.kept().time, at);
  await h.k.flush();
  const g = graph("root", (await load(backend))!);
  assertEquals(g.read({ agent: "probe", address: ["n"] })[0].value, "arrived");
});

Deno.test("flushing after each operation needs no call", async () => {
  const backend = memory();
  const g = graph("root");
  const k = keep(g, backend, "root");
  k.place({ agent: "a", cause: site, address: [], name: "a", id: "a1", value: 1, time: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals((await load(backend))?.nodes.get("a1")?.value, 1);
});

Deno.test("a new graph's first flush replaces whatever the backend held", async () => {
  const backend = memory();
  backend.records.set("node:stale", new Uint8Array([0xa0]));
  backend.records.set(META, new Uint8Array([0xa0]));
  const k = keep(graph("root"), backend, "root", { auto: false });
  await k.flush();
  assertEquals([...backend.records.keys()].sort(), ["meta", "node:root"]);
  assertEquals((await load(backend))?.time, 0);
});

Deno.test("a failed write is written whole next time", async () => {
  const backend = memory();
  let fail = false;
  const flaky: Backend = {
    read: () => backend.read(),
    write: (batch, whole) => fail ? Promise.reject(new Error("disk")) : backend.write(batch, whole),
  };
  const h = host(flaky);
  h.place([], "a", "a1", { value: 1 });
  await h.k.flush();
  fail = true;
  h.place([], "b", "b1", { value: 2 });
  await assertRejects(() => h.k.flush(), Error, "disk");
  fail = false;
  h.place([], "c", "c1", { value: 3 });
  await h.k.flush();
  assertEquals(await load(backend), h.k.kept());
});

Deno.test("a keeper that missed a change says so", async () => {
  const g = graph("root");
  g.place({ agent: "a", cause: site, address: [], name: "a", id: "a1", value: 1, time: 1 });
  const k = keep(g, memory(), "root", { auto: false });
  k.write({ agent: "a", cause: site, address: ["a"], patches: [], time: 2 });
  await assertRejects(() => k.flush(), KeepError, "never saw");
});

Deno.test("storage that is not a keeper's is refused", async () => {
  const backend = memory();
  const k = keep(graph("root"), backend, "root", { auto: false });
  await k.flush();
  backend.records.set("node:root", new Uint8Array([0xf6]));
  await assertRejects(() => load(backend), KeepError);
  backend.records.delete("node:root");
  await assertRejects(() => load(backend), KeepError, "root");
  assertEquals(await load(memory()), undefined);
  assertThrows(() => graph("other", { root: "root", time: 0, nodes: new Map() }), Invalid);
});

// backends

async function roundTrip(open: () => Backend) {
  const h = host(open());
  scenario(h);
  await h.k.flush();
  h.place(["docs"], "late", "l1", { value: "after the first flush" });
  h.write(["docs", "late"], [{ type: "snapshot", value: "written twice" }]);
  await h.k.flush();
  const kept = (await load(open()))!;
  assertEquals(kept, h.k.kept());
  h.g.reload();
  const time = kept.time + 100;
  assertEquals(reads(graph("root", kept), time), reads(h.g, time));
}

Deno.test("files: a kept graph loads back from a fresh backend on the same directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await roundTrip(() => files(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("files: a frame cut short is dropped, and what came before stands", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const h = host(files(dir));
    h.place([], "a", "a1", { value: 1 });
    await h.k.flush();
    h.place([], "b", "b1", { value: 2 });
    await h.k.flush();
    const whole = await Deno.readFile(`${dir}/log`);
    await Deno.writeFile(`${dir}/log`, new Uint8Array([0, 0, 1, 0, 0xa1, 0x61]), { append: true });
    assertEquals(await load(files(dir)), h.k.kept());
    assertEquals(await Deno.readFile(`${dir}/log`), whole);
    // and writing after it is read again
    const again = files(dir);
    const kept = (await load(again))!;
    const k = keep(graph("root", kept), again, "root", { kept, auto: false });
    k.place({ agent: "a", cause: site, address: [], name: "c", id: "c1", value: 3, time: 99 });
    await k.flush();
    assertEquals(await load(files(dir)), k.kept());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("files: a log grown past what it holds is rewritten", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const h = host(files(dir, { slack: 0 }));
    h.place([], "a", "a1", { value: "x".repeat(100) });
    await h.k.flush();
    for (let i = 0; i < 20; i++) {
      h.write(["a"], [{ type: "snapshot", value: "y".repeat(100 + i) }]);
      await h.k.flush();
    }
    const { size } = await Deno.stat(`${dir}/log`);
    assert(size < 4 * 400, `the log is ${size} bytes`);
    assertEquals(await load(files(dir)), h.k.kept());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("indexeddb: a kept graph loads back from the same database", async () => {
  const factory = new IDBFactory();
  const opened: ReturnType<typeof indexeddb>[] = [];
  try {
    await roundTrip(() => {
      const b = indexeddb("ermine", factory);
      opened.push(b);
      return b;
    });
  } finally {
    for (const b of opened) b.close();
  }
});

Deno.test("indexeddb: a whole write replaces every record", async () => {
  const factory = new IDBFactory();
  const b = indexeddb("ermine", factory);
  try {
    await b.write(new Map([["x", new Uint8Array([1])], ["y", new Uint8Array([2])]]), false);
    await b.write(new Map([["y", null], ["z", new Uint8Array([3])]]), false);
    assertEquals([...(await b.read()).keys()].sort(), ["x", "z"]);
    await b.write(new Map([["w", new Uint8Array([4])]]), true);
    assertEquals(await b.read(), new Map([["w", new Uint8Array([4])]]));
  } finally {
    b.close();
  }
});

/** Unused, so the type is checked: a keeper is an interface. */
export const _keeper: (k: Keeper) => Interface = (k) => k;
