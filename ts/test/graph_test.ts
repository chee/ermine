import { assert, assertEquals, assertThrows } from "@std/assert";
import { applyPatches, byCodePoint, equal, NotJson, own } from "../src/patch.ts";
import { back, type View } from "../src/address.ts";
import { graph } from "../src/graph.ts";
import { protect, subject } from "../src/protect.ts";
import {
  type Address,
  type Change,
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
function host(api: Interface = graph("root")) {
  let time = 0;
  const at = () => ({ agent: "host", time: ++time, cause: site });
  return {
    api,
    /** places, making the node when a value is given */
    place: (
      address: Address,
      name: string,
      id: string,
      more: { position?: number; value?: Json } = {},
    ) => api.place({ ...at(), address, name, id, ...more }),
    make: (address: Address, name: string, value: Json) =>
      api.place({ ...at(), address, name, id: name, value }),
    write: (address: Address, ...patches: Patch[]) => api.write({ ...at(), address, patches }),
    unplace: (address: Address, name: string, id: string) =>
      api.unplace({ ...at(), address, name, id }),
    read: (address: Address) => api.read({ agent: "host", address }).map((i) => i.value),
    slot: (address: Address, name: string) => {
      const listing = api.directory({ agent: "host", address, name });
      return "items" in listing ? listing.items.map((i) => i.id) : undefined;
    },
    undo: () => time--,
    next: () => ++time,
  };
}

/** The code an operation failed with. */
function code(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof ErmineError) return e.why.code;
    throw e;
  }
}

Deno.test("splice counts code points in strings", () => {
  const splice = (range: [number, number], value?: string): Patch =>
    value === undefined
      ? { type: "splice", path: [], range }
      : { type: "splice", path: [], range, value };
  assertEquals(applyPatches("a😀b", [splice([1, 2], "xy")]), "axyb");
  assertEquals(applyPatches("a😀b", [splice([2, 3])]), "a😀");
  assertEquals(applyPatches("😀😀", [splice([2, 2], "!")]), "😀😀!");
  assertEquals(code(() => applyPatches("😀😀", [splice([2, 3], "!")])), "range");
  assertEquals(code(() => applyPatches("abc", [splice([2, 1])])), "range");
  assertEquals(code(() => applyPatches("abc", [splice([-1, 1])])), "range");
  assertEquals(
    code(() => applyPatches("abc", [{ type: "splice", path: [], range: [0.5, 1] }])),
    "range",
  );
});

Deno.test("an invalid patch names its index, and a range its length", () => {
  const e = assertThrows(
    () =>
      applyPatches("abc", [
        { type: "snapshot", value: "x" },
        { type: "splice", path: [], range: [0, 9] },
      ]),
    Invalid,
  );
  assertEquals({ ...e.why, text: undefined }, {
    code: "range",
    index: 1,
    length: 1,
    text: undefined,
  });
  assertEquals(code(() => applyPatches(1, [{ type: "move" } as unknown as Patch])), "not-a-patch");
  assertEquals(code(() => applyPatches({}, [{ type: "set", path: ["x"], key: "k" }])), "no-key");
  assertEquals(code(() => applyPatches(1, [{ type: "set", path: [], key: "k" }])), "wrong-kind");
  assertEquals(code(() => applyPatches(1, "x" as unknown as Patch[])), "wrong-field");
});

Deno.test("splice of a list inserts the members of a list", () => {
  assertEquals(
    applyPatches([1, 2, 3], [{ type: "splice", path: [], range: [1, 2], value: [[9], 8] }]),
    [1, [9], 8, 3],
  );
  assertEquals(
    code(() => applyPatches([1], [{ type: "splice", path: [], range: [0, 0], value: "x" }])),
    "wrong-kind",
  );
  assertEquals(
    code(() => applyPatches(5, [{ type: "splice", path: [], range: [0, 0], value: "x" }])),
    "wrong-kind",
  );
});

Deno.test("paths are strings into objects and whole numbers into lists", () => {
  const value = { l: [{ s: "hi" }] };
  assertEquals(
    applyPatches(value, [{ type: "set", path: ["l", 0], key: "t", value: true }]),
    { l: [{ s: "hi", t: true }] },
  );
  for (
    const [path, expected] of [
      // a key that is neither a string nor a whole number: not a patch, whatever the value
      [["l", -1], "not-a-patch"],
      [["l", 0.5], "not-a-patch"],
      [["nope", null], "not-a-patch"],
      [[true], "not-a-patch"],
      // an object that lacks the key, or a list shorter than the index
      [["nope"], "no-key"],
      [["l", 1], "no-key"],
      // a key of the wrong kind for where it leads, or a key into what is neither
      [["l", "0"], "wrong-kind"],
      [[0], "wrong-kind"],
      [["l", 0, "s", 0], "wrong-kind"],
      [["l", 0, "s", "x"], "wrong-kind"],
    ] as [unknown[], string][]
  ) {
    assertEquals(
      code(() => applyPatches(value, [{ type: "set", path: path as never, key: "k", value: 1 }])),
      expected,
      JSON.stringify(path),
    );
  }
  assertEquals(
    code(() => applyPatches(1, [{ type: "splice", path: [], range: [0, 0], value: "x" }])),
    "wrong-kind",
    "a splice of what is neither a string nor a list",
  );
  // a set's key: a number into an object, once the path is followed; one of no kind is not a patch
  for (
    const [path, key, expected] of [
      [[], 0, "wrong-kind"],
      [["nope"], 0, "no-key"],
      [["nope"], null, "not-a-patch"],
      [[], 1.5, "not-a-patch"],
      [[], true, "not-a-patch"],
      [["l"], "0", "wrong-kind"],
    ] as [unknown[], unknown, string][]
  ) {
    assertEquals(
      code(() => applyPatches(value, [{ type: "set", path, key, value: 1 } as never])),
      expected,
      JSON.stringify([path, key]),
    );
  }
  assertEquals(value, { l: [{ s: "hi" }] }, "the value given is left as it was");
});

