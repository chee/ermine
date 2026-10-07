/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
// ermine/dom against a real graph and the reference scheduler, in a DOM from
// linkedom. JSX is an effect scope: every view here is rendered from a
// program's effect, and each bound part is a scope the scheduler runs, whose
// record says what it read (ts/demo/dom.org, Scopes). Handles over an
// interface bound as alice write as alice, from the line that wrote.

import { assert, assertEquals, assertExists } from "@std/assert";
// deno-lint-ignore no-import-prefix no-unversioned-import -- the lock has it already, as npm:linkedom@*
import { parseHTML } from "npm:linkedom";
import { graph } from "../src/graph.ts";
import { protect } from "../src/protect.ts";
import { schedule, type Scheduler } from "../src/schedule.ts";
import { type Builtin, builtin, type EffectGiven, type Loaded } from "../src/loaders.ts";
import type { Header, Interface, Json, Record, Site } from "../src/types.ts";
import { each, Fragment, h, node, render, type Scope, why } from "../src/dom/mod.ts";

void Fragment;

const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
const click = (el: Element) => el.dispatchEvent(new window.Event("click", { bubbles: true }));

const host = { agent: "host", cause: { file: "dom_test.tsx", line: 1, column: 1 } };

/** A program that only draws: its compute reads nothing, its effect runs draw once. */
const view = (draw: (ctx: EffectGiven) => unknown): Builtin => ({
  compute: (() => null) as Loaded,
  effect: ((ctx: EffectGiven) => void draw(ctx)) as unknown as Loaded,
});

/** A stack with the builtin loader over these programs, and a handle-maker bound as alice. */
function stack(table: { [name: string]: Builtin } = {}) {
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
  const alice: Interface = s.bind(s, { agent: "alice", writes: true });
  const start = (name: string) => {
    const started = s.start({ ...host, address: [], program: ["programs", name] });
    return (started.change as { id: string }).id;
  };
  /** Every scope record sent to the process's subscribers. */
  const records = (pid: string) => {
    const out: Record[] = [];
    s.subscribe({
      agent: "host",
      address: [pid],
      send: (e) => "record" in e && e.record.process.startsWith(`${pid}#`) && out.push(e.record),
    });
    return out;
  };
  const write = (name: string, value: Json) =>
    s.write({ ...host, address: [name], patches: [{ type: "snapshot", value }] });
  return { s, alice, start, records, write };
}

const stage = () => {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
};

/** The line of this file that holds text: where a handler's write should say it came from. */
const lineOf = (text: string) =>
  Deno.readTextFileSync(new URL(import.meta.url)).split("\n").findIndex((l) => l.includes(text)) +
  1;

const valueReads = (r: Record) => r.reads.filter((x) => x.op === "read").map((x) => x.address);

Deno.test("chee's button: a click writes, only that text's scope runs, and the text leads back", () => {
  const root = stage();
  const { s, start, records, ...rest } = stack({
    button: view((ctx) => {
      const count = node(rest.alice, "count");
      // deno-lint-ignore jsx-button-has-type -- the line as chee wrote it
      render(() => <button onClick={() => count((n) => n + 1)}>{count}</button>, root, ctx);
    }),
  });
  s.place({ ...host, address: [], name: "count", id: "count", value: 0 });
  const pid = start("button");

  const button = root.querySelector("button")!;
  assertEquals(root.textContent, "0");
  const text = [...button.childNodes].find((n) => n.nodeType === 3 && n.textContent === "0")!;
  assertExists(text);
  const before = [...button.childNodes];
  const runs = records(pid);

  click(button);
  assertEquals(root.textContent, "1");
  // one run, of the text's scope: the process did not run, nor did the render's root
  assertEquals(runs.length, 1);
  const [rec] = runs;
  assertEquals(rec.ending, "done");
  assertEquals(valueReads(rec), [["count"]]);
  const now = s.read({ agent: "host", address: ["count"] })[0].change as Header;
  assertEquals(rec.reads.find((r) => r.op === "read")!.saw, now.time);
  assertEquals(rec.marked, [now.time]);

  click(button);
  assertEquals(root.textContent, "2");
  assertEquals(runs.map((r) => r.process), [rec.process, rec.process]);
  // the same button, the same nodes in it, and the same text node, now saying 2
  assertEquals(root.querySelector("button"), button);
  assertEquals([...button.childNodes], before);
  assertEquals(text.textContent, "2");

  // the text node leads back, through its scope's record, to count and the change that set it
  const w = why(text)!;
  assertEquals(w.node, text);
  const [r] = w.reasons;
  assertEquals(r.path, ["count"]);
  assertEquals(r.node, "count");
  assertEquals(r.route, [{ parent: "root", name: "count", node: "count", position: 0 }]);
  const last = s.read({ agent: "host", address: ["count"] })[0].change as Header;
  assertEquals(r.change, last);
  assertEquals(r.change!.time, runs[1].reads.find((x) => x.op === "read")!.saw);
  assertEquals(r.change!.agent, "alice");
  const site = r.change!.cause as Site;
  assert(site.file.endsWith("dom_test.tsx"), site.file);
  assertEquals(site.line, lineOf("<button onClick={() => count((n) => n + 1)}>"));
  // a click target finds the same
  assertEquals(why(button)!.reasons[0].change, last);
});

