import { assert, assertEquals, assertThrows } from "@std/assert";
import { applyPatches, byCodePoint, equal, own } from "../src/patch.ts";
import { checkPath, graph } from "../src/graph.ts";
import { protect, subject } from "../src/protect.ts";
import {
  type ChangeRef,
  ErmineError,
  type Event,
  type Interface,
  Invalid,
  type Json,
  type Patch,
  Refused,
} from "../src/types.ts";

const site = { file: "graph_test.ts", line: 1, column: 1 };

/** A bare graph with a clock, as a host below drive would hold it. */
function host(api: Interface = graph()) {
  let time = 0;
  const at = () => ({ agent: "host", time: ++time, site });
  return {
    api,
    make: (id: string, value: Json, data?: Json) =>
      api.make({ ...at(), id, value, ...(data === undefined ? {} : { data }) }),
    write: (node: string, ...patches: Patch[]) => api.write({ ...at(), node, patches }),
    place: (parent: string, name: string, id: string, position?: number) =>
      api.place({ ...at(), parent, name, id, ...(position === undefined ? {} : { position }) }),
    unplace: (parent: string, name: string, id: string) =>
      api.unplace({ ...at(), parent, name, id }),
    read: (node: string) => api.read({ agent: "host", node }),
    slot: (node: string, name: string) => {
      const listing = api.directory({ agent: "host", node, name });
      return "slot" in listing ? listing.slot : undefined;
    },
    undo: () => time--,
    next: () => ++time,
  };
}

Deno.test("splice counts code points in strings", () => {
  const splice = (range: [number, number], value?: string): Patch =>
    value === undefined
      ? { type: "splice", path: [], range }
      : { type: "splice", path: [], range, value };
  assertEquals(applyPatches("a😀b", [splice([1, 2], "xy")]), "axyb");
  assertEquals(applyPatches("a😀b", [splice([2, 3])]), "a😀");
  assertEquals(applyPatches("😀😀", [splice([2, 2], "!")]), "😀😀!");
  assertThrows(() => applyPatches("😀😀", [splice([2, 3], "!")]), Invalid);
  assertThrows(() => applyPatches("abc", [splice([2, 1])]), Invalid);
  assertThrows(() => applyPatches("abc", [splice([-1, 1])]), Invalid);
  assertThrows(() => applyPatches("abc", [{ type: "splice", path: [], range: [0.5, 1] }]), Invalid);
});

Deno.test("splice of a list inserts the members of a list", () => {
  assertEquals(
    applyPatches([1, 2, 3], [{ type: "splice", path: [], range: [1, 2], value: [[9], 8] }]),
    [1, [9], 8, 3],
  );
  assertThrows(
    () => applyPatches([1], [{ type: "splice", path: [], range: [0, 0], value: "x" }]),
    Invalid,
  );
  assertThrows(
    () => applyPatches(5, [{ type: "splice", path: [], range: [0, 0], value: "x" }]),
    Invalid,
  );
});

Deno.test("paths are strings into objects and whole numbers into lists", () => {
  const value = { l: [{ s: "hi" }] };
  assertEquals(
    applyPatches(value, [{ type: "set", path: ["l", 0], key: "t", value: true }]),
    { l: [{ s: "hi", t: true }] },
  );
  for (const path of [["l", "0"], ["l", 1], ["l", -1], ["l", 0.5], ["nope"], ["l", 0, "s", 0]]) {
    assertThrows(
      () => applyPatches(value, [{ type: "set", path, key: "k", value: 1 }]),
      Invalid,
      undefined,
      JSON.stringify(path),
    );
  }
  assertEquals(value, { l: [{ s: "hi" }] }, "the value given is left as it was");
});

Deno.test("set deletes a key when it has no value, and sets null when given null", () => {
  assertEquals(applyPatches({ a: 1, b: 2 }, [{ type: "set", path: [], key: "a" }]), { b: 2 });
  assertEquals(applyPatches({}, [{ type: "set", path: [], key: "a", value: null }]), { a: null });
  assertEquals(
    applyPatches({}, [{ type: "set", path: [], key: "__proto__", value: 1 }]),
    JSON.parse('{"__proto__":1}'),
  );
  assertThrows(() => applyPatches([1], [{ type: "set", path: [], key: "0", value: 1 }]), Invalid);
});

