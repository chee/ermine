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
} from "./harness/programs.ts";
import { Refused } from "../../graph/typescript/types.ts";

type Op = { [key: string]: Json };

// A fake interface: values and directories by address, and a log of what was asked.
function fake(
  nodes: { [address: string]: Json } = {},
  dirs: { [address: string]: { [name: string]: string[] } } = {},
) {
  const log: Json[] = [];
  const key = (address: Json) =>
    Array.isArray(address) ? address.join("/") : JSON.stringify(address);
  const api: Required<Api> = {
    read(address) {
      log.push(["read", address]);
      const k = key(address);
      return Object.hasOwn(nodes, k) ? [{ value: nodes[k], from: { route: [] } }] : [];
    },
    directory(address, name) {
      log.push(name === undefined ? ["directory", address] : ["directory", address, name]);
      const d = dirs[key(address)];
      const items = (n: string) =>
        (d?.[n] ?? []).map((id, position) => ({ id, from: { route: [], position } }));
      if (name !== undefined) return items(name as string);
      if (!d) return [];
      return Object.keys(d).sort().map((k) => [k, items(k)]);
    },
    lookup(name) {
      log.push(["lookup", name]);
      return (dirs[""]?.[name as string] ?? []).map((id, position) => ({
        id,
        from: { path: [name], position },
      }));
    },
    write(op: Op) {
      log.push(["write", op]);
      nodes[key(op.address)] = (op.patches as { value: Json }[])[0].value;
    },
    place(op: Op) {
      log.push(["place", op]);
      if (op.value !== undefined) {
        nodes[key([...(op.address as string[]), op.name as string])] = op.value;
      }
    },
    unplace(op: Op) {
      log.push(["unplace", op]);
    },
  };
  return { api, log, nodes };
}

function slot(id: string, position: number): Json {
  return { id, from: { route: [], position } };
}

function program(code: Json): Program {
  const p = load(code);
  if (p instanceof ProgramError) throw p;
  return p;
}

function compute(code: Json, api: Api = fake().api, more: {
  self?: string;
  cwd?: Json;
  name?: string;
  changes?: Json;
} = {}) {
  return program(code).compute({
    api,
    self: more.self ?? "p1",
    cwd: more.cwd ?? [],
    name: more.name ?? "p1",
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
    cwd: ["dir"],
    name: "p1",
    value,
    previous,
    handler: (name, fire) => handlers.set(name, fire),
    cleanup: (run) => cleanups.push(run),
  });
  return { handlers, cleanups };
}

/** Runs f, which must throw a ProgramError of the kind, and with the code if given. */
function failsWith(f: () => unknown, code?: string, kind = "thrown"): ProgramError {
  const e = assertThrows(f);
  assertInstanceOf(e, ProgramError);
  assertEquals(e.kind, kind);
  if (code !== undefined) assertEquals(e.why.code, code);
  return e;
}

// --- load ---

Deno.test("load: a list of steps is a program", () => {
  assert(!(load([]) instanceof ProgramError));
  assert(!(load([{ do: "pending" }]) instanceof ProgramError));
});

Deno.test("load: anything else is not a program", () => {
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
      [{ do: "read", address: ["a"] }],
      [{ do: "read", address: ["a"], as: 1 }],
      [{ do: "read", node: "a", as: "x" }],
      [{ do: "make", id: "a", value: 1 }],
      [{ do: "if", test: true, then: "no" }],
      [{ do: "if", test: true, then: [], else: [{ do: "nope" }] }],
      [{ do: "each", list: [], as: "x", steps: [{ do: 1 }] }],
      [{ do: "handler", name: { $: "x" }, steps: [] }],
      [{ do: "try", steps: [] }],
    ] as Json[]
  ) {
    const p = load(v);
    assertInstanceOf(p, ProgramError, JSON.stringify(v));
    assertEquals([p.kind, p.why.code], ["thrown", "not-a-program"]);
  }
});

Deno.test("load: the program is copied, so changing the value later does nothing", () => {
  const code: Json = [{ do: "return", value: 1 }];
  const p = program(code);
  ((code as Json[])[0] as { [k: string]: Json }).value = 2;
  assertEquals(p.compute({ api: {}, self: "p", cwd: [], name: "p", changes: [] }), {
    value: 1,
  });
});

// --- expressions ---

