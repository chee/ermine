/// <reference lib="dom" />
// The demo's world without a page: a DOM from linkedom, the keeper in memory,
// and each example's boot image run to its first quiet point. Then each is
// kept, loaded again as a reload would, and reopened: its processes start
// again from the boot image, and nothing it kept is made twice.
//
//   cd ts && deno test --allow-read --allow-env demo/core/headless_test.ts
//
// A program's module imports "demo" and "ermine", which ts/deno.json maps to
// demo/core/host/, as the page's import map does.

// deno-lint-ignore no-import-prefix no-unversioned-import -- the lock has it already, as npm:linkedom@*
import { parseHTML } from "npm:linkedom";
import { assert, assertEquals } from "@std/assert";
import { load, memory } from "../../src/keeper.ts";
import { examples } from "./src/examples.ts";
import { PID, World } from "./src/world.ts";

const page = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, {
  document: page.document,
  window: page.window,
  Node: page.Node,
  HTMLElement: page.HTMLElement,
});
// linkedom draws nothing on a canvas: one that takes every call, for the pixels example
const canvas = Object.getPrototypeOf(page.document.createElement("canvas"));
canvas.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });

/** Waits until the log has stopped growing and no process is waiting, or until ms. */
async function quiet(world: World, ms = 5000) {
  const end = Date.now() + ms;
  let last = -1;
  let still = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    const waiting = [...world.running().keys()].some((pid) =>
      world.front(pid).some((i) => "waiting" in i)
    );
    if (world.log.length === last && !waiting) {
      if (++still >= 6) return;
    } else still = 0;
    last = world.log.length;
  }
}

/** What went wrong in a world: failed snippets, errors logged, runs that did not end done. */
function trouble(world: World): string[] {
  const out: string[] = [];
  for (const s of world.snippets) {
    if (s.ok === false) out.push(`snippet ${s.n} (${s.label}): ${s.error?.why}`);
  }
  for (const e of world.log) if (e.t === "error") out.push(`error: ${e.error.why}`);
  for (const pid of world.running().keys()) {
    const last = world.records.get(pid)?.at(-1);
    if (!last) out.push(`${pid} never ran`);
    else if (last.ending !== "done") {
      out.push(`${pid} ended ${last.ending}: ${JSON.stringify(last.errors)}`);
    }
  }
  for (const [pid, t] of world.thrown) out.push(`${pid}'s ${t.part} threw: ${t.message}`);
  return out;
}

/**
 * The nodes the root reaches without going through a process, that are not
 * ephemeral, by id: what a process holds is its own, made again when it is.
 */
function data(world: World): string[] {
  const seen = new Set<string>(["root"]);
  const queue = ["root"];
  while (queue.length) {
    for (const [, ids] of world.slotsOf(queue.shift()!)) {
      for (const id of ids) {
        if (seen.has(id) || world.isProcess(id) || PID.test(id) || world.ephemeral.has(id)) {
          continue;
        }
        if (!world.made.has(id)) continue;
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return [...seen].sort();
}

/** A node's value, as the host reads it. */
function valueOf(world: World, id: string) {
  const r = world.read(id);
  return "value" in r ? r.value : undefined;
}

/** A value as canonical JSON: map keys sorted, and a pid only a pid. */
function canon(v: unknown): string {
  return JSON.stringify(
    v,
    (_, x) =>
      x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        : typeof x === "string" && /^@\d+-[a-z]{5}/.test(x)
        ? "@pid"
        : x,
  );
}

/** What the processes started from outside compute, by program, as canonical JSON, sorted. */
function computed(world: World): string[] {
  return [...world.running().keys()]
    .filter((pid) => world.procs.get(pid)!.by === undefined)
    .map((pid) => world.procs.get(pid)!.program.node + " " + canon(valueOf(world, pid)))
    .sort();
}

/** The programs the running processes run, by node, counted. */
function programs(world: World): string[] {
  return [...world.running().keys()].map((pid) => world.procs.get(pid)!.program.node).sort();
}

for (const ex of examples) {
  Deno.test(`${ex.id}: boots, runs to quiet, and reopens from what was kept`, async () => {
    const backend = memory();
    const world = new World({ backend: () => backend });
    world.reset({ keep: true });
    world.run(ex.code, `example: ${ex.title}`, "boot");
    await quiet(world);
    assertEquals(trouble(world), [], "the example ran without trouble");
    if (ex.id !== "blank") assert(world.running().size > 0, "it runs processes");
    for (const pid of world.running().keys()) {
      const front = world.front(pid);
      assert(!front.some((i) => "error" in i), `${pid} shows no error`);
    }

    // a reload: what was kept, loaded, and the boot image run for its starts
    await world.keeper!.flush();
    const image = world.image();
    const before = { data: data(world), programs: programs(world) };
    const values = computed(world);
    world.reset();
    const kept = await load(backend);
    assert(kept, "something was kept");
    const again = new World({ backend: () => backend });
    again.reset({ keep: true, kept });
    again.reopen(image, `reopen: ${ex.title}`);
    await quiet(again);
    assertEquals(trouble(again), [], "it reopened without trouble");
    assertEquals(data(again), before.data, "nothing kept is made twice, and nothing is lost");
    assertEquals(programs(again), before.programs, "the same programs run again");
    for (const pid of again.running().keys()) {
      assert(!world.procs.has(pid), `${pid} is a new process, with a new pid`);
    }
    // what the processes the boot image started compute, as before, but for their pids
    if (ex.id !== "slow") assertEquals(computed(again), values, "they compute what they did");
    // no process node from before the reload is still placed
    for (const id of again.reachable()) {
      if (PID.test(id)) assert(again.procs.has(id), `${id} from before the reload was taken out`);
    }
    again.reset();
  });
}

Deno.test("replace: a newer program, started again where the old one was", async () => {
  const world = new World({ backend: () => memory() });
  world.reset();
  world.run(examples.find((e) => e.id === "hello")!.code, "hello", "boot");
  await quiet(world);
  const counter = [...world.running().keys()].find((pid) =>
    world.procs.get(pid)!.program.node === "counter"
  )!;
  world.run(`set("counter", [], "compute", ${
    JSON.stringify(`export default function ({ api }) {
  const [clicks] = api.lookup({ name: "clicks" })
  return { n: api.read({ address: clicks.from.path })[0].value + 1000, at: clicks.from.path }
}`)
  })`);
  await quiet(world);
  assert(world.front(counter).some((i) => "newer" in i), "the counter shows newer");
  const s = world.run(`return replace(${JSON.stringify(counter)})`);
  assert(s.ok, s.error?.why);
  await quiet(world);
  const next = JSON.parse(s.result!);
  assert(world.running().has(next) && !world.running().has(counter), "the new one runs instead");
  assertEquals((valueOf(world, next) as { n: number }).n, 1000);
  world.fireFromWorld(next, "press");
  await quiet(world);
  assertEquals(valueOf(world, "clicks"), 1001, "a press writes through the handler");
  assertEquals(trouble(world), []);
  world.reset();
});
