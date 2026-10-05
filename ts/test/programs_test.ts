import { assert, assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import {
  ABSENT,
  type Api,
  type Cleanup,
  equal,
  errorJson,
  type Fire,
  type Json,
  load,
  type Program,
  ProgramError,
  runHandler,
  type Value,
} from "../harness/programs.ts";

// A fake interface: nodes, directories, and a log of what was asked.
function fake(
  nodes: { [id: string]: Json } = {},
  dirs: { [id: string]: { [name: string]: string[] } } = {},
) {
  const log: Json[] = [];
  const api: Required<Api> = {
    read(node) {
      log.push(["read", node]);
      return Object.hasOwn(nodes, node) ? nodes[node] : ABSENT;
    },
    directory(node, name) {
      log.push(
        name === undefined ? ["directory", node] : ["directory", node, name],
      );
      const d = dirs[node];
      if (name !== undefined) return d?.[name] ?? [];
      if (!d) return ABSENT;
      return Object.keys(d).sort().map((k) => [k, d[k]]);
    },
    lookup(name) {
      log.push(["lookup", name]);
      return dirs.root?.[name] ?? [];
    },
    make(op) {
      log.push(["make", op]);
      nodes[op.id] = op.value;
    },
    write(op) {
      log.push(["write", op]);
      nodes[op.node] = (op.patches as { value: Json }[])[0].value;
    },
    place(op) {
      log.push(["place", op]);
    },
    unplace(op) {
      log.push(["unplace", op]);
    },
  };
  return { api, log, nodes };
}

function program(code: Json): Program {
  const p = load(code);
  if (p instanceof ProgramError) throw p;
  return p;
}

function compute(code: Json, api: Api = fake().api, more: {
  self?: string;
  path?: Json;
  changes?: Json;
} = {}) {
  return program(code).compute({
    api,
    self: more.self ?? "p1",
    path: more.path ?? [],
    changes: more.changes ?? [],
  });
}

/** Evaluates one expression in a compute. */
function ev(e: Json, api?: Api) {
  const out = compute([{ do: "return", value: e }], api);
  if (!("value" in out)) throw new Error("pending");
  return out.value;
}

function effect(
  code: Json,
  api: Api,
  value: Json = null,
  previous: Value = ABSENT,
) {
  const handlers = new Map<string, Fire>();
  const cleanups: Cleanup[] = [];
  program(code).effect({
    api,
    self: "p1",
    value,
    previous,
    handler: (name, fire) => handlers.set(name, fire),
    cleanup: (run) => cleanups.push(run),
  });
  return { handlers, cleanups };
}

function failsWith(f: () => unknown, kind = "thrown"): ProgramError {
  const e = assertThrows(f);
  assertInstanceOf(e, ProgramError);
  assertEquals(e.kind, kind);
  return e;
}

// --- load ---

Deno.test("load: a list of steps is a program", () => {
  assert(!(load([]) instanceof ProgramError));
  assert(!(load([{ do: "pending" }]) instanceof ProgramError));
});

Deno.test("load: anything else is a failure", () => {
  for (
    const v of [
      "hello",
      1,
      null,
      {},
      { do: "return", value: 1 },
      [1],
      [{}],
      [{ do: "dance" }],
      [{ do: "return" }],
      [{ do: "read", node: "a" }],
      [{ do: "read", node: "a", as: 1 }],
      [{ do: "if", test: true, then: "no" }],
      [{ do: "if", test: true, then: [], else: [{ do: "nope" }] }],
      [{ do: "each", list: [], as: "x", steps: [{ do: 1 }] }],
      [{ do: "handler", name: { $: "x" }, steps: [] }],
      [{ do: "try", steps: [] }],
    ] as Json[]
  ) {
    const p = load(v);
    assertInstanceOf(p, ProgramError, JSON.stringify(v));
    assertEquals(p.kind, "thrown");
  }
});

Deno.test("load: the program is copied, so changing the value later does nothing", () => {
  const code: Json = [{ do: "return", value: 1 }];
  const p = program(code);
  ((code as Json[])[0] as { [k: string]: Json }).value = 2;
  assertEquals(p.compute({ api: {}, self: "p", path: [], changes: [] }), {
    value: 1,
  });
});

// --- expressions ---

Deno.test("expressions: the scenario's examples", () => {
  assertEquals(ev({ $add: [1, 2, 3.5] }), 6.5);
  assertEquals(
    ev({ $get: [{ $quote: { a: { b: [10, 20] } } }, "a", "b", 1] }),
    20,
  );
  assertEquals(ev({ $absent: { $get: [{ $quote: { a: 1 } }, "z"] } }), true);
  assertEquals(
    ev({
      $eq: [{ $quote: { x: 1, y: [1, 2] } }, { $quote: { y: [1, 2], x: 1 } }],
    }),
    true,
  );
  assertEquals(ev({ $eq: [{ $add: [0.5, 0.5] }, 1] }), true);
  assertEquals(ev({ $eq: [[1, 2], [2, 1]] }), false);
  assertEquals(ev({ $concat: ["a", "b", "😀"] }), "ab😀");
  assertEquals(ev({ $concat: [[1], [2, 3]] }), [1, 2, 3]);
  assertEquals(
    ev([{ $len: "a😀" }, { $len: [1, 2, 3] }, {
      $len: { $quote: { a: 1, b: 2 } },
    }]),
    [
      2,
      3,
      2,
    ],
  );
  assertEquals(ev({ $quote: { $: "x" } }), { $: "x" });
  assertEquals(ev({ $not: false }), true);
  assertEquals(ev({ inner: [{ $not: true }] }), { inner: [false] });
});

Deno.test("expressions: plain values and objects with more keys are evaluated member by member", () => {
  assertEquals(ev(null), null);
  assertEquals(ev("s"), "s");
  assertEquals(ev({ $a: { $not: true }, $b: 1 }), { $a: false, $b: 1 });
  assertEquals(ev({}), {});
  assertEquals(ev([]), []);
});

Deno.test("expressions: $get", () => {
  assertEquals(ev({ $get: [{ $quote: [1, 2] }] }), [1, 2]);
  assertEquals(ev({ $absent: { $get: [[1, 2], 2] } }), true);
  assertEquals(ev({ $absent: { $get: [[1, 2], -1] } }), true);
  assertEquals(ev({ $absent: { $get: [[1, 2], 0.5] } }), true);
  // once absent, the rest of the keys stay absent
  assertEquals(ev({ $absent: { $get: [{}, "a", "b", 1] } }), true);
  // a member that is there but null is not absent
  assertEquals(ev({ $get: [{ a: null }, "a"] }), null);
  // not own properties
  assertEquals(ev({ $absent: { $get: [{}, "toString"] } }), true);
  assertEquals(ev({ $absent: { $get: [{}, "__proto__"] } }), true);
  failsWith(() => ev({ $get: [1, "a"] }));
  failsWith(() => ev({ $get: [[1], "0"] }));
  failsWith(() => ev({ $get: [{ a: 1 }, 0] }));
  failsWith(() => ev({ $get: [] }));
  failsWith(() => ev({ $get: "a" }));
});

Deno.test("expressions: $eq", () => {
  assertEquals(ev({ $eq: [null, null] }), true);
  assertEquals(ev({ $eq: [null, false] }), false);
  assertEquals(ev({ $eq: [{ $quote: {} }, { $quote: [] }] }), false);
  assertEquals(
    ev({ $eq: [{ $quote: { a: 1 } }, { $quote: { a: 1, b: 2 } }] }),
    false,
  );
  assertEquals(
    ev({ $eq: [{ $quote: { a: 1, b: 2 } }, { $quote: { a: 1, c: 2 } }] }),
    false,
  );
  assertEquals(ev({ $eq: ["1", 1] }), false);
  failsWith(() => ev({ $eq: [1] }));
  failsWith(() => ev({ $eq: [1, 2, 3] }));
});

Deno.test("expressions: wrong kinds throw", () => {
  failsWith(() => ev({ $not: 1 }));
  failsWith(() => ev({ $not: null }));
  failsWith(() => ev({ $add: [1, "2"] }));
  failsWith(() => ev({ $add: 1 }));
  failsWith(() => ev({ $concat: ["a", [1]] }));
  failsWith(() => ev({ $concat: "a" }));
  failsWith(() => ev({ $len: 1 }));
  failsWith(() => ev({ $len: null }));
  failsWith(() => ev({ $: 1 }));
  failsWith(() => ev({ $nope: 1 }));
});

Deno.test("expressions: every operator but $absent throws on absent", () => {
  const absent = { $get: [{}, "x"] };
  failsWith(() => ev({ $add: [absent, 1] }));
  failsWith(() => ev({ $not: absent }));
  failsWith(() => ev({ $len: absent }));
  failsWith(() => ev({ $eq: [absent, null] }));
  failsWith(() => ev({ $concat: [absent] }));
  failsWith(() => ev({ $get: [absent, "a"] }));
  assertEquals(ev({ $absent: absent }), true);
  assertEquals(ev({ $absent: null }), false);
  // absent is not a value: not inside a list or object, not returned
  failsWith(() => ev([absent]));
  failsWith(() => ev({ a: absent }));
  failsWith(() => ev(absent));
});

Deno.test("expressions: $add and $concat of nothing", () => {
  assertEquals(ev({ $add: [] }), 0);
  assertEquals(ev({ $concat: [] }), "");
});

Deno.test("expressions: operands may come from variables", () => {
  assertEquals(
    compute([
      { do: "let", as: "xs", value: [1, 2, 3] },
      { do: "return", value: { $add: { $: "xs" } } },
    ]),
    { value: 6 },
  );
});

Deno.test("expressions: $quote copies, so the program is not shared", () => {
  const p = program([{ do: "return", value: { $quote: { a: [1] } } }]);
  const ctx = { api: {}, self: "p", path: [], changes: [] };
  const one = p.compute(ctx) as { value: { a: number[] } };
  one.value.a.push(2);
  assertEquals(p.compute(ctx), { value: { a: [1] } });
});

Deno.test("expressions: a __proto__ key is a key", () => {
  const v = ev(JSON.parse('{"__proto__": {"$not": true}}')) as {
    [k: string]: Json;
  };
  assert(Object.hasOwn(v, "__proto__"));
  assertEquals(Object.getPrototypeOf(v), Object.prototype);
  assertEquals(ev({ $len: JSON.parse('{"__proto__": 1}') }), 1);
});

Deno.test("expressions: unknown variables throw", () => {
  failsWith(() => ev({ $: "nope" }));
  failsWith(() => ev({ $: "value" })); // an effect's, not a compute's
});

// --- compute ---

Deno.test("compute: variables self, path, changes", () => {
  const path = [{ parent: "init", name: "x", node: "p1" }];
  const changes = [{ node: "init", time: 6 }];
  assertEquals(
    compute(
      [{
        do: "return",
        value: [{ $: "self" }, { $: "path" }, { $len: { $: "changes" } }],
      }],
      {},
      {
        self: "p1",
        path,
        changes,
      },
    ),
    { value: ["p1", path, 1] },
  );
});

Deno.test("compute: no return gives null", () => {
  assertEquals(compute([{ do: "let", as: "x", value: 1 }]), { value: null });
  assertEquals(compute([]), { value: null });
});

Deno.test("compute: return ends the part from inside each and if", () => {
  assertEquals(
    compute([
      {
        do: "each",
        list: [1, 2, 3],
        as: "i",
        steps: [{
          do: "if",
          test: { $eq: [{ $: "i" }, 2] },
          then: [{ do: "return", value: { $add: [{ $: "i" }, 100] } }],
          else: [],
        }],
      },
      { do: "return", value: 0 },
    ]),
    { value: 102 },
  );
});

Deno.test("compute: pending ends the part", () => {
  const { api, log } = fake();
  assertEquals(
    compute([{ do: "pending" }, { do: "read", node: "a", as: "x" }], api),
    { pending: true },
  );
  assertEquals(log, []);
  assertEquals(
    compute([{ do: "each", list: [1], as: "i", steps: [{ do: "pending" }] }, {
      do: "return",
      value: 1,
    }]),
    { pending: true },
  );
});

Deno.test("compute: read gives the value, or absent", () => {
  const { api, log } = fake({ a: 5, n: null });
  assertEquals(
    compute([
      { do: "read", node: "a", as: "a" },
      { do: "read", node: "n", as: "n" },
      { do: "read", node: { $concat: ["gh", "ost"] }, as: "g" },
      {
        do: "return",
        value: [{ $: "a" }, { $: "n" }, { $absent: { $: "n" } }, {
          $absent: { $: "g" },
        }],
      },
    ], api),
    { value: [5, null, false, true] },
  );
  assertEquals(log, [["read", "a"], ["read", "n"], ["read", "ghost"]]);
});

Deno.test("compute: the read-then-pending pattern", () => {
  const code: Json = [
    { do: "read", node: "a", as: "x" },
    { do: "if", test: { $absent: { $: "x" } }, then: [{ do: "pending" }] },
    { do: "return", value: { $: "x" } },
  ];
  assertEquals(compute(code, fake().api), { pending: true });
  assertEquals(compute(code, fake({ a: 5 }).api), { value: 5 });
});

Deno.test("compute: directory, one slot or whole", () => {
  const { api, log } = fake({}, { d: { y: ["n1"], x: ["a", "b"] } });
  assertEquals(
    compute([
      { do: "directory", node: "d", name: "x", as: "x" },
      { do: "directory", node: "d", name: "gone", as: "g" },
      { do: "directory", node: "d", as: "all" },
      { do: "directory", node: "e", as: "none" },
      {
        do: "return",
        value: [{ $: "x" }, { $: "g" }, { $: "all" }, {
          $absent: { $: "none" },
        }],
      },
    ], api),
    { value: [["a", "b"], [], [["x", ["a", "b"]], ["y", ["n1"]]], true] },
  );
  assertEquals(log, [
    ["directory", "d", "x"],
    ["directory", "d", "gone"],
    ["directory", "d"],
    ["directory", "e"],
  ]);
});

Deno.test("compute: a directory name that is absent is left out", () => {
  const { api, log } = fake({}, { d: {} });
  compute(
    [{ do: "directory", node: "d", name: { $get: [{}, "x"] }, as: "x" }],
    api,
  );
  assertEquals(log, [["directory", "d"]]);
  failsWith(() => compute([{ do: "directory", node: "d", name: 1, as: "x" }], api));
});

Deno.test("compute: lookup", () => {
  const { api, log } = fake({}, { root: { theme: ["dark"] } });
  assertEquals(
    compute([{ do: "lookup", name: "theme", as: "t" }, {
      do: "return",
      value: { $: "t" },
    }], api),
    { value: ["dark"] },
  );
  assertEquals(log, [["lookup", "theme"]]);
});

Deno.test("compute: ids and names must be strings", () => {
  const { api } = fake();
  failsWith(() => compute([{ do: "read", node: 1, as: "x" }], api));
  failsWith(() => compute([{ do: "read", node: { $get: [{}, "x"] }, as: "x" }], api));
  failsWith(() => compute([{ do: "lookup", name: null, as: "x" }], api));
});

Deno.test("compute: if needs a boolean, each a list", () => {
  failsWith(() => compute([{ do: "if", test: 1, then: [] }]));
  failsWith(() => compute([{ do: "each", list: "abc", as: "c", steps: [] }]));
  assertEquals(
    compute([{ do: "if", test: false, then: [{ do: "return", value: 1 }] }, {
      do: "return",
      value: 2,
    }]),
    { value: 2 },
  );
});

Deno.test("compute: let, each and try share one scope", () => {
  assertEquals(
    compute([
      { do: "let", as: "sum", value: 0 },
      {
        do: "each",
        list: [1, 2, 3],
        as: "i",
        steps: [{
          do: "let",
          as: "sum",
          value: { $add: [{ $: "sum" }, { $: "i" }] },
        }],
      },
      { do: "return", value: [{ $: "sum" }, { $: "i" }] },
    ]),
    { value: [6, 3] },
  );
});

Deno.test("compute: let may hold absent", () => {
  assertEquals(
    compute([
      { do: "let", as: "x", value: { $get: [{}, "a"] } },
      { do: "return", value: { $absent: { $: "x" } } },
    ]),
    { value: true },
  );
});

Deno.test("compute: a write through a read-only interface is invalid", () => {
  const { api } = fake();
  const readOnly: Api = {
    read: api.read,
    directory: api.directory,
    lookup: api.lookup,
  };
  const e = failsWith(
    () => compute([{ do: "write", node: "a", patches: [] }], readOnly),
    "invalid",
  );
  assertEquals(e.op, "write");
  assertEquals(errorJson(e), { kind: "invalid", op: "write", why: e.why });
});

// --- throw and try ---

Deno.test("throw: an uncaught throw ends the part", () => {
  const e = failsWith(() => compute([{ do: "throw", message: "boom" }]));
  assertEquals(e.why, "boom");
  assertEquals(errorJson(e), { kind: "thrown", why: "boom" });
  const f = failsWith(() => compute([{ do: "throw", message: { a: [1] } }]));
  assertEquals(f.why, '{"a":[1]}');
});

Deno.test("try: binds null when nothing is thrown", () => {
  assertEquals(
    compute([
      { do: "try", steps: [{ do: "let", as: "y", value: 1 }], as: "e" },
      { do: "return", value: [{ $: "e" }, { $: "y" }] },
    ]),
    { value: [null, 1] },
  );
});

Deno.test("try: catches a throw step and goes on", () => {
  assertEquals(
    compute([
      {
        do: "try",
        steps: [{ do: "throw", message: "boom" }, { do: "return", value: 1 }],
        as: "e",
      },
      {
        do: "return",
        value: [{ $not: { $eq: [{ $: "e" }, null] } }, { $: "e" }],
      },
    ]),
    { value: [true, { kind: "thrown", why: "boom" }] },
  );
});

Deno.test("try: catches operator errors", () => {
  const out = compute([
    { do: "try", steps: [{ do: "return", value: { $not: 1 } }], as: "e" },
    { do: "return", value: { $get: [{ $: "e" }, "kind"] } },
  ]);
  assertEquals(out, { value: "thrown" });
});

Deno.test("try: catches an operation's error as {kind, op, why}", () => {
  class Refused extends Error {
    kind = "refused";
    op = "read";
    why = "no";
  }
  const api: Api = {
    read() {
      throw new Refused("no");
    },
  };
  assertEquals(
    compute([
      { do: "try", steps: [{ do: "read", node: "secret", as: "x" }], as: "e" },
      { do: "return", value: { $: "e" } },
    ], api),
    { value: { kind: "refused", op: "read", why: "no" } },
  );
});

Deno.test("try: an uncaught operation error passes as it is", () => {
  const thrown = { kind: "refused", why: "no" };
  const api: Api = {
    read() {
      throw thrown;
    },
  };
  const e = assertThrows(() => compute([{ do: "read", node: "a", as: "x" }], api));
  assert(e === thrown);
});

Deno.test("try: return and pending pass through it", () => {
  assertEquals(
    compute([{ do: "try", steps: [{ do: "return", value: 1 }], as: "e" }, {
      do: "return",
      value: 2,
    }]),
    { value: 1 },
  );
  assertEquals(
    compute([{ do: "try", steps: [{ do: "pending" }], as: "e" }, {
      do: "return",
      value: 2,
    }]),
    { pending: true },
  );
});

Deno.test("errorJson: other things thrown", () => {
  assertEquals(errorJson(new Error("x")), { kind: "thrown", why: "x" });
  assertEquals(errorJson("x"), { kind: "thrown", why: "x" });
  assertEquals(errorJson({ kind: "invalid", why: "w", op: 3 }), {
    kind: "invalid",
    why: "w",
  });
  const e = Object.assign(new Error("m"), { kind: "invalid" });
  assertEquals(errorJson(e), { kind: "invalid", why: "m" });
});

// --- effect ---

Deno.test("effect: variables self, value, previous", () => {
  const { api, nodes } = fake();
  const code: Json = [{
    do: "write",
    node: "seen",
    patches: [{
      type: "snapshot",
      value: {
        self: { $: "self" },
        v: { $: "value" },
        first: { $absent: { $: "previous" } },
      },
    }],
  }];
  effect(code, api, 1);
  assertEquals(nodes.seen, { self: "p1", v: 1, first: true });
  effect(code, api, 2, 1);
  assertEquals(nodes.seen, { self: "p1", v: 2, first: false });
  // a compute's variables are not there
  failsWith(() => effect([{ do: "let", as: "x", value: { $: "changes" } }], api));
});

Deno.test("effect: make, write, place, unplace pass their fields", () => {
  const { api, log } = fake();
  effect(
    [
      { do: "make", id: "n", value: { a: { $: "value" } } },
      { do: "make", id: "m", value: 1, cause: null },
      {
        do: "write",
        node: "n",
        patches: [{ type: "snapshot", value: 2 }],
        cause: { why: "x" },
      },
      { do: "place", parent: { $: "self" }, name: "kid", id: "n" },
      {
        do: "place",
        parent: "p1",
        name: "kid",
        id: "m",
        position: 0,
        cause: "c",
      },
      { do: "unplace", parent: "p1", name: "kid", id: "n" },
      {
        do: "unplace",
        parent: "p1",
        name: "kid",
        id: "m",
        cause: { $get: [{}, "no"] },
      },
    ],
    api,
    7,
  );
  assertEquals(log, [
    ["make", { id: "n", value: { a: 7 } }],
    ["make", { id: "m", value: 1, cause: null }],
    ["write", {
      node: "n",
      patches: [{ type: "snapshot", value: 2 }],
      cause: { why: "x" },
    }],
    ["place", { parent: "p1", name: "kid", id: "n" }],
    ["place", { parent: "p1", name: "kid", id: "m", position: 0, cause: "c" }],
    ["unplace", { parent: "p1", name: "kid", id: "n" }],
    ["unplace", { parent: "p1", name: "kid", id: "m" }],
  ]);
});

Deno.test("effect: wrong kinds in write steps throw before the operation", () => {
  const { api, log } = fake();
  failsWith(() => effect([{ do: "make", id: 1, value: 1 }], api));
  failsWith(() => effect([{ do: "make", id: "a", value: { $get: [{}, "x"] } }], api));
  failsWith(() =>
    effect(
      [{ do: "place", parent: "a", name: "b", id: "c", position: "0" }],
      api,
    )
  );
  failsWith(() => effect([{ do: "write", node: "a", patches: { $get: [{}, "x"] } }], api));
  assertEquals(log, []);
});

Deno.test("effect: read, directory and lookup are invalid through a write-only interface", () => {
  const { api, log } = fake({ a: 1 }, { d: {} });
  const writeOnly: Api = {
    make: api.make,
    write: api.write,
    place: api.place,
    unplace: api.unplace,
  };
  for (
    const [step, op] of [
      [{ do: "read", node: "a", as: "x" }, "read"],
      [{ do: "directory", node: "d", as: "x" }, "directory"],
      [{ do: "lookup", name: "t", as: "x" }, "lookup"],
    ] as [Json, string][]
  ) {
    const e = failsWith(() => effect([step], writeOnly), "invalid");
    assertEquals(e.op, op);
  }
  // what happened before stands
  failsWith(() =>
    effect([
      { do: "write", node: "log", patches: [{ type: "snapshot", value: 1 }] },
      { do: "read", node: "a", as: "x" },
    ], writeOnly), "invalid");
  assertEquals(log.length, 1);
});

Deno.test("effect: pending is compute only", () => {
  failsWith(() => effect([{ do: "pending" }], fake().api));
});

Deno.test("effect: return ends the effect", () => {
  const { api, log } = fake();
  effect(
    [{ do: "return", value: null }, { do: "make", id: "a", value: 1 }],
    api,
  );
  assertEquals(log, []);
});

Deno.test("compute: handler and cleanup are effect only", () => {
  failsWith(() => compute([{ do: "handler", name: "h", steps: [] }]));
  failsWith(() => compute([{ do: "cleanup", steps: [] }]));
});

// --- handlers ---

Deno.test("handler: registers, makes no change, and runs later with self and input", () => {
  const { api, log } = fake();
  const { handlers } = effect([
    {
      do: "handler",
      name: "type",
      steps: [{
        do: "write",
        node: "doc",
        patches: [{ type: "snapshot", value: [{ $: "self" }, { $: "input" }] }],
      }],
    },
  ], api);
  assertEquals(log, []);
  assertEquals([...handlers.keys()], ["type"]);
  const lasting = fake();
  handlers.get("type")!(lasting.api, "hey");
  assertEquals(lasting.nodes.doc, ["p1", "hey"]);
});

Deno.test("handler: sees only self and input", () => {
  const { handlers } = effect(
    [
      { do: "let", as: "x", value: 1 },
      {
        do: "handler",
        name: "h",
        steps: [{ do: "return", value: { $: "x" } }],
      },
      {
        do: "handler",
        name: "v",
        steps: [{ do: "return", value: { $: "value" } }],
      },
    ],
    fake().api,
    5,
  );
  failsWith(() => handlers.get("h")!(fake().api, null));
  failsWith(() => handlers.get("v")!(fake().api, null));
});

Deno.test("handler: input may be absent", () => {
  const lasting = fake();
  const { handlers } = effect([
    {
      do: "handler",
      name: "h",
      steps: [{
        do: "write",
        node: "doc",
        patches: [{ type: "snapshot", value: { $absent: { $: "input" } } }],
      }],
    },
  ], fake().api);
  handlers.get("h")!(lasting.api, ABSENT);
  assertEquals(lasting.nodes.doc, true);
});

Deno.test("handler: a throw after a write leaves the write", () => {
  const lasting = fake();
  const { handlers } = effect([
    {
      do: "handler",
      name: "boom",
      steps: [
        {
          do: "write",
          node: "doc",
          patches: [{ type: "snapshot", value: "pre" }],
        },
        { do: "throw", message: "bad" },
      ],
    },
  ], fake().api);
  const e = failsWith(() => handlers.get("boom")!(lasting.api, ABSENT));
  assertEquals(e.why, "bad");
  assertEquals(lasting.nodes.doc, "pre");
});

Deno.test("handler: the same name registered twice hands both to the driver, which replaces", () => {
  const { handlers } = effect([
    { do: "handler", name: "h", steps: [{ do: "make", id: "one", value: 1 }] },
    { do: "handler", name: "h", steps: [{ do: "make", id: "two", value: 2 }] },
  ], fake().api);
  const lasting = fake();
  handlers.get("h")!(lasting.api, null);
  assertEquals(lasting.nodes, { two: 2 });
});

Deno.test("handler: pending, handler and cleanup are not allowed in it", () => {
  for (
    const step of [
      { do: "pending" },
      { do: "handler", name: "x", steps: [] },
      { do: "cleanup", steps: [] },
    ] as Json[]
  ) {
    failsWith(() => runHandler([step], { self: "p1", input: null }, fake().api));
  }
});

Deno.test("runHandler: runs steps with the variables given", () => {
  const lasting = fake();
  runHandler(
    [{ do: "make", id: { $: "self" }, value: { $: "input" } }],
    { self: "p9", input: [1] },
    lasting.api,
  );
  assertEquals(lasting.nodes, { p9: [1] });
  runHandler(
    [{ do: "make", id: "m", value: { $: "input" } }],
    new Map<string, Value>([["input", 2]]),
    lasting.api,
  );
  assertEquals(lasting.nodes.m, 2);
  failsWith(() => runHandler("no", {}, lasting.api));
});

// --- cleanup ---

Deno.test("cleanup: registers, and runs later with the effect's variables", () => {
  const { api, log } = fake();
  const { cleanups } = effect([
    { do: "let", as: "id", value: { $concat: [{ $: "self" }, "-view"] } },
    { do: "place", parent: "p1", name: "view", id: { $: "id" } },
    {
      do: "cleanup",
      steps: [{ do: "unplace", parent: "p1", name: "view", id: { $: "id" } }],
    },
    { do: "let", as: "id", value: "changed after" },
  ], api);
  assertEquals(log.length, 1);
  assertEquals(cleanups.length, 1);
  const lasting = fake();
  cleanups[0](lasting.api);
  assertEquals(lasting.log, [["unplace", {
    parent: "p1",
    name: "view",
    id: "p1-view",
  }]]);
});

Deno.test("cleanup: can run twice without its first run showing", () => {
  const { cleanups } = effect([
    { do: "let", as: "n", value: 0 },
    {
      do: "cleanup",
      steps: [
        { do: "let", as: "n", value: { $add: [{ $: "n" }, 1] } },
        { do: "make", id: "c", value: { $: "n" } },
      ],
    },
  ], fake().api);
  const one = fake();
  cleanups[0](one.api);
  cleanups[0](one.api);
  assertEquals(one.nodes.c, 1);
});

Deno.test("cleanup: pending, handler and cleanup are not allowed in it", () => {
  for (
    const step of [
      { do: "pending" },
      { do: "handler", name: "x", steps: [] },
      { do: "cleanup", steps: [] },
    ] as Json[]
  ) {
    const { cleanups } = effect([{ do: "cleanup", steps: [step] }], fake().api);
    failsWith(() => cleanups[0](fake().api));
  }
});

// --- equal ---

Deno.test("equal: the $eq relation", () => {
  assert(equal({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }));
  assert(!equal([1], { 0: 1 }));
  assert(!equal(null, {}));
  assert(equal(0, -0));
  assert(!equal("a", "b"));
});