Deno.test("expressions: the scenario's examples", () => {
  assertEquals(ev({ $add: [1, 2, 3.5] }), 6.5);
  assertEquals(ev({ $get: [{ $quote: { a: { b: [10, 20] } } }, "a", "b", 1] }), 20);
  assertEquals(ev({ $missing: { $get: [{ $quote: { a: 1 } }, "z"] } }), true);
  assertEquals(
    ev({ $eq: [{ $quote: { x: 1, y: [1, 2] } }, { $quote: { y: [1, 2], x: 1 } }] }),
    true,
  );
  assertEquals(ev({ $eq: [{ $add: [0.5, 0.5] }, 1] }), true);
  assertEquals(ev({ $eq: [[1, 2], [2, 1]] }), false);
  assertEquals(ev({ $concat: ["a", "b", "😀"] }), "ab😀");
  assertEquals(ev({ $concat: [[1], [2, 3]] }), [1, 2, 3]);
  assertEquals(
    ev([{ $len: "a😀" }, { $len: [1, 2, 3] }, { $len: { $quote: { a: 1, b: 2 } } }]),
    [2, 3, 2],
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
  assertEquals(ev({ $missing: { $get: [[1, 2], 2] } }), true);
  assertEquals(ev({ $missing: { $get: [[1, 2], -1] } }), true);
  assertEquals(ev({ $missing: { $get: [[1, 2], 0.5] } }), true);
  // once missing, the rest of the keys stay missing
  assertEquals(ev({ $missing: { $get: [{}, "a", "b", 1] } }), true);
  // a member that is there but null is not missing
  assertEquals(ev({ $get: [{ a: null }, "a"] }), null);
  // not own properties
  assertEquals(ev({ $missing: { $get: [{}, "toString"] } }), true);
  assertEquals(ev({ $missing: { $get: [{}, "__proto__"] } }), true);
  failsWith(() => ev({ $get: [1, "a"] }), "operator");
  failsWith(() => ev({ $get: [[1], "0"] }), "operator");
  failsWith(() => ev({ $get: [{ a: 1 }, 0] }), "operator");
  failsWith(() => ev({ $get: [] }), "operator");
  failsWith(() => ev({ $get: "a" }), "operator");
});

Deno.test("expressions: $eq compares numbers as Object.is does", () => {
  assertEquals(ev({ $eq: [null, null] }), true);
  assertEquals(ev({ $eq: [null, false] }), false);
  assertEquals(ev({ $eq: [{ $quote: {} }, { $quote: [] }] }), false);
  assertEquals(ev({ $eq: [{ $quote: { a: 1 } }, { $quote: { a: 1, b: 2 } }] }), false);
  assertEquals(ev({ $eq: [{ $quote: { a: 1, b: 2 } }, { $quote: { a: 1, c: 2 } }] }), false);
  assertEquals(ev({ $eq: ["1", 1] }), false);
  failsWith(() => ev({ $eq: [1] }), "operator");
  failsWith(() => ev({ $eq: [1, 2, 3] }), "operator");
});

Deno.test("expressions: wrong kinds throw, with the operator", () => {
  for (
    const [e, op] of [
      [{ $not: 1 }, "$not"],
      [{ $not: null }, "$not"],
      [{ $add: [1, "2"] }, "$add"],
      [{ $add: 1 }, "$add"],
      [{ $concat: ["a", [1]] }, "$concat"],
      [{ $concat: "a" }, "$concat"],
      [{ $len: 1 }, "$len"],
      [{ $len: null }, "$len"],
      [{ $: 1 }, "$"],
      [{ $nope: 1 }, "$nope"],
      [{ $value: 5 }, "$value"],
      [{ $ids: "n1" }, "$ids"],
    ] as [Json, string][]
  ) {
    const err = failsWith(() => ev(e), "operator");
    assertEquals(err.why.operator, op);
  }
});

Deno.test("expressions: every operator but $missing throws on missing", () => {
  const missing = { $get: [{}, "x"] };
  failsWith(() => ev({ $add: [missing, 1] }), "missing-value");
  failsWith(() => ev({ $not: missing }), "missing-value");
  failsWith(() => ev({ $len: missing }), "missing-value");
  failsWith(() => ev({ $eq: [missing, null] }), "missing-value");
  failsWith(() => ev({ $concat: [missing] }), "missing-value");
  failsWith(() => ev({ $get: [missing, "a"] }), "missing-value");
  assertEquals(ev({ $missing: missing }), true);
  assertEquals(ev({ $missing: null }), false);
  // missing is not a value: not inside a list or object, not returned
  failsWith(() => ev([missing]), "missing-value");
  failsWith(() => ev({ a: missing }), "missing-value");
  failsWith(() => ev(missing), "missing-value");
});

Deno.test("expressions: $value and $ids take the items that have one", () => {
  const items: Json = [
    { waiting: [{ node: "a", time: 1 }], from: { process: "p" } },
    { value: 1, from: { route: [] } },
  ];
  assertEquals(ev({ $value: { $quote: items } }), 1);
  assertEquals(ev({ $missing: { $value: [] } }), true);
  assertEquals(ev({ $ids: { $quote: items } }), []);
  assertEquals(ev({ $ids: [{ id: "a" }, { value: 2 }, { id: "b" }] }), ["a", "b"]);
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
  const ctx = { api: {}, self: "p", cwd: [], name: "p", changes: [] };
  const one = p.compute(ctx) as { value: { a: number[] } };
  one.value.a.push(2);
  assertEquals(p.compute(ctx), { value: { a: [1] } });
});

Deno.test("expressions: a __proto__ key is a key", () => {
  const v = ev(JSON.parse('{"__proto__": {"$not": true}}')) as { [k: string]: Json };
  assert(Object.hasOwn(v, "__proto__"));
  assertEquals(Object.getPrototypeOf(v), Object.prototype);
  assertEquals(ev({ $len: JSON.parse('{"__proto__": 1}') }), 1);
});

Deno.test("expressions: unbound variables throw, naming the variable", () => {
  assertEquals(failsWith(() => ev({ $: "nope" }), "unbound").why.name, "nope");
  failsWith(() => ev({ $: "value" }), "unbound"); // an effect's, not a compute's
});

// --- compute ---

Deno.test("compute: variables self, cwd, name, changes", () => {
  const changes = [{ node: "init", time: 6 }];
  assertEquals(
    compute(
      [{
        do: "return",
        value: [{ $: "self" }, { $: "cwd" }, { $: "name" }, { $len: { $: "changes" } }],
      }],
      {},
      { self: "p1", cwd: ["dir"], name: "x", changes },
    ),
    { value: ["p1", ["dir"], "x", 1] },
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
    compute([{ do: "pending" }, { do: "read", address: ["a"], as: "x" }], api),
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

Deno.test("compute: read gives items, none when the address reaches nothing", () => {
  const { api, log } = fake({ a: 5, n: null });
  assertEquals(
    compute([
      { do: "read", address: ["a"], as: "a" },
      { do: "read", address: ["n"], as: "n" },
      { do: "read", address: [{ $concat: ["gh", "ost"] }], as: "g" },
      {
        do: "return",
        value: [
          { $value: { $: "a" } },
          { $value: { $: "n" } },
          { $missing: { $value: { $: "n" } } },
          { $missing: { $value: { $: "g" } } },
          { $: "a" },
          { $: "g" },
        ],
      },
    ], api),
    { value: [5, null, false, true, [{ value: 5, from: { route: [] } }], []] },
  );
  assertEquals(log, [["read", ["a"]], ["read", ["n"]], ["read", ["ghost"]]]);
});

Deno.test("compute: the read-then-pending pattern", () => {
  const code: Json = [
    { do: "read", address: ["a"], as: "x" },
    { do: "if", test: { $missing: { $value: { $: "x" } } }, then: [{ do: "pending" }] },
    { do: "return", value: { $value: { $: "x" } } },
  ];
  assertEquals(compute(code, fake().api), { pending: true });
  assertEquals(compute(code, fake({ a: 5 }).api), { value: 5 });
});

Deno.test("compute: directory, one slot or whole", () => {
  const { api, log } = fake({}, { d: { y: ["n1"], x: ["a", "b"] } });
  assertEquals(
    compute([
      { do: "directory", address: ["d"], name: "x", as: "x" },
      { do: "directory", address: ["d"], name: "gone", as: "g" },
      { do: "directory", address: ["d"], as: "all" },
      { do: "directory", address: ["e"], as: "none" },
      {
        do: "return",
        value: [{ $ids: { $: "x" } }, { $: "g" }, { $: "all" }, { $len: { $: "none" } }, {
          $: "x",
        }],
      },
    ], api),
    {
      value: [
        ["a", "b"],
        [],
        [["x", [slot("a", 0), slot("b", 1)]], ["y", [slot("n1", 0)]]],
        0,
        [slot("a", 0), slot("b", 1)],
      ],
    },
  );
  assertEquals(log, [
    ["directory", ["d"], "x"],
    ["directory", ["d"], "gone"],
    ["directory", ["d"]],
    ["directory", ["e"]],
  ]);
});

Deno.test("compute: a directory name that is missing is left out", () => {
  const { api, log } = fake({}, { d: {} });
  compute([{ do: "directory", address: ["d"], name: { $get: [{}, "x"] }, as: "x" }], api);
  assertEquals(log, [["directory", ["d"]]]);
});

Deno.test("compute: lookup", () => {
  const { api, log } = fake({}, { "": { theme: ["dark"] } });
  assertEquals(
    compute([{ do: "lookup", name: "theme", as: "t" }, { do: "return", value: { $: "t" } }], api),
    { value: [{ id: "dark", from: { path: ["theme"], position: 0 } }] },
  );
  assertEquals(log, [["lookup", "theme"]]);
});

Deno.test("compute: fields are passed as they are; a missing one throws before the operation", () => {
  const { api, log } = fake();
  compute([{ do: "read", address: 1, as: "x" }], api);
  assertEquals(log, [["read", 1]]);
  failsWith(
    () => compute([{ do: "read", address: { $get: [{}, "x"] }, as: "x" }], api),
    "missing-value",
  );
  failsWith(
    () => compute([{ do: "lookup", name: { $get: [{}, "x"] }, as: "x" }], api),
    "missing-value",
  );
  assertEquals(log.length, 1);
});

Deno.test("compute: if needs a boolean, each a list", () => {
  failsWith(() => compute([{ do: "if", test: 1, then: [] }]), "not-boolean");
  failsWith(() => compute([{ do: "each", list: "abc", as: "c", steps: [] }]), "operator");
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
        steps: [{ do: "let", as: "sum", value: { $add: [{ $: "sum" }, { $: "i" }] } }],
      },
      { do: "return", value: [{ $: "sum" }, { $: "i" }] },
    ]),
    { value: [6, 3] },
  );
});

