// The first sync experiment (SYNC.tex; layers/subduction/sync-experiment.org):
// one node's value shared between two graphs in one process, commits passed
// by hand, no network.

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { graph } from "../../../core/graph/typescript/graph.ts";
import { schedule, type Scheduler } from "../../../core/scheduler/typescript/schedule.ts";
import { builtin, type ComputeGiven } from "../../../core/scheduler/typescript/loaders.ts";
import type { Change, Event, Json, Patch } from "../../../core/graph/typescript/types.ts";
import type { StartOp } from "../../../core/scheduler/typescript/loaders.ts";
import { type Commit, commit, CommitError, open, qualify, trim } from "./commit.ts";
import { encode, type Value } from "../../../core/graph/typescript/cbor.ts";
import { digest } from "../../../core/graph/typescript/hash.ts";
import { share, type SideItem } from "./share.ts";

const host = { agent: "host", cause: { file: "sync_test.ts", line: 1, column: 1 } };

/** A device: a scheduler over a bare graph, a watch program, the node "doc", shared on top. */
function device(name: string) {
  const g = graph("root");
  const table = {
    watch: {
      compute: ({ api }: ComputeGiven) =>
        api.read({ address: ["doc"] }).map((i) => (i as SideItem).commit ?? null),
    },
  };
  const s = schedule(g, { host: builtin(table) }, { graph: g });
  s.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
  s.place({ ...host, address: ["loaders"], name: "host", id: "l/host", value: { loader: "host" } });
  s.place({ ...host, address: [], name: "programs", id: "programs", value: null });
  s.place({
    ...host,
    address: ["programs"],
    name: "watch",
    id: "p/watch",
    value: { kind: "host", compute: "watch" },
  });
  s.place({ ...host, address: [], name: "doc", id: "doc", value: null });
  // the clock goes on from its own times; let the two devices' clocks differ
  if (name === "B") { for (let i = 0; i < 5; i++) s.write({ ...host, address: [], patches: [] }); }
  return share(s as Scheduler, { id: "doc", address: ["doc"], device: key(name) });
}

/** A made-up device key, 64 hex digits, from a name. */
function key(name: string): string {
  return [...name].map((ch) => ch.charCodeAt(0).toString(16)).join("").padEnd(64, "0");
}

type Device = ReturnType<typeof device>;

const doc = (d: Device) => d.read({ agent: "host", address: ["doc"] }) as SideItem[];
const values = (d: Device) => doc(d).map((i) => i.value);
const commits = (d: Device) => doc(d).map((i) => i.commit);
const snap = (value: Json): Patch[] => [{ type: "snapshot", value }];

/** Writes as an agent, from here: its cause is this line's site. */
const write = (d: Device, agent: string, patches: Patch[]) =>
  d.write({ agent, address: ["doc"], patches });

/** Every commit of from that to has not, received in from's order. */
function send(from: Device, to: Device) {
  const known = new Set(to.commits().map((c) => c.hash));
  for (const c of from.commits()) if (!known.has(c.hash)) to.receive(c);
}

Deno.test("a: B reads A's write with A's agent and cause, a time of B's, and the commit's hash", () => {
  const A = device("A"), B = device("B");
  write(A, "ay", snap("hello"));
  const [c] = A.commits();
  const applied = B.receive(c);
  assertEquals(applied.map((x) => x.hash), [c.hash]);
  const [mine] = doc(A), [theirs] = doc(B);
  assertEquals(doc(B).length, 1);
  assertEquals(theirs.value, "hello");
  assertEquals(theirs.commit, c.hash);
  assertEquals(mine.commit, c.hash);
  assertEquals(theirs.change?.agent, "ay");
  // the cause crossed with its site trimmed: no local path is in the blob
  assert((mine.change?.cause as { file: string }).file.startsWith("file:///"));
  assertEquals(theirs.change?.cause, { ...mine.change?.cause as object, file: "sync_test.ts" });
  // B's own time: after every change B had, and not A's
  assertNotEquals(theirs.change?.time, mine.change?.time);
  assertEquals(theirs.change?.time, B.time);
  assertEquals(B.hashOf(theirs.change!.time), c.hash);
  assertEquals(B.heads(), A.heads());
});

