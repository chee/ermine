// the agent (src/page.js) without a browser: Deno's global is the page's window (EventTarget,
// CustomEvent), the agent evaluated into it as inspectedWindow.eval would, the graphs answering
// through answer.ts. what it gives must be JSON, as eval hands it over.
//
//   deno task test
import { assert, assertEquals } from "@std/assert";
import { devtools } from "./answer.ts";
import { make, put, val } from "../demos/shape/lib/host.ts";
import { createWorld } from "@ermine/slaygrounds/world";
import type { Policy } from "@ermine/protect";

// deno-lint-ignore no-explicit-any
type Any = any;

const source = await Deno.readTextFile(new URL("./src/page.js", import.meta.url));
// as the panel does: an eval in the page's global scope
const install = () => (0, eval)(source);
const agent = (): Any => (globalThis as Any).__ermine_devtools;
// plain data only: what JSON keeps (an undefined field is left out, as eval's JSON leaves it)
function plain(v: unknown, at = "result"): void {
  if (v === null || typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number") return assert(Number.isFinite(v), `${at}: ${v}`);
  if (Array.isArray(v)) return v.forEach((x, i) => plain(x, `${at}[${i}]`));
  assert(typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype, `${at}: not data`);
  for (const [k, x] of Object.entries(v as object)) if (x !== undefined) plain(x, `${at}.${k}`);
}
// a call as the panel makes it: arguments and result through JSON
function call<T = Any>(method: string, ...args: unknown[]): T {
  const r = agent()[method](...args.map((a) => JSON.parse(JSON.stringify(a))));
  plain(r, method);
  return JSON.parse(JSON.stringify(r ?? null));
}
const settle = () => new Promise((r) => setTimeout(r, 0));
// each graph shown through answer.ts, and each test from none: what an earlier one left stopped
const stops: (() => void)[] = [];
const show = (host: unknown, o: { name: string }) => {
  const stop = devtools(host, o);
  stops.push(stop);
  return stop;
};
const fresh = () => {
  for (const stop of stops.splice(0)) stop();
  agent()?.stop();
};

// a shape-demo host: /data/a and /data/b, /calc/sum reading both, a handler at /on/bump
function shapeHost() {
  const s = make();
  const data = put(s, "root", "data", null);
  put(s, data, "a", 1);
  put(s, data, "b", 2);
  put(s, "root", "calc", null);
  const on = put(s, "root", "on", null);
  put(s, on, "bump", ({ api }: Any) => {
    api.write(["/", "data", "a"], [{ path: [], value: val<number>(api, ["/", "data", "a"]) + 1 }]);
    return "bumped";
  });
  s.start({
    address: ["calc"],
    name: "sum",
    program: {
      compute: ({ api }: Any) =>
        val<number>(api, ["..", "data", "a"]) + val<number>(api, ["..", "data", "b"]),
    },
  });
  return s;
}
const row = (t: Any, path: string[]) =>
  t.rows.find((r: Any) => JSON.stringify(r.path) === JSON.stringify(path));

Deno.test("handshake: a page answering before the agent comes, and one answering late", () => {
  fresh();
  const s = shapeHost();
  const stop = show(s, { name: "shape" });
  install();
  assertEquals(call("status").graphs.map((g: Any) => g.name), ["shape"]);
  assertEquals(call("status").graphs[0].kind, "host");
  // evaluated again: the same agent, nothing doubled
  install();
  agent().ask();
  assertEquals(call("status").graphs.length, 1);
  // one more, after: found when the agent asks again; its name made its own
  const late = show(shapeHost(), { name: "shape" });
  assertEquals(call("status").graphs.length, 1);
  assertEquals(agent().ask(), 2);
  assertEquals(call("status").graphs.map((g: Any) => g.name), ["shape", "shape 2"]);
  late();
  stop();
  assertEquals(call("status").graphs, []);
});

Deno.test("host: tree, pick lights reads and readers, moments in words", () => {
  fresh();
  const s = shapeHost();
  const stop = show(s, { name: "shape" });
  install();
  agent().ask();
  const t = call("tree", "shape", { open: [] });
  const a = row(t, ["data", "a"]);
  const sum = row(t, ["calc", "sum"]);
  assertEquals(a.value, ["vn", "1"]);
  assertEquals(sum.kind, "proc");
  assertEquals(sum.value, ["vn", "3"]);
  assertEquals(typeof sum.run, "number");
  assertEquals(row(t, ["on"]).folded, true);
  // the process: what it read; the input: who reads it
  const d = call("pick", "shape", { path: sum.path, k: 0, id: sum.id });
  assert(d.lit.reads.includes(a.id), "sum reads a");
  assertEquals(d.can, { kill: true, replace: true, call: false, write: false });
  const da = call("pick", "shape", { path: a.path, k: 0, id: a.id });
  assertEquals(da.lit.readers, [sum.id]);
  assertEquals(da.versions[0].text, "1");
  assert(da.can.write);
  // a change: sum runs again, told in words
  s.write(["/", "data", "b"], [{ path: [], value: 3 }]);
  const m = call("moments", "shape", 0);
  assert(m.list.some((x: Any) => x.text.includes("calc/sum → done")), JSON.stringify(m.list));
  stop();
});

Deno.test("host: write, call, replace and kill go through the host", async () => {
  fresh();
  const s = shapeHost();
  const stop = show(s, { name: "shape" });
  install();
  agent().ask();
  let t = call("tree", "shape", {});
  const a = row(t, ["data", "a"]);
  assert("ok" in call("act", "shape", "write", { path: a.path, k: 0, id: a.id, value: 10 }));
  assertEquals(val(s, ["data", "a"]), 10);
  assertEquals(val(s, ["calc", "sum"]), 12);
  const r = call("act", "shape", "call", { path: ["on", "bump"] });
  assertEquals(r, { ok: "bumped" });
  assertEquals(val(s, ["calc", "sum"]), 13);
  t = call("tree", "shape", {});
  const sum = row(t, ["calc", "sum"]);
  assertEquals(call("act", "shape", "replace", { path: sum.path }), { ok: null });
  assertEquals(call("act", "shape", "kill", { id: sum.id }), { ok: null });
  await settle();
  t = call("tree", "shape", {});
  assertEquals(row(t, ["calc", "sum"]), undefined);
  const words = call("moments", "shape", 0).list.map((x: Any) => x.text);
  assert(words.some((w: string) => w.startsWith("✕") && w.includes("gone")), words.join("\n"));
  // a refusal of the host's own is an error, not a throw across eval
  assert("error" in call("act", "shape", "kill", { id: "nobody" }));
  stop();
});

Deno.test("host: the map and the scheduler's shape as JSON", () => {
  fresh();
  const s = shapeHost();
  const stop = show(s, { name: "shape" });
  install();
  agent().ask();
  const m = call("map", "shape", {});
  const sum = m.cards.find((c: Any) => c.name === "sum");
  const a = m.cards.find((c: Any) => c.name === "a");
  assert(m.reads.some((r: Any) => r.from === sum.key && r.to === a.key), "a read edge sum → a");
  for (const mode of ["values", "keys", "owners"]) {
    const sh = call("shape", "shape", mode);
    assert(sh.boxes.length > 0, mode);
  }
  const keys = call("shape", "shape", "keys");
  assert(keys.boxes.some((b: Any) => b.kind === "key" && b.label === "data/a"), "a's key named");
  const owners = call("shape", "shape", "owners", call("shape", "shape", "owners").boxes[0].key);
  assert(owners.about.length > 0);
  stop();
});

Deno.test("api: a world on the process api, protect asked, a method called, a process killed", async () => {
  const secret: Policy = (ask) =>
    ask.op === "read" && ask.target.path?.join("/") === "secret/key"
      ? { answer: "no", reason: "secret" }
      : { answer: "yes" };
  fresh();
  const w = createWorld({ render: () => {}, processes: [{ name: "demo" }], may: secret });
  w.seed((host) => {
    host.open("/data/n", 21);
    host.open("/secret/key", "hush");
  });
  w.reload({
    default: (api: Any) => {
      const n = api.open("./data/n");
      api.memo("double", () => api.read(n) * 2);
      api.method("on/bump", () => api.edit(n, [{ path: [], value: api.peep(n) + 1 }]));
      return "hi";
    },
  });
  await settle();
  const stop = show(w.world, { name: "slay" });
  install();
  agent().ask();
  assertEquals(call("status").graphs[0].kind, "api");
  const t = call("tree", "slay", { open: ["/demo/on#0"] });
  assertEquals(row(t, ["data", "n"]).value, ["vn", "21"]);
  assertEquals(row(t, ["demo"]).kind, "proc");
  const double = row(t, ["demo", "double"]);
  assertEquals(double.kind, "comp");
  assertEquals(double.value, ["vn", "42"]);
  assert(
    row(t, ["secret", "key"])?.refused,
    JSON.stringify(t.rows.filter((r: Any) => r.path[0] === "secret")),
  );
  const n = row(t, ["data", "n"]);
  const d = call("pick", "slay", { path: double.path, k: 0, id: double.id });
  assert(d.lit.reads.includes(n.id), "double reads n");
  assertEquals(row(t, ["demo", "on", "bump"]).kind, "fn");
  assertEquals(call("act", "slay", "call", { path: ["demo", "on", "bump"] }), { ok: null });
  await settle();
  assertEquals(row(call("tree", "slay", {}), ["demo", "double"]).value, ["vn", "44"]);
  assert(call("moments", "slay", 0).list.some((x: Any) => x.text.includes("demo/double")));
  assert(call("shape", "slay", "values").boxes.length > 0);
  const demo = row(t, ["demo"]);
  assertEquals(call("act", "slay", "kill", { id: demo.id }), { ok: null });
  await settle();
  assertEquals(row(call("tree", "slay", {}), ["demo"]), undefined);
  stop();
});