Deno.test("compute: let may hold missing", () => {
  assertEquals(
    compute([
      { do: "let", as: "x", value: { $get: [{}, "a"] } },
      { do: "return", value: { $missing: { $: "x" } } },
    ]),
    { value: true },
  );
});

Deno.test("compute: a write through an interface without writes is invalid", () => {
  const { api } = fake();
  const readOnly: Api = { read: api.read, directory: api.directory, lookup: api.lookup };
  const e = failsWith(
    () => compute([{ do: "write", address: ["a"], patches: [] }], readOnly),
    "read-only",
    "invalid",
  );
  assertEquals(e.op, "write");
  assertEquals(errorJson(e), { kind: "invalid", op: "write", why: e.why } as unknown as Json);
});

// --- throw and try ---

Deno.test("throw: an uncaught throw ends the part", () => {
  const e = failsWith(() => compute([{ do: "throw", message: "boom" }]), "thrown");
  assertEquals(e.why.message, "boom");
  assertEquals(errorJson(e), { kind: "thrown", why: e.why } as unknown as Json);
  const f = failsWith(() => compute([{ do: "throw", message: { a: [1] } }]), "thrown");
  assertEquals(f.why.message, { a: [1] });
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
      { do: "try", steps: [{ do: "throw", message: "boom" }, { do: "return", value: 1 }], as: "e" },
      {
        do: "return",
        value: [{ $not: { $eq: [{ $: "e" }, null] } }, { $get: [{ $: "e" }, "why", "code"] }],
      },
    ]),
    { value: [true, "thrown"] },
  );
});