Deno.test("a write is whole: if any patch is invalid, nothing changes", () => {
  const g = host();
  g.make("a", { x: 1 });
  assertThrows(
    () =>
      g.write(
        "a",
        { type: "set", path: [], key: "x", value: 2 },
        { type: "set", path: ["nope"], key: "y", value: 1 },
      ),
    Invalid,
  );
  g.undo();
  assertEquals(g.read("a"), { value: { x: 1 } });
  g.write(
    "a",
    { type: "set", path: [], key: "x", value: { y: [] } },
    { type: "splice", path: ["x", "y"], range: [0, 0], value: [7] },
  );
  assertEquals(g.read("a"), { value: { x: { y: [7] } } });
});

Deno.test("values held are frozen copies", () => {
  const g = host();
  const given = { list: [1] };
  g.make("a", given);
  given.list.push(2);
  const read = g.read("a") as { value: { list: number[] } };
  assertEquals(read.value, { list: [1] });
  assert(Object.isFrozen(read.value.list));
  assertThrows(() => own({ f: () => 1 }), Invalid);
  assertThrows(() => own(NaN), Invalid);
});

Deno.test("a position is where the id ends up; one past the end is the end", () => {
  const g = host();
  g.make("p", {});
  g.place("p", "x", "a");
  g.place("p", "x", "b");
  g.place("p", "x", "c");
  g.place("p", "x", "a", 2);
  assertEquals(g.slot("p", "x"), ["b", "c", "a"]);
  g.place("p", "x", "a", 0);
  assertEquals(g.slot("p", "x"), ["a", "b", "c"]);
  const again = g.place("p", "x", "b");
  assertEquals(again.change.kind, "place");
  assertEquals(g.slot("p", "x"), ["a", "b", "c"], "placing again without a position");
  g.place("p", "x", "a", 3);
  assertEquals(g.slot("p", "x"), ["b", "c", "a"]);
  assertThrows(() => g.place("p", "x", "b", 4), Invalid);
  g.undo();
  g.place("p", "x", "d", 4);
  assertEquals(g.slot("p", "x"), ["b", "c", "a", "d"]);
  assertThrows(() => g.place("p", "x", "e", 6), Invalid);
  g.undo();
  assertThrows(() => g.place("p", "x", "e", -1), Invalid);
  g.undo();
});

Deno.test("unplacing the last id makes the slot gone", () => {
  const g = host();
  g.make("p", {});
  g.place("p", "x", "a");
  g.unplace("p", "x", "a");
  assertEquals(g.api.directory({ agent: "host", node: "p" }), { directory: [] });
  assertEquals(g.slot("p", "x"), []);
  assertThrows(() => g.unplace("p", "x", "a"), Invalid);
});

Deno.test("names are in code point order", () => {
  assertEquals(["😀", "～", "Zed", "a"].sort(byCodePoint), ["Zed", "a", "～", "😀"]);
  assert(byCodePoint("a", "ab") < 0);
  assert(equal({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] }));
  assert(!equal({ a: 1 }, { a: 1, b: undefined as unknown as Json }));
});

/** Runs a compute by hand: binds, records, reads, finishes. */
function run(
  api: Interface,
  process: string,
  reads: (rec: Interface) => void,
  marked: ChangeRef[] = [],
) {
  const bound = api.bind(api, { agent: "host", process, writes: false });
  const rec = api.record(bound, marked);
  reads(rec);
  bound.end();
  return api.finish(rec, "done");
}

Deno.test("a change marks the processes whose last run read what it changed", () => {
  const g = host();
  g.make("a", 1);
  g.make("d", {});
  g.make("p1", null, []);
  g.make("p2", null, []);
  g.make("p3", null, []);
  run(g.api, "p1", (r) => r.read({ node: "a" }));
  run(g.api, "p2", (r) => r.directory({ node: "d", name: "x" }));
  run(g.api, "p3", (r) => {
    r.directory({ node: "d" });
    r.read({ node: "ghost" });
  });

  assertEquals(g.write("a", { type: "snapshot", value: 1 }).marked.map((m) => m.process), ["p1"]);
  assertEquals(g.place("d", "y", "n").marked.map((m) => m.process), ["p3"]);
  const both = g.place("d", "x", "n");
  assertEquals(both.marked, [
    { process: "p2", by: { node: "d", time: both.change.time } },
    { process: "p3", by: { node: "d", time: both.change.time } },
  ]);
  assertEquals(g.place("a", "x", "n").marked, [], "a placement does not mark value readers");
  assertEquals(g.make("ghost", 0).marked.map((m) => m.process), ["p3"], "absent reads mark");

  // each run's reads replace the last
  run(g.api, "p1", (r) => r.read({ node: "d" }));
  assertEquals(g.write("a", { type: "snapshot", value: 2 }).marked, []);
});

