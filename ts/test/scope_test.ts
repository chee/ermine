// Scopes (ts/demo/dom.org, Scopes): light children of a process, run by the
// reference scheduler in its rounds, recorded under "<pid>#<n>".

import { assert, assertEquals, assertThrows } from "@std/assert";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { schedule, type Scheduler } from "../src/schedule.ts";
import {
  type Builtin,
  builtin,
  type EffectGiven,
  type Loaded,
  type MakeScope,
  type Scope,
} from "../src/loaders.ts";
import type { Json, Record } from "../src/types.ts";

const host = { agent: "host", cause: { file: "scope_test.ts", line: 1, column: 1 } };

function stack(table: { [name: string]: Builtin }) {
  const g = graph("root");
  const s: Scheduler = schedule(protect(g, () => true), { builtin: builtin(table) }, { graph: g });
  s.top(s);
  s.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
  s.place({
    ...host,
    address: ["loaders"],
    name: "builtin",
    id: "lb",
    value: { loader: "builtin" },
  });
  s.place({ ...host, address: [], name: "programs", id: "programs", value: null });
  for (const name of Object.keys(table)) {
    const value: Json = table[name].effect
      ? { kind: "builtin", compute: name, effect: name }
      : { kind: "builtin", compute: name };
    s.place({ ...host, address: ["programs"], name, id: `program:${name}`, value });
  }
  const start = (name: string) =>
    (s.start({ ...host, address: [], program: ["programs", name] }).change as { id: string }).id;
  const write = (name: string, value: Json) =>
    s.write({ ...host, address: [name], patches: [{ type: "snapshot", value }] });
  return { s, start, write };
}

/** A program whose effect hands its scope maker to the test, once. */
function holder() {
  const got: { scope?: MakeScope } = {};
  const program: Builtin = {
    compute: (() => null) as Loaded,
    effect: ((ctx: EffectGiven) => {
      got.scope ??= ctx.scope;
    }) as unknown as Loaded,
  };
  return { got, program };
}

const valueOf = (api: { read: (op: { address: string[] }) => { value?: Json }[] }, name: string) =>
  api.read({ address: [name] }).find((i) => Object.hasOwn(i, "value"))?.value;

Deno.test("a scope runs at once, and again when what its compute read changes", () => {
  const { got, program } = holder();
  const { s, start, write } = stack({ holder: program });
  s.place({ ...host, address: [], name: "count", id: "count", value: 1 });
  const pid = start("holder");
  const seen: [Json, Json | undefined][] = [];
  const scope = got.scope!(
    ({ api }) => valueOf(api, "count") as Json,
    (value, previous) => void seen.push([value, previous]),
  );
  assertEquals(scope.id, `${pid}#1`);
  assertEquals(seen, [[1, undefined]]);
  const done = write("count", 2);
  assertEquals(seen, [[1, undefined], [2, 1]]);
  // the change marked the scope, by its id; its run is in the answer
  assert(done.marked.some((m) => m.process === scope.id));
  const rec = done.runs.find((r) => r.process === scope.id)!;
  assertEquals(rec.ending, "done");
  assertEquals(rec.reads.map((r) => r.address), [["count"]]);
  assertEquals(rec.reads[0].saw, done.change.time);
  assertEquals(rec.marked, [done.change.time]);
  // its agent is the process's, its last step naming the scope and its run
  const step = (rec.agent as { code: Json[] }).code.at(-1) as { [k: string]: Json };
  assertEquals([step.process, step.scope, step.run], [pid, 1, 2]);
  assertEquals(scope.record, rec);
});

Deno.test("a scope's compute only reads", () => {
  const { got, program } = holder();
  const { start } = stack({ holder: program });
  start("holder");
  const scope = got.scope!(({ api }) => {
    api.write({ address: ["x"], patches: [] } as never);
    return 1;
  }, () => {});
  assertEquals(scope.record!.ending, "failed");
  assertEquals(scope.record!.errors[0].why.code, "read-only");
});