Deno.test("try: catches operator errors", () => {
  const out = compute([
    { do: "try", steps: [{ do: "return", value: { $not: 1 } }], as: "e" },
    {
      do: "return",
      value: [{ $get: [{ $: "e" }, "kind"] }, { $get: [{ $: "e" }, "why", "code"] }],
    },
  ]);
  assertEquals(out, { value: ["thrown", "operator"] });
});

Deno.test("try: catches an operation's error as {kind, op, why}", () => {
  const api: Api = {
    read() {
      throw new Refused({ code: "rule", rule: 0 }, "read");
    },
  };
  assertEquals(
    compute([
      { do: "try", steps: [{ do: "read", address: ["secret"], as: "x" }], as: "e" },
      { do: "return", value: { $: "e" } },
    ], api),
    { value: { kind: "refused", op: "read", why: { code: "rule", rule: 0 } } },
  );
});

Deno.test("try: an uncaught operation error passes as it is", () => {
  const thrown = new Refused({ code: "rule" }, "read");
  const api: Api = {
    read() {
      throw thrown;
    },
  };
  const e = assertThrows(() => compute([{ do: "read", address: ["a"], as: "x" }], api));
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
    compute([{ do: "try", steps: [{ do: "pending" }], as: "e" }, { do: "return", value: 2 }]),
    { pending: true },
  );
});

