// The driver as a library, with programs written in JS: what the scenarios
// cannot reach, such as interfaces that stop working and wrappers above it.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { type Compute, drive, type Driver, type Effect, type Load, PENDING } from "../src/drive.ts";
import { graph } from "../src/graph.ts";
import { protect, subject } from "../src/protect.ts";
import { type Interface, Invalid, type Json, type Recording, Refused } from "../src/types.ts";

const site = { file: "drive_test.ts", line: 1, column: 1 };
const host = { agent: "host", cause: site };

/** A loader whose program nodes hold a name from a table of JS parts. */
function table(parts: { [name: string]: Compute | Effect }): Load {
  return ((code: Json) => {
    const part = typeof code === "string" ? parts[code] : undefined;
    if (!part) throw new Error(`no program ${JSON.stringify(code)}`);
    return part;
  }) as Load;
}

/** The value of what a read reached, if it reached anything. */
function first(items: { value: Json }[]): Json | typeof PENDING {
  return items.length ? items[0].value : PENDING;
}

/**
 * A driver over the api (a bare graph by default), with a node a, programs
 * show and eff, and a node p, not yet a process: start() places show in its
 * compute slot.
 */
function setup(show: Compute, eff?: Effect, api: Interface = graph("init")) {
  const d = drive(api, "init", table(eff ? { show, eff } : { show }));
  d.place({ ...host, address: [], name: "a", id: "a", value: 1 });
  d.place({ ...host, address: [], name: "show", id: "show", value: "show" });
  d.place({ ...host, address: [], name: "p", id: "p", value: null });
  if (eff) {
    d.place({ ...host, address: [], name: "eff", id: "eff", value: "eff" });
    d.place({ ...host, address: ["p"], name: "effect", id: "eff" });
  }
  return d;
}

const show: Compute = ({ api }) => first(api.read({ address: ["a"] }));

function start(d: Driver) {
  return d.place({ ...host, address: ["p"], name: "compute", id: "show" });
}

Deno.test("drive gives each change the next time, and runs what a write marked", () => {
  const d = setup(show);
  const started = start(d);
  assertEquals(started.change.time, 4);
  assertEquals(started.runs.map((r) => [r.run, r.value, r.changes]), [
    [1, 1, [{ node: "p", time: 5 }]],
  ]);
  const written = d.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 2 }] });
  assertEquals(written.change.time, 6);
  assertEquals(written.runs.map((r) => r.value), [2]);
  assertEquals(d.read({ agent: "host", address: ["p"] }).map((i) => i.value), [2]);
});

Deno.test("a process runs where the walk reached it: its cwd and name", () => {
  const seen: [readonly string[], string][] = [];
  const where: Compute = ({ cwd, name }) => (seen.push([cwd, name]), null);
  const d = drive(graph("init"), "init", table({ show: where }));
  d.place({ ...host, address: [], name: "dir", id: "dir", value: null });
  d.place({ ...host, address: ["dir"], name: "x", id: "p", value: null });
  d.place({ ...host, address: [], name: "show", id: "show", value: "show" });
  d.place({ ...host, address: ["dir", "x"], name: "compute", id: "show" });
  assertEquals(seen, [[["dir"], "x"]]);
});

Deno.test("a compute that returns PENDING leaves the value, and runs when the node is made", () => {
  const d = drive(graph("init"), "init", table({ show }));
  d.place({ ...host, address: [], name: "show", id: "show", value: "show" });
  d.place({ ...host, address: [], name: "p", id: "p", value: null });
  assertEquals(start(d).runs.map((r) => [r.ending, "value" in r]), [["pending", false]]);
  const made = d.place({ ...host, address: [], name: "a", id: "a", value: 5 });
  assertEquals(made.runs.map((r) => [r.ending, r.value]), [["done", 5]]);
});

Deno.test("a compute's interface stops working when the compute returns", () => {
  let kept: Interface | undefined;
  const d = setup((ctx) => {
    kept = ctx.api;
    return show(ctx);
  });
  start(d);
  assertThrows(() => kept!.read({ address: ["a"] }), Invalid);
});

Deno.test("an effect's cleanup runs before its next effect and when the process stops", () => {
  const log: string[] = [];
  const d = setup(show, ({ api, value }) => {
    log.push(`effect ${value}`);
    api.write({ address: ["log"], patches: [{ type: "snapshot", value }] });
    return () => void log.push(`cleanup ${value}`);
  });
  d.place({ ...host, address: [], name: "log", id: "log", value: null });
  start(d);
  d.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 2 }] });
  const stopped = d.unplace({ ...host, address: [], name: "p", id: "p" });
  assertEquals(log, ["effect 1", "cleanup 1", "effect 2", "cleanup 2"]);
  assertEquals(stopped.stopped.map((s) => s.process), ["p"]);
});

