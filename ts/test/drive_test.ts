// The driver as a library, with programs written in JS: what the scenarios
// cannot reach, such as interfaces that stop working and wrappers above it.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { type Compute, drive, type Driver, type Effect, type Load, PENDING } from "../src/drive.ts";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { type Interface, Invalid, type Json, type Recording, Refused } from "../src/types.ts";

const site = { file: "drive_test.ts", line: 1, column: 1 };
const host = { agent: "host", site };

/** A loader whose program nodes hold a name from a table of JS parts. */
function table(parts: { [name: string]: Compute | Effect }): Load {
  return ((code: Json) => {
    const part = typeof code === "string" ? parts[code] : undefined;
    if (!part) throw new Error(`no program ${JSON.stringify(code)}`);
    return part;
  }) as Load;
}

/**
 * A driver over the api (a bare graph by default), with a root, a node a, and
 * a process p, not yet started, whose compute is show and effect is eff.
 */
function setup(show: Compute, eff?: Effect, api: Interface = graph()) {
  const d = drive(api, "init", table(eff ? { show, eff } : { show }));
  d.make({ ...host, id: "init", value: {} });
  d.make({ ...host, id: "a", value: 1 });
  d.make({ ...host, id: "show", value: "show" });
  d.make({ ...host, id: "p", value: null, data: { path: [] } });
  d.place({ ...host, parent: "p", name: "compute", id: "show" });
  if (eff) {
    d.make({ ...host, id: "eff", value: "eff" });
    d.place({ ...host, parent: "p", name: "effect", id: "eff" });
  }
  return d;
}

const show: Compute = ({ api }) => {
  const r = api.read({ node: "a" });
  return "value" in r ? r.value : PENDING;
};

function start(d: Driver) {
  return d.place({ ...host, parent: "init", name: "p", id: "p" });
}

Deno.test("drive gives each change the next time, and runs what a write marked", () => {
  const d = setup(show);
  const started = start(d);
  assertEquals(started.change.time, 6);
  assertEquals(started.runs.map((r) => [r.run, r.value, r.changes]), [
    [1, 1, [{ node: "p", time: 7 }]],
  ]);
  const written = d.write({ ...host, node: "a", patches: [{ type: "snapshot", value: 2 }] });
  assertEquals(written.change.time, 8);
  assertEquals(written.runs.map((r) => r.value), [2]);
  assertEquals(d.read({ agent: "host", node: "p" }), { value: 2 });
});

Deno.test("a compute that returns PENDING leaves the value, and runs when the node is made", () => {
  const d = drive(graph(), "init", table({ show }));
  d.make({ ...host, id: "init", value: {} });
  d.make({ ...host, id: "show", value: "show" });
  d.make({ ...host, id: "p", value: null, data: { path: [] } });
  d.place({ ...host, parent: "p", name: "compute", id: "show" });
  assertEquals(start(d).runs.map((r) => [r.ending, "value" in r]), [["pending", false]]);
  const made = d.make({ ...host, id: "a", value: 5 });
  assertEquals(made.runs.map((r) => [r.ending, r.value]), [["done", 5]]);
});

Deno.test("a compute's interface stops working when the compute returns", () => {
  let kept: Interface | undefined;
  const d = setup((ctx) => {
    kept = ctx.api;
    return show(ctx);
  });
  start(d);
  assertThrows(() => kept!.read({ node: "a" }), Invalid);
});

Deno.test("an effect's cleanup runs before its next effect and when the process stops", () => {
  const log: string[] = [];
  const d = setup(show, ({ api, value }) => {
    log.push(`effect ${value}`);
    api.write({ node: "log", patches: [{ type: "snapshot", value }] });
    return () => void log.push(`cleanup ${value}`);
  });
  d.make({ ...host, id: "log", value: null });
  start(d);
  d.write({ ...host, node: "a", patches: [{ type: "snapshot", value: 2 }] });
  const stopped = d.unplace({ ...host, parent: "init", name: "p", id: "p" });
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
      ctx.lasting.write({ node: "b", patches: [{ type: "snapshot", value: input ?? null }] });
    });
  });
  d.make({ ...host, id: "b", value: null });
  start(d);
  assertThrows(() => effectApi!.write({ node: "b", patches: [] }), Invalid);
  const fired = d.fire({ agent: "host", process: "p", handler: "set", input: "hey" });
  assertEquals(fired.changes.map((c) => [c.node, c.agent, c.process]), [["b", "host", "p"]]);
  assert(!("error" in fired));
  assertEquals(d.read({ agent: "host", node: "b" }), { value: "hey" });
  d.unplace({ ...host, parent: "init", name: "p", id: "p" });
  assertThrows(() => lasting!.write({ node: "b", patches: [] }), Invalid);
  assertThrows(() => d.fire({ agent: "host", process: "p", handler: "set" }), Invalid);
});

