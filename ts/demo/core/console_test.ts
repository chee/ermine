/// <reference lib="dom" />
// The console against a World without a page: its paths and words, and each
// command made as the acting agent through the page's stack, with a site
// naming the console line.
//
//   cd ts && deno test --allow-read --allow-env demo/core/console_test.ts

// deno-lint-ignore no-import-prefix no-unversioned-import -- the lock has it already, as npm:linkedom@*
import { parseHTML } from "npm:linkedom";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { memory } from "../../src/keeper.ts";
import type { Json, ValueItem } from "../../src/types.ts";
import {
  Console,
  type Entry,
  parsePath,
  parseSlot,
  patchFor,
  printValue,
  showPath,
  tokens,
  valueOf,
  word,
} from "./src/console.ts";
import { World } from "./src/world.ts";

const page = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, {
  document: page.document,
  window: page.window,
  Node: page.Node,
  HTMLElement: page.HTMLElement,
});

/** A world with notes/today = {"text": "", "tags": []} and a counter program, and a console. */
function setup() {
  const world = new World({ backend: () => memory() });
  world.reset();
  const s = world.run(`batch(() => {
  make("root", "notes", "notes", {})
  make("notes", "today", "today", { text: "", tags: ["a"] })
  make("root", "n", "n", 1)
})`);
  assert(s.ok, s.error?.why);
  const shell = new Console(world);
  return { world, shell };
}

/** What a command printed, as text, one line each. */
function text(e: Entry | undefined): string[] {
  return (e?.out ?? []).map((l) => l.map((s) => s.text).join("").trimEnd());
}

function ok(shell: Console, line: string): string[] {
  const e = shell.run(line);
  assert(e?.kind === "command" && e.ok, `${line}: ${text(e).join("\n")}`);
  return text(e);
}

function fails(shell: Console, line: string): string {
  const e = shell.run(line);
  assert(e?.kind === "command" && !e.ok, `${line} should fail: ${text(e).join("\n")}`);
  return text(e).join("\n");
}

const value = (w: World, ...address: string[]) =>
  (w.scheduler.read({ agent: w.agent, address }) as ValueItem[]).find((i) => "value" in i)
    ?.value;

Deno.test("paths parse into CORE's address lists, from the place", () => {
  assertEquals(parsePath("/", ["a"]), { address: ["/"], names: [] });
  assertEquals(parsePath("/notes/today", []), {
    address: ["/", "notes", "today"],
    names: ["notes", "today"],
  });
  assertEquals(parsePath("today", ["notes"]), { address: ["today"], names: ["notes", "today"] });
  assertEquals(parsePath("../n", ["notes"]), { address: ["..", "n"], names: ["n"] });
  assertEquals(parsePath(".", ["notes"]), { address: [], names: ["notes"] });
  assertEquals(parsePath("../..", ["a", "b"]), { address: ["..", ".."], names: [] });
  // a ".." after a name takes it back off, before it is an address
  assertEquals(parsePath("x/../y", []), { address: ["y"], names: ["y"] });
  assertEquals(parsePath("./a//b/", []), { address: ["a", "b"], names: ["a", "b"] });
  // a "/" inside a name, escaped; any escaped character stands for itself
  assertEquals(parsePath("a\\/b/c", []).address, ["a/b", "c"]);
  assertEquals(parsePath("my\\ notes", []).address, ["my notes"]);
  assertEquals(parsePath('"/a b/c"', []).address, ["/", "a b", "c"]);
  assertThrows(() => parsePath("..", []), Error, "above the root");
  assertThrows(() => parsePath("/..", ["a"]), Error, "above the root");
  assertEquals(parseSlot("notes/today", []), {
    address: ["notes"],
    names: ["notes"],
    name: "today",
  });
  assertThrows(() => parseSlot("..", ["a"]), Error, "names no slot");
  assertEquals(showPath(["a/b", "c d"]), "/a\\/b/c\\ d");
  assertEquals(parsePath(showPath(["a/b", "c d"]), []).names, ["a/b", "c d"]);
});