Deno.test("set deletes a key when it has no value, and sets null when given null", () => {
  assertEquals(applyPatches({ a: 1, b: 2 }, [{ type: "set", path: [], key: "a" }]), { b: 2 });
  assertEquals(applyPatches({ a: 1 }, [{ type: "set", path: [], key: "z" }]), { a: 1 });
  assertEquals(applyPatches({}, [{ type: "set", path: [], key: "a", value: null }]), { a: null });
  assertEquals(
    applyPatches({}, [{ type: "set", path: [], key: "__proto__", value: 1 }]),
    JSON.parse('{"__proto__":1}'),
  );
  assertThrows(() => applyPatches([1], [{ type: "set", path: [], key: "0", value: 1 }]), Invalid);
});

Deno.test("a write is whole: if any patch is invalid, nothing changes", () => {
  const g = host();
  g.make([], "a", { x: 1 });
  assertEquals(
    code(() =>
      g.write(
        ["a"],
        { type: "set", path: [], key: "x", value: 2 },
        { type: "set", path: ["nope"], key: "y", value: 1 },
      )
    ),
    "no-key",
  );
  g.undo();
  assertEquals(g.read(["a"]), [{ x: 1 }]);
  g.write(
    ["a"],
    { type: "set", path: [], key: "x", value: { y: [] } },
    { type: "splice", path: ["x", "y"], range: [0, 0], value: [7] },
  );
  assertEquals(g.read(["a"]), [{ x: { y: [7] } }]);
});

Deno.test("values held are frozen copies", () => {
  const g = host();
  const given = { list: [1] };
  g.make([], "a", given);
  given.list.push(2);
  const [item] = g.api.read({ agent: "host", address: ["a"] });
  assertEquals(item.value, { list: [1] });
  assert(Object.isFrozen((item.value as { list: number[] }).list));
  assert(Object.isFrozen(item.change));
  assertThrows(() => own({ f: () => 1 }), NotJson);
  assertThrows(() => own(NaN), NotJson);
  assertEquals(own({ a: 1, b: undefined }), { a: 1 });
  const holds: { [key: string]: unknown } = { a: [1] };
  (holds.a as unknown[]).push(holds);
  assertThrows(() => own(holds), NotJson);
  const shared = [1];
  assertEquals(own({ a: shared, b: [shared] }), { a: [1], b: [[1]] });
  assertEquals(Object.keys(own({ b: 1, a: { d: 2, c: 3 }, ["__proto__"]: 4 }) as object), [
    "b",
    "a",
    "__proto__",
  ]);
});

Deno.test("a value nests as deep as it likes: owning, comparing and patching it need no deep stack", () => {
  const depth = 100_000;
  const nest = (inner: Json, key?: string) => {
    let v = inner;
    for (let i = 0; i < depth; i++) v = key === undefined ? [v] : { [key]: v };
    return v;
  };
  const list = own(nest(1));
  let here: Json = list;
  for (let i = 0; i < depth; i++) {
    assert(Object.isFrozen(here));
    here = (here as Json[])[0];
  }
  assertEquals(here, 1);
  assert(equal(list, nest(1)));
  assert(!equal(list, nest(2)));
  assert(equal(own(nest(1, "a")), nest(1, "a")));
  assert(!equal(nest(1, "a"), nest(2, "a")));
  const spliced = applyPatches(list, [
    { type: "splice", path: Array(depth - 1).fill(0), range: [1, 1], value: [2] },
  ]);
  let bottom: Json = spliced;
  for (let i = 0; i < depth - 1; i++) bottom = (bottom as Json[])[0];
  assertEquals(bottom, [1, 2]);
  assertEquals(
    code(() => applyPatches(list, [{ type: "set", path: Array(depth).fill(0), key: "k" }])),
    "wrong-kind",
  );
  // values that hold themselves are never JSON, but comparing them still ends
  const a: unknown[] = [];
  a.push(a, 1);
  const b: unknown[] = [];
  const c: unknown[] = [b, 2];
  b.push(c, 1);
  assert(equal(a as Json, [a, 1] as Json));
  assert(!equal(a as Json, b as Json));
});

Deno.test("the root is null, has no change, and every read is a list of items with from and change", () => {
  const g = host();
  assertEquals(g.api.read({ agent: "host", address: [] }), [{ value: null, from: { route: [] } }]);
  const made = g.make([], "a", 1).change;
  const [item] = g.api.read({ agent: "host", address: ["a"] });
  assertEquals(item, {
    value: 1,
    from: { route: [{ parent: "root", name: "a", node: "a", position: 0 }] },
    change: made,
  });
  const written = g.write(["a"], { type: "snapshot", value: 2 }).change;
  assertEquals(g.api.read({ agent: "host", address: ["a"] })[0].change, written);
  assertEquals(g.api.directory({ agent: "host", address: [], name: "a" }), {
    items: [{ id: "a", from: { route: [], position: 0 }, change: made }],
  });
  assertEquals(g.api.read({ agent: "host", address: ["ghost"] }), []);
  assertEquals(g.api.directory({ agent: "host", address: ["ghost"] }), { directory: [] });
});

