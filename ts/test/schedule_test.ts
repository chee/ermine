// The reference scheduler through its TypeScript interface: schedule over
// protect over the graph, with the steps loader and the same-thread loader.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { actorOf, pidOf, schedule, type Scheduler } from "../src/schedule.ts";
import { sameThread, type StartOp } from "../src/loaders.ts";
import { steps } from "../src/steps.ts";
import { ErmineError, type Json, type ValueItem } from "../src/types.ts";

const cause = { file: "schedule_test.ts", line: 1, column: 1 };
const host = { agent: "host", cause };

/** A stack with the steps loader, and loaders/steps at the root. */
function stack(options: { budget?: number } = {}): Scheduler {
  const g = graph("root");
  const s = schedule(protect(g, () => true), { steps: steps() }, {
    graph: g,
    ...options,
  });
  s.top(s);
  s.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
  s.place({
    ...host,
    address: ["loaders"],
    name: "steps",
    id: "lsteps",
    value: { loader: "steps" },
  });
  s.place({ ...host, address: [], name: "programs", id: "programs", value: null });
  return s;
}

/** A stack whose js loader node names the loader the host gave it. */
function jsStack(): Scheduler {
  const g = graph("root");
  const s = schedule(protect(g, () => true), { steps: steps(), "same-thread": sameThread() }, {
    graph: g,
  });
  s.top(s);
  s.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
  s.place({
    ...host,
    address: ["loaders"],
    name: "js",
    id: "ljs",
    value: { loader: "same-thread" },
  });
  s.place({ ...host, address: [], name: "programs", id: "programs", value: null });
  return s;
}

function program(s: Scheduler, name: string, value: Json) {
  s.place({ ...host, address: ["programs"], name, id: name, value });
}

const start = (s: Scheduler, op: Partial<StartOp> & { program: string[] }) =>
  s.start({ ...host, address: [], ...op } as StartOp);

const value = (s: Scheduler, address: string[]) =>
  s.read({ agent: "host", address }).find((i) => Object.hasOwn(i, "value"))?.value;

const code = (e: unknown) => e instanceof ErmineError ? e.why.code : undefined;

Deno.test("pids: @, the start's time, -, and five letters from it", () => {
  assertEquals(pidOf(6), "@6-jabab");
  assertEquals(pidOf(7), "@7-kabab");
  assertEquals(pidOf(13), "@13-rabab");
  assertEquals(pidOf(6, 7), "@6-kabab");
});

Deno.test("an agent not of the scheduler's shape is the actor", () => {
  assertEquals(actorOf("alice"), "alice");
  assertEquals(actorOf({ actor: "bob", code: [] }), "bob");
  assertEquals(actorOf({ name: "carol" }), { name: "carol" });
});

Deno.test("start places the process under its pid, runs it, and a write it read runs it again", () => {
  const s = stack();
  s.place({ ...host, address: [], name: "a", id: "a", value: 1 });
  program(s, "show", {
    kind: "steps",
    compute: [{ do: "read", address: ["a"], as: "x" }, {
      do: "return",
      value: { $value: { $: "x" } },
    }],
  });
  const started = start(s, { program: ["programs", "show"] });
  const pid = pidOf(started.change.time);
  assertEquals(started.change.kind === "place" && started.change.id, pid);
  assertEquals(started.marked, [{ process: pid, by: started.change.time }]);
  assertEquals(started.runs.map((r) => [r.run, r.value, r.ending]), [[1, 1, "done"]]);
  assertEquals(started.runs[0].program, { node: "show", time: 5 });
  assertEquals(value(s, [pid]), 1);
  const wrote = s.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 2 }] });
  assertEquals(wrote.runs.map((r) => [r.run, r.marked, r.value]), [[2, [wrote.change.time], 2]]);
  assertEquals(value(s, [pid]), 2);
});