Deno.test("errorJson: other things thrown", () => {
  assertEquals(errorJson(new Error("x")), {
    kind: "thrown",
    why: { code: "thrown", message: "x", text: "x" },
  });
  assertEquals(errorJson("x"), {
    kind: "thrown",
    why: { code: "thrown", message: "x", text: "x" },
  });
});

// --- effect ---

Deno.test("effect: variables self, cwd, name, value, previous", () => {
  const { api, nodes } = fake();
  const code: Json = [{
    do: "write",
    address: ["seen"],
    patches: [{
      type: "snapshot",
      value: {
        self: { $: "self" },
        at: [{ $: "cwd" }, { $: "name" }],
        v: { $: "value" },
        first: { $missing: { $: "previous" } },
      },
    }],
  }];
  effect(code, api, 1);
  assertEquals(nodes.seen, { self: "p1", at: [["dir"], "p1"], v: 1, first: true });
  effect(code, api, 2, 1);
  assertEquals(nodes.seen, { self: "p1", at: [["dir"], "p1"], v: 2, first: false });
  // a compute's variables are not there
  failsWith(() => effect([{ do: "let", as: "x", value: { $: "changes" } }], api), "unbound");
});

Deno.test("effect: write, place and unplace pass their fields, leaving missing ones out", () => {
  const { api, log } = fake();
  effect(
    [
      { do: "place", address: [{ $: "name" }], name: "n", id: "n", value: { a: { $: "value" } } },
      {
        do: "write",
        address: ["n"],
        patches: [{ type: "snapshot", value: 2 }],
        cause: { why: "x" },
      },
      { do: "place", address: [], name: "kid", id: "m", position: 0, cause: "c" },
      { do: "place", address: [], name: "kid", id: "o", value: { $get: [{}, "no"] } },
      { do: "unplace", address: [], name: "kid", id: "m", cause: { $get: [{}, "no"] } },
    ],
    api,
    7,
  );
  assertEquals(log, [
    ["place", { address: ["p1"], name: "n", id: "n", value: { a: 7 } }],
    ["write", { address: ["n"], patches: [{ type: "snapshot", value: 2 }], cause: { why: "x" } }],
    ["place", { address: [], name: "kid", id: "m", position: 0, cause: "c" }],
    ["place", { address: [], name: "kid", id: "o" }],
    ["unplace", { address: [], name: "kid", id: "m" }],
  ]);
});

Deno.test("effect: a needed field that is missing throws before the operation", () => {
  const { api, log } = fake();
  failsWith(
    () => effect([{ do: "place", address: [], name: "a", id: { $get: [{}, "x"] } }], api),
    "missing-value",
  );
  failsWith(
    () => effect([{ do: "write", address: ["a"], patches: { $get: [{}, "x"] } }], api),
    "missing-value",
  );
  assertEquals(log, []);
});

Deno.test("effect: read, directory and lookup are invalid through a write-only interface", () => {
  const { api, log } = fake({ a: 1 }, { d: {} });
  const writeOnly: Api = { write: api.write, place: api.place, unplace: api.unplace };
  for (
    const [step, op] of [
      [{ do: "read", address: ["a"], as: "x" }, "read"],
      [{ do: "directory", address: ["d"], as: "x" }, "directory"],
      [{ do: "lookup", name: "t", as: "x" }, "lookup"],
    ] as [Json, string][]
  ) {
    const e = failsWith(() => effect([step], writeOnly), "write-only", "invalid");
    assertEquals(e.op, op);
  }
  // what happened before stands
  failsWith(
    () =>
      effect([
        { do: "write", address: ["log"], patches: [{ type: "snapshot", value: 1 }] },
        { do: "read", address: ["a"], as: "x" },
      ], writeOnly),
    "write-only",
    "invalid",
  );
  assertEquals(log.length, 1);
});

Deno.test("effect: pending is compute only", () => {
  failsWith(() => effect([{ do: "pending" }], fake().api), "wrong-part");
});