Deno.test("placing is making, mounting, or placing again; a value for an id the graph has is invalid", () => {
  const g = host();
  const made = g.make([], "a", 1);
  assertEquals(made.change.kind === "place" && made.change.value, 1);
  assertEquals(code(() => g.place([], "b", "a", { value: 2 })), "exists");
  g.undo();
  assertEquals(code(() => g.place([], "b", "root", { value: 2 })), "exists");
  g.undo();
  g.place([], "b", "a");
  assertEquals(g.read(["b"]), [1]);
  // mounting an id the graph does not have: pending, passed over, and here once made
  const mounted = g.place([], "m", "ghost").change;
  assertEquals(g.api.directory({ agent: "host", address: [], name: "m" }), {
    items: [{ id: "ghost", from: { route: [], position: 0 }, change: mounted, pending: true }],
  });
  assertEquals(g.read(["m"]), []);
  assertEquals(code(() => g.write(["m"], { type: "snapshot", value: 1 })), "nothing-there");
  g.undo();
  g.make(["a"], "ghost", "here");
  assertEquals(g.read(["m"]), ["here"]);
});

Deno.test("nothing is removed: an unreachable node is placed again as it was", () => {
  const g = host();
  g.make([], "a", 1);
  g.make(["a"], "b", 2);
  g.unplace([], "a", "a");
  assertEquals(g.read(["a"]), []);
  assertEquals(code(() => g.place([], "x", "a", { value: 9 })), "exists");
  g.undo();
  g.place([], "again", "a");
  assertEquals(g.read(["again"]), [1]);
  assertEquals(g.read(["again", "b"]), [2]);
});

Deno.test("a position is a gap in the slot as it is; placing an id there moves it", () => {
  const g = host();
  g.make([], "p", {});
  for (const id of ["a", "b", "c"]) g.place(["p"], "x", id);
  g.place(["p"], "x", "a", { position: 2 });
  assertEquals(g.slot(["p"], "x"), ["b", "a", "c"]);
  g.place(["p"], "x", "a", { position: 0 });
  assertEquals(g.slot(["p"], "x"), ["a", "b", "c"]);
  const again = g.place(["p"], "x", "b");
  assertEquals(again.change.kind, "place");
  assertEquals(g.slot(["p"], "x"), ["a", "b", "c"], "placing again without a position");
  g.place(["p"], "x", "a", { position: 3 });
  assertEquals(g.slot(["p"], "x"), ["b", "c", "a"]);
  const e = assertThrows(() => g.place(["p"], "x", "b", { position: 4 }), Invalid);
  assertEquals([e.why.code, e.why.length], ["position", 3]);
  g.undo();
  g.place(["p"], "x", "d", { position: 3 });
  assertEquals(g.slot(["p"], "x"), ["b", "c", "a", "d"]);
  assertEquals(code(() => g.place(["p"], "x", "e", { position: -1 })), "wrong-field");
  g.undo();
});

Deno.test("unplacing the last id makes the slot gone; unplacing what is not there is invalid", () => {
  const g = host();
  g.make([], "p", {});
  g.place(["p"], "x", "a");
  g.unplace(["p"], "x", "a");
  assertEquals(g.api.directory({ agent: "host", address: ["p"] }), { directory: [] });
  assertEquals(g.slot(["p"], "x"), []);
  assertEquals(code(() => g.unplace(["p"], "x", "a")), "not-in-slot");
});

Deno.test("addresses: /, .., places, chroot, and above-root", () => {
  const g = host();
  g.make([], "a", "A");
  g.make(["a"], "b", "B");
  g.make(["a", "b"], "c", "C");
  const read = (address: Address, place?: string[], chroot?: number) =>
    g.api.read({ agent: "host", address, place, chroot }).map((i) => i.value);
  assertEquals(read(["c"], ["a", "b"]), ["C"]);
  assertEquals(read([".."], ["a", "b"]), ["A"]);
  assertEquals(read(["/", "a"], ["a", "b"]), ["A"]);
  assertEquals(read(["/"], ["a", "b"], 1), ["A"]);
  assertEquals(read(["/", "b"], ["a", "b"], 1), ["B"]);
  assertEquals(code(() => read(["..", ".."], ["a", "b"], 1)), "above-root");
  assertEquals(code(() => read([".."])), "above-root");
  assertEquals(code(() => read(["a", ".."])), "wrong-field");
  assertEquals(code(() => read(["."])), "wrong-field");
  // the route is the address's own walk, from where it starts
  assertEquals(g.api.read({ agent: "host", address: ["c"], place: ["a", "b"] })[0].from, {
    route: [{ parent: "b", name: "c", node: "c", position: 0 }],
  });
});

