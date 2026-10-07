// The local cache of compute results (plans/cache.org): a loader wrapper that
// replays a recorded run's reads and, where they give the same answers, returns
// the value without running the code.

import { assert, assertEquals } from "@std/assert";
import { graph } from "../src/graph.ts";
import { memory } from "../src/keeper.ts";
import {
  builtin,
  type ComputeGiven,
  type EffectGiven,
  type Loader,
  sameThread,
} from "../src/loaders.ts";
import { pidOf, schedule, type Scheduler } from "../src/schedule.ts";
import { cached, type Hit, source, type Stats, type Store, store } from "../src/cache/mod.ts";
import type { Json, Patch } from "../src/types.ts";

const host = { agent: "host", cause: { file: "cache_test.ts", line: 1, column: 1 } };

/** How many times each program's code ran. */
let ran: { [name: string]: number } = {};
const count = (name: string) => ran[name] = (ran[name] ?? 0) + 1;

const table = {
  // the length of /a's value, as a stand-in for expensive work
  len: {
    compute: ({ api }: ComputeGiven) => {
      count("len");
      return (api.read({ address: ["/", "a"] })[0].value as string).length;
    },
  },
  // a dynamic dependency: /flag picks which of /x and /y it reads
  pick: {
    compute: ({ api }: ComputeGiven) => {
      count("pick");
      const flag = api.read({ address: ["/", "flag"] })[0].value;
      return api.read({ address: ["/", flag ? "x" : "y"] })[0].value;
    },
  },
  // looks at the change that made /a: the step keeps it
  when: {
    compute: ({ api }: ComputeGiven) => {
      count("when");
      const [item] = api.read({ address: ["/", "a"] });
      return [item.value, item.change!.agent];
    },
  },
  // has an effect: never cached
  both: {
    compute: ({ api }: ComputeGiven) => {
      count("both");
      return api.read({ address: ["/", "a"] })[0].value;
    },
    effect: (_: EffectGiven) => {},
  },
  // reads a name that is not there: pending, never kept
  wait: {
    compute: ({ api, pending }: ComputeGiven) => {
      count("wait");
      const items = api.read({ address: ["/", "later"] });
      return items.length ? items[0].value : pending;
    },
  },
  // its own pid in its value: keyed by it
  me: {
    compute: ({ api, name }: ComputeGiven) => {
      count("me");
      return [name, api.read({ address: ["/", "a"] })[0].value];
    },
  },
  // tells whether the root has been written, by whether its item has a change, not by the change
  first: {
    compute: ({ api }: ComputeGiven) => {
      count("first");
      const [root] = api.read({ address: [] });
      return "change" in root ? "written" : "first";
    },
  },
  // reads in an order no answer decides
  fickle: {
    compute: ({ api }: ComputeGiven) => {
      const n = count("fickle");
      return api.read({ address: ["/", n % 2 ? "x" : "y"] })[0].value;
    },
  },
};

const codes: { [name: string]: string } = Object.fromEntries(
  Object.keys(table).map((k) => [k, k]),
);

function stack(s?: Store, onhit?: (h: Hit) => void, given?: Loader & { stats: Stats }) {
  // the table is fixed in this test, so a name is what the code is
  const loader = given ??
    cached(builtin(table), { store: s!, key: (code) => code as string, onhit });
  const g = graph("root");
  const api = schedule(g, { host: loader as Loader }, { graph: g });
  api.top(api);
  api.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
  api.place({ ...host, address: ["loaders"], name: "host", id: "lh", value: { loader: "host" } });
  api.place({ ...host, address: [], name: "programs", id: "programs", value: null });
  for (const [name, b] of Object.entries(table)) {
    const value: { [k: string]: Json } = { kind: "host", compute: codes[name] };
    if ("effect" in b) value.effect = codes[name];
    api.place({ ...host, address: ["programs"], name, id: `p/${name}`, value });
  }
  for (const [name, value] of [["a", "hello"], ["flag", true], ["x", "ex"], ["y", "why"]]) {
    api.place({ ...host, address: [], name: name as string, id: name as string, value });
  }
  return { api, stats: loader.stats };
}

const start = (api: Scheduler, program: string) =>
  pidOf(api.start({ ...host, address: [], program: ["programs", program] }).change.time);

const set = (api: Scheduler, name: string, value: Json) =>
  api.write({ ...host, address: [name], patches: [{ type: "snapshot", value } as Patch] });