Deno.test("start: no program, not a program, no loader, each taking no time", () => {
  const s = stack();
  const before = s.time;
  assertEquals(code(assertThrows(() => start(s, { program: ["programs", "nope"] }))), "no-program");
  program(s, "junk", "hello");
  assertEquals(
    code(assertThrows(() => start(s, { program: ["programs", "junk"] }))),
    "not-a-program",
  );
  program(s, "other", { kind: "lisp", compute: [] });
  assertEquals(code(assertThrows(() => start(s, { program: ["programs", "other"] }))), "no-loader");
  assertEquals(s.time, before + 2);
});

Deno.test("only a process makes an ephemeral node, and a process node is in one place", () => {
  const s = stack();
  assertEquals(
    code(
      assertThrows(() =>
        s.place({ ...host, address: [], name: "e", id: "e", value: 1, ephemeral: true })
      ),
    ),
    "not-a-process",
  );
  program(s, "p", { kind: "steps", compute: [{ do: "return", value: 1 }] });
  const pid = pidOf(start(s, { program: ["programs", "p"] }).change.time);
  assertEquals(
    code(assertThrows(() => s.place({ ...host, address: ["programs"], name: "x", id: pid }))),
    "one-place",
  );
  const made = s.place({
    ...host,
    process: pid,
    address: [],
    name: "e",
    id: "e",
    value: 1,
    ephemeral: true,
  });
  assertEquals(made.change.ephemeral, true);
});

Deno.test("killing a process runs its cleanup and unplaces the ephemeral nodes it made", () => {
  const s = stack();
  s.place({ ...host, address: [], name: "log", id: "log", value: null });
  program(s, "maker", {
    kind: "steps",
    compute: [{ do: "return", value: 1 }],
    effect: [
      { do: "place", address: [], name: "tmp", id: "t1", value: "e", ephemeral: true },
      {
        do: "cleanup",
        steps: [{
          do: "write",
          address: ["log"],
          patches: [{ type: "snapshot", value: "cleaned" }],
        }],
      },
    ],
  });
  const pid = pidOf(start(s, { program: ["programs", "maker"] }).change.time);
  assertEquals(value(s, ["tmp"]), "e");
  const killed = s.unplace({ ...host, address: [], name: pid, id: pid });
  assertEquals(killed.stopped.length, 1);
  const [stop] = killed.stopped;
  assertEquals(stop.process, pid);
  assertEquals(stop.changes.map((c) => [c.node, c.kind]), [["log", "write"], ["root", "unplace"]]);
  assertEquals(stop.changes[1].cause, { killed: pid, by: killed.change.time });
  assertEquals(stop.gone, ["t1"]);
  assertEquals(value(s, ["log"]), "cleaned");
  assertEquals(value(s, ["tmp"]), undefined);
  assertEquals(
    code(assertThrows(() => s.fire({ agent: "host", process: pid, handler: "h" }))),
    "stopped",
  );
});

Deno.test("a kill unplaces each ephemeral node still here from its one slot, most recently made first", () => {
  const s = stack();
  s.place({ ...host, address: [], name: "box", id: "box", value: null });
  s.place({ ...host, address: [], name: "o", id: "o", value: "ordinary" });
  program(s, "maker", {
    kind: "steps",
    compute: [{ do: "return", value: 1 }],
    effect: [
      { do: "place", address: [], name: "a", id: "t1", value: 1, ephemeral: true },
      { do: "place", address: ["a"], name: "held", id: "o" },
      { do: "place", address: ["box"], name: "b", id: "t2", value: 2, ephemeral: true },
      { do: "place", address: [], name: "c", id: "t3", value: 3, ephemeral: true },
      { do: "place", address: [], name: "d", id: "t4", value: 4, ephemeral: true },
    ],
  });
  const pid = pidOf(start(s, { program: ["programs", "maker"] }).change.time);
  // t2's parent unreachable: no address reaches it, and it still goes
  s.unplace({ ...host, address: [], name: "box", id: "box" });
  // t3 already gone
  assertEquals(s.unplace({ ...host, address: [], name: "c", id: "t3" }).gone, ["t3"]);
  const killed = s.unplace({ agent: "killer", cause, address: [], name: pid, id: pid });
  const by = killed.change.time;
  const [stop] = killed.stopped;
  assertEquals(stop.gone, ["t4", "t2", "t1"]);
  assertEquals(
    stop.changes.map((c) => [c.time, c.node, c.kind === "write" ? "" : c.id, c.agent, c.cause]),
    [
      [by + 1, "root", "t4", "killer", { killed: pid, by }],
      [by + 2, "box", "t2", "killer", { killed: pid, by }],
      [by + 3, "root", "t1", "killer", { killed: pid, by }],
      // t1's letting go: the ordinary node it held taken out, with the same agent and cause
      [by + 4, "t1", "o", "killer", { killed: pid, by }],
    ],
  );
  assert(stop.changes.every((c) => c.ephemeral && c.process === undefined));
  assertEquals(value(s, ["o"]), "ordinary");
  assertEquals(s.time, by + 4);
});