Deno.test("protect is asked before every operation a run makes, as its process", () => {
  const asked: string[] = [];
  const d = setup(
    show,
    undefined,
    protect(graph(), (_agent, process, op, args) => {
      if (process === "p") asked.push(`${op} ${(args as { node?: string }).node}`);
      return true;
    }),
  );
  start(d);
  // binding the lasting and reading interfaces, recording the run, the program
  // slots and nodes, the compute's read, the driver's write of the value, and
  // finishing the run
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
      if (args.process === "p") seen.push(`${op} ${args.node}`);
      // deno-lint-ignore no-explicit-any
      return (below as any)[op](args);
    };
  }
  above.top = (api) => below.top(api);
  below.top(above);
  (above as Driver).place({ ...host, parent: "init", name: "p", id: "p" });
  assertEquals(seen, ["directory p", "read show", "directory p", "read a", "write p"]);
});

Deno.test("batch runs what its changes marked once, after the last, even when it throws", () => {
  const d = setup(show);
  start(d);
  let settled;
  assertThrows(() => {
    settled = d.batch(() => {
      d.write({ ...host, node: "a", patches: [{ type: "snapshot", value: 2 }] });
      d.write({ ...host, node: "a", patches: [{ type: "snapshot", value: 3 }] });
      d.write({ ...host, node: "ghost", patches: [] });
    });
  }, Invalid);
  assertEquals(settled, undefined);
  assertEquals(d.read({ agent: "host", node: "p" }), { value: 3 });
  const runs = d.batch(() => {
    d.write({ ...host, node: "a", patches: [{ type: "snapshot", value: 4 }] });
    d.write({ ...host, node: "a", patches: [{ type: "snapshot", value: 5 }] });
  }).runs;
  assertEquals(runs.map((r) => [r.marked.length, r.value]), [[2, 5]]);
});

Deno.test("drive passes on operations it does not know", () => {
  const below = { ...graph(), hello: () => "hi" };
  const d = drive(below, "init", table({})) as Driver & { hello(): string };
  assertEquals(d.hello(), "hi");
});

Deno.test("in a batch, a change's answer has what it stopped; the batch's, what stopped after", () => {
  const d = setup(show);
  start(d);
  const answers: string[][] = [];
  const settled = d.batch(() => {
    const a = d.unplace({ ...host, parent: "init", name: "p", id: "p" });
    answers.push(a.stopped.map((s) => s.process), a.runs.map((r) => r.process));
  });
  assertEquals(answers, [["p"], []]);
  assertEquals(settled, { runs: [], stopped: [] });
});

Deno.test("a process stopped by another's cleanup comes after it", () => {
  const d = setup(show, ({ lasting }) => () => {
    lasting.unplace({ parent: "init", name: "q", id: "q" });
  });
  d.make({ ...host, id: "q", value: null, data: { path: [] } });
  d.place({ ...host, parent: "q", name: "compute", id: "show" });
  d.place({ ...host, parent: "init", name: "q", id: "q" });
  start(d);
  const stopped = d.unplace({ ...host, parent: "init", name: "p", id: "p" }).stopped;
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
      graph(),
      (_agent, process, op, args) =>
        !(process === "p" && op === "read" && (args as { node: string }).node === "show"),
    ),
  );
  const [run] = start(d).runs;
  assertEquals(run.compute, { node: "show", refused: true, slot: ["show"] });
  assertEquals(run.ending, "refused");
  assertEquals(run.errors.map((e) => [e.kind, e.op]), [["refused", "read"]]);
});