const value = (api: Scheduler, pid: string) =>
  api.read({ agent: "host", address: [pid] }).find((i) => Object.hasOwn(i, "value"))?.value;

Deno.test("contents seen before: the value comes from the cache, and the code does not run", async () => {
  ran = {};
  const hits: Hit[] = [];
  const { api, stats } = stack(await store(), (h) => hits.push(h));
  const pid = start(api, "len");
  assertEquals(value(api, pid), 5);
  set(api, "a", "hi");
  assertEquals(value(api, pid), 2);
  assertEquals(ran.len, 2);
  // a new change, the same contents as the first: a hit
  const back = set(api, "a", "hello");
  assertEquals(value(api, pid), 5);
  assertEquals(ran.len, 2);
  assertEquals(stats.hits, 1);
  assertEquals(hits.length, 1);
  assertEquals(hits[0].process, pid);
  assertEquals(hits[0].from.process, pid);
  // the replayed read is in the record, and is kept: a write marks it as before
  const rec = back.runs.find((r) => r.process === pid)!;
  assertEquals(rec.reads.map((r) => r.address), [["/", "a"]]);
  assertEquals(rec.value, 5);
  set(api, "a", "three");
  assertEquals(value(api, pid), 5);
  assertEquals(ran.len, 3);
});

Deno.test("a second process running the same program on the same contents: a hit at start", async () => {
  ran = {};
  const { api, stats } = stack(await store());
  start(api, "len");
  const two = start(api, "len");
  assertEquals(value(api, two), 5);
  assertEquals(ran.len, 1);
  assertEquals(stats.hits, 1);
});

Deno.test("a dynamic dependency: each branch is kept, and replay follows the one the reads choose", async () => {
  ran = {};
  const { api, stats } = stack(await store());
  const pid = start(api, "pick");
  assertEquals(value(api, pid), "ex");
  set(api, "flag", false);
  assertEquals(value(api, pid), "why");
  set(api, "flag", true);
  set(api, "flag", false);
  assertEquals(value(api, pid), "why");
  assertEquals(ran.pick, 2);
  assertEquals(stats.hits, 2);
  // /y changed: the replay reads /flag, then /y, finds no branch, and runs once, reading each once
  const r = set(api, "y", "zed").runs.find((r) => r.process === pid)!;
  assertEquals(value(api, pid), "zed");
  assertEquals(ran.pick, 3);
  assertEquals(r.reads.map((x) => x.address), [["/", "flag"], ["/", "y"]]);
});

Deno.test("a compute that looks at an item's change is keyed by the change too", async () => {
  ran = {};
  const { api, stats } = stack(await store());
  const pid = start(api, "when");
  set(api, "a", "hi");
  set(api, "a", "hello");
  assertEquals(value(api, pid), ["hello", "host"]);
  assertEquals(ran.when, 3);
  assertEquals(stats.hits, 0);
});

Deno.test("not cached: a program with an effect, and pending", async () => {
  ran = {};
  const { api, stats } = stack(await store());
  const both = start(api, "both");
  set(api, "a", "hi");
  set(api, "a", "hello");
  assertEquals(value(api, both), "hello");
  assertEquals(ran.both, 3);
  const wait = start(api, "wait");
  start(api, "wait");
  assertEquals(ran.wait, 2);
  assertEquals(stats.hits, 0);
  // once there is a value, it is kept: the second process hits it
  api.place({ ...host, address: [], name: "later", id: "later", value: 1 });
  assertEquals(value(api, wait), 1);
  assertEquals(ran.wait, 3);
  assertEquals(stats.hits, 1);
});

Deno.test("a compute that uses its pid is keyed by it: another process misses", async () => {
  ran = {};
  const { api, stats } = stack(await store());
  start(api, "me");
  start(api, "me");
  assertEquals(ran.me, 2);
  assertEquals(stats.hits, 0);
});

Deno.test("a run that reads in another order than the replay is not kept", async () => {
  ran = {};
  const { api, stats } = stack(await store());
  const pid = start(api, "fickle");
  assertEquals(value(api, pid), "ex");
  // the replay reads /x, the code reads /y: diverged, the value is the code's, nothing kept
  set(api, "x", "ex2");
  assertEquals(value(api, pid), "why");
  assertEquals(stats.diverged, 1);
  assertEquals(stats.stored, 1);
  // the replay's read of /x is in the record, so this marks it: the first run's leaf, which the
  // cache cannot know is wrong for code that reads behind the interface's back
  set(api, "x", "ex");
  assertEquals(value(api, pid), "ex");
  assertEquals(stats.hits, 1);
});