Deno.test("a process is not marked by its own changes", () => {
  const g = host();
  g.make("a", 1);
  g.make("p1", null, []);
  run(g.api, "p1", (r) => r.read({ node: "a" }));
  const lasting = g.api.bind(g.api, { agent: "host", process: "p1", writes: true });
  const own = lasting.write({
    node: "a",
    patches: [{ type: "snapshot", value: 2 }],
    time: g.next(),
  });
  assertEquals(own.change.process, "p1");
  assert(!("site" in own.change));
  assertEquals(own.marked, []);
});

Deno.test("a lookup searches up the path, and is marked only by its name there", () => {
  const g = host();
  for (const id of ["r", "a", "b", "p"]) g.make(id, {});
  g.place("r", "theme", "t-r");
  const path = [
    { parent: "r", name: "kids", node: "a" },
    { parent: "a", name: "kids", node: "b" },
  ];
  const bound = g.api.bind(g.api, { agent: "host", process: "p", path, writes: false });
  const rec = g.api.record(bound, []);
  assertEquals(rec.lookup({ name: "theme" }).found, ["t-r"]);
  g.api.finish(rec, "done");
  assertEquals(rec.lookups[0].searched.map((s) => s.node), ["a", "r"]);
  assertEquals(g.place("r", "font", "f").marked, []);
  assertEquals(g.place("a", "theme", "t-a").marked.map((m) => m.process), ["p"]);
});

Deno.test("a recording records programs, changes and errors, and sends its record", () => {
  const g = host();
  g.make("prog", ["code"]);
  g.make("p1", null, []);
  g.place("p1", "compute", "prog");
  const events: Event[] = [];
  g.api.subscribe({ agent: "host", node: "p1", send: (e) => events.push(e) });

  const bound = g.api.bind(g.api, { agent: "alice", process: "p1", writes: false });
  const rec = g.api.record(bound, [{ node: "p1", time: 3 }]);
  assertEquals(rec.program("compute"), { node: "prog", slot: ["prog"], value: ["code"] });
  assertEquals(rec.program("effect"), undefined);
  assertThrows(() => rec.write({ node: "p1", patches: [], time: 50 + g.next() }), Invalid);
  const writer = g.api.bind(g.api, { agent: "alice", process: "p1", writes: true, reads: false });
  rec.through(writer).write({
    node: "p1",
    patches: [{ type: "snapshot", value: 1 }],
    time: g.next(),
  });
  assertThrows(() => rec.through(writer).read({ node: "p1" }), Invalid);
  bound.end();
  assertThrows(() => rec.read({ node: "prog" }), Invalid);
  const record = g.api.finish(rec, "failed", { value: 1 });
  assertEquals(record, {
    process: "p1",
    run: 1,
    agent: "alice",
    marked: [{ node: "p1", time: 3 }],
    compute: { node: "prog", saw: 1, slot: ["prog"] },
    lookups: [],
    reads: [],
    directories: [],
    value: 1,
    cleanup: [],
    changes: [{ node: "p1", time: 5 }],
    ending: "failed",
    errors: [
      { kind: "invalid", op: "write", why: "write: this interface only reads" },
      { kind: "invalid", op: "read", why: "read: this interface only writes" },
      { kind: "invalid", op: "read", why: "read: this interface has ended" },
    ],
  });
  assertEquals(events.map((e) => "record" in e ? "record" : "change"), ["change", "record"]);
  assertThrows(() => g.api.finish(rec, "done"), Invalid);

  // the program reads mark the process
  assertEquals(g.write("prog", { type: "snapshot", value: [] }).marked.map((m) => m.process), [
    "p1",
  ]);
  assertEquals(g.place("p1", "effect", "e").marked.map((m) => m.process), ["p1"]);
});

Deno.test("protect asks before every operation, each directory of a lookup included", () => {
  const asked: string[] = [];
  const g = host(protect(graph(), (agent, _process, op, args) => {
    asked.push(`${op} ${(args as { node?: string }).node ?? ""}`.trim());
    return !(agent === "eve" && op === "directory" && (args as { node: string }).node === "a");
  }));
  for (const id of ["r", "a", "b"]) g.make(id, {});
  g.place("r", "theme", "t");
  asked.length = 0;
  const path = [{ parent: "r", name: "kids", node: "a" }, { parent: "a", name: "kids", node: "b" }];
  assertEquals(g.api.lookup({ agent: "host", name: "theme", path }).found, ["t"]);
  assertEquals(asked, ["lookup", "directory a", "directory r"]);
  const eve = g.api.lookup({ agent: "eve", name: "theme", path });
  assertEquals(eve, { found: [], searched: [{ node: "a", refused: true }] });
  assertThrows(() => g.api.directory({ agent: "eve", node: "a" }), Refused);
});