Deno.test("a scope that reads a process runs after it, in the same round, and sees its new value", () => {
  const doubled: Builtin = {
    compute: (({ api }) => (valueOf(api, "count") as number) * 2) as Loaded,
  };
  const { got, program } = holder();
  const { s, start, write } = stack({ doubled, holder: program });
  s.place({ ...host, address: [], name: "count", id: "count", value: 1 });
  const pid = start("doubled");
  start("holder");
  const seen: Json[] = [];
  // reads count, then the process: count's write marks both, and the process must go first
  const scope = got.scope!(({ api }) => {
    return [valueOf(api, "count"), api.read({ address: [pid] }).map((i) => i.value ?? "item")];
  }, (v) => void seen.push(v as Json));
  assertEquals(seen, [[1, [2]]]);
  const done = write("count", 5);
  assertEquals(seen.at(-1), [5, [10]], "never a waiting item, never the old value");
  const order = done.runs.map((r) => r.process);
  assert(order.indexOf(pid) < order.lastIndexOf(scope.id), JSON.stringify(order));
  // and it ran once for the write, after the process
  assertEquals(order.filter((p) => p === scope.id).length, 1);
});

Deno.test("disposing a scope disposes its children first; their reads are forgotten", () => {
  const { got, program } = holder();
  const { s, start, write } = stack({ holder: program });
  s.place({ ...host, address: [], name: "a", id: "a", value: 0 });
  s.place({ ...host, address: [], name: "b", id: "b", value: 0 });
  const pid = start("holder");
  const log: string[] = [];
  let child: Scope | undefined;
  const parent = got.scope!(({ api, scope }) => {
    const a = valueOf(api, "a");
    child = scope(({ api }) => valueOf(api, "b"), (v) => {
      log.push(`child ${v}`);
      return () => log.push("child cleanup");
    });
    return a;
  }, (v) => {
    log.push(`parent ${v}`);
    return () => log.push("parent cleanup");
  });
  assertEquals(child!.id, `${pid}#2`);
  assertEquals(log, ["child 0", "parent 0"]);

  // the parent runs again: its child is disposed first, and a new one made
  const first = child!;
  write("a", 1);
  assert(first.disposed);
  assertEquals(log.slice(2), ["child cleanup", "child 0", "parent cleanup", "parent 1"]);
  log.length = 0;

  // the child alone runs when b changes
  write("b", 7);
  assertEquals(log, ["child cleanup", "child 7"]);
  log.length = 0;

  parent();
  assertEquals(log, ["child cleanup", "parent cleanup"]);
  assert(child!.disposed && parent.disposed);
  log.length = 0;
  // nothing marks them any more
  const a = write("a", 2), b = write("b", 8);
  assertEquals([...a.marked, ...b.marked].filter((m) => m.process.startsWith(pid)), []);
  assertEquals([...a.runs, ...b.runs], []);
  assertEquals(log, []);
});

Deno.test("a kill disposes the process's scopes, and their reads are forgotten", () => {
  const { got, program } = holder();
  const { s, start, write } = stack({ holder: program });
  s.place({ ...host, address: [], name: "a", id: "a", value: 0 });
  const pid = start("holder");
  const log: string[] = [];
  const scope = got.scope!(({ api }) => valueOf(api, "a"), () => () => log.push("cleanup"));
  s.unplace({ ...host, address: [], name: pid, id: pid });
  assert(scope.disposed);
  assertEquals(log, ["cleanup"]);
  assertEquals(write("a", 1).marked, []);
  assertThrows(() => got.scope!(() => 1, () => {}));
});

Deno.test("a scope ends pending or failed, with no effect; its records go to the process's subscribers", () => {
  const { got, program } = holder();
  const { s, start, write } = stack({ holder: program });
  s.place({ ...host, address: [], name: "n", id: "n", value: 0 });
  const pid = start("holder");
  const records: Record[] = [];
  s.subscribe({
    agent: "host",
    address: [pid],
    send: (e) => "record" in e && records.push(e.record),
  });
  const applied: Json[] = [];
  const scope = got.scope!(({ api, pending }) => {
    const n = valueOf(api, "n") as number;
    if (n === 0) return pending;
    if (n < 0) throw new Error("negative");
    return n;
  }, (v) => void applied.push(v));
  assertEquals(scope.record!.ending, "pending");
  write("n", -1);
  assertEquals(scope.record!.ending, "failed");
  assertEquals(scope.record!.errors[0].why.message, "negative");
  write("n", 3);
  assertEquals(scope.record!.ending, "done");
  assertEquals(applied, [3]);
  assertEquals(
    records.filter((r) => r.process === scope.id).map((r) => r.ending),
    ["pending", "failed", "done"],
  );
});