Deno.test("b: commits delivered out of order and twice give the same result", () => {
  const A = device("A"), B = device("B");
  write(A, "ay", snap({ n: 1 }));
  write(A, "ay", [{ type: "set", path: [], key: "m", value: 2 }]);
  write(A, "ay", [{ type: "set", path: [], key: "n", value: 3 }]);
  const [c1, c2, c3] = A.commits();
  assertEquals(B.receive(c3), []);
  assertEquals(B.waiting(), [c3.hash]);
  assertEquals(B.receive(c3), []);
  assertEquals(B.receive(c2), []);
  assertEquals(doc(B).map((i) => i.value), [null]);
  // the first lets the other two apply, in order
  assertEquals(B.receive(c1).map((x) => x.hash), [c1.hash, c2.hash, c3.hash]);
  assertEquals(B.receive(c1), []);
  assertEquals(B.receive(c2), []);
  assertEquals(B.waiting(), []);
  assertEquals(values(B), [{ n: 3, m: 2 }]);
  assertEquals(values(B), values(A));
  assertEquals(commits(B), commits(A));
  assertEquals(B.heads(), [c3.hash]);
});

Deno.test("c, d, f: concurrent writes read as two sides in one order on both; a write over them settles it", () => {
  const A = device("A"), B = device("B");
  write(A, "ay", snap({ title: "notes" }));
  send(A, B);
  // apart: each sets a different key
  write(A, "ay", [{ type: "set", path: [], key: "a", value: 1 }]);
  write(B, "bee", [{ type: "set", path: [], key: "b", value: 2 }]);
  const [ca] = A.commits().slice(-1), [cb] = B.commits().slice(-1);
  send(A, B);
  send(B, A);
  // c: two items, in the same order on both, each naming its commit, each a whole side
  assertEquals(doc(A).length, 2);
  assertEquals(commits(A), commits(B));
  assertEquals(new Set(commits(A)), new Set([ca.hash, cb.hash]));
  assertEquals(values(A), values(B));
  const sideOf = (h: string) => values(A)[commits(A).indexOf(h)];
  assertEquals(sideOf(ca.hash), { title: "notes", a: 1 });
  assertEquals(sideOf(cb.hash), { title: "notes", b: 2 });
  // each item carries the change that applied it here, naming who made it
  for (const d of [A, B]) {
    for (const item of doc(d)) {
      assertEquals(item.change?.agent, item.commit === ca.hash ? "ay" : "bee");
      assertEquals(d.hashOf(item.change!.time), item.commit);
    }
  }
  assertEquals(A.heads(), B.heads());
  assertEquals(A.heads(), commits(A));

  // d: a write over both, on A, a set: applied to the side A's graph holds, the first
  const first = commits(A)[0];
  write(A, "ay", [{ type: "set", path: [], key: "chosen", value: true }]);
  const [cm] = A.commits().slice(-1);
  send(A, B);
  for (const d of [A, B]) {
    assertEquals(doc(d).length, 1);
    assertEquals(commits(d), [cm.hash]);
    assertEquals(d.heads(), [cm.hash]);
  }
  const body = open(cm);
  assertEquals(body.parents, [ca.hash, cb.hash].sort());
  assertEquals(body.lamport, 3);
  // A's graph held the first side in the agreed order: the set went onto it
  assertEquals(body.base, first);
  // f: equal values and heads
  assertEquals(values(A), values(B));
  assertEquals(values(A), [
    first === ca.hash
      ? { title: "notes", a: 1, chosen: true }
      : { title: "notes", b: 2, chosen: true },
  ]);
  assertEquals(A.heads(), B.heads());
  assertEquals(new Set(A.commits().map((c) => c.hash)), new Set(B.commits().map((c) => c.hash)));
});

Deno.test("c: concurrent splices on different bases stay whole sides, never rebased", () => {
  const A = device("A"), B = device("B");
  write(A, "ay", snap("hello"));
  send(A, B);
  write(A, "ay", [{ type: "splice", path: [], range: [5, 5], value: " world" }]);
  write(B, "bee", [{ type: "splice", path: [], range: [0, 1], value: "J" }]);
  write(B, "bee", [{ type: "splice", path: [], range: [5, 5], value: "!" }]);
  send(A, B);
  send(B, A);
  assertEquals(commits(A), commits(B));
  assertEquals(values(A), values(B));
  // B's chain is longer, so its Lamport number is higher: it is first
  assertEquals(values(A), ["Jello!", "hello world"]);
  // the graph holds the first side, on both, whichever arrived last
  assertEquals(A.read({ agent: "host", address: ["doc"] }).length, 2);
  write(B, "bee", snap("Jello world!"));
  send(B, A);
  assertEquals(values(A), ["Jello world!"]);
  assertEquals(values(B), ["Jello world!"]);
});