Deno.test("a walk takes the first member that is here and has the next name; a directory read lists the union", () => {
  const g = host();
  g.make([], "m1", 1);
  g.make([], "m2", 2);
  g.make(["m1"], "x", "x1");
  g.make(["m2"], "y", "y2");
  g.place([], "u", "ghost");
  g.place([], "u", "m1");
  g.place([], "u", "m2");
  // a read gives every member that is here, the node the address reaches first
  assertEquals(g.read(["u"]), [1, 2]);
  assertEquals(
    g.api.read({ agent: "host", address: ["u"] }).map((i) => [i.from.route, i.change?.time]),
    [
      [[{ parent: "root", name: "u", node: "m1", position: 1 }], 1],
      [[{ parent: "root", name: "u", node: "m2", position: 2 }], 2],
    ],
  );
  assertEquals(g.read(["u", "y"]), ["y2"]);
  assertEquals(
    g.api.read({ agent: "host", address: ["u", "y"] })[0].from.route.map((
      s,
    ) => [s.node, s.position]),
    [["m2", 2], ["y", 0]],
  );
  const listing = g.api.directory({ agent: "host", address: ["u"] });
  assert("directory" in listing);
  assertEquals(
    listing.directory.map(([n, items]) => [n, items.map((i) => [i.id, i.from])]),
    [
      ["x", [["x", {
        route: [{ parent: "root", name: "u", node: "m1", position: 1 }],
        position: 0,
      }]]],
      ["y", [["y", {
        route: [{ parent: "root", name: "u", node: "m2", position: 2 }],
        position: 0,
      }]]],
    ],
  );
});

Deno.test(".. goes back the way the place was reached, and a lookup searches the directories its walk went through", () => {
  const g = host();
  g.make([], "m1", "one");
  g.make([], "m2", "two");
  g.make(["m2"], "y", "Y");
  g.place(["m1"], "tool", "t1", { value: "m1's" });
  g.place(["m2"], "tool", "t2", { value: "m2's" });
  g.place([], "u", "m1");
  g.place([], "u", "m2");
  const at = { agent: "host", place: ["u", "y"] };
  // the place's walk takes m2 for u, the member that has y
  assertEquals(g.api.read({ ...at, address: [] }).map((i) => i.value), ["Y"]);
  assertEquals(g.api.read({ ...at, address: [".."] }).map((i) => [i.value, i.from]), [
    ["two", { route: [] }],
  ]);
  assertEquals(g.api.read({ ...at, address: ["..", ".."] }).map((i) => i.value), [null]);
  assertEquals(g.api.lookup({ ...at, name: "tool" }).map((i) => [i.id, i.from]), [
    ["t2", { path: ["..", "tool"], position: 0 }],
  ]);
  // writing through .. writes to the node the place's walk came through
  g.write([], { type: "snapshot", value: 0 });
  g.api.write({
    ...at,
    address: [".."],
    patches: [{ type: "snapshot", value: 2 }],
    time: g.next(),
  });
  assertEquals(g.read(["m2"]), [2]);
  assertEquals(g.read(["m1"]), ["one"]);
  // from a place that reaches nothing, the way back is as far as its walk got
  g.place(["m2"], "p", "ghost");
  const lost = { agent: "host", place: ["u", "p"] };
  assertEquals(g.api.read({ ...lost, address: [] }), []);
  assertEquals(g.api.read({ ...lost, address: [".."] }).map((i) => i.value), [2]);
  assertEquals(g.api.lookup({ ...lost, name: "tool" }).map((i) => [i.id, i.from]), [
    ["t2", { path: ["..", "tool"], position: 0 }],
  ]);
  assertEquals(
    code(() => g.api.write({ ...lost, address: [], patches: [], time: g.next() })),
    "nothing-there",
  );
  g.undo();
  const short = { agent: "host", place: ["u", "y", "w"] };
  assertEquals(g.api.read({ ...short, address: [".."] }), []);
  assertEquals(g.api.read({ ...short, address: ["..", ".."] }).map((i) => i.value), [2]);
  assertEquals(g.api.read({ ...short, address: ["..", "..", ".."] }).map((i) => i.value), [0]);
  assertEquals(g.api.lookup({ ...short, name: "tool" }).map((i) => i.from), [
    { path: ["..", "..", "tool"], position: 0 },
  ]);
  assertEquals(g.api.lookup({ ...short, name: "m1" }).map((i) => i.from), [
    { path: ["..", "..", "..", "m1"], position: 0 },
  ]);
});

Deno.test("back takes the walk only as far as it goes back to, each step taking the member with the next name", () => {
  const slots: { [node: string]: { [name: string]: string[] } } = {
    root: { u: ["ghost", "m1", "m2"] },
    m1: { z: ["z1"] },
    m2: { y: ["y2"], z: ["z2"] },
    y2: { p: ["ghost"] },
  };
  const view: View = {
    here: (id) => id in slots || id === "z1" || id === "z2",
    slot: (id, name) => slots[id]?.[name] ?? [],
  };
  const names = ["u", "y", "p"];
  assertEquals([0, 1, 2, 3].map((k) => back(view, "root", names, k)), [
    undefined, // p holds only an absent id: the place reaches nothing
    "y2",
    "m2", // the member of u that has y, not m1, which u reaches
    "root",
  ]);
  assertEquals(back(view, "root", ["u", "q"], 1), undefined, "no member of u has q");
  assertEquals(back(view, "root", ["u", "q"], 2), "root");
  assertEquals(back(view, "root", ["u"], 0), "m1");
});

Deno.test("a subscription is sent each placement that changes its route, and each change to its node", () => {
  const g = host();
  g.make([], "d1", 1);
  g.make([], "d2", 2);
  g.place([], "doc", "d1");
  const got: number[] = [];
  g.api.subscribe({
    agent: "host",
    address: ["doc"],
    send: (e) => "change" in e && got.push(e.change.time),
  });
  g.place([], "doc", "ghost", { position: 0 }); // 4: d1 is now at position 1, the same node
  g.place([], "doc", "d2"); // 5: behind d1, the route is as it was
  g.place([], "doc", "d1"); // 6: placed again with no position, the slot is as it was
  g.write(["d2"], { type: "snapshot", value: 3 }); // 7: not the node it reaches
  g.place(["d1"], "x", "d2"); // 8: a change to d1's directory
  g.unplace([], "doc", "ghost"); // 9: d1 is back at position 0
  g.unplace([], "doc", "d1"); // 10: to d2
  g.unplace([], "doc", "d2"); // 11: to nothing
  g.place([], "doc", "ghost"); // 12: still nothing
  g.make([], "ghost", "here"); // 13: ghost is made, so the address reaches it
  assertEquals(got, [4, 8, 9, 10, 11, 13]);
});