Deno.test("fixed data is given at the making, carried by it, and never read by the graph", () => {
  const g = host();
  const plain = g.make("a", 1);
  assert(!("data" in plain.change));
  assertEquals(g.api.data({ agent: "host", node: "a" }), { data: null });
  // not a path, and still fine: the graph does not look inside
  const made = g.make("q", null, { path: "nope" });
  assertEquals((made.change as { data?: Json }).data, { path: "nope" });
  assertEquals(g.api.data({ agent: "host", node: "q" }), { data: { path: "nope" } });
  assertEquals((g.make("n", 1, null).change as { data?: Json }).data, null);
  assertEquals(g.api.data({ agent: "host", node: "ghost" }), { absent: true });
  // a write changes the value, never the data
  g.write("q", { type: "snapshot", value: { path: [] } });
  assertEquals(g.api.data({ agent: "host", node: "q" }), { data: { path: "nope" } });
});

Deno.test("a change that is invalid in its agent, cause or site changes nothing", () => {
  const g = host();
  g.make("a", 1);
  g.make("p", {});
  const at = { time: 3, site };
  const snapshot: Patch = { type: "snapshot", value: 2 };
  assertThrows(
    () => g.api.write({ agent: "host", ...at, node: "a", patches: [snapshot], cause: NaN }),
    Invalid,
  );
  assertEquals(g.read("a"), { value: 1 });
  assertThrows(() => g.api.make({ agent: Infinity, ...at, id: "c", value: 1 }), Invalid);
  assertEquals(g.read("c"), { absent: true });
  assertThrows(
    () =>
      g.api.place({
        agent: "host",
        ...at,
        parent: "p",
        name: "x",
        id: "q",
        cause: (() => 1) as unknown as Json,
      }),
    Invalid,
  );
  assertEquals(g.slot("p", "x"), []);
  assertThrows(
    () => g.api.unplace({ agent: "host", ...at, parent: "p", name: "x", id: "q", cause: NaN }),
    Invalid,
  );
  // time 3 is still free
  assertEquals(g.api.make({ agent: "host", ...at, id: "b", value: 0 }).change.time, 3);
});

Deno.test("a bound interface binds only as itself, and cannot record or finish runs", () => {
  const g = host();
  g.make("x", 1);
  g.make("victim", null);
  run(g.api, "victim", (r) => r.read({ node: "x" }));
  const records: Event[] = [];
  g.api.subscribe({ agent: "host", node: "victim", send: (e) => records.push(e) });

  const mb = g.api.bind(g.api, { agent: "mallory", process: "m", writes: false });
  const fake = mb.bind(mb, { agent: "eve", process: "victim", writes: true });
  assertThrows(() => mb.record(fake, [{ node: "x", time: 2 }]), Invalid);
  assertThrows(() => fake.record(fake, []), Invalid);
  // what the holder bound acts as the holder, and does no more than it does
  assertThrows(() => fake.write({ node: "x", patches: [], time: g.next() }), Invalid);
  g.undo();
  // a recording passes record and finish to the bound interface beneath it
  const rec = g.api.record(mb, []);
  assertThrows(
    () => rec.record(rec.bind(rec, { agent: "eve", process: "victim", writes: false }), []),
    Invalid,
  );
  assertThrows(() => rec.finish(rec, "done"), Invalid);
  g.api.finish(rec, "done");

  assertEquals(records, []);
  assertEquals(g.write("x", { type: "snapshot", value: 2 }).marked.map((m) => m.process), [
    "victim",
  ]);
});

Deno.test("a path is a chain: each step's parent is the node of the step before", () => {
  const g = host();
  for (const id of ["r", "z"]) g.make(id, {});
  g.place("z", "theme", "t-z");
  const broken = [
    { parent: "r", name: "kids", node: "a" },
    { parent: "z", name: "kids", node: "b" },
  ];
  assertThrows(() => checkPath(broken), Invalid);
  checkPath([{ parent: "r", name: "kids", node: "a" }, { parent: "a", name: "kids", node: "b" }]);
  assertThrows(() => g.api.lookup({ agent: "host", name: "theme", path: broken }), Invalid);
  assertThrows(
    () => g.api.bind(g.api, { agent: "host", process: "p", path: broken, writes: false }),
    Invalid,
  );
});