Deno.test("a scope that reads a process runs after it, in the same round", () => {
  const doubled: Builtin = {
    compute: (({ api }) => (api.read({ address: ["count"] })[0]?.value as number) * 2) as Loaded,
  };
  const root = stage();
  let pid = "";
  const { s, start, records, write, ...rest } = stack({
    doubled,
    page: view((ctx) => {
      const count = node(rest.alice, "count");
      const twice = node(rest.alice, pid);
      render(
        () => (
          <p>
            <b>{count}</b>×2=<i>{twice}</i>{" "}
            <span class={() => (count() as number) > 1 ? "big" : "small"}>
              {() => (twice() as number) + 1}
            </span>
          </p>
        ),
        root,
        ctx,
      );
    }),
  });
  s.place({ ...host, address: [], name: "count", id: "count", value: 1 });
  pid = start("doubled");
  const page = start("page");
  const i = root.querySelector("i")!, span = root.querySelector("span")!;
  assertEquals(i.textContent, "2");
  assertEquals(span.getAttribute("class"), "small");
  assertEquals(span.textContent, "3");
  const runs = records(page);
  const done = write("count", 5);
  assertEquals(i.textContent, "10");
  assertEquals(span.getAttribute("class"), "big");
  assertEquals(span.textContent, "11");
  // count's write marked doubled and the scopes reading count; doubled ran first, then
  // the scopes reading it, each once: none saw a waiting item or the old value
  const order = done.runs.map((r) => r.process);
  const readsTwice = runs.filter((r) => valueReads(r).some((a) => a[0] === pid));
  assertEquals(readsTwice.length, 2);
  for (const r of readsTwice) assert(order.indexOf(pid) < order.indexOf(r.process), order.join());
  assertEquals(new Set(runs.map((r) => r.process)).size, runs.length, "each scope ran once");
  // the process's value says which run of it made it
  const r = why(i.firstChild!)!.reasons[0];
  assertEquals(r.node, pid);
  assertEquals((r.by as { process: string; run: number }).process, pid);
  assertEquals((r.by as { run: number }).run, 2);
  // an accessor's text knows both values it read
  assertEquals(why(span)!.reasons.map((x) => x.path).sort(), [["count"], [pid]].sort());
});

Deno.test("pending and error items render as marks in front of the value", () => {
  const slow: Builtin = {
    compute:
      (({ api, pending }) => api.read({ address: ["later"] })[0]?.value ?? pending) as Loaded,
  };
  const broken: Builtin = {
    compute: (({ api }) => {
      if (api.read({ address: ["fine"] })[0]?.value !== true) throw new Error("not fine");
      return "fine";
    }) as Loaded,
  };
  const root = stage();
  const ids: string[] = [];
  const { s, start, ...rest } = stack({
    slow,
    broken,
    page: view((ctx) =>
      render(
        () => (
          <div>
            <p>{node(rest.alice, ids[0])}</p>
            <p>{node(rest.alice, ids[1])}</p>
          </div>
        ),
        root,
        ctx,
      )
    ),
  });
  s.place({ ...host, address: [], name: "fine", id: "fine", value: false });
  ids.push(start("slow"), start("broken"));
  start("page");
  const [a, b] = [...root.querySelectorAll("p")];
  assertExists(a.querySelector(".ermine-waiting"));
  assertExists(b.querySelector(".ermine-error"));
  assertEquals(b.querySelector(".ermine-error")!.getAttribute("title"), "not fine");
  // the mark leads back to the item it shows
  assert("waiting" in why(a.querySelector(".ermine-waiting")!)!.reasons[0].item!);

  // any write redraws before it returns: the scheduler ran the scopes
  s.place({ ...host, address: [], name: "later", id: "later", value: "here" });
  assertEquals(a.querySelector(".ermine-waiting"), null);
  assertEquals(a.textContent, "here");
  node(rest.alice, "fine")(true);
  assertEquals(b.querySelector(".ermine-error"), null);
  assertEquals(b.textContent, "fine");
});