Deno.test("the lasting interface works until the process stops; the effect's does not", () => {
  let effectApi: Interface | undefined;
  let lasting: Interface | undefined;
  const d = setup(show, (ctx) => {
    effectApi = ctx.api;
    lasting = ctx.lasting;
    ctx.handler("set", (input) => {
      ctx.lasting.write({ address: ["b"], patches: [{ type: "snapshot", value: input ?? null }] });
    });
  });
  d.place({ ...host, address: [], name: "b", id: "b", value: null });
  start(d);
  assertThrows(() => effectApi!.write({ address: ["b"], patches: [] }), Invalid);
  const fired = d.fire({ agent: "host", process: "p", handler: "set", input: "hey" });
  assertEquals(fired.changes.map((c) => [c.node, c.agent, c.process]), [["b", "host", "p"]]);
  assert(!("error" in fired));
  assertEquals(d.read({ agent: "host", address: ["b"] }).map((i) => i.value), ["hey"]);
  d.unplace({ ...host, address: [], name: "p", id: "p" });
  assertThrows(() => lasting!.write({ address: ["b"], patches: [] }), Invalid);
  assertThrows(() => d.fire({ agent: "host", process: "p", handler: "set" }), Invalid);
});

Deno.test("a handler acts as the agent of the fire; the lasting interface otherwise as the process's", () => {
  let lasting: Interface | undefined;
  const d = setup(show, (ctx) => {
    lasting = ctx.lasting;
    ctx.handler("set", (input) => {
      ctx.lasting.write({ address: ["b"], patches: [{ type: "snapshot", value: input ?? null }] });
    });
  });
  d.place({ ...host, address: [], name: "b", id: "b", value: null });
  start(d);
  const fired = d.fire({ agent: "alice", process: "p", handler: "set", input: "hey" });
  assertEquals(fired.changes.map((c) => [c.node, c.agent, c.process]), [["b", "alice", "p"]]);
  // the same interface, called later from outside any handler call, as a timer would
  const later = lasting!.write({ address: ["b"], patches: [{ type: "snapshot", value: "tick" }] });
  assertEquals([later.change.agent, later.change.process], ["host", "p"]);
});

Deno.test("protect asks about a handler's operations as the agent that fired it", () => {
  const may = (agent: Json, _process: unknown, op: string, args: object) =>
    !(agent === "alice" && op === "write" && subject(op, args) === "b");
  const d = setup(show, (ctx) => {
    ctx.handler("set", () => {
      ctx.lasting.write({ address: ["b"], patches: [{ type: "snapshot", value: 1 }] });
    });
  }, protect(graph("init"), may));
  d.place({ ...host, address: [], name: "b", id: "b", value: null });
  start(d);
  assert(d.fire({ agent: "alice", process: "p", handler: "set" }).error instanceof Refused);
  assert(!("error" in d.fire({ agent: "host", process: "p", handler: "set" })));
});

Deno.test("protect is asked before every operation a run makes, as its process", () => {
  const asked: string[] = [];
  const d = setup(
    show,
    undefined,
    protect(graph("init"), (_agent, process, op, args) => {
      if (process === "p") asked.push(`${op} ${subject(op, args)}`);
      return true;
    }),
  );
  start(d);
  // binding the lasting and reading interfaces, recording the run, the program
  // slot and node, the effect slot, the compute's read, the driver's write of
  // the value, and finishing the run
  assertEquals(asked, [
    "bind undefined",
    "bind undefined",
    "record undefined",
    "directory p",
    "read show",
    "directory p",
    "read a",
    "bind undefined",
    "write p",
    "finish undefined",
  ]);
});

Deno.test("a wrapper above drive, once told the top, sees what a run does", () => {
  const seen: string[] = [];
  const below = setup(show);
  const above: Interface = { ...below };
  for (const op of ["read", "directory", "write"] as const) {
    // deno-lint-ignore no-explicit-any
    (above as any)[op] = (args: any) => {
      if (args.process === "p") seen.push(`${op} ${JSON.stringify(args.address)}`);
      // deno-lint-ignore no-explicit-any
      return (below as any)[op](args);
    };
  }
  above.top = (api) => below.top(api);
  below.top(above);
  (above as Driver).place({ ...host, address: ["p"], name: "compute", id: "show" });
  assertEquals(seen, [
    'directory ["p"]',
    'read ["p","compute"]',
    'directory ["p"]',
    'read ["a"]',
    'write ["p"]',
  ]);
});