Deno.test("an operation's error names the operation", () => {
  const g = host(protect(graph(), (agent, _process, op) => !(agent === "eve" && op === "write")));
  g.make("a", 1);
  const named = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return [(e as Invalid).kind, (e as Invalid).op];
    }
  };
  assertEquals(named(() => g.api.write({ agent: "eve", node: "a", patches: [] })), [
    "refused",
    "write",
  ]);
  assertEquals(named(() => g.api.write({ agent: "host", node: "ghost", patches: [] })), [
    "invalid",
    "write",
  ]);
  assertEquals(named(() => g.api.read({ agent: "host", node: 5 as unknown as string })), [
    "invalid",
    "read",
  ]);
});

Deno.test("protect checks an unsubscribe against the node of its subscription", () => {
  const asked: [string, string | undefined][] = [];
  const api = protect(graph(), (_agent, _process, op, args) => {
    asked.push([op, subject(op, args)]);
    return !(op === "unsubscribe" && subject(op, args) === "a");
  });
  const { sub: a } = api.subscribe({ agent: "host", node: "a", send: () => {} });
  const { sub: b } = api.subscribe({ agent: "host", node: "b", send: () => {} });
  assertThrows(() => api.unsubscribe({ agent: "host", sub: a }), Refused);
  api.unsubscribe({ agent: "host", sub: b });
  assertEquals(asked.filter(([op]) => op === "unsubscribe"), [
    ["unsubscribe", "a"],
    ["unsubscribe", "b"],
  ]);
});

Deno.test("protect asks before data, bind, record and finish, as the binding's agent and process", () => {
  const asked: string[] = [];
  const api = protect(graph(), (agent, process, op) => {
    asked.push(`${op} ${JSON.stringify(agent)} ${process}`);
    return agent !== "mallory";
  });
  api.make({ agent: "host", id: "a", value: 1, data: [1], time: 1, site });
  assertThrows(() => api.data({ agent: "mallory", node: "a" }), Refused);
  assertThrows(() => api.bind(api, { agent: "mallory", process: "m", writes: false }), Refused);
  const bound = api.bind(api, { agent: "alice", process: "p", writes: false });
  const rec = api.record(bound, []);
  api.finish(rec, "done");
  assertEquals(asked, [
    'make "host" undefined',
    'data "mallory" undefined',
    'bind "mallory" m',
    'bind "alice" p',
    'record "alice" p',
    'finish "alice" p',
  ]);
});

Deno.test("each layer is told the top of the stack once, so no holder can point it elsewhere", () => {
  const may = (agent: Json, _process: string | undefined, op: string, args: object) =>
    !(agent === "alice" && op === "directory" && (args as { node: string }).node === "secret");
  const api = protect(graph(), may);
  api.top(api);
  api.make({ agent: "host", id: "secret", value: 1, time: 1, site });
  api.place({ agent: "host", parent: "secret", name: "tool", id: "real", time: 2, site });
  const path = [{ parent: "secret", name: "x", node: "y" }];
  assertEquals(api.lookup({ agent: "alice", name: "tool", path }).found, []);
  const planted: Interface = { ...api, directory: () => ({ slot: ["planted"] }) };
  assertThrows(() => api.top(planted), Invalid);
  assertEquals(api.lookup({ agent: "alice", name: "tool", path }).found, []);
  assertEquals(api.lookup({ agent: "bob", name: "tool", path }).found, ["real"]);
  // a layer below, already told by protect, is told no more by anyone else
  const g = graph();
  const p = protect(g, () => true);
  assertThrows(() => g.top(planted), Invalid);
  p.top(p);
});

Deno.test("nothing under src uses Deno", async () => {
  async function look(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
      const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await look(url);
      else assert(!/\bDeno\./.test(await Deno.readTextFile(url)), `${url.pathname} uses Deno`);
    }
  }
  await look(new URL("../src/", import.meta.url));
});

Deno.test("errors are known by their mark, so a copy from another bundle counts", () => {
  const copy = Object.assign(new Error("no"), { kind: "refused" });
  Object.defineProperty(copy, Symbol.for("ermine.error"), { value: true });
  assert(copy instanceof ErmineError && copy instanceof Refused && !(copy instanceof Invalid));
  assert(!(new Error("no") instanceof ErmineError));
});