Deno.test("a kill leaves alone a node another process made with the id of one that went", () => {
  const s = stack();
  program(s, "p", { kind: "steps", compute: [{ do: "return", value: 1 }] });
  const a = pidOf(start(s, { program: ["programs", "p"] }).change.time);
  const b = pidOf(start(s, { program: ["programs", "p"] }).change.time);
  s.place({ ...host, process: a, address: [], name: "e", id: "e", value: 1, ephemeral: true });
  assertEquals(s.unplace({ ...host, process: a, address: [], name: "e", id: "e" }).gone, ["e"]);
  s.place({ ...host, process: b, address: [], name: "f", id: "e", value: 2, ephemeral: true });
  const [stop] = s.unplace({ ...host, address: [], name: a, id: a }).stopped;
  assertEquals(stop.changes, []);
  assertEquals(stop.gone, undefined);
  assertEquals(value(s, ["f"]), 2);
  assertEquals(s.unplace({ ...host, address: [], name: b, id: b }).stopped[0].gone, ["e"]);
});

Deno.test("an ephemeral node is in one slot: mounting it elsewhere through the scheduler is one-place", () => {
  const s = stack();
  program(s, "p", { kind: "steps", compute: [{ do: "return", value: 1 }] });
  const pid = pidOf(start(s, { program: ["programs", "p"] }).change.time);
  const as = { ...host, process: pid };
  s.place({ ...as, address: [], name: "e", id: "e", value: 1, ephemeral: true });
  assertEquals(
    code(assertThrows(() => s.place({ ...as, address: [], name: "f", id: "e" }))),
    "one-place",
  );
  s.place({ ...host, address: [], name: "m", id: "later" });
  assertEquals(
    code(
      assertThrows(() =>
        s.place({ ...as, address: [], name: "g", id: "later", value: 1, ephemeral: true })
      ),
    ),
    "one-place",
  );
});

Deno.test("a batch runs what its operations marked once, after the last", () => {
  const s = stack();
  s.place({ ...host, address: [], name: "a", id: "a", value: 1 });
  s.place({ ...host, address: [], name: "b", id: "b", value: 1 });
  program(s, "ab", {
    kind: "steps",
    compute: [
      { do: "read", address: ["a"], as: "a" },
      { do: "read", address: ["b"], as: "b" },
      { do: "return", value: [{ $value: { $: "a" } }, { $value: { $: "b" } }] },
    ],
  });
  const pid = pidOf(start(s, { program: ["programs", "ab"] }).change.time);
  const settled = s.batch(() => {
    s.write({ ...host, address: ["a"], patches: [{ type: "snapshot", value: 2 }] });
    s.write({ ...host, address: ["b"], patches: [{ type: "snapshot", value: 3 }] });
  });
  assertEquals(settled.runs.map((r) => [r.process, r.value]), [[pid, [2, 3]]]);
});