Deno.test("concurrent first writes, and three devices' sides, keep one order everywhere", () => {
  const A = device("A"), B = device("B"), C = device("C");
  write(A, "ay", snap("a"));
  write(B, "bee", snap("b"));
  write(C, "cee", snap("c"));
  // each device hears the others in a different order
  send(B, A), send(C, A);
  send(C, B), send(A, B);
  send(A, C), send(B, C);
  assertEquals(doc(A).length, 3);
  assertEquals(commits(A), commits(B));
  assertEquals(commits(B), commits(C));
  assertEquals(values(A), values(C));
  write(C, "cee", snap("all"));
  send(C, A), send(C, B);
  for (const d of [A, B, C]) assertEquals(values(d), ["all"]);
  assertEquals(open(C.commits().at(-1)!).parents.length, 3);
});

Deno.test("e: readers on B are marked by arriving commits: a process runs, a subscription hears", () => {
  const A = device("A"), B = device("B");
  const heard: Change[] = [];
  B.subscribe({
    agent: "host",
    address: ["doc"],
    send: (e: Event) => "change" in e && heard.push(e.change),
  });
  const pid = (B.start({ ...host, address: [], program: ["programs", "watch"] } as StartOp)
    .change as { id: string }).id;
  const watched = () => B.read({ agent: "host", address: [pid] })[0].value;
  assertEquals(watched(), [null]);
  write(A, "ay", snap(1));
  const [c1] = A.commits();
  const applied = B.receive(c1);
  assertEquals(applied[0].changed.marked.map((m) => m.process), [pid]);
  assertEquals(watched(), [c1.hash]);
  assertEquals(heard.map((c) => c.agent), ["ay"]);
  // a concurrent pair: the process reads both sides
  write(A, "ay", snap(2));
  write(B, "bee", snap(3));
  send(A, B);
  assertEquals(watched(), commits(B));
  assertEquals((watched() as Json[]).length, 2);
  assertEquals(heard.map((c) => c.agent), ["ay", "bee", "ay"]);
});

Deno.test("g: a change hashes the same on A and B, whatever its time", () => {
  const A = device("A"), B = device("B");
  write(A, "ay", snap({ x: [1, 2.5, "three"] }));
  const [c] = A.commits();
  B.receive(c);
  // B's change for it, made at B's time, makes the same commit
  const theirs = doc(B)[0].change!;
  const change = {
    ...theirs,
    patches: snap({ x: [1, 2.5, "three"] }),
  } as Change & { kind: "write" };
  assertEquals(commit(change, [], 1).hash, c.hash);
  const later = { ...change, time: change.time + 1000 };
  assertEquals(commit(later, [], 1).hash, c.hash);
  assertEquals(commit(later, [], 1).blob, c.blob);
  // anything else it says changes it
  assertNotEquals(commit({ ...change, agent: "bee" }, [], 1).hash, c.hash);
  assertNotEquals(commit(change, [], 2).hash, c.hash);
});

Deno.test("a commit whose hash is not its blob's, or whose Lamport number is wrong, is refused", () => {
  const A = device("A"), B = device("B");
  write(A, "ay", snap("x"));
  const [c] = A.commits();
  const bad: Commit = { hash: c.hash, blob: c.blob.slice(0, -1) };
  assertThrows(() => B.receive(bad), CommitError);
  const change = { ...doc(A)[0].change!, patches: snap("y") } as Change & { kind: "write" };
  assertThrows(() => B.receive(commit(change, [], 2)), CommitError, "lamport");
  assertEquals(B.commits(), []);
  assertEquals(values(B), [null]);
});

Deno.test("an ephemeral node's writes are never commits", () => {
  const g = graph("root");
  let t = 0;
  const time = () => ++t;
  g.place({
    ...host,
    address: [],
    name: "doc",
    id: "doc",
    value: "x",
    ephemeral: true,
    time: time(),
  });
  const d = share(g, { id: "doc", address: ["doc"], device: key("solo"), time });
  d.write({ ...host, address: ["doc"], patches: snap("y"), time: time() });
  assertEquals(d.commits(), []);
  assertEquals(values(d as unknown as Device), ["y"]);
});