Deno.test("effect: return ends the effect", () => {
  const { api, log } = fake();
  effect([{ do: "return", value: null }, {
    do: "place",
    address: [],
    name: "a",
    id: "a",
    value: 1,
  }], api);
  assertEquals(log, []);
});

Deno.test("compute: handler and cleanup are effect only", () => {
  failsWith(() => compute([{ do: "handler", name: "h", steps: [] }]), "wrong-part");
  failsWith(() => compute([{ do: "cleanup", steps: [] }]), "wrong-part");
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
        address: ["doc"],
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
      { do: "handler", name: "h", steps: [{ do: "return", value: { $: "x" } }] },
      { do: "handler", name: "v", steps: [{ do: "return", value: { $: "value" } }] },
    ],
    fake().api,
    5,
  );
  failsWith(() => handlers.get("h")!(fake().api, null), "unbound");
  failsWith(() => handlers.get("v")!(fake().api, null), "unbound");
});

Deno.test("handler: input may be missing", () => {
  const lasting = fake();
  const { handlers } = effect([
    {
      do: "handler",
      name: "h",
      steps: [{
        do: "write",
        address: ["doc"],
        patches: [{ type: "snapshot", value: { $missing: { $: "input" } } }],
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
        { do: "write", address: ["doc"], patches: [{ type: "snapshot", value: "pre" }] },
        { do: "throw", message: "bad" },
      ],
    },
  ], fake().api);
  const e = failsWith(() => handlers.get("boom")!(lasting.api, ABSENT), "thrown");
  assertEquals(e.why.message, "bad");
  assertEquals(lasting.nodes.doc, "pre");
});

Deno.test("handler: the same name registered twice hands both to the driver, which replaces", () => {
  const { handlers } = effect([
    {
      do: "handler",
      name: "h",
      steps: [{ do: "place", address: [], name: "one", id: "one", value: 1 }],
    },
    {
      do: "handler",
      name: "h",
      steps: [{ do: "place", address: [], name: "two", id: "two", value: 2 }],
    },
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
    failsWith(() => runHandler([step], { self: "p1", input: null }, fake().api), "wrong-part");
  }
});

Deno.test("runHandler: runs steps with the variables given", () => {
  const lasting = fake();
  runHandler(
    [{ do: "place", address: [], name: { $: "self" }, id: { $: "self" }, value: { $: "input" } }],
    { self: "p9", input: [1] },
    lasting.api,
  );
  assertEquals(lasting.nodes, { p9: [1] });
  runHandler(
    [{ do: "place", address: [], name: "m", id: "m", value: { $: "input" } }],
    new Map<string, Value>([["input", 2]]),
    lasting.api,
  );
  assertEquals(lasting.nodes.m, 2);
  failsWith(() => runHandler("no", {}, lasting.api), "not-a-program");
});

// --- cleanup ---

Deno.test("cleanup: registers, and runs later with the effect's variables", () => {
  const { api, log } = fake();
  const { cleanups } = effect([
    { do: "let", as: "id", value: { $concat: [{ $: "self" }, "-view"] } },
    { do: "place", address: [{ $: "name" }], name: "view", id: { $: "id" } },
    {
      do: "cleanup",
      steps: [{ do: "unplace", address: [{ $: "name" }], name: "view", id: { $: "id" } }],
    },
    { do: "let", as: "id", value: "changed after" },
  ], api);
  assertEquals(log.length, 1);
  assertEquals(cleanups.length, 1);
  const lasting = fake();
  cleanups[0](lasting.api);
  assertEquals(lasting.log, [["unplace", { address: ["p1"], name: "view", id: "p1-view" }]]);
});

Deno.test("cleanup: can run twice without its first run showing", () => {
  const { cleanups } = effect([
    { do: "let", as: "n", value: 0 },
    {
      do: "cleanup",
      steps: [
        { do: "let", as: "n", value: { $add: [{ $: "n" }, 1] } },
        { do: "place", address: [], name: "c", id: "c", value: { $: "n" } },
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
    failsWith(() => cleanups[0](fake().api), "wrong-part");
  }
});

// --- equal ---

Deno.test("equal: the $eq relation", () => {
  assert(equal({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }));
  assert(!equal([1], { 0: 1 }));
  assert(!equal(null, {}));
  assert(!equal(0, -0), "numbers as Object.is compares them");
  assert(equal(NaN, NaN));
  assert(!equal("a", "b"));
});