Deno.test("words and values: quotes, escapes, JSON or plain text", () => {
  assertEquals(tokens('write a "hi there" x').map((t) => t.raw), [
    "write",
    "a",
    '"hi there"',
    "x",
  ]);
  assertEquals(tokens("a\\ b c").map((t) => t.raw), ["a\\ b", "c"]);
  assertEquals(word('"a\\nb"'), "a\nb");
  assertEquals(word("'x y'"), "x y");
  assertEquals(word("a\\ b"), "a b");
  assertEquals(valueOf(" 5 "), 5);
  assertEquals(valueOf('{"a": [1, true]}'), { a: [1, true] });
  assertEquals(valueOf('"5"'), "5");
  assertEquals(valueOf("hello world"), "hello world");
  assertEquals(valueOf("'null'"), "null");
  assertEquals(valueOf(""), undefined);
});

Deno.test("values print readably: strings plain, JSON pretty, bytes and typed arrays summarised", () => {
  const t = (v: Json) => printValue(v).map((l) => l.map((s) => s.text).join(""));
  assertEquals(t("two\nlines"), ["two", "lines"]);
  assertEquals(t({ a: 1 }), ["{", '  "a": 1', "}"]);
  assertEquals(t(new Uint8Array([1, 2, 255]).buffer as ArrayBuffer), ["bytes · 3 B · 01 02 ff"]);
  assertEquals(t(new Float32Array([1, 2]) as unknown as Json), ["float32[2] · 1, 2"]);
  assertEquals(t({ b: new Uint8Array(2).buffer as ArrayBuffer }), [
    "{",
    '  "b": "‹bytes · 2 B · 00 00›"',
    "}",
  ]);
});

Deno.test("patches: a key of a map, an element of a list, deleted with no value", () => {
  const v = { text: "", tags: ["a", "b"], deep: { x: 1 } };
  assertEquals(patchFor(v, ["text"], "hi"), { type: "set", path: [], key: "text", value: "hi" });
  assertEquals(patchFor(v, ["deep", "x"], 2), {
    type: "set",
    path: ["deep"],
    key: "x",
    value: 2,
  });
  assertEquals(patchFor(v, ["tags", "1"], "c"), {
    type: "splice",
    path: ["tags"],
    range: [1, 2],
    value: ["c"],
  });
  assertEquals(patchFor(v, ["tags", "2"], "c"), {
    type: "splice",
    path: ["tags"],
    range: [2, 2],
    value: ["c"],
  });
  assertEquals(patchFor(v, ["tags", "0"], undefined), {
    type: "splice",
    path: ["tags"],
    range: [0, 1],
  });
  assertEquals(patchFor(v, ["text"], undefined), { type: "set", path: [], key: "text" });
  assertThrows(() => patchFor(v, ["nope", "x"], 1), Error, "nothing there");
  assertThrows(() => patchFor(v, ["text", "x"], 1), Error, "only a map's keys");
});

Deno.test("cd, pwd, ls and read walk the graph as the acting agent", () => {
  const { shell } = setup();
  assertEquals(ok(shell, "pwd"), ["/"]);
  const ls = ok(shell, "ls");
  assert(ls.some((l) => l.includes("notes/")), ls.join("\n"));
  assert(ls.some((l) => /n\s+1/.test(l)), ls.join("\n"));
  ok(shell, "cd notes");
  assertEquals(shell.prompt, "/notes");
  assertEquals(ok(shell, "read today"), [
    "{",
    '  "text": "",',
    '  "tags": [',
    '    "a"',
    "  ]",
    "}",
  ]);
  assertEquals(ok(shell, "cat ../n"), ["1"]);
  assert(fails(shell, "cd nowhere").includes("nothing there"));
  ok(shell, "cd ..");
  assertEquals(shell.prompt, "/");
  ok(shell, "cd /notes/today");
  ok(shell, "cd");
  assertEquals(shell.cwd, []);
  assert(fails(shell, "frobnicate").includes("no such command"));
});