Deno.test("over the bare graph, arriving changes take their time from the clock given", () => {
  const make = (start: number) => {
    const g = graph("root");
    let t = start;
    const time = () => ++t;
    g.place({ ...host, address: [], name: "doc", id: "doc", value: "x", time: time() });
    return { d: share(g, { id: "doc", address: ["doc"], device: key("solo"), time }), time };
  };
  const a = make(0), b = make(100);
  a.d.write({ ...host, address: ["doc"], patches: snap("y"), time: a.time() });
  b.d.receive(a.d.commits()[0]);
  const [item] = b.d.read({ agent: "host", address: ["doc"] }) as SideItem[];
  assertEquals(item.value, "y");
  assertEquals(item.change?.time, 102);
  assertEquals(item.commit, a.d.commits()[0].hash);
});

/** A device over the bare graph, its clock its own, so the graph beneath can be read. */
function bare(name: string, hold?: { document?: number; peer?: number }) {
  const g = graph("root");
  let t = 0;
  const time = () => ++t;
  g.place({ ...host, address: [], name: "doc", id: "doc", value: null, time: time() });
  const d = share(g, { id: "doc", address: ["doc"], device: key(name), time, hold });
  const put = (patches: Patch[]) => d.write({ ...host, address: ["doc"], patches, time: time() });
  /** the node's value as the graph beneath holds it */
  const held = () => g.read({ agent: "host", address: ["doc"] })[0].value;
  return { g, d, put, held, time, clock: (n: number) => t = n };
}

Deno.test("the graph holds the first side in the agreed order: the same on two devices, whatever came last", () => {
  const A = bare("A"), B = bare("B");
  A.put(snap({ n: 0 }));
  B.d.receive(A.d.commits()[0]);
  A.put([{ type: "set", path: [], key: "a", value: 1 }]);
  B.put([{ type: "set", path: [], key: "b", value: 2 }]);
  const [ca] = A.d.commits().slice(-1), [cb] = B.d.commits().slice(-1);
  const heard: Change[] = [];
  for (const x of [A, B]) {
    x.g.subscribe({
      agent: "host",
      address: ["doc"],
      send: (e: Event) => "change" in e && heard.push(e.change),
    });
  }
  A.d.receive(cb);
  B.d.receive(ca);
  assertEquals(A.d.heads(), B.d.heads());
  assertEquals(A.held(), B.held());
  const first = A.d.heads()[0];
  assertEquals(A.held(), first === ca.hash ? { n: 0, a: 1 } : { n: 0, b: 2 });
  // the one that did not become the first head was written as no patches, and still marked
  const empty = heard.filter((c) => c.kind === "write" && c.patches.length === 0);
  assertEquals(empty.length, 1);
  // a write over both is made on the first, which the blob names as its base
  A.put([{ type: "set", path: [], key: "c", value: 3 }]);
  const [cm] = A.d.commits().slice(-1);
  assertEquals(open(cm).base, first);
  B.d.receive(cm);
  assertEquals(B.held(), A.held());
});

Deno.test("a commit over sides whose base is not the first parent is refused", () => {
  const A = bare("A"), B = bare("B"), C = bare("C");
  A.put(snap(0));
  for (const x of [B, C]) x.d.receive(A.d.commits()[0]);
  B.put(snap(1));
  C.put(snap(2));
  const [cb] = B.d.commits().slice(-1), [cc] = C.d.commits().slice(-1);
  A.d.receive(cb);
  A.d.receive(cc);
  const [second] = A.d.heads().slice(1);
  const change = { ...A.d.read({ agent: "host", address: ["doc"] })[0].change!, patches: snap(3) };
  const wrong = commit(change as Change & { kind: "write" }, A.d.heads(), 3, second);
  // held for its parent, then refused once it is known, after the parent applies
  assertEquals(B.d.receive(wrong), []);
  assertThrows(() => B.d.receive(cc), CommitError, "base");
  assertEquals(B.d.heads().length, 2);
  assertEquals(B.d.status().refused.map((r) => r.hash), [wrong.hash]);
});