Deno.test("batch runs what its changes marked once, after the last, even when it throws", () => {
  const d = setup(show);
  start(d);
  let settled;
  assertThrows(() => {
    settled = d.batch(() => {
      d.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 2 }] });
      d.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 3 }] });
      d.write({ ...host, address: ["ghost"], patches: [] });
    });
  }, Invalid);
  assertEquals(settled, undefined);
  assertEquals(d.read({ agent: "host", address: ["p"] }).map((i) => i.value), [3]);
  const runs = d.batch(() => {
    d.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 4 }] });
    d.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 5 }] });
  }).runs;
  assertEquals(runs.map((r) => [r.marked.length, r.value]), [[2, 5]]);
});

Deno.test("drive passes on operations it does not know", () => {
  const below = { ...graph("init"), hello: () => "hi" };
  const d = drive(below, "init", table({})) as Driver & { hello(): string };
  assertEquals(d.hello(), "hi");
});

Deno.test("in a batch, a change's answer has what it stopped; the batch's, what stopped after", () => {
  const d = setup(show);
  start(d);
  const answers: string[][] = [];
  const settled = d.batch(() => {
    const a = d.unplace({ ...host, address: [], name: "p", id: "p" });
    answers.push(a.stopped.map((s) => s.process), a.runs.map((r) => r.process));
  });
  assertEquals(answers, [["p"], []]);
  assertEquals(settled, { runs: [], stopped: [] });
});

Deno.test("a process stopped by another's cleanup comes after it", () => {
  const d = setup(show, ({ lasting }) => () => {
    lasting.unplace({ address: [], name: "q", id: "q" });
  });
  d.place({ ...host, address: [], name: "q", id: "q", value: null });
  d.place({ ...host, address: ["q"], name: "compute", id: "show" });
  start(d);
  const stopped = d.unplace({ ...host, address: [], name: "p", id: "p" }).stopped;
  assertEquals(stopped.map((s) => [s.process, s.changes.map((c) => c.kind)]), [
    ["p", ["unplace"]],
    ["q", []],
  ]);
});

Deno.test("a refused read of a program node is in the record, and the run is refused", () => {
  const d = setup(
    show,
    undefined,
    protect(
      graph("init"),
      (_agent, process, op, args) =>
        !(process === "p" && op === "read" && subject(op, args) === "show"),
    ),
  );
  const [run] = start(d).runs;
  assertEquals(run.compute, { node: "show", refused: true, slot: ["show"] });
  assertEquals(run.ending, "refused");
  assertEquals(run.errors.map((e) => [e.kind, e.op, e.why.code]), [["refused", "read", "rule"]]);
});

Deno.test("a process the walk reaches at another place keeps running there", () => {
  const seen: string[] = [];
  const where: Compute = ({ cwd, name }) => (seen.push([...cwd, name].join("/")), null);
  const d = drive(graph("init"), "init", table({ show: where }));
  d.place({ ...host, address: [], name: "d1", id: "d1", value: null });
  d.place({ ...host, address: [], name: "d2", id: "d2", value: null });
  d.place({ ...host, address: [], name: "show", id: "show", value: "show" });
  d.place({ ...host, address: ["d1"], name: "x", id: "p", value: null });
  d.place({ ...host, address: ["d1", "x"], name: "compute", id: "show" });
  d.place({ ...host, address: ["d2"], name: "y", id: "p" });
  const moved = d.unplace({ ...host, address: ["d1"], name: "x", id: "p" });
  assertEquals(moved.stopped, []);
  assertEquals(seen, ["d1/x", "d2/y"]);
});

Deno.test("a process a cleanup makes reachable is marked by the change that made it so", () => {
  const d = setup(show, ({ lasting }) => () => {
    lasting.write({ address: ["log"], patches: [{ type: "snapshot", value: "bye" }] });
    lasting.place({ address: [], name: "x", id: "x" });
  });
  d.place({ ...host, address: [], name: "log", id: "log", value: null });
  // x is made and given its program, then taken out, so it starts when placed again
  d.place({ ...host, address: [], name: "x", id: "x", value: null });
  d.place({ ...host, address: ["x"], name: "compute", id: "show" });
  d.unplace({ ...host, address: [], name: "x", id: "x" });
  start(d);
  const answer = d.unplace({ ...host, address: [], name: "p", id: "p" });
  const [, placed] = answer.stopped[0].changes;
  assertEquals(placed.kind, "place");
  const run = answer.runs.find((r) => r.process === "x")!;
  assertEquals(run.marked, [{ node: "init", time: placed.time }]);
});