Deno.test("a process whose data.path is not a path fails each run with op path, before its programs", () => {
  const d = drive(graph(), "init", table({ show }));
  d.make({ ...host, id: "init", value: {} });
  d.make({ ...host, id: "show", value: "show" });
  const path = [{ parent: "a", name: "x", node: "b" }, { parent: "c", name: "y", node: "p" }];
  d.make({ ...host, id: "p", value: null, data: { path } });
  d.place({ ...host, parent: "p", name: "compute", id: "show" });
  const [run] = start(d).runs;
  assertEquals(run.ending, "failed");
  assertEquals(run.errors.map((e) => [e.kind, e.op]), [["invalid", "path"]]);
  assert(!("compute" in run));
  // it read nothing, so nothing marks it
  assertEquals(d.place({ ...host, parent: "p", name: "compute", id: "show" }).runs, []);
});

Deno.test("a process a cleanup makes reachable is marked by the change that made it so", () => {
  const d = setup(show, ({ lasting }) => () => {
    lasting.write({ node: "log", patches: [{ type: "snapshot", value: "bye" }] });
    lasting.place({ parent: "init", name: "x", id: "x" });
  });
  d.make({ ...host, id: "log", value: null });
  d.make({ ...host, id: "x", value: null, data: { path: [] } });
  d.place({ ...host, parent: "x", name: "compute", id: "show" });
  start(d);
  const answer = d.unplace({ ...host, parent: "init", name: "p", id: "p" });
  const [, placed] = answer.stopped[0].changes;
  assertEquals(placed.kind, "place");
  const run = answer.runs.find((r) => r.process === "x")!;
  assertEquals(run.marked, [{ node: "init", time: placed.time }]);
});

Deno.test("an effect raises a process whose compute read the program node it changed", () => {
  const order: string[] = [];
  const d = drive(
    graph(),
    "init",
    table({
      ca: () => 1,
      ea: (({ api }) => {
        api.write({ node: "m", patches: [{ type: "snapshot", value: 1 }] });
        api.write({ node: "cb", patches: [{ type: "snapshot", value: "cb2" }] });
      }) as Effect,
      cb: () => (order.push("b"), "b"),
      cb2: () => (order.push("b"), "b"),
      cc: (({ api }) => (order.push("c"), api.read({ node: "m" }), "c")) as Compute,
    }),
  );
  d.make({ ...host, id: "init", value: {} });
  d.make({ ...host, id: "m", value: 0 });
  for (const code of ["ca", "ea", "cb", "cc"]) d.make({ ...host, id: code, value: code });
  for (const [p, compute, effect] of [["a", "ca", "ea"], ["b", "cb"], ["c", "cc"]]) {
    d.make({ ...host, id: p, value: null, data: { path: [] } });
    d.place({ ...host, parent: p, name: "compute", id: compute });
    if (effect) d.place({ ...host, parent: p, name: "effect", id: effect });
  }
  d.batch(() => {
    for (const p of ["a", "b", "c"]) d.place({ ...host, parent: "init", name: p, id: p });
  });
  // b and c are both above a now; c's first mark, m, is older than b's, cb
  assertEquals(order, ["b", "c", "c", "b"]);
});

Deno.test("under drive, a change a subscriber makes takes the next time, and is learned after", () => {
  const d = setup(() => ({ n: 1, seen: true }));
  const times: number[] = [];
  d.subscribe({
    agent: "host",
    node: "p",
    send: (e) => {
      if (!("change" in e) || e.change.agent !== "host") return;
      const patches = [{ type: "set" as const, path: [], key: "seen", value: true }];
      times.push(d.write({ agent: "watcher", site, node: "p", patches }).change.time);
    },
  });
  const written = d.write({ ...host, node: "p", patches: [{ type: "snapshot", value: { n: 1 } }] });
  assertEquals([written.change.time, times], [6, [7]]);
  assertEquals(d.read({ agent: "host", node: "p" }), { value: { n: 1, seen: true } });
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
        api.write({ node: "locked", patches: [] });
      } catch (e) {
        caught.push([(e as Refused).kind, (e as Refused).op]);
      }
      handler("careless", () => void lasting.write({ node: "locked", patches: [] }));
    },
    protect(
      graph(),
      (_agent, process, op, args) =>
        !(process === "p" && op === "write" && (args as { node: string }).node === "locked"),
    ),
  );
  d.make({ ...host, id: "locked", value: 0 });
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