Deno.test("pids are qualified by the device and sites trimmed before hashing", () => {
  const dev = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
  const other = "ff".repeat(32);
  const change = {
    node: "doc",
    time: 9,
    kind: "write",
    patches: snap(1),
    process: "@7-kabab",
    agent: {
      actor: "chee",
      code: [{ process: "@7-kabab", program: { node: "editor", time: 3 }, run: 2 }],
    },
    cause: [
      { exited: "@7-kabab", file: "file:///Users/me/src/notes/app.ts", line: 12, column: 3 },
      { file: "C:\\Users\\me\\app.ts", line: 1 },
      { file: "https://example.com/x.ts", line: 2 },
    ],
  } as unknown as Change & { kind: "write" };
  const body = open(
    commit(change, [], 1, undefined, undefined, { device: dev, roots: ["/Users/me/src"] }),
  );
  assertEquals(body.process, `@7-kabab/${dev}`);
  assertEquals((body.agent as { code: { process: string }[] }).code[0].process, `@7-kabab/${dev}`);
  assertEquals(body.cause, [
    { exited: "@7-kabab", file: "notes/app.ts", line: 12, column: 3 },
    { file: "app.ts", line: 1 },
    { file: "https://example.com/x.ts", line: 2 },
  ]);
  // the same local pid on another device is another commit
  const there = commit(change, [], 1, undefined, undefined, {
    device: other,
    roots: ["/Users/me/src"],
  });
  assertNotEquals(there.hash, commit(change, [], 1, undefined, undefined, { device: dev }).hash);
  // a pid qualified already is kept; without a device, an unqualified one has no commit
  assertEquals(qualify(`@1-x/${other}`, dev), `@1-x/${other}`);
  assertThrows(() => commit(change, [], 1), CommitError, "device");
  // under no root, a local file is its last part; nearest root wins
  assertEquals(trim("/a/b/c.ts"), "c.ts");
  assertEquals(trim("/a/b/c.ts", ["/a", "/a/b/"]), "c.ts");
  assertEquals(trim("file:///a/b/c.ts", ["file:///a"]), "b/c.ts");
});

Deno.test("the spec's vectors V1 and V2 hold with the pid and site made shareable here", () => {
  const unhex = (h: string) => {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
    return out.buffer;
  };
  const dev = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
  // N's id: BLAKE3("ermine/v0/id" || "unlocked" as a CBOR text string || the bytes 20..3f)
  const made = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
  const input = [...new TextEncoder().encode("ermine/v0/id"), ...encode("unlocked"), ...made];
  const n = digest(new Uint8Array(input));
  assertEquals(n, "0c8c6f9648e6a9d929cf6d0cd4a04d186434b25d9b58dc1c984d4f31b85217ce");
  const N = unhex(n);
  const site = {
    file: trim("file:///home/chee/app/notes/app.ts", ["/home/chee/app"]),
    line: 12,
    column: 3,
  };
  const v1 = {
    kind: "write",
    node: N,
    agent: { actor: "chee", code: [] },
    cause: site,
    nonce: unhex("0001020304050607"),
    parents: [],
    lamport: 1,
    patches: [{ type: "snapshot", value: { title: "hello" } }],
  } as Value;
  const name1 = digest(encode(v1));
  assertEquals(name1, "175b587173b11fee87eb6e42023ab1f628e86eba61bacf57ebbfa25b264ae758");
  const pid = qualify("@7-kabab", dev);
  const v2 = {
    kind: "write",
    node: N,
    process: pid,
    agent: {
      actor: "chee",
      code: [{ process: pid, program: { node: "editor", time: 3 }, run: 2 }],
    },
    nonce: unhex("08090a0b0c0d0e0f"),
    parents: [unhex(name1)],
    lamport: 2,
    patches: [{ type: "splice", path: ["title"], range: [5, 5], value: "!" }],
  } as Value;
  assertEquals(
    digest(encode(v2)),
    "abc096c6c1d41ccf27f424d32e9504871ea99d0577475a0cc9c049fbef738f65",
  );
});

Deno.test("held commits are bounded per peer and per document; the dropped are listed", () => {
  const A = bare("A");
  for (let i = 0; i < 6; i++) A.put(snap(i));
  const cs = A.d.commits();
  const B = bare("B", { document: 3, peer: 2 });
  // all but the first, from one peer: two may wait
  for (const c of cs.slice(1, 4)) B.d.receive(c, "p");
  assertEquals(B.d.waiting(), [cs[2].hash, cs[3].hash]);
  assertEquals(B.d.status().dropped.map((x) => [x.hash, x.peer]), [[cs[1].hash, "p"]]);
  assert(B.d.status().dropped[0].reason.includes("peer p"));
  // from another peer, the document's limit lets the oldest go
  B.d.receive(cs[4], "q");
  B.d.receive(cs[5], "q");
  assertEquals(B.d.waiting(), [cs[3].hash, cs[4].hash, cs[5].hash]);
  assert(B.d.status().dropped.at(-1)!.reason.includes("document"));
  assertEquals(B.d.status().waiting[0], { hash: cs[3].hash, peer: "p", missing: [cs[2].hash] });
  // sent again, the dropped apply, and what waited on them
  B.d.receive(cs[0]);
  assertEquals(B.d.receive(cs[1]).map((x) => x.hash), [cs[1].hash]);
  assertEquals(B.d.receive(cs[2]).map((x) => x.hash), cs.slice(2).map((c) => c.hash));
  assertEquals(B.d.status(), { waiting: [], refused: [], stuck: [], dropped: [] });
});