Deno.test("write: a value, or a patch after a dot, made with a site naming the console line", () => {
  const { world, shell } = setup();
  ok(shell, 'write notes/today.text "hi"');
  assertEquals(value(world, "notes", "today"), { text: "hi", tags: ["a"] });
  ok(shell, "write notes/today.tags.1 b");
  assertEquals(value(world, "notes", "today"), { text: "hi", tags: ["a", "b"] });
  ok(shell, "write notes/today.tags.0");
  assertEquals(value(world, "notes", "today"), { text: "hi", tags: ["b"] });
  ok(shell, "write n 41");
  assertEquals(value(world, "n"), 41);
  const e = shell.run("write n plain words here");
  assertEquals(value(world, "n"), "plain words here");
  // the change carries the acting agent and the console line's site
  const [item] = world.scheduler.read({ agent: world.agent, address: ["n"] }) as ValueItem[];
  assertEquals(item.change?.agent, world.agent);
  assertEquals(item.change?.cause, {
    file: `console-${e!.kind === "command" ? e!.n : 0}`,
    line: 1,
    column: 1,
  });
  assertEquals(shell.line((e as { n: number }).n), "write n plain words here");
  // a node whose name has a dot is the node, not a key
  ok(shell, "make notes/a.b 1");
  ok(shell, "write notes/a.b 2");
  assertEquals(value(world, "notes", "a.b"), 2);
  assert(fails(shell, "write n").includes("write what?"));
});

Deno.test("make, place, mv, unplace: placements by path", () => {
  const { world, shell } = setup();
  ok(shell, "cd notes");
  ok(shell, "make draft hello");
  assertEquals(value(world, "notes", "draft"), "hello");
  ok(shell, "make other second");
  // one more place for draft, in the slot other: behind other's own node
  ok(shell, "place draft other");
  assertEquals(world.slotOf("notes", "other"), ["other", "draft"]);
  ok(shell, "mv other draft first");
  assertEquals(world.slotOf("notes", "other"), ["draft", "other"]);
  // a read gives every node the slot holds, the first first
  assertEquals(ok(shell, "read other"), ["#0 · the one a walk takes", "hello", "#1", "second"]);
  ok(shell, "mv other last");
  assertEquals(world.slotOf("notes", "other"), ["other", "draft"]);
  ok(shell, "unplace other draft");
  assertEquals(world.slotOf("notes", "other"), ["other"]);
  ok(shell, "rm other");
  assertEquals(world.slotOf("notes", "other"), []);
  assert(fails(shell, "mv draft 7").includes("invalid"));
});

Deno.test("lookup searches from the console's place up", () => {
  const { shell } = setup();
  ok(shell, "cd notes/today");
  const out = ok(shell, "lookup n");
  assertEquals(out, ["../../n  → n"]);
  assertEquals(ok(shell, "lookup nothing-by-that-name"), [
    "no slot named nothing-by-that-name from here up",
  ]);
});

Deno.test("protect sees the console's acts: a refusal shows its kind, code and why", () => {
  const { world, shell } = setup();
  world.rules = [{ agent: "bun", op: "write", allow: false, on: true }];
  world.agent = "bun";
  const why = fails(shell, "write n 5");
  assert(why.startsWith("✕ refused · rule"), why);
  assertEquals(value(world, "n"), 1);
  world.agent = "chee";
  ok(shell, "write n 5");
});