Deno.test("placing an id again with no position is the slot's last change, and unplacing from nothing is nothing-there", () => {
  const g = host();
  g.make([], "p", {});
  g.place(["p"], "x", "a", { value: 1 });
  g.place(["p"], "x", "b", { value: 2 });
  const again = g.place(["p"], "x", "a").change;
  const listing = g.api.directory({ agent: "host", address: ["p"], name: "x" });
  assert("items" in listing);
  assertEquals(listing.items.map((i) => [i.id, i.change]), [["a", again], ["b", again]]);
  assertEquals(code(() => g.unplace(["nope"], "x", "a")), "nothing-there");
  g.undo();
});

Deno.test("fields are checked in order, then the address, then the time, then the change", () => {
  const g = host();
  g.make([], "a", { k: 1 });
  const op = (more: object) => ({ agent: "host", cause: site, ...more });
  const write = (more: object) => code(() => g.api.write(op(more) as never));
  const place = (more: object) => code(() => g.api.place(op(more) as never));
  const unplace = (more: object) => code(() => g.api.unplace(op(more) as never));
  // the request: agent, process, place, chroot, address, name, id, position, value, patches, cause, time
  assertEquals(code(() => g.api.write({ process: 5, address: 5 } as never)), "missing");
  assertEquals(write({ process: 5, address: 5 }), "wrong-field");
  const field = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Invalid).why.field;
    }
  };
  assertEquals(
    field(() => g.api.place(op({ place: "x", address: 5, name: "." }) as never)),
    "place",
  );
  assertEquals(field(() => g.api.place(op({ address: 5, name: "." }) as never)), "address");
  assertEquals(field(() => g.api.place(op({ address: [], name: ".", id: 5 }) as never)), "name");
  assertEquals(
    field(() => g.api.place(op({ address: [], name: "x", id: 5, position: -1 }) as never)),
    "id",
  );
  assertEquals(
    field(() =>
      g.api.place(op({ address: [], name: "x", id: "x", position: -1, time: 0 }) as never)
    ),
    "position",
  );
  assertEquals(
    field(() => g.api.place(op({ address: [], name: "x", id: "x", position: 0.5 }) as never)),
    "position",
  );
  assertEquals(
    field(() => g.api.place(op({ address: [], name: "x", id: "x", value: NaN, time: 0 }) as never)),
    "value",
  );
  assertEquals(
    field(() => g.api.write(op({ address: [], patches: {}, time: 0 }) as never)),
    "patches",
  );
  assertEquals(
    field(() => g.api.write(op({ address: [], patches: [], cause: NaN, time: 0 }) as never)),
    "cause",
  );
  for (const time of [0, -1, 1.5, "1", null]) {
    assertEquals(field(() => g.api.write(op({ address: [], patches: [], time }) as never)), "time");
  }
  assertEquals(field(() => g.api.write(op({ address: [], patches: [] }) as never)), "time");
  // the graph: where, then when, then what
  const late = 1;
  const bad = [{ type: "set", path: ["nope"], key: "k" }];
  assertEquals(write({ address: [".."], patches: bad, time: late }), "above-root");
  assertEquals(write({ address: ["nope"], patches: bad, time: late }), "nothing-there");
  assertEquals(write({ address: ["a"], patches: bad, time: late }), "time");
  assertEquals(
    place({ address: [], name: "a", id: "a", value: 1, position: 9, time: late }),
    "time",
  );
  assertEquals(unplace({ address: [], name: "zz", id: "a", time: late }), "time");
  const now = g.next();
  g.undo();
  assertEquals(
    place({ address: [], name: "a", id: "a", value: 1, position: 9, time: now }),
    "exists",
  );
  assertEquals(place({ address: [], name: "a", id: "q", position: 9, time: now }), "position");
  assertEquals(unplace({ address: [], name: "zz", id: "a", time: now }), "not-in-slot");
  // patch by patch: the first that does not apply, whatever the later ones are
  const e = assertThrows(
    () =>
      g.api.write(
        op({
          address: ["a"],
          patches: [{ type: "snapshot", value: {} }, { type: "set", path: ["x"], key: "k" }, 5],
          time: now,
        }) as never,
      ),
    Invalid,
  );
  assertEquals([e.why.code, e.why.index], ["no-key", 1]);
  assertEquals(g.read(["a"]), [{ k: 1 }]);
});

Deno.test("names are in code point order", () => {
  assertEquals(["😀", "～", "Zed", "a"].sort(byCodePoint), ["Zed", "a", "～", "😀"]);
  assert(byCodePoint("a", "ab") < 0);
  assert(equal({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] }));
  assert(!equal({ a: 1 }, { a: 1, b: undefined as unknown as Json }));
});