Deno.test("a commit waiting on a refused one is stuck, with the reason; a forged hash refuses nothing", () => {
  const A = bare("A"), B = bare("B");
  A.put(snap(1));
  const [c1] = A.d.commits();
  const change = { ...A.d.read({ agent: "host", address: ["doc"] })[0].change!, patches: snap(2) };
  const write = change as Change & { kind: "write" };
  const bad = commit(write, [c1.hash], 5);
  const child = commit({ ...write, patches: snap(3) }, [bad.hash], 6);
  assertEquals(B.d.receive(child, "p"), []);
  assertEquals(B.d.waiting(), [child.hash]);
  // a forged blob under bad's hash is dropped, and refuses nothing
  assertThrows(() => B.d.receive({ hash: bad.hash, blob: c1.blob }), CommitError);
  assertEquals(B.d.status().refused, []);
  assertEquals(B.d.status().dropped.map((x) => x.hash), [bad.hash]);
  B.d.receive(c1);
  assertThrows(() => B.d.receive(bad), CommitError, "lamport");
  const status = B.d.status();
  assertEquals(status.waiting, []);
  assertEquals(status.refused.map((x) => x.hash), [bad.hash]);
  assertEquals(status.stuck.map((x) => [x.hash, x.on, x.peer]), [[child.hash, bad.hash, "p"]]);
  assert(status.stuck[0].reason.includes("lamport"));
  // what comes on a stuck commit is stuck at once
  const grandchild = commit({ ...write, patches: snap(4) }, [child.hash], 7);
  assertEquals(B.d.receive(grandchild), []);
  assertEquals(B.d.status().stuck.at(-1)!.on, child.hash);
  assertEquals(B.d.receive(bad), []);
  assertEquals(B.held(), 1);
});

Deno.test("a subscription through the wrapper sees the sides when its address comes to the node", () => {
  const A = device("A"), B = device("B");
  write(A, "ay", snap(0));
  send(A, B);
  write(A, "ay", snap(1));
  write(B, "bee", snap(2));
  send(A, B);
  const reaches: SideItem[][] = [];
  B.subscribe({
    agent: "host",
    address: ["here"],
    send: (e: Event) => {
      if ("change" in e && e.reaches) reaches.push(e.reaches as SideItem[]);
    },
  });
  B.place({ ...host, address: [], name: "here", id: "doc" });
  assertEquals(reaches.length, 1);
  assertEquals(reaches[0].map((i) => i.commit), commits(B));
  assertEquals(reaches[0].map((i) => i.value), values(B));
  assertEquals(reaches[0].length, 2);
});

Deno.test("an arriving change's time from a clock behind the node's is refused, not overwritten", () => {
  const A = bare("A"), B = bare("B");
  A.put(snap(1));
  B.put(snap(2));
  const mine = B.d.commits()[0].hash;
  const latest = B.d.read({ agent: "host", address: ["doc"] })[0].change!.time;
  B.clock(latest - 1);
  assertThrows(() => B.d.receive(A.d.commits()[0]), CommitError, "clocks");
  assertEquals(B.d.hashOf(latest), mine);
  assertEquals(B.d.heads(), [mine]);
  assertEquals(B.d.status().dropped.map((x) => x.hash), [A.d.commits()[0].hash]);
  // with the clock right, sent again, it applies
  B.clock(latest + 10);
  assertEquals(B.d.receive(A.d.commits()[0]).length, 1);
  assertEquals(B.d.hashOf(latest + 11), A.d.commits()[0].hash);
  assertEquals(B.d.hashOf(latest), mine);
});

Deno.test('a "__proto__" key from a peer is an own key, not the prototype', () => {
  const A = bare("A"), B = bare("B");
  A.put(snap({}));
  A.put([{ type: "set", path: [], key: "__proto__", value: { polluted: true } }]);
  for (const c of A.d.commits()) B.d.receive(c);
  const v = B.d.read({ agent: "host", address: ["doc"] })[0].value as object;
  assertEquals(Object.getOwnPropertyNames(v), ["__proto__"]);
  assertEquals(Object.getPrototypeOf(v), Object.prototype);
  assertEquals((v as { polluted?: boolean }).polluted, undefined);
});
