// The first sync experiment (SUBDUCTION_SYNC.tex; plans/sync-experiment.org):
// one node's value shared between two graphs in one process, commits passed
// by hand, no network.

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { graph } from "../src/graph.ts";
import { schedule, type Scheduler } from "../src/schedule.ts";
import { builtin, type ComputeGiven } from "../src/loaders.ts";
import type { Change, Event, Json, Patch } from "../src/types.ts";
import type { StartOp } from "../src/loaders.ts";
import { type Commit, commit, CommitError, open } from "../src/sync/commit.ts";
import { share, type SideItem } from "../src/sync/share.ts";

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
  return share(s as Scheduler, { id: "doc", address: ["doc"] });
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
  assertEquals(theirs.change?.cause, mine.change?.cause);
  assert((mine.change?.cause as { file: string }).file.endsWith("sync_test.ts"));
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

  // d: a write over both, on A, a set: applied to the side A's graph holds
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
  // A's graph held B's side, the one applied there last: the set went onto it
  assertEquals(body.base, cb.hash);
  // f: equal values and heads
  assertEquals(values(A), values(B));
  assertEquals(values(A), [{ title: "notes", b: 2, chosen: true }]);
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
  // the graph holds the side applied last, written as a snapshot when its base was another
  assertEquals(
    A.read({ agent: "host", address: ["doc"] }).length,
    2,
  );
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
  const d = share(g, { id: "doc", address: ["doc"], time });
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
    return { d: share(g, { id: "doc", address: ["doc"], time }), time };
  };
  const a = make(0), b = make(100);
  a.d.write({ ...host, address: ["doc"], patches: snap("y"), time: a.time() });
  b.d.receive(a.d.commits()[0]);
  const [item] = b.d.read({ agent: "host", address: ["doc"] }) as SideItem[];
  assertEquals(item.value, "y");
  assertEquals(item.change?.time, 102);
  assertEquals(item.commit, a.d.commits()[0].hash);
});