Deno.test("a subscription follows its address, and gets the placement that switched it", () => {
  const g = host();
  const got: Change[] = [];
  g.api.subscribe({
    agent: "host",
    address: ["doc"],
    send: (e) => "change" in e && got.push(e.change),
  });
  g.make([], "d1", 1);
  g.place([], "doc", "d1"); // switches to d1
  g.write(["d1"], { type: "snapshot", value: 2 }); // d1's change
  g.make([], "d2", 3); // neither
  g.place([], "doc", "d2", { position: 0 }); // switches to d2
  g.write(["d1"], { type: "snapshot", value: 4 }); // no longer d1
  g.unplace([], "doc", "d2"); // back to d1
  assertEquals(got.map((c) => c.time), [2, 3, 5, 7]);
});

/** Runs a compute by hand: binds, records, reads, finishes. */
function run(
  api: Interface,
  process: string,
  reads: (rec: Interface) => void,
  marked: ChangeRef[] = [],
  place?: string[],
) {
  const bound = api.bind(api, { agent: "host", process, place, writes: false });
  const rec = api.record(bound, marked);
  reads(rec);
  bound.end();
  return api.finish(rec, "done");
}

Deno.test("a change marks the processes whose last run read what it changed", () => {
  const g = host();
  g.make([], "a", 1);
  g.make([], "d", {});
  run(g.api, "p1", (r) => r.read({ address: ["a"] }));
  run(g.api, "p2", (r) => r.directory({ address: ["d"], name: "x" }));
  run(g.api, "p3", (r) => {
    r.directory({ address: ["d"] });
    r.read({ address: ["ghost"] });
  });
  const marked = (c: { marked: { process: string }[] }) => c.marked.map((m) => m.process);
  assertEquals(marked(g.write(["a"], { type: "snapshot", value: 1 })), ["p1"]);
  assertEquals(marked(g.place(["d"], "y", "n")), ["p3"]);
  const both = g.place(["d"], "x", "n");
  assertEquals(both.marked, [
    { process: "p2", by: { node: "d", time: both.change.time } },
    { process: "p3", by: { node: "d", time: both.change.time } },
  ]);
  assertEquals(marked(g.place(["a"], "x", "n")), [], "a placement does not mark value readers");
  assertEquals(marked(g.make([], "ghost", 0)), ["p3"], "a read that reached nothing is marked");
  // each run's reads replace the last
  run(g.api, "p1", (r) => r.read({ address: ["d"] }));
  assertEquals(g.write(["a"], { type: "snapshot", value: 2 }).marked, []);
});

Deno.test("a walk is marked by every member it tried, and the slot it looked for in it", () => {
  const g = host();
  g.make([], "l1", 1);
  g.make([], "l2", 2);
  g.place(["l2"], "x", "x2", { value: "two" });
  g.place([], "lib", "l1");
  g.place([], "lib", "l2");
  const record = run(g.api, "r", (rec) => rec.read({ address: ["lib", "x"] }));
  assertEquals(record.reads.map((r) => r.route.map((s) => s.node)), [["l2", "x2"]]);
  const placed = g.place(["l1"], "x", "x1", { value: "one" });
  assertEquals(placed.marked.map((m) => m.process), ["r"]);
});

Deno.test("a process is marked by its own changes, which name it", () => {
  const g = host();
  g.make([], "a", 1);
  run(g.api, "p1", (r) => r.read({ address: ["a"] }));
  const lasting = g.api.bind(g.api, { agent: "host", process: "p1", writes: true });
  const own = lasting.write({
    address: ["a"],
    patches: [{ type: "snapshot", value: 2 }],
    time: g.next(),
  });
  assertEquals(own.change.process, "p1");
  assert(!("cause" in own.change), "a process's change has a cause only if its program gives one");
  assertEquals(own.marked.map((m) => m.process), ["p1"]);
});

Deno.test("a lookup searches up from the place's directory, and is marked only by its name there", () => {
  const g = host();
  g.make([], "a", {});
  g.make(["a"], "b", {});
  g.place([], "theme", "t-r", { value: "r" });
  const bound = g.api.bind(g.api, {
    agent: "host",
    process: "p",
    place: ["a", "b"],
    writes: false,
  });
  assertEquals(bound.cwd, ["a", "b"]);
  const rec = g.api.record(bound, []);
  assertEquals(rec.lookup({ name: "theme" }).map((i) => [i.id, i.from]), [
    ["t-r", { path: ["..", "..", "theme"], position: 0 }],
  ]);
  g.api.finish(rec, "done");
  assertEquals(rec.lookups[0].searched.map((s) => s.node), ["b", "a", "root"]);
  assertEquals(g.place([], "font", "f").marked, []);
  assertEquals(g.place(["a"], "theme", "t-a").marked.map((m) => m.process), ["p"]);
});

Deno.test("a lookup passes over a slot whose ids are all absent, and is marked when one is made", () => {
  const g = host();
  g.make([], "a", {});
  g.place([], "theme", "t-r", { value: "r" });
  g.place(["a"], "theme", "ghost");
  const lookup = () => {
    const bound = g.api.bind(g.api, { agent: "host", process: "p", place: ["a"], writes: false });
    const rec = g.api.record(bound, []);
    const found = rec.lookup({ name: "theme" }).map((i) => [i.id, i.from, !!i.pending]);
    bound.end();
    g.api.finish(rec, "done");
    return { found, searched: rec.lookups[0].searched };
  };
  const passed = lookup();
  assertEquals(passed.found, [["t-r", { path: ["..", "theme"], position: 0 }, false]]);
  assertEquals(passed.searched, [{ node: "a", saw: 3 }, { node: "root", saw: 2 }]);
  // a slot that holds one node that is here gives all its items, pending ones too
  const placed = g.place(["a"], "theme", "t-a", { value: "a" });
  assertEquals(placed.marked.map((m) => m.process), ["p"]);
  assertEquals(lookup().found, [
    ["ghost", { path: ["theme"], position: 0 }, true],
    ["t-a", { path: ["theme"], position: 1 }, false],
  ]);
  g.unplace(["a"], "theme", "t-a");
  lookup();
  // the search went on past ghost, so ghost's being made marks it
  assertEquals(g.make([], "ghost", "g").marked.map((m) => m.process), ["p"]);
  assertEquals(lookup().found.map(([id]) => id), ["ghost"]);
});

