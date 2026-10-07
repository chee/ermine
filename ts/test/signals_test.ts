// ermine/signals: real programs under the reference scheduler, loaded by the
// same-thread loader. The importer hands it modules from this file by name,
// and the two examples from src/signals/examples, which render into a DOM
// from linkedom.

import { assert, assertEquals, assertExists } from "@std/assert";
// deno-lint-ignore no-import-prefix no-unversioned-import -- the lock has it already, as npm:linkedom@*
import { parseHTML } from "npm:linkedom";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { pidOf, schedule, type Scheduler } from "../src/schedule.ts";
import { type ComputeGiven, type EffectGiven, sameThread, type StartOp } from "../src/loaders.ts";
import type { Header, Json, ValueItem } from "../src/types.ts";
import { h, isHandle, render, why } from "../src/dom/mod.ts";
import { input, keep, show, type Signal, signals, source } from "../src/signals/mod.ts";

const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
const fire = (el: Element, type: string) =>
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

const host = { agent: "host", cause: { file: "signals_test.tsx", line: 1, column: 1 } };

type Module = { compute: (ctx: ComputeGiven) => unknown; effect?: (ctx: EffectGiven) => unknown };

/** A stack whose same-thread loader imports these modules by name, or a URL. */
function stack(modules: { [name: string]: Module | string }, g = graph("root")) {
  const importer = (name: string) => {
    const m = modules[name];
    return typeof m === "string" ? import(m) : Promise.resolve(m);
  };
  const s: Scheduler = schedule(
    protect(g, () => true),
    { "same-thread": sameThread(importer) },
    { graph: g },
  );
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
  for (const [name, m] of Object.entries(modules)) {
    const code = { import: name };
    const effect = typeof m === "string" || m.effect ? { effect: code } : {};
    s.place({
      ...host,
      address: ["programs"],
      name,
      id: `program:${name}`,
      value: { kind: "js", compute: code, ...effect },
    });
  }
  const start = (name: string) =>
    pidOf(s.start({ ...host, address: [], program: ["programs", name] } as StartOp).change.time);
  const kill = (pid: string) => s.unplace({ ...host, address: [], name: pid, id: pid });
  const items = (address: string[]) => s.read({ agent: "host", address });
  const value = (address: string[]) => items(address).find((i) => Object.hasOwn(i, "value"))?.value;
  const ids = (address: string[]) => {
    const l = s.directory({ agent: "host", address: address.slice(0, -1), name: address.at(-1) });
    return "items" in l ? l.items.map((i) => i.id) : [];
  };
  return { s, start, kill, items, value, ids };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(f: () => boolean) {
  for (let i = 0; i < 200 && !f(); i++) await tick();
  assert(f(), "timed out");
}

/** The last step of the agent of the change that last set what an item holds. */
const stepOf = (item: unknown) =>
  ((item as ValueItem).change?.agent as { code: Json[] }).code.at(-1) as { [k: string]: Json };

// the counter, without a view: a handler increments count

const counted = signals({ count: input(0) });
let later: (() => void) | undefined;
const counter: Module = {
  compute(ctx) {
    const { count } = counted(ctx);
    return { count: count(), double: count() * 2 };
  },
  effect(ctx) {
    const { count } = counted(ctx);
    ctx.handler("hop", () => count((n) => n + 1));
    later = () => count(count() + 10);
  },
};

Deno.test("a counter: the effect makes count, a handler increments it, and the compute runs again", async () => {
  const { s, start, value, ids } = stack({ counter });
  const pid = start("counter");
  await until(() => ids([pid, "count"]).length === 1);
  assertEquals(value([pid]), { count: 0, double: 0 });
  assertEquals(value([pid, "count"]), 0);

  s.fire({ ...host, process: pid, handler: "hop" });
  assertEquals(value([pid]), { count: 1, double: 2 });
  s.fire({ ...host, process: pid, handler: "hop" });
  assertEquals(value([pid]), { count: 2, double: 4 });
});

Deno.test("the same node across runs: later effects find the slot and make nothing", async () => {
  const { s, start, ids } = stack({ counter });
  const pid = start("counter");
  await until(() => ids([pid, "count"]).length === 1);
  const [first] = ids([pid, "count"]);
  const runs: number[] = [];
  s.subscribe({
    agent: "host",
    address: [pid],
    send: (e) => "record" in e && runs.push(e.record.run),
  });
  for (let i = 0; i < 3; i++) s.fire({ ...host, process: pid, handler: "hop" });
  assert(runs.length >= 3, "the process ran again");
  assertEquals(ids([pid, "count"]), [first]);
});

Deno.test("a write after the effect returned goes through lasting and runs the readers", async () => {
  const { start, value, ids, items } = stack({ counter });
  const pid = start("counter");
  await until(() => ids([pid, "count"]).length === 1);
  later!();
  assertEquals(value([pid]), { count: 10, double: 20 });
  assertExists(stepOf(items([pid, "count"])[0]).lasting);
});

const both = signals({ mine: input("eph"), ours: keep("kept") });
const holder: Module = {
  compute(ctx) {
    const { mine, ours } = both(ctx);
    return [mine(), ours()];
  },
  effect(ctx) {
    both(ctx);
  },
};

Deno.test("an input goes when its process is killed; a keep stays, and the next process finds it", async () => {
  const { s, start, kill, value, ids } = stack({ holder });
  const pid = start("holder");
  await until(() => ids([pid, "mine"]).length === 1);
  assertEquals(value([pid]), ["eph", "kept"]);
  assertEquals(ids([pid, "mine"]).length, 1);
  const [kept] = ids(["ours"]);
  assertExists(kept);
  s.write({ ...host, address: ["ours"], patches: [{ type: "snapshot", value: "changed" }] });

  const [mine] = ids([pid, "mine"]);
  kill(pid);
  assertEquals(s.read({ agent: "host", address: [pid, "mine"] }), []);
  assert(!ids([pid, "mine"]).includes(mine));
  assertEquals(value(["ours"]), "changed");

  // a new process: a new pid, a new input, the same keep
  const again = start("holder");
  await until(() => ids([again, "mine"]).length === 1);
  assertEquals(value([again]), ["eph", "changed"]);
  assertEquals(ids(["ours"]), [kept]);
});

// a derived value: a program with no effect, reading what another keeps

const shared = signals({ total: keep(1) });
const keeper: Module = {
  compute: (ctx) => shared(ctx).total(),
  effect(ctx) {
    const { total } = shared(ctx);
    ctx.handler("add", (n) => total((t) => t + (n as number)));
  },
};
const found = signals({ total: source<number>("total") });
const doubled: Module = {
  compute(ctx) {
    const { total } = found(ctx);
    const t = total();
    return t === undefined ? ctx.pending : t * 2;
  },
};

Deno.test("a derived value: a compute-only program reads the nearest total by source", async () => {
  const { s, start, value } = stack({ keeper, doubled });
  const d = start("doubled");
  await tick();
  assertEquals(value([d]), null, "pending while nothing is there");
  const k = start("keeper");
  await until(() => value([d]) === 2);
  s.fire({ ...host, process: k, handler: "add", input: 4 });
  assertEquals(value([k]), 5);
  assertEquals(value([d]), 10);
});

Deno.test("a compute only reads: a write through its signal is refused as read-only", async () => {
  const caught: string[] = [];
  const writes = signals({ n: input(0) });
  const { start, value } = stack({
    writer: {
      compute(ctx) {
        const { n } = writes(ctx);
        try {
          n(1);
        } catch (e) {
          caught.push((e as { why: { code: string } }).why.code);
        }
        return n();
      },
      effect: (ctx) => void writes(ctx),
    },
  });
  const pid = start("writer");
  await until(() => value([pid]) === 0 && caught.length > 0);
  assertEquals(caught[0], "read-only");
});

Deno.test("provenance: each change names the process, and the run, handler or lasting step", async () => {
  const { s, start, ids, items } = stack({ counter });
  const pid = start("counter");
  await until(() => ids([pid, "count"]).length === 1);

  // made by the effect: the placement is the node's first change, in a run
  const made = stepOf(items([pid, "count"])[0]);
  assertEquals(made.process, pid);
  assertEquals(typeof made.run, "number");
  const placed = (items([pid, "count"])[0] as ValueItem).change as Header;
  assertEquals(placed.kind, "place");
  assertEquals(placed.process, pid);
  // a process's change has no site: the agent names the code instead
  assertEquals(placed.cause, undefined);

  s.fire({ ...host, process: pid, handler: "hop" });
  assertEquals(stepOf(items([pid, "count"])[0]).handler, "hop");

  later!();
  const step = stepOf(items([pid, "count"])[0]);
  assertEquals(step.process, pid);
  assertEquals(typeof step.lasting, "number");
});

// the examples, rendered

/** The demo host as a program imports it: screen(pid) is an element for that process. */
function screens() {
  const els = new Map<string, Element>();
  (globalThis as { __ermineDemo?: unknown }).__ermineDemo = {
    demo: {
      screen(pid: string) {
        let el = els.get(pid);
        if (!el) {
          el = document.createElement("div");
          document.body.append(el);
          els.set(pid, el);
        }
        return el;
      },
    },
  };
  return els;
}
const examples = new URL("../src/signals/examples/", import.meta.url);

Deno.test("the counter example: a click patches the text node in place; the process follows", async () => {
  const els = screens();
  const { start, kill, value } = stack({ counter: new URL("counter.tsx", examples).href });
  const pid = start("counter");
  await until(() => (value([pid]) as { count?: number } | undefined)?.count === 0);
  const el = els.get(pid)!;
  await until(() => el.querySelector(".big") !== null);
  const big = el.querySelector(".big")!;
  const label = el.querySelector(".label")!;
  const text = big.firstChild;
  assertEquals(big.textContent, "0");
  assertEquals(label.textContent, "double: 0");

  fire(el.querySelector("button")!, "click");
  assertEquals(big.textContent, "1");
  assertEquals(value([pid]), { count: 1, double: 2 });
  assertEquals(label.textContent, "double: 2");
  fire(el.querySelector("button")!, "click");
  assertEquals(big.textContent, "2");
  assertEquals(label.textContent, "double: 4");

  // the view was resumed, not drawn again: the same nodes
  assertEquals(el.querySelector(".big"), big);
  assert(big.contains(text));

  // why: the text leads back to <pid>/count and the click that set it
  const w = why(big)!;
  assertEquals(w.reasons[0].path, [pid, "count"]);
  assertEquals((w.reasons[0].by as { process: string }).process, pid);
  assertEquals(typeof (w.reasons[0].by as { lasting: number }).lasting, "number");

  // killed: the DOM is taken out after the cleanup; count is gone
  kill(pid);
  await tick();
  assertEquals(el.childNodes.length, 0);
});

Deno.test("the todo example: todos are kept beside the process; the draft goes with it", async () => {
  const els = screens();
  const { start, kill, value, ids } = stack({ todo: new URL("todo.tsx", examples).href });
  const pid = start("todo");
  await until(() => els.get(pid)?.querySelector("form") != null);
  const el = els.get(pid)!;
  const form = el.querySelector("form")!;
  const box = el.querySelector("input")! as unknown as HTMLInputElement;
  const texts = () => [...el.querySelectorAll("li")].map((li) => li.textContent!.replace("×", ""));

  for (const text of ["milk", "eggs"]) {
    box.value = text;
    fire(box, "input");
    assertEquals(value([pid, "draft"]), text);
    fire(form, "submit");
  }
  assertEquals(value([pid, "draft"]), "");
  assertEquals(box.value, "");
  assertEquals(texts(), ["milk", "eggs"]);
  assertEquals(value([pid]), { left: 2, total: 2 });
  assertEquals(el.querySelector("p")!.textContent, "2 of 2 left");

  fire(el.querySelector("li input")!, "change");
  assertEquals(value([pid]), { left: 1, total: 2 });
  assertEquals(el.querySelector("p")!.textContent, "1 of 2 left");

  // in the order added: milk first, now done; dropping it leaves eggs
  fire(el.querySelector("li button")!, "click");
  assertEquals(el.querySelectorAll("li").length, 1);
  assert(el.querySelector("li")!.textContent!.includes("eggs"));
  assertEquals(value([pid]), { left: 1, total: 1 });

  kill(pid);
  await tick();
  assertEquals(ids([pid, "draft"]).length, 0);
  assertEquals(ids(["todos"]).length, 1, "todos outlives the process");
  const again = start("todo");
  await until(() => (value([again]) as { total?: number } | undefined)?.total === 1);
});

Deno.test("a signal is a dom handle: it renders in JSX anywhere, and leads back", async () => {
  let seen: Signal<number> | undefined;
  let given: EffectGiven | undefined;
  const grab = signals({ count: input(0) });
  const { s, start, ids } = stack({
    grabber: {
      compute: (ctx) => grab(ctx).count(),
      effect(ctx) {
        const { count } = grab(ctx);
        seen = count;
        given ??= ctx;
        ctx.handler("hop", () => count((n) => n + 1));
      },
    },
  });
  const pid = start("grabber");
  await until(() => ids([pid, "count"]).length === 1);
  assert(isHandle(seen));
  // rendered by the effect's ctx, or by anything holding it later: the scopes are the process's
  const el = document.createElement("div");
  const dispose = render(() => h("b", null, seen!), el, given!);
  assertEquals(el.textContent, "0");
  s.fire({ ...host, process: pid, handler: "hop" });
  assertEquals(el.textContent, "1", "drawn before fire returned");
  assertEquals(
    (why(el.querySelector("b")!.lastChild!)!.reasons[0].by as { handler: string }).handler,
    "hop",
  );
  dispose();
  assertEquals(el.childNodes.length, 0);
});

// review additions

Deno.test("a write in the effect body before show is drawn; later effect runs leave the view", async () => {
  const el = document.createElement("div");
  const runs = signals({ count: input(0), runs: input(0) });
  const { s, start } = stack({
    shower: {
      compute: (ctx) => runs(ctx).count(),
      effect(ctx) {
        const { count, runs: n } = runs(ctx);
        ctx.handler("hop", () => count((c) => c + 1));
        n(n() + 1); // written while the view is paused
        return show(ctx, el, () => h("i", null, n));
      },
    },
  });
  const pid = start("shower");
  await until(() => el.querySelector("i") !== null);
  await tick();
  const text = el.querySelector("i")!.firstChild;
  const was = Number(el.textContent);
  s.fire({ ...host, process: pid, handler: "hop" });
  await until(() => el.textContent === String(was + 1));
  assert(el.querySelector("i")!.contains(text), "the same view, not drawn again");
});

Deno.test("a view subscribes to nothing; a kill disposes its scopes and the graph forgets them", async () => {
  const els = screens();
  const g = graph("root");
  let live = 0;
  const sub = g.subscribe.bind(g), unsub = g.unsubscribe.bind(g);
  g.subscribe =
    ((op: Parameters<typeof g.subscribe>[0]) => (live++, sub(op))) as typeof g.subscribe;
  g.unsubscribe =
    ((op: Parameters<typeof g.unsubscribe>[0]) => (live--, unsub(op))) as typeof g.unsubscribe;
  const { s, start, kill, value } = stack({ counter: new URL("counter.tsx", examples).href }, g);
  const before = live;
  const pid = start("counter");
  await until(() => (value([pid]) as { count?: number } | undefined)?.count === 0);
  await until(() => els.get(pid)?.querySelector(".big") != null);
  const records: string[] = [];
  const { sub: mine } = s.subscribe({
    agent: "host",
    address: [pid],
    send: (e) => "record" in e && records.push(e.record.process),
  });
  const during = live;
  fire(els.get(pid)!.querySelector("button")!, "click");
  assertEquals(live, during, "a click subscribes to nothing");
  assert(
    records.some((p) => p.startsWith(`${pid}#`)),
    "the text's scope ran, and its record was sent",
  );
  // what the view read is gone with the process, so dom_test and scope_test show the forgetting
  s.unsubscribe({ agent: "host", sub: mine });
  kill(pid);
  assertEquals(els.get(pid)!.childNodes.length, 0, "taken out at once, by the kill");
  assertEquals(live, before, "and nothing was left subscribed");
});

Deno.test("source follows the nearest slot, farther up", async () => {
  let path: readonly string[] = [];
  const find = signals({ t: source("t") });
  const { s, value } = stack({
    finder: {
      compute(ctx) {
        const { t } = find(ctx);
        path = t.path;
        return t() ?? ctx.pending;
      },
    },
  });
  s.place({ ...host, address: [], name: "sub", id: "sub", value: null });
  s.place({ ...host, address: [], name: "t", id: "t", value: 3 });
  const pid = pidOf(
    s.start({ ...host, address: ["sub"], program: ["programs", "finder"] } as StartOp).change.time,
  );
  await until(() => value(["sub", pid]) === 3);
  assertEquals(path, ["..", "t"]);
});