Deno.test("kept in a backend: a new graph with the same contents hits, with no code run", async () => {
  ran = {};
  const backend = memory();
  const first = await store(backend);
  const one = stack(first);
  start(one.api, "len");
  await first.flush();
  assert(backend.records.size > 0);
  const again = await store(backend);
  const two = stack(again);
  const pid = start(two.api, "len");
  assertEquals(value(two.api, pid), 5);
  assertEquals(ran.len, 1);
  assertEquals(two.stats.hits, 1);
});

Deno.test("past the budget the least used entries go", async () => {
  ran = {};
  const s = await store();
  const loader = cached(builtin(table), { store: s, key: (c) => c as string, budget: 200 });
  const g = graph("root");
  const api = schedule(g, { host: loader as Loader }, { graph: g });
  api.top(api);
  api.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
  api.place({ ...host, address: ["loaders"], name: "host", id: "lh", value: { loader: "host" } });
  api.place({ ...host, address: [], name: "programs", id: "programs", value: null });
  api.place({
    ...host,
    address: ["programs"],
    name: "len",
    id: "pl",
    value: { kind: "host", compute: "len" },
  });
  api.place({ ...host, address: [], name: "a", id: "a", value: "x" });
  start(api, "len");
  for (let i = 0; i < 20; i++) set(api, "a", "x".repeat(i + 2));
  assert(s.bytes <= 200);
  assert(loader.stats.evicted > 0);
});

Deno.test("one cache serving two graphs: the same node at the same time is not the same value", async () => {
  ran = {};
  const loader = cached(builtin(table), { store: await store(), key: (c) => c as string });
  const one = stack(undefined, undefined, loader);
  set(one.api, "a", "hi");
  assertEquals(value(one.api, start(one.api, "len")), 2);
  // the same ids, made at the same times, in another graph, with other contents
  const two = stack(undefined, undefined, loader);
  set(two.api, "a", "hey!");
  assertEquals(value(two.api, start(two.api, "len")), 4);
  assertEquals(ran.len, 2);
});

Deno.test("whether an item has a change is in the key, though the change is not", async () => {
  ran = {};
  const { api, stats } = stack(await store());
  const pid = start(api, "first");
  assertEquals(value(api, pid), "first");
  // the root's value is the same, and now it has a change
  api.write({ ...host, address: [], patches: [{ type: "snapshot", value: null } as Patch] });
  assertEquals(value(api, pid), "written");
  assertEquals(stats.hits, 0);
});

Deno.test("with no key, nothing is cached: a builtin's name is not what its code is", async () => {
  ran = {};
  const loader = cached(builtin(table), { store: await store() });
  const { api } = stack(undefined, undefined, loader);
  start(api, "len");
  start(api, "len");
  assertEquals(ran.len, 2);
  assertEquals(loader.stats.hits + loader.stats.misses, 0);
});

Deno.test("the same-thread loader, keyed by source: a hit once the module is there, and before", async () => {
  const code =
    `export const compute = ({ api }) => api.read({ address: ["/", "a"] })[0].value + "!";`;
  const s = await store();
  const run = () => {
    const loader = cached(sameThread(), { store: s, key: source });
    const g = graph("root");
    const api = schedule(g, { js: loader as Loader }, { graph: g });
    api.top(api);
    api.place({ ...host, address: [], name: "loaders", id: "loaders", value: null });
    api.place({ ...host, address: ["loaders"], name: "js", id: "lj", value: { loader: "js" } });
    api.place({ ...host, address: [], name: "programs", id: "programs", value: null });
    api.place({
      ...host,
      address: ["programs"],
      name: "bang",
      id: "pb",
      value: { kind: "js", compute: code },
    });
    api.place({ ...host, address: [], name: "a", id: "a", value: "hello" });
    const pid = start(api, "bang");
    return { api, pid, loader };
  };
  const one = run();
  for (let i = 0; i < 50 && value(one.api, one.pid) == null; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  assertEquals(value(one.api, one.pid), "hello!");
  assertEquals(one.loader.stats.stored, 1);
  // a new loader, its module not loaded: the value is there at once
  const two = run();
  assertEquals(value(two.api, two.pid), "hello!");
  assertEquals(two.loader.stats.hits, 1);
});