Deno.test("a recording records programs, reads, changes and errors, and sends its record", () => {
  const g = host();
  g.make([], "prog", ["code"]);
  g.make([], "p1", null);
  g.place(["p1"], "compute", "prog");
  const events: Event[] = [];
  g.api.subscribe({ agent: "host", address: ["p1"], send: (e) => events.push(e) });

  const bound = g.api.bind(g.api, { agent: "alice", process: "p1", writes: false });
  const rec = g.api.record(bound, [{ node: "p1", time: 3 }]);
  const compute = rec.program("compute", ["p1"]);
  assertEquals([compute?.node, compute?.slot, compute?.items.map((i) => i.value)], [
    "prog",
    ["prog"],
    [["code"]],
  ]);
  assertEquals(rec.program("effect", ["p1"]), undefined);
  assertThrows(() => rec.write({ address: ["p1"], patches: [], time: 50 + g.next() }), Invalid);
  const writer = g.api.bind(g.api, { agent: "alice", process: "p1", writes: true, reads: false });
  rec.through(writer).write({
    address: ["p1"],
    patches: [{ type: "snapshot", value: 1 }],
    time: g.next(),
  });
  assertThrows(() => rec.through(writer).read({ address: ["p1"] }), Invalid);
  bound.end();
  assertThrows(() => rec.read({ address: ["prog"] }), Invalid);
  const record = g.api.finish(rec, "failed", { value: 1 });
  assertEquals({ ...record, errors: record.errors.map((e) => [e.kind, e.op, e.why.code]) }, {
    process: "p1",
    run: 1,
    agent: "alice",
    marked: [{ node: "p1", time: 3 }],
    compute: { node: "prog", saw: 1, slot: ["prog"] },
    lookups: [],
    reads: [],
    value: 1,
    cleanup: [],
    changes: [{ node: "p1", time: 5 }],
    ending: "failed",
    errors: [
      ["invalid", "write", "read-only"],
      ["invalid", "read", "write-only"],
      ["invalid", "read", "stopped"],
    ],
  } as never);
  assertEquals(events.map((e) => "record" in e ? "record" : "change"), ["change", "record"]);
  assertThrows(() => g.api.finish(rec, "done"), Invalid);

  // the program reads mark the process
  assertEquals(g.write(["prog"], { type: "snapshot", value: [] }).marked.map((m) => m.process), [
    "p1",
  ]);
  assertEquals(g.place(["p1"], "effect", "e").marked.map((m) => m.process), ["p1"]);
});

Deno.test("a change from outside with no cause gets its site, captured where it entered the stack", () => {
  const api = protect(graph("root"), () => true);
  api.top(api);
  const made = api.place({ agent: "host", address: [], name: "a", id: "a", value: 1, time: 1 });
  const cause = made.change.cause as { file: string; line: number; column: number };
  assert(cause.file.endsWith("/test/graph_test.ts"), cause.file);
  assert(Number.isInteger(cause.line) && Number.isInteger(cause.column));
  // a cause given is kept, null included
  assertEquals(
    api.write({ agent: "host", address: ["a"], patches: [], time: 2, cause: null }).change.cause,
    null,
  );
});

Deno.test("protect asks before every operation, with the node its address reaches, each directory of a lookup included", () => {
  const asked: string[] = [];
  const g = host(protect(graph("root"), (agent, _process, op, args) => {
    asked.push(`${op} ${subject(op, args) ?? ""}`.trim());
    return !(agent === "eve" && op === "directory" && subject(op, args) === "a");
  }));
  g.make([], "a", {});
  g.make(["a"], "b", {});
  g.place([], "theme", "t", { value: "T" });
  asked.length = 0;
  const lookup = (agent: string) =>
    g.api.lookup({ agent, name: "theme", place: ["a", "b"] }).map((i) => i.id);
  assertEquals(lookup("host"), ["t"]);
  assertEquals(asked, ["lookup", "directory b", "directory a", "directory root"]);
  assertEquals(lookup("eve"), []);
  assertThrows(() => g.api.directory({ agent: "eve", address: ["a"] }), Refused);
  asked.length = 0;
  g.place(["a"], "x", "n");
  assertEquals(asked, ["place a"]);
});