Deno.test("an effect raises a process whose compute read the program node it changed", () => {
  const order: string[] = [];
  const d = drive(
    graph("init"),
    "init",
    table({
      ca: () => 1,
      ea: (({ api }) => {
        api.write({ address: ["m"], patches: [{ type: "snapshot", value: 1 }] });
        api.write({ address: ["cb"], patches: [{ type: "snapshot", value: "cb2" }] });
      }) as Effect,
      cb: () => (order.push("b"), "b"),
      cb2: () => (order.push("b"), "b"),
      cc: (({ api }) => (order.push("c"), api.read({ address: ["m"] }), "c")) as Compute,
    }),
  );
  d.place({ ...host, address: [], name: "m", id: "m", value: 0 });
  for (const code of ["ca", "ea", "cb", "cc"]) {
    d.place({ ...host, address: [], name: code, id: code, value: code });
  }
  d.batch(() => {
    for (const [p, compute, effect] of [["a", "ca", "ea"], ["b", "cb"], ["c", "cc"]]) {
      d.place({ ...host, address: [], name: p, id: p, value: null });
      if (effect) d.place({ ...host, address: [p], name: "effect", id: effect });
      d.place({ ...host, address: [p], name: "compute", id: compute });
    }
  });
  // b and c are both above a now; c's first mark, m, is older than b's, cb
  assertEquals(order, ["b", "c", "c", "b"]);
});

Deno.test("under drive, a change a subscriber makes takes the next time, and is learned after", () => {
  const d = setup(() => ({ n: 1, seen: true }));
  const times: number[] = [];
  d.subscribe({
    agent: "host",
    address: ["p"],
    send: (e) => {
      if (!("change" in e) || e.change.agent !== "host" || e.change.kind !== "write") return;
      const patches = [{ type: "set" as const, path: [], key: "seen", value: true }];
      times.push(d.write({ agent: "watcher", cause: site, address: ["p"], patches }).change.time);
    },
  });
  const written = d.write({
    ...host,
    address: ["p"],
    patches: [{ type: "snapshot", value: { n: 1 } }],
  });
  assertEquals([written.change.time, times], [4, [5]]);
  assertEquals(d.read({ agent: "host", address: ["p"] }).map((i) => i.value), [{
    n: 1,
    seen: true,
  }]);
  // the driver learned both, in order, so the compute's equal value is not written
  assertEquals(start(d).runs.map((r) => r.changes), [[]]);
});

Deno.test("the driver is told the top once", () => {
  const d = setup(show);
  d.top(d);
  assertThrows(() => d.top({ ...d }), Invalid);
  assertEquals(start(d).runs.map((r) => r.value), [1]);
});

Deno.test("a caught refusal, and a fire's error, name the operation", () => {
  const caught: unknown[] = [];
  const d = setup(
    show,
    ({ api, lasting, handler }) => {
      try {
        api.write({ address: ["locked"], patches: [] });
      } catch (e) {
        caught.push([(e as Refused).kind, (e as Refused).op]);
      }
      handler("careless", () => void lasting.write({ address: ["locked"], patches: [] }));
    },
    protect(
      graph("init"),
      (_agent, process, op, args) =>
        !(process === "p" && op === "write" && subject(op, args) === "locked"),
    ),
  );
  d.place({ ...host, address: [], name: "locked", id: "locked", value: 0 });
  start(d);
  assertEquals(caught, [["refused", "write"]]);
  const fired = d.fire({ agent: "host", process: "p", handler: "careless" });
  const error = fired.error as Refused;
  assertEquals([error.kind, error.op], ["refused", "write"]);
});

Deno.test("a run cannot record or finish runs, and trying spoils its value", () => {
  const d = setup((ctx) => {
    try {
      ctx.api.finish(ctx.api as Recording, "done");
    } catch {
      // caught, and still in the record
    }
    return show(ctx);
  });
  const [run] = start(d).runs;
  assertEquals([run.ending, run.errors.map((e) => [e.kind, e.op])], ["failed", [[
    "invalid",
    "finish",
  ]]]);
});

Deno.test("a fire on what is not running, or a handler it does not have, is invalid with a code", () => {
  const d = setup(show);
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Invalid).why.code;
    }
  };
  assertEquals(
    code(() => d.fire({ agent: "host", process: "p", handler: "h" })),
    "unknown-process",
  );
  start(d);
  assertEquals(
    code(() => d.fire({ agent: "host", process: "p", handler: "h" })),
    "unknown-handler",
  );
});