Deno.test("why: the route an item took, and who made its change, when, and from which line", () => {
  const { world, shell } = setup();
  const e = shell.run("write notes/today.text why");
  const out = ok(shell, "why notes/today");
  assertEquals(out[0], "from notes/today  → today");
  const change = out.find((l) => l.startsWith("write @"))!;
  assert(change.includes(`by ${world.agent}`), change);
  const site = out.find((l) => l.includes("site "))!;
  assert(
    site.includes(`console-${(e as { n: number }).n}:1:1  write notes/today.text why`),
    site,
  );
  // a change from the workspace names its snippet's line
  world.run(`write("n", 9)`);
  assert(ok(shell, "why n").some((l) => /site snippet-\d+:1:\d+ {2}write\("n", 9\)/.test(l)));
});

Deno.test("start, ps, why of a process's value, and stop", async () => {
  const { world, shell } = setup();
  // the loaders and programs/, as the workspace's process() makes them
  world.run(`batch(() => {
  make("root", "loaders", "loaders", {})
  make("loaders", "js", "loader-js", { loader: "same-thread" })
  make("root", "programs", "programs", {})
})`);
  world.run(`program("programs", "double", ${
    JSON.stringify(`export default function ({ api }) {
  const [n] = api.lookup({ name: "n" })
  return api.read({ address: n.from.path })[0].value * 2
}`)
  })`);
  // a program is found as the scheduler finds it: by its path, searched up from where it starts
  const started = ok(shell, "start programs/double in notes");
  const pid = started[0].match(/◉ (@\S+)/)![1];
  await quiet(world);
  const ps = ok(shell, "ps");
  assert(
    ps.some((l) => l.includes(pid) && l.includes("/notes") && l.includes("programs/double")),
    ps.join("\n"),
  );
  assert(ps.some((l) => l.trim() === "2"), ps.join("\n"));
  ok(shell, "write n 21");
  await quiet(world);
  const why = ok(shell, `why notes/${pid}`);
  assert(why.some((l) => l.includes(`as ◉ ${pid}`)), why.join("\n"));
  assert(why.some((l) => /set by run #\d+ of ◉ .* marked by @\d+/.test(l)), why.join("\n"));
  ok(shell, `stop ${pid}`);
  assert(!world.running().has(pid));
  assert(fails(shell, "start /programs/double").includes("searching up"));
});

Deno.test("watch streams changes into the console until unwatched", () => {
  const { world, shell } = setup();
  ok(shell, "watch n");
  ok(shell, "write n 2");
  world.run(`write("n", 3)`);
  const events = shell.entries.filter((e) => e.kind === "event").map((e) => text(e).join(" "));
  assert(events.some((t) => t.includes("write") && t.includes("= 2")), events.join("\n"));
  assert(events.some((t) => t.includes("= 3")), events.join("\n"));
  ok(shell, "unwatch");
  const before = shell.entries.length;
  world.run(`write("n", 4)`);
  assertEquals(shell.entries.length, before, "nothing more comes");
  assertEquals(ok(shell, "unwatch"), ["nothing is watched"]);
});

Deno.test("tab completes commands and names; history keeps what was typed", () => {
  const { shell } = setup();
  assertEquals(shell.complete("wh").options, ["whoami", "why"]);
  assertEquals(shell.complete("whoa").text, "whoami ");
  assertEquals(shell.complete("cd no").text, "cd notes/");
  assertEquals(shell.complete("read notes/to").text, "read notes/today ");
  const many = shell.complete("ls ");
  assert(many.options.includes("notes/") && many.options.includes("n"), many.options.join(" "));
  shell.run("make notes/with\\/slash 1");
  assertEquals(shell.complete("read notes/wi").text, "read notes/with\\/slash ");
  ok(shell, "pwd");
  assertEquals(shell.history.slice(-2), ["make notes/with\\/slash 1", "pwd"]);
  assert(ok(shell, "history").some((l) => l.endsWith("pwd")));
});

/** Waits until the world's log stops growing. */
async function quiet(world: World, ms = 2000) {
  const end = Date.now() + ms;
  let last = -1;
  let still = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
    if (world.log.length === last) {
      if (++still >= 4) return;
    } else still = 0;
    last = world.log.length;
  }
}