Deno.test("a change that is invalid in its agent, cause or value changes nothing", () => {
  const g = host();
  g.make([], "a", 1);
  g.make([], "p", {});
  const at = { time: 3, cause: site };
  const snapshot: Patch = { type: "snapshot", value: 2 };
  assertEquals(
    code(() =>
      g.api.write({ agent: "host", ...at, address: ["a"], patches: [snapshot], cause: NaN })
    ),
    "wrong-field",
  );
  assertEquals(g.read(["a"]), [1]);
  assertEquals(
    code(() => g.api.place({ agent: Infinity, ...at, address: [], name: "c", id: "c", value: 1 })),
    "wrong-field",
  );
  assertEquals(g.read(["c"]), []);
  assertEquals(code(() => g.api.read({ address: ["a"] })), "missing");
  assertEquals(
    code(() =>
      g.api.place(
        { agent: "host", ...at, address: ["p"], name: "x", id: "q", value: () => 1 } as never,
      )
    ),
    "wrong-field",
  );
  assertEquals(g.slot(["p"], "x"), []);
  // time 3 is still free
  assertEquals(
    g.api.place({ agent: "host", ...at, address: [], name: "b", id: "b", value: 0 }).change.time,
    3,
  );
  assertEquals(
    code(() => g.api.place({ agent: "host", ...at, address: [], name: "z", id: "z", value: 0 })),
    "time",
  );
});

Deno.test("a bound interface binds only as itself, and cannot record or finish runs", () => {
  const g = host();
  g.make([], "x", 1);
  run(g.api, "victim", (r) => r.read({ address: ["x"] }));
  const records: Event[] = [];
  g.api.subscribe({ agent: "host", address: ["victim"], send: (e) => records.push(e) });

  const mb = g.api.bind(g.api, { agent: "mallory", process: "m", writes: false });
  const fake = mb.bind(mb, { agent: "eve", process: "victim", writes: true });
  assertThrows(() => mb.record(fake, [{ node: "x", time: 2 }]), Invalid);
  assertThrows(() => fake.record(fake, []), Invalid);
  // what the holder bound acts as the holder, and does no more than it does
  assertEquals(
    code(() => fake.write({ address: ["x"], patches: [], time: g.next() })),
    "read-only",
  );
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
  assertEquals(g.write(["x"], { type: "snapshot", value: 2 }).marked.map((m) => m.process), [
    "victim",
  ]);
});

Deno.test("an operation's error names the operation", () => {
  const g = host(
    protect(graph("root"), (agent, _process, op) => !(agent === "eve" && op === "write")),
  );
  g.make([], "a", 1);
  const named = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return [(e as Invalid).kind, (e as Invalid).op, (e as Invalid).why.code];
    }
  };
  assertEquals(named(() => g.api.write({ agent: "eve", address: ["a"], patches: [] })), [
    "refused",
    "write",
    "rule",
  ]);
  assertEquals(
    named(() => g.api.write({ agent: "host", address: ["ghost"], patches: [], time: 9 })),
    [
      "invalid",
      "write",
      "nothing-there",
    ],
  );
  assertEquals(named(() => g.api.read({ agent: "host", address: 5 as unknown as Address })), [
    "invalid",
    "read",
    "wrong-field",
  ]);
});

Deno.test("protect checks an unsubscribe against the node its subscription reaches now", () => {
  const asked: [string, string | undefined][] = [];
  const api = protect(graph("root"), (_agent, _process, op, args) => {
    asked.push([op, subject(op, args)]);
    return !(op === "unsubscribe" && subject(op, args) === "a");
  });
  api.place({ agent: "host", address: [], name: "a", id: "a", value: 1, time: 1 });
  const { sub: a } = api.subscribe({ agent: "host", address: ["a"], send: () => {} });
  const { sub: b } = api.subscribe({ agent: "host", address: ["b"], send: () => {} });
  assertThrows(() => api.unsubscribe({ agent: "host", sub: a }), Refused);
  api.unsubscribe({ agent: "host", sub: b });
  assertEquals(asked.filter(([op]) => op === "unsubscribe"), [
    ["unsubscribe", "a"],
    ["unsubscribe", undefined],
  ]);
});

Deno.test("protect asks before bind, record and finish, as the binding's agent and process", () => {
  const asked: string[] = [];
  const api = protect(graph("root"), (agent, process, op) => {
    asked.push(`${op} ${JSON.stringify(agent)} ${process}`);
    return agent !== "mallory";
  });
  api.place({ agent: "host", address: [], name: "a", id: "a", value: 1, time: 1, cause: site });
  assertThrows(() => api.read({ agent: "mallory", address: ["a"] }), Refused);
  assertThrows(() => api.bind(api, { agent: "mallory", process: "m", writes: false }), Refused);
  const bound = api.bind(api, { agent: "alice", process: "p", writes: false });
  const rec = api.record(bound, []);
  api.finish(rec, "done");
  assertEquals(asked, [
    'place "host" undefined',
    'read "mallory" undefined',
    'bind "mallory" m',
    'bind "alice" p',
    'record "alice" p',
    'finish "alice" p',
  ]);
});

Deno.test("each layer is told the top of the stack once, so no holder can point it elsewhere", () => {
  const may = (agent: Json, _process: string | undefined, op: string, args: object) =>
    !(agent === "alice" && op === "directory" && subject(op, args) === "secret");
  const api = protect(graph("root"), may);
  api.top(api);
  api.place({ agent: "host", address: [], name: "secret", id: "secret", value: 1, time: 1 });
  api.place({ agent: "host", address: ["secret"], name: "tool", id: "real", value: 1, time: 2 });
  const search = (agent: string) =>
    api.lookup({ agent, name: "tool", place: ["secret"], chroot: 1 }).map((i) => i.id);
  assertEquals(search("alice"), []);
  const planted: Interface = { ...api, directory: () => ({ items: [] }) };
  assertThrows(() => api.top(planted), Invalid);
  assertEquals(search("alice"), []);
  assertEquals(search("bob"), ["real"]);
  // a layer below, already told by protect, is told no more by anyone else
  const g = graph("root");
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
