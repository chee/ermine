// The same-thread loader (LOADERS.tex): how a part's code says it is source
// or an address, and loading a program whose compute and effect are two
// modules.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { pidOf, schedule, type Scheduler } from "../src/schedule.ts";
import { type Loader, moduleOf, type Program, sameThread, type StartOp } from "../src/loaders.ts";
import { ErmineError, type Json } from "../src/types.ts";

const cause = { file: "loaders_test.ts", line: 1, column: 1 };
const host = { agent: "host", cause };

function stack(loader: Loader): Scheduler {
  const g = graph("root");
  const s = schedule(protect(g, () => true), { "same-thread": loader }, { graph: g });
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
  s.place({ ...host, address: [], name: "out", id: "out", value: [] });
  return s;
}

const start = (s: Scheduler, program: Program) => {
  s.place({ ...host, address: ["programs"], name: "p", id: "p", value: program as Json });
  return s.start({ ...host, address: [], program: ["programs", "p"] } as StartOp);
};

const value = (s: Scheduler, address: string[]) =>
  s.read({ agent: "host", address }).find((i) => Object.hasOwn(i, "value"))?.value;

const tick = () => new Promise((r) => setTimeout(r, 5));

async function until(f: () => boolean) {
  for (let i = 0; i < 200 && !f(); i++) await tick();
  assert(f(), "timed out");
}

/** An importer whose modules load when the test says, each by its URL. */
function held() {
  const opens = new Map<string, () => void>();
  const asked: string[] = [];
  const importer = (url: string) => {
    asked.push(url);
    return new Promise<unknown>((resolve) => {
      opens.set(url, () => resolve(import(url)));
    });
  };
  const open = (code: string) => {
    const url = moduleOf(code).url;
    const f = opens.get(url);
    assert(f, "not asked for yet");
    f();
  };
  return { importer, open, asked };
}

/** A loader that tells the inner one each process's program, as a scheduler may (Running.code). */
function told(inner: Loader, program: () => Program): Loader {
  return {
    started: (p) => inner.started?.({ ...p, code: program() }),
    killed: (p) => inner.killed?.(p),
    load: (code, part, p) => inner.load(code, part, { ...p, code: program() }),
  };
}

/** A loader as a scheduler that does not hand loaders the program would make it. */
function untold(inner: Loader): Loader {
  const strip = (p: Parameters<NonNullable<Loader["started"]>>[0]) => {
    const { code: _code, ...rest } = p;
    return rest as typeof p;
  };
  return {
    started: (p) => inner.started?.(strip(p)),
    killed: (p) => inner.killed?.(p),
    load: (code, part, p) => inner.load(code, part, strip(p)),
  };
}

const COMPUTE = `// the compute: a comment first
export function compute({ api }) {
  return api.read({ address: ["/", "out"] })[0].value.length;
}`;
const EFFECT = `// the effect, another module
export function effect({ api, value }) {
  if (value === 0) api.write({ address: ["/", "out"], patches: [{ type: "splice", path: [], range: [0, 0], value: ["ran"] }] });
}`;

Deno.test("a part's code: a string is source, even one starting with a comment", async () => {
  assertEquals(
    moduleOf("// hi\nexport default () => 1").key,
    "source:// hi\nexport default () => 1",
  );
  assert(moduleOf("// hi").url.startsWith("data:text/javascript"));
  assertEquals(moduleOf({ import: "./x.js" }), { key: "import:./x.js", url: "./x.js" });
  for (const bad of [1, null, ["x"], { import: 1 }, { import: "a", also: 1 }]) {
    const e = assertThrows(() => moduleOf(bad as Json)) as ErmineError;
    assertEquals(e.why.code, "not-a-program");
  }
  const s = stack(sameThread());
  const pid = pidOf(
    start(s, { kind: "js", compute: "// one\nexport default () => 1" }).change.time,
  );
  await until(() => value(s, [pid]) === 1);
});

Deno.test('a part\'s code: {"import": address} imports the module there', async () => {
  const urls: string[] = [];
  const s = stack(sameThread((url) => {
    urls.push(url);
    return Promise.resolve({ default: () => 7 });
  }));
  const pid = pidOf(
    start(s, { kind: "js", compute: { import: "https://example.com/seven.js" } }).change.time,
  );
  await until(() => value(s, [pid]) === 7);
  assertEquals(urls, ["https://example.com/seven.js"]);
});

Deno.test("compute and effect as two modules, the effect's slower: told the program, no run fails", async () => {
  const { importer, open, asked } = held();
  const program = { kind: "js", compute: COMPUTE, effect: EFFECT };
  const s = stack(told(sameThread(importer), () => program));
  const started = start(s, program);
  const pid = pidOf(started.change.time);
  // both started loading at start
  assertEquals(asked.length, 2);
  assertEquals(started.runs.map((r) => r.ending), ["pending"]);
  open(COMPUTE);
  await tick();
  // the compute's module is there, the effect's is not: still pending, nothing failed
  assertEquals(value(s, [pid]), null);
  assert(!s.read({ agent: "host", address: [pid] }).some((i) => "error" in i));
  open(EFFECT);
  // the effect ran: out has one entry, so the compute's value is 1
  await until(() => value(s, [pid]) === 1);
  assertEquals(value(s, ["out"]), ["ran"]);
  assert(!s.read({ agent: "host", address: [pid] }).some((i) => "error" in i));
});

Deno.test("compute and effect as two modules, not told the program: the effect runs once it loads", async () => {
  const { importer, open } = held();
  const program = { kind: "js", compute: COMPUTE, effect: EFFECT };
  const s = stack(untold(sameThread(importer)));
  const pid = pidOf(start(s, program).change.time);
  open(COMPUTE);
  // the compute ran, and its effect, whose module had not loaded, failed the run
  await until(() => s.read({ agent: "host", address: [pid] }).some((i) => "error" in i));
  assertEquals(value(s, [pid]), 0);
  open(EFFECT);
  // the answer marks the process, whose effect now runs: before, it was placed, hit exists, and nothing ran
  await until(() => value(s, [pid]) === 1);
  assertEquals(value(s, ["out"]), ["ran"]);
  assert(!s.read({ agent: "host", address: [pid] }).some((i) => "error" in i));
});

Deno.test("the answer node is written each time a module loads, placed only the first", async () => {
  const { importer, open } = held();
  const A = `export const compute = () => 1`;
  const B = `export const effect = () => {}`;
  const program = { kind: "js", compute: A, effect: B };
  const s = stack(told(sameThread(importer), () => program));
  const pid = pidOf(start(s, program).change.time);
  open(A);
  await until(() => value(s, [pid, "loaded"]) === true);
  const first = s.read({ agent: "host", address: [pid, "loaded"] })[0].change!;
  assertEquals(first.kind, "place");
  open(B);
  await until(() => value(s, [pid]) === 1);
  const second = s.read({ agent: "host", address: [pid, "loaded"] })[0].change!;
  assertEquals(second.kind, "write");
  assert(second.time > first.time);
});

Deno.test("a killed process is not answered, though a wrapping loader copied what it was told", async () => {
  const { importer, open } = held();
  const program = { kind: "js", compute: COMPUTE };
  const s = stack(told(sameThread(importer), () => program));
  const pid = pidOf(start(s, program).change.time);
  s.unplace({ ...host, address: [], name: pid, id: pid });
  open(COMPUTE);
  await tick();
  assertEquals(s.read({ agent: "host", address: [pid] }), []);
});