Deno.test("a cycle that never stops reaches the budget; what is due stays due, reading as waiting", () => {
  const s = stack({ budget: 3 });
  program(s, "up", {
    kind: "steps",
    compute: [
      { do: "read", address: [{ $: "name" }], as: "me" },
      { do: "let", as: "v", value: { $value: { $: "me" } } },
      { do: "if", test: { $eq: [{ $: "v" }, null] }, then: [{ do: "return", value: 0 }] },
      { do: "return", value: { $add: [{ $: "v" }, 1] } },
    ],
  });
  const e = assertThrows(() => start(s, { program: ["programs", "up"] }));
  assertEquals(code(e), "budget");
  const t = s.time;
  const pid = pidOf(t - 3);
  const items = s.read({ agent: "host", address: [pid] }) as unknown as { waiting?: number[] }[];
  assert(Array.isArray(items[0].waiting));
});

Deno.test("fire calls a handler as the fire's actor, logs it, and runs what it marked", () => {
  const s = stack();
  s.place({ ...host, address: [], name: "doc", id: "doc", value: "hi" });
  program(s, "ed", {
    kind: "steps",
    compute: [{ do: "read", address: ["doc"], as: "d" }, {
      do: "return",
      value: { $value: { $: "d" } },
    }],
    effect: [{
      do: "handler",
      name: "type",
      steps: [{
        do: "write",
        address: ["doc"],
        patches: [{ type: "snapshot", value: { $: "input" } }],
      }],
    }],
  });
  const pid = pidOf(start(s, { program: ["programs", "ed"] }).change.time);
  const fired = s.fire({ agent: "alice", process: pid, handler: "type", input: "hey" });
  assertEquals(fired.handler.ending, "done");
  assertEquals((fired.handler.agent as { actor: Json }).actor, "alice");
  assertEquals(fired.changes.length, 1);
  assertEquals(fired.runs.map((r) => r.value), ["hey"]);
  assertEquals(
    code(assertThrows(() => s.fire({ agent: "host", process: pid, handler: "nope" }))),
    "unknown-handler",
  );
});

Deno.test("restart drops every process but keeps the clock", () => {
  const s = stack();
  program(s, "p", { kind: "steps", compute: [{ do: "return", value: 1 }] });
  const pid = pidOf(start(s, { program: ["programs", "p"] }).change.time);
  const t = s.time;
  s.restart();
  assertEquals(s.time, t);
  assertEquals(
    code(assertThrows(() => s.fire({ agent: "host", process: pid, handler: "h" }))),
    "unknown-process",
  );
});

Deno.test("the same-thread loader: pending until its module loads, then it runs; parts share the module", async () => {
  const s = jsStack();
  s.place({ ...host, address: [], name: "tick", id: "tick", value: 0 });
  const source = `
    let seen = 0;
    export function compute({ api }) {
      api.read({ address: ["/", "tick"] });
      return seen;
    }
    export function effect({ value }) {
      seen = value + 1;
    }
  `;
  program(s, "js", { kind: "js", compute: source, effect: source });
  const started = start(s, { program: ["programs", "js"] });
  const pid = pidOf(started.change.time);
  assertEquals(started.runs.map((r) => r.ending), ["pending"]);
  const items = s.read({ agent: "host", address: [pid] }) as unknown as { waiting?: number[] }[];
  assert(Array.isArray(items[0].waiting));
  for (let i = 0; i < 100 && value(s, [pid]) === null; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assertEquals(value(s, [pid]), 0);
  const wrote = s.write({ ...host, address: ["tick"], patches: [{ type: "snapshot", value: 1 }] });
  // the effect set what the compute reads next: they share the module
  assertEquals(wrote.runs.map((r) => r.value), [1]);
});

Deno.test("the same-thread loader: a compute that returns nothing fails its run", async () => {
  const s = jsStack();
  const source = `export default function () {}`;
  program(s, "none", { kind: "js", compute: source });
  const pid = pidOf(start(s, { program: ["programs", "none"] }).change.time);
  let items: ValueItem[] = [];
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    items = s.read({ agent: "host", address: [pid] });
    if ((items[0] as unknown as { error?: unknown }).error) break;
  }
  const error = (items[0] as unknown as { error: { why: { code: string } } }).error;
  assertEquals(error.why.code, "missing-value");
});