Deno.test("a slot renders its members in order; placing one adds it; a mounted one is pending", () => {
  const root = stage();
  const { s, start, alice } = stack({
    page: view((ctx) => render(() => <ul>{node(alice, "notes")}</ul>, root, ctx)),
  });
  s.place({ ...host, address: [], name: "notes", id: "n1", value: "one" });
  s.place({ ...host, address: [], name: "notes", id: "n2", value: "two" });
  start("page");
  const notes = node(alice, "notes");
  const ul = root.querySelector("ul")!;
  assertEquals(ul.textContent, "onetwo");
  const one = [...ul.childNodes].find((n) => n.textContent === "one")!;

  notes.at("..").place("notes", "n0", "zero", { position: 0 });
  assertEquals(ul.textContent, "zeroonetwo");
  notes.at("..").place("notes", "elsewhere"); // mounted, not here
  assertExists(ul.querySelector(".ermine-pending"));
  assertEquals(
    ul.querySelector(".ermine-pending")!.getAttribute("title"),
    "elsewhere is not here yet",
  );
  // each member's text leads to its own member
  const two = [...ul.childNodes].find((n) => n.textContent === "two")!;
  assertEquals(why(two)!.reasons[0].node, "n2");
  // one's value was set by the placement that made it
  assertEquals(why(one)!.reasons[0].change!.kind, "place");
});

Deno.test("each: a row per name, with a handle on it; rows are the list's scope's children", () => {
  const root = stage();
  const { s, start, alice } = stack({
    page: view((ctx) =>
      render(
        () => <ol>{each(node(alice, "todos"), (t, name) => <li title={name}>{t}</li>)}</ol>,
        root,
        ctx,
      )
    ),
  });
  s.place({ ...host, address: [], name: "todos", id: "todos", value: null });
  s.place({ ...host, address: ["todos"], name: "a", id: "a", value: "milk" });
  const pid = start("page");
  const todos = node(alice, "todos");
  assertEquals([...root.querySelectorAll("li")].map((l) => l.textContent), ["milk"]);
  todos.place("b", "b", "eggs");
  assertEquals([...root.querySelectorAll("li")].map((l) => l.textContent), ["milk", "eggs"]);
  const milk = root.querySelector("li")!;
  todos.at("a")("oat milk");
  assertEquals(root.querySelector("li"), milk);
  assertEquals(milk.textContent, "oat milk");
  // the first row's scope was disposed when the list ran again: a's first row reads nothing now
  const marked = todos.at("a")("milk").marked.map((m) => m.process).filter((p) => p !== pid);
  assertEquals(marked.length, 1, "only the live row's scope is marked");
});

Deno.test("disposing the render disposes the nested scopes: their reads are forgotten", () => {
  const root = stage();
  let drawn: Scope | undefined;
  const { s, start, write, records, alice } = stack({
    page: view((ctx) => {
      const show = node(alice, "show"), count = node(alice, "count");
      drawn = render(
        () => <div>{() => show() ? <b title={() => `n${count()}`}>{count}</b> : "hidden"}</div>,
        root,
        ctx,
      );
    }),
  });
  s.place({ ...host, address: [], name: "show", id: "show", value: true });
  s.place({ ...host, address: [], name: "count", id: "count", value: 1 });
  const pid = start("page");
  const runs = records(pid);
  assertEquals(root.querySelector("b")!.getAttribute("title"), "n1");
  assertEquals(root.textContent, "1");
  // count marks the nested scopes: the b's text and its title
  assertEquals(write("count", 2).marked.filter((m) => m.process.startsWith(pid)).length, 2);
  assertEquals(root.querySelector("b")!.getAttribute("title"), "n2");
  // hidden: the scope that made the b runs again and disposes them; count marks nothing
  write("show", false);
  assertEquals(root.textContent, "hidden");
  assertEquals(write("count", 3).marked, []);
  write("show", true);
  assertEquals(root.textContent, "3");
  runs.length = 0;
  // the render undone: every scope disposed, nothing marked, nothing run, the DOM taken out
  drawn!();
  assertEquals(root.childNodes.length, 0);
  assertEquals(write("count", 4).marked, []);
  assertEquals(write("show", false).marked, []);
  assertEquals(runs, []);
});

Deno.test("rendered over its lasting interface: a click is the process's; a kill takes the view out", () => {
  const root = stage();
  const { s, start } = stack({
    panel: view((ctx) => {
      const n = node(ctx.lasting, "n");
      render(
        () => <button type="button" onClick={() => n((v) => v + 1)}>{n}</button>,
        root,
        ctx,
      );
    }),
  });
  s.place({ ...host, address: [], name: "n", id: "n", value: 0 });
  const pid = start("panel");
  const button = root.querySelector("button")!;
  click(button);
  assertEquals(button.textContent, "1");
  const r = why(button)!.reasons[0];
  assertEquals(r.change!.process, pid);
  assertEquals(r.by, { process: pid, program: { node: "program:panel", time: 4 }, lasting: 1 });
  // killing it disposes its scopes: the render is undone, and n marks nothing
  s.unplace({ ...host, address: [], name: pid, id: pid });
  assertEquals(root.querySelector("button"), null);
  assertEquals(
    s.write({ ...host, address: ["n"], patches: [{ type: "snapshot", value: 9 }] }).marked,
    [],
  );
});
