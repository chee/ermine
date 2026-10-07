/// <reference lib="dom" />
// The console: a calm REPL for exploring and changing the graph, with string
// paths instead of JSON.
//
// A path is a string: "/" first starts at the root, ".." goes back one step
// and "." stays, as CORE.tex's addresses have them, and names are joined by
// "/". A "/" inside a name is written "\/", and any character after a "\"
// stands for itself, so "a\ b" is one name with a space in it. A path is
// parsed into CORE's address list, ["/", names…] or ["..", …, names…], and
// made from the console's place, its pwd: every operation carries place, so
// the graph follows it afresh each time, as a working directory is. A ".."
// after a name takes that name back off, as a shell's does, before it becomes
// an address: CORE puts every ".." before the first name.
//
// Every command is made as the acting agent, through the top of the page's
// stack, so protect and the scheduler see it as they see any other act; and
// each change carries a site, {"file": "console-<n>", "line": 1, "column": 1},
// naming the console line that made it, so the transcript and the why pane
// show console commands as they show the workspace's.

import { signal } from "@preact/signals";
import {
  type Address,
  type Change,
  ErmineError,
  type Event,
  type Header,
  type Id,
  isBytes,
  type Json,
  kindOf,
  type Patch,
  type SlotItem,
  type ValueItem,
} from "../../../src/mod.ts";
import type { ProcessItem, Scheduler } from "../../../src/schedule.ts";
import { actorOf, J, peerOf, PID, problem, siteOf, type World } from "./world.ts";

// --- what the console prints ---

/**
 * A piece of a line: its text, a class to style it, and what clicking it
 * shows: a node in the inspector, or a change in the why pane.
 */
export type Span = { text: string; cls?: string; node?: Id; ref?: number };
export type Line = Span[];

/** One command and what it printed; or what a watch received, as it came. */
export type Entry =
  | {
    kind: "command";
    n: number;
    text: string;
    cwd: string[];
    agent: string;
    out: Line[];
    ok: boolean;
  }
  | { kind: "event"; watch: number; path: string; out: Line[] };

/** A watch: a subscription that prints each change it receives, until it is stopped. */
export type Watch = { n: number; sub: number; path: string; scheduler: Scheduler };

const span = (text: string, cls?: string, more: Omit<Span, "text" | "cls"> = {}): Span => ({
  text,
  ...(cls ? { cls } : {}),
  ...more,
});
const line = (...spans: (Span | string)[]): Line =>
  spans.map((s) => typeof s === "string" ? span(s) : s);

// --- paths ---

/** Splits raw text at each sep that no "\" escapes; the parts keep their escapes. */
export function splitRaw(raw: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      cur += c + raw[i + 1];
      i++;
    } else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** A part as it means: each "\x" is x. */
export function unescape(raw: string): string {
  return raw.replace(/\\(.)/gs, "$1");
}

/** A name as a path shows it: "\" and "/" escaped, and a space, so it reads back as one name. */
export function escapeName(name: string): string {
  return name.replace(/[\\/ "']/g, (c) => "\\" + c);
}

/** Names from the root as a path: "/" and the names, escaped. */
export function showPath(names: readonly string[]): string {
  return "/" + names.map(escapeName).join("/");
}

/** A path parsed: CORE's address, from the place; and the names from the root it reaches, lexically. */
export type Parsed = { address: Address; names: string[] };

/**
 * Parses a path, from the place cwd (names from the root), into CORE's
 * address list and the names from the root it stands for. Quotes around the
 * whole path are taken off.
 */
export function parsePath(raw: string, cwd: readonly string[]): Parsed {
  let t = raw.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) t = t.slice(1, -1);
  if (t === "") return { address: [], names: [...cwd] };
  const absolute = t.startsWith("/");
  const parts = splitRaw(absolute ? t.slice(1) : t, "/");
  let up = 0;
  const names: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (names.length) names.pop();
      else if (absolute) throw new Error(`${raw}: ".." cannot go above the root`);
      else up++;
      continue;
    }
    names.push(unescape(p));
  }
  if (absolute) return { address: ["/", ...names], names };
  if (up > cwd.length) throw new Error(`${raw}: ".." cannot go above the root`);
  return {
    address: [...Array.from({ length: up }, () => ".."), ...names],
    names: [...cwd.slice(0, cwd.length - up), ...names],
  };
}

/** A path to a slot: the address of the node it is in, and the slot's name. */
export function parseSlot(raw: string, cwd: readonly string[]): Parsed & { name: string } {
  const p = parsePath(raw, cwd);
  const name = p.names[p.names.length - 1];
  const last = p.address[p.address.length - 1];
  if (name === undefined || last === undefined || last === "/" || last === "..") {
    throw new Error(`${raw || "."} names no slot: give a path that ends in a name`);
  }
  return { address: p.address.slice(0, -1), names: p.names.slice(0, -1), name };
}

// --- words and values ---

/** A word of a command line: its raw text, quotes and escapes kept, and where it starts. */
export type Token = { raw: string; start: number };

/** The words of a line: split at spaces outside quotes; a "\" escapes the next character. */
export function tokens(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    let quote: string | undefined;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (quote) {
        if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") quote = c;
      else if (/\s/.test(c)) break;
      i++;
    }
    out.push({ raw: text.slice(start, Math.min(i, text.length)), start });
  }
  return out;
}

/** A word as it means: a quoted one read as JSON (or as written, in single quotes), escapes taken off. */
export function word(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch { /* not JSON: as written */ }
  }
  if (raw.length >= 2 && raw[0] === "'" && raw.endsWith("'")) return raw.slice(1, -1);
  return unescape(raw);
}

/**
 * A value as typed: JSON when it reads as JSON (5, true, null, [1, 2],
 * {"a": 1}, "quoted"), the text inside single quotes, and otherwise the
 * text as it is, a string. Nothing, for no text.
 */
export function valueOf(text: string): Json | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch { /* not JSON */ }
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

// --- printing values ---

function size(n: number): string {
  return n < 1024
    ? `${n} B`
    : n < 1048576
    ? `${(n / 1024).toFixed(1)} KB`
    : `${(n / 1048576).toFixed(1)} MB`;
}

function isLiveValue(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v) || isBytes(v) || kindOf(v)) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto !== Object.prototype && proto !== null;
}

/** Bytes, a typed array or a live value, in one short line; undefined for anything else. */
export function summary(v: unknown): string | undefined {
  if (isBytes(v)) {
    const u = new Uint8Array(v);
    const hex = [...u.subarray(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
    return `bytes · ${size(u.length)}${u.length ? ` · ${hex}${u.length > 8 ? " …" : ""}` : ""}`;
  }
  const kind = kindOf(v);
  if (kind) {
    const a = v as ArrayLike<number | bigint>;
    const first = Array.from({ length: Math.min(8, a.length) }, (_, i) => String(a[i]));
    return `${kind}[${a.length}]${
      a.length ? ` · ${first.join(", ")}${a.length > 8 ? ", …" : ""}` : ""
    }`;
  }
  if (isLiveValue(v)) return `live · ${(v as object).constructor?.name ?? "thing"}`;
}

/** JSON, with bytes, typed arrays and live values inside it summarised. */
function pretty(v: Json, indent = 2): string {
  return JSON.stringify(
    v,
    function (k, x) {
      // JSON.stringify hands a typed array's own toJSON-less value: look at the holder's
      const raw = k === "" ? v : (this as { [k: string]: unknown })[k];
      const s = summary(raw);
      if (s !== undefined) return `‹${s}›`;
      if (typeof raw === "number" && !Number.isFinite(raw)) return `‹${raw}›`;
      if (Object.is(raw, -0)) return "‹-0›";
      return x;
    },
    indent,
  );
}

/** A value, short, on one line. */
export function peek(v: Json | undefined, max = 40): string {
  if (v === undefined) return "absent";
  const s = summary(v) ?? (typeof v === "string" ? J(v) : pretty(v, 0));
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * A value as the console prints it: a string as its text, plain; bytes,
 * typed arrays and live values summarised; anything else as pretty JSON.
 */
export function printValue(v: Json | undefined): Line[] {
  if (v === undefined) return [line(span("absent", "dim"))];
  if (typeof v === "string") {
    return v === "" ? [line(span('""', "dim"))] : v.split("\n").map((l) => line(span(l, "str")));
  }
  const s = summary(v);
  if (s !== undefined) return [line(span(s, "num"))];
  if (v === null) return [line(span("null", "dim"))];
  if (typeof v !== "object") return [line(span(pretty(v), "num"))];
  return pretty(v).split("\n").map((l) => line(span(l, "json")));
}

/** An error as the console says it: its kind and code, and a short why. */
export function errorLine(e: unknown): Line {
  if (e instanceof ErmineError) {
    const { code, text } = e.why;
    return line(
      span("✕ ", "bad"),
      span(`${e.kind} · ${code}`, "bad strong"),
      span(e.op ? ` (${e.op})` : "", "dim"),
      span(text ? `  ${text}` : ""),
    );
  }
  const p = problem(e);
  return line(
    span("✕ ", "bad"),
    span(p.kind === "thrown" ? "" : p.kind + " ", "bad strong"),
    p.why,
  );
}

// --- commands ---

type Command = {
  name: string;
  also?: string[];
  usage: string;
  help: string;
  run: (c: Console, a: Args) => void;
};

/** What a command is given: its words, the text after the nth, and where to print. */
type Args = {
  n: number;
  words: Token[];
  /** the raw text from the ith word on, as typed */
  rest(i: number): string;
  out: Line[];
};

const COMMANDS: Command[] = [
  {
    name: "help",
    also: ["?"],
    usage: "help [command]",
    help: "what each command does",
    run: (_c, a) => {
      const which = a.words[0] ? word(a.words[0].raw) : undefined;
      if (which) {
        const cmd = commandNamed(which);
        if (!cmd) throw new Error(`no command ${which}: try help`);
        a.out.push(line(span(cmd.usage, "strong")), line(span(cmd.help, "dim")));
        if (cmd.also?.length) a.out.push(line(span(`also: ${cmd.also.join(", ")}`, "dim")));
        return;
      }
      const width = Math.max(...COMMANDS.map((x) => x.usage.length));
      for (const cmd of COMMANDS) {
        a.out.push(line(span(cmd.usage.padEnd(width + 2), "strong"), span(cmd.help, "dim")));
      }
      a.out.push(
        line(""),
        line(span(
          'paths: "/" is the root, ".." goes back, names joined by "/"; "\\/" is a "/" inside a name. values: JSON, or plain text',
          "dim",
        )),
        line(span("tab completes names; ↑ and ↓ walk the history; ⌃L clears", "dim")),
      );
    },
  },
  {
    name: "pwd",
    usage: "pwd",
    help: "where the console is: its place, which every command acts from",
    run: (c, a) => void a.out.push(line(span(showPath(c.cwd), "path"))),
  },
  {
    name: "cd",
    usage: "cd [path]",
    help: "go to a node; with no path, to the root",
    run: (c, a) => {
      const p = parsePath(a.words[0]?.raw ?? "/", c.cwd);
      const items = c.tryRead(p.address);
      if (items !== "refused" && !items.some((i) => "value" in i)) {
        throw new Error(`${showPath(p.names)}: nothing there`);
      }
      c.cwd = p.names;
      if (items === "refused") {
        a.out.push(line(span("you may not read it; the place is yours to stand in", "dim")));
      }
    },
  },
  {
    name: "ls",
    also: ["dir"],
    usage: "ls [-l] [path]",
    help: "a node's slots: each name, and what it holds. -l: ids, and who last changed each",
    run: (c, a) => {
      const long = a.words[0]?.raw === "-l";
      const p = parsePath(a.words[long ? 1 : 0]?.raw ?? ".", c.cwd);
      const d = c.api.directory({ ...c.acting(), address: p.address });
      if (!("directory" in d)) return;
      if (!d.directory.length) {
        a.out.push(line(span("nothing here: no slots", "dim")));
        return;
      }
      const width = Math.min(28, Math.max(...d.directory.map(([n]) => escapeName(n).length + 1)));
      for (const [name, items] of d.directory) {
        a.out.push(c.listed(p.address, name, items, width, long));
      }
    },
  },
  {
    name: "read",
    also: ["cat"],
    usage: "read <path>",
    help: "what a path reads: the node's value, and anything a scheduler puts in front",
    run: (c, a) => {
      const p = parsePath(need(a, 0, "read what? a path"), c.cwd);
      const items = c.api.read({ ...c.acting(), address: p.address });
      const values = items.filter((i): i is ValueItem => "value" in i);
      for (const f of items.filter((i) => !("value" in i))) a.out.push(front(f as ProcessItem));
      if (!values.length) {
        a.out.push(line(span(`${showPath(p.names)}: nothing there`, "dim")));
        return;
      }
      values.forEach((it, k) => {
        if (values.length > 1) {
          a.out.push(line(span(`#${k}${k === 0 ? " · the one a walk takes" : ""}`, "dim")));
        }
        a.out.push(...printValue(it.value));
      });
    },
  },
  {
    name: "write",
    also: ["set"],
    usage: "write <path>[.key…] [value]",
    help:
      'set a value; or with .key after the path, one key of a map or element of a list (a patch). with no value, a key is deleted. e.g. write notes/today.text "hi"',
    run: (c, a) => {
      const raw = need(a, 0, "write where? a path, then a value");
      const v = valueOf(a.rest(1));
      const { address, names, keys } = c.target(raw);
      let patches: Patch[];
      if (!keys.length) {
        if (v === undefined) throw new Error("write what? give a value after the path");
        patches = [{ type: "snapshot", value: v }];
      } else {
        const now = c.valueAt(address);
        patches = [patchFor(now, keys, v)];
      }
      const r = c.api.write({ ...c.acting(), ...c.cause(a.n), address, patches });
      a.out.push(done("wrote", names, keys, r.change.time), ...marks(r.marked));
    },
  },
  {
    name: "make",
    also: ["mk"],
    usage: "make <path> [value]",
    help: "make a node in a slot, placing it with its value (null if none): one change",
    run: (c, a) => {
      const s = parseSlot(need(a, 0, "make what? a path ending in the new name"), c.cwd);
      const v = valueOf(a.rest(1)) ?? null;
      const id = c.freshId(s.name);
      const r = c.api.place({
        ...c.acting(),
        ...c.cause(a.n),
        address: s.address,
        name: s.name,
        id,
        value: v,
      });
      a.out.push(
        line(
          span("✓ ", "ok"),
          "made ",
          span(showPath([...s.names, s.name]), "path", { node: id }),
          span(id === s.name ? "" : `  id ${id}`, "dim"),
          span(`  @${r.change.time}`, "ref", { ref: r.change.time }),
        ),
        ...marks(r.marked),
      );
    },
  },
  {
    name: "place",
    also: ["ln"],
    usage: "place <id> <path> [position]",
    help:
      "put an id in a slot: one more place for a node that is here, or a mount of one that is not",
    run: (c, a) => {
      const id = word(need(a, 0, "place what? an id, then a path ending in the slot's name"));
      const s = parseSlot(need(a, 1, "place it where? a path ending in the slot's name"), c.cwd);
      const at = a.words[2]
        ? position(word(a.words[2].raw), c.slot(s.address, s.name).length)
        : undefined;
      const r = c.api.place({
        ...c.acting(),
        ...c.cause(a.n),
        address: s.address,
        name: s.name,
        id,
        ...(at === undefined ? {} : { position: at }),
      });
      a.out.push(
        line(
          span("✓ ", "ok"),
          "placed ",
          span(id, "id", { node: id }),
          " in ",
          span(showPath([...s.names, s.name]), "path"),
          span(at === undefined ? "" : ` at ${at}`, "dim"),
          span(`  @${r.change.time}`, "ref", { ref: r.change.time }),
        ),
        ...marks(r.marked),
      );
    },
  },
  {
    name: "unplace",
    also: ["rm"],
    usage: "unplace <path> [id]",
    help:
      "take an id out of a slot: the node the path reaches, or the id given. a process unplaced is killed",
    run: (c, a) => {
      const s = parseSlot(need(a, 0, "unplace what? a path"), c.cwd);
      const id = a.words[1] ? word(a.words[1].raw) : c.first(s.address, s.name);
      const r = c.api.unplace({
        ...c.acting(),
        ...c.cause(a.n),
        address: s.address,
        name: s.name,
        id,
      });
      a.out.push(
        line(
          span("✓ ", "ok"),
          "unplaced ",
          span(id, "id"),
          " from ",
          span(showPath([...s.names, s.name]), "path"),
          span(`  @${r.change.time}`, "ref", { ref: r.change.time }),
        ),
        ...gone(r.gone),
        ...marks(r.marked),
      );
    },
  },
  {
    name: "mv",
    also: ["move"],
    usage: "mv <path> [id] <position|first|last>",
    help:
      "move an id within its slot: the node the path reaches, or the id given. the first wins: a read gives it, a walk takes it",
    run: (c, a) => {
      const s = parseSlot(need(a, 0, "move what? a path, then a position"), c.cwd);
      const id = a.words.length > 2 ? word(a.words[1].raw) : c.first(s.address, s.name);
      const where = word(
        need(a, a.words.length > 2 ? 2 : 1, "to where? a position, first or last"),
      );
      const ids = c.slot(s.address, s.name);
      const at = position(where, ids.length);
      const r = c.api.place({
        ...c.acting(),
        ...c.cause(a.n),
        address: s.address,
        name: s.name,
        id,
        position: at,
      });
      const now = c.slot(s.address, s.name);
      a.out.push(
        line(
          span("✓ ", "ok"),
          "moved ",
          span(id, "id", { node: id }),
          ` to ${now.indexOf(id)} of ${now.length} in `,
          span(showPath([...s.names, s.name]), "path"),
          span(`  @${r.change.time}`, "ref", { ref: r.change.time }),
        ),
        ...marks(r.marked),
      );
    },
  },
  {
    name: "lookup",
    also: ["find"],
    usage: "lookup <name>",
    help: "search for a name from here up, nearest first, as a process here would",
    run: (c, a) => {
      const name = word(need(a, 0, "look up what? a name"));
      const items = c.api.lookup({ ...c.acting(), name });
      if (!items.length) {
        a.out.push(line(span(`no slot named ${name} from here up`, "dim")));
        return;
      }
      for (const it of items) {
        if ("refused" in it) {
          a.out.push(
            line(span("⊘ ", "bad"), span(`the search was refused at ${rel(it.from.path)}`, "dim")),
          );
          continue;
        }
        const s = it as SlotItem;
        const path = "path" in s.from ? s.from.path : [];
        a.out.push(line(
          span(rel(path), "path"),
          span("  → ", "dim"),
          span(s.id, "id", { node: s.id }),
          span(s.pending ? "  pending: not here yet" : s.ephemeral ? "  ephemeral" : "", "dim"),
        ));
      }
    },
  },
  {
    name: "why",
    usage: "why <path>",
    help:
      "why a read gives what it gives: each item's from (the route it took) and the change that set it: who, why, when, and the site; for a process's value, the run",
    run: (c, a) => {
      const p = parsePath(need(a, 0, "why what? a path"), c.cwd);
      const items = c.api.read({ ...c.acting(), address: p.address });
      if (!items.length) {
        a.out.push(line(span(`${showPath(p.names)}: nothing there, so nothing to explain`, "dim")));
        return;
      }
      for (const it of items) {
        if (!("value" in it)) {
          a.out.push(front(it as ProcessItem));
          continue;
        }
        a.out.push(...c.explain(it));
      }
    },
  },
  {
    name: "start",
    usage: "start <program> [in <path>] [value]",
    help:
      "start a process running the program found at that path (searched up from where it starts, as the scheduler does), here or in the path given",
    run: (c, a) => {
      const program =
        parsePath(need(a, 0, "start what? a program's path, such as programs/counter"), [])
          .address;
      if (program[0] === "/" || program[0] === "..") {
        throw new Error(
          "a program is found by searching up: give its names, such as programs/counter",
        );
      }
      let i = 1;
      let where: Parsed = { address: [], names: [...c.cwd] };
      if (a.words[1] && (a.words[1].raw === "in" || a.words[1].raw === "at") && a.words[2]) {
        where = parsePath(a.words[2].raw, c.cwd);
        i = 3;
      }
      const v = valueOf(a.rest(i));
      const r = c.api.start({
        ...c.acting(),
        ...c.cause(a.n),
        address: where.address,
        program,
        ...(v === undefined ? {} : { value: v }),
      });
      const pid = r.change.kind === "place" ? r.change.id : undefined;
      a.out.push(
        line(
          span("✓ ", "ok"),
          "started ",
          span(`◉ ${pid}`, "proc", pid ? { node: pid } : {}),
          " in ",
          span(showPath(where.names), "path"),
          span(`  running ${program.join("/")}`, "dim"),
          span(`  @${r.change.time}`, "ref", { ref: r.change.time }),
        ),
      );
    },
  },
  {
    name: "stop",
    also: ["kill"],
    usage: "stop <pid|path>",
    help: "kill a process, by unplacing it from where it was started",
    run: (c, a) => {
      const raw = need(a, 0, "stop what? a pid, or a path to a process");
      const pid = word(raw);
      const p = c.world.procs.get(pid);
      let address: Address;
      let name: string;
      let id: Id;
      if (PID.test(pid) && p) {
        const at = c.world.addressOf(p.parent);
        if (!at) throw new Error(`${pid}: no path from the root reaches where it runs`);
        address = ["/", ...at];
        name = pid;
        id = pid;
      } else {
        const s = parseSlot(raw, c.cwd);
        address = s.address;
        name = s.name;
        id = c.first(s.address, s.name);
        if (!c.world.procs.has(id)) {
          throw new Error(`${showPath([...s.names, s.name])} is not a process`);
        }
      }
      const r = c.api.unplace({ ...c.acting(), ...c.cause(a.n), address, name, id });
      a.out.push(
        line(
          span("✓ ", "ok"),
          "stopped ",
          span(`◉ ${id}`, "proc"),
          span(`  @${r.change.time}`, "ref", { ref: r.change.time }),
        ),
        ...gone(r.gone),
      );
    },
  },
  {
    name: "ps",
    usage: "ps",
    help: "the processes running: where each runs, its program, who it acts for, and its items",
    run: (c, a) => {
      const running = [...c.world.running()];
      if (!running.length) {
        a.out.push(line(span("nothing runs", "dim")));
        return;
      }
      for (const [pid] of running) {
        const p = c.world.procs.get(pid)!;
        const at = c.world.addressOf(pid);
        a.out.push(line(
          span(`◉ ${pid}`, "proc", { node: pid }),
          "  ",
          span(at ? showPath(at.slice(0, -1)) : "(no path)", "path"),
          span(`  ${p.path ? p.path.join("/") : p.program.node}`, "strong"),
          span(`  for ${who(p.actor)}`, "dim"),
          span(p.by ? `  started by ${p.by}` : "", "dim"),
        ));
        if (!at) continue;
        let items;
        try {
          items = c.api.read({ ...c.acting(), address: ["/", ...at] });
        } catch (e) {
          a.out.push(indent(errorLine(e)));
          continue;
        }
        for (const it of items) {
          a.out.push(
            indent(
              "value" in it ? line(span(peek(it.value, 72), "num")) : front(it as ProcessItem),
            ),
          );
        }
      }
    },
  },
  {
    name: "watch",
    also: ["sub"],
    usage: "watch <path>",
    help: "print each change to what a path reaches, as it comes, until unwatch",
    run: (c, a) => {
      const raw = need(a, 0, "watch what? a path");
      const p = parsePath(raw, c.cwd);
      const n = c.watch(p);
      a.out.push(line(
        span("◎ ", "ok"),
        `watching ${showPath(p.names)}`,
        span(`  #${n} · unwatch ${n} to stop`, "dim"),
      ));
    },
  },
  {
    name: "unwatch",
    also: ["unsub"],
    usage: "unwatch [n|all]",
    help: "stop a watch: the one numbered, the last, or all",
    run: (c, a) => {
      const which = a.words[0] ? word(a.words[0].raw) : undefined;
      const live = [...c.watching()];
      if (!live.length) {
        a.out.push(line(span("nothing is watched", "dim")));
        return;
      }
      const stop = which === "all"
        ? live
        : which === undefined
        ? [live[live.length - 1]]
        : live.filter((w) => String(w.n) === which || w.path === which);
      if (!stop.length) {
        throw new Error(`no watch ${which}: watches is ${live.map((w) => w.n).join(", ")}`);
      }
      for (const w of stop) {
        c.unwatch(w.n);
        a.out.push(line(span("◌ ", "dim"), `stopped watching ${w.path}`, span(`  #${w.n}`, "dim")));
      }
    },
  },
  {
    name: "history",
    usage: "history",
    help: "the commands typed here, oldest first",
    run: (c, a) => {
      const h = c.history;
      h.forEach((t, i) => a.out.push(line(span(String(i + 1).padStart(4) + "  ", "dim"), t)));
    },
  },
  {
    name: "whoami",
    usage: "whoami",
    help: "the agent every command acts as: the one chosen in the top bar",
    run: (c, a) => void a.out.push(line(span(c.world.agent, "agent"))),
  },
  {
    name: "clear",
    also: ["cls"],
    usage: "clear",
    help: "clear the console; the history stays",
    run: (c) => c.clear(),
  },
];

function commandNamed(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.also?.includes(name));
}

/** The names a command line may start with. */
export const commandNames = COMMANDS.flatMap((c) => [c.name, ...(c.also ?? [])]).sort();

function need(a: Args, i: number, what: string): string {
  const w = a.words[i];
  if (!w) throw new Error(what);
  return w.raw;
}

/** A position in a slot: a number, first, or last (after the last id: its length). */
function position(text: string, length: number): number {
  if (text === "first" || text === "front") return 0;
  if (text === "last" || text === "end") return length;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${text}: a position is 0, 1, …, first or last`);
  }
  return n;
}

/** An address relative to here, as a path. */
function rel(path: readonly string[]): string {
  if (!path.length) return ".";
  return path.map((p) => (p === ".." ? p : escapeName(p))).join("/");
}

function who(agent: Json): string {
  const a = actorOf(agent);
  return typeof a === "string" ? a : J(a);
}

function indent(l: Line): Line {
  return [span("    "), ...l];
}

/** What a scheduler put in front of a process's value, in a line. */
function front(f: ProcessItem): Line {
  if ("waiting" in f) {
    return line(
      span("… ", "warn"),
      span(`waiting on ${f.waiting.map((t) => "@" + t).join(" ")}`, "dim"),
    );
  }
  if ("stopped" in f) return line(span("■ ", "dim"), span("stopped", "dim"));
  if ("error" in f) {
    return line(
      span("✕ ", "bad"),
      span(`${f.error.kind} · ${f.error.why.code}`, "bad strong"),
      span(`  run #${f.from.run}`, "dim"),
      span(f.error.why.text ? `  ${f.error.why.text}` : ""),
    );
  }
  return line(
    span("↻ ", "warn"),
    span("newer: its program or loader has changed since it started", "dim"),
  );
}

/** "✓ wrote /a/b.key @t" */
function done(verb: string, names: string[], keys: string[], time: number): Line {
  return line(
    span("✓ ", "ok"),
    `${verb} `,
    span(showPath(names) + keys.map((k) => "." + k).join(""), "path"),
    span(`  @${time}`, "ref", { ref: time }),
  );
}

/** The processes a change marked, as the scheduler ran them. */
function marks(marked: readonly { process: Id }[] | undefined): Line[] {
  if (!marked?.length) return [];
  return [line(
    span("  marked ", "dim"),
    ...marked.flatMap((m, i) => [
      span(i ? ", " : ""),
      span(`◉ ${m.process}`, "proc", { node: m.process }),
    ]),
  )];
}

function gone(ids: readonly Id[] | undefined): Line[] {
  if (!ids?.length) return [];
  return [line(span(`  let go: ${ids.join(", ")}`, "dim"))];
}

/**
 * The patch that sets keys inside a value to v, or deletes the last of them
 * when v is nothing: a set in a map, a splice in a list.
 */
export function patchFor(
  value: Json | undefined,
  keys: readonly string[],
  v: Json | undefined,
): Patch {
  const path: (string | number)[] = [];
  let at: unknown = value;
  for (const k of keys.slice(0, -1)) {
    const key = Array.isArray(at) && /^\d+$/.test(k) ? Number(k) : k;
    if (at === null || typeof at !== "object" || !(key in (at as object))) {
      throw new Error(`.${[...path, key].join(".")}: nothing there in the value`);
    }
    path.push(key);
    at = (at as { [k: string]: unknown })[key as string];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(at)) {
    if (!/^\d+$/.test(last)) throw new Error(`.${last}: a list's elements are 0, 1, …`);
    const i = Number(last);
    if (i > at.length || (v === undefined && i >= at.length)) {
      throw new Error(`.${last}: the list has ${at.length} elements`);
    }
    return v === undefined
      ? { type: "splice", path, range: [i, i + 1] }
      : { type: "splice", path, range: [i, Math.min(i + 1, at.length)], value: [v] };
  }
  if (at === null || typeof at !== "object" || isBytes(at) || kindOf(at)) {
    throw new Error(`.${keys.join(".")}: only a map's keys and a list's elements can be set`);
  }
  return v === undefined
    ? { type: "set", path, key: last }
    : { type: "set", path, key: last, value: v };
}

// --- the console ---

export class Console {
  /** bumped whenever what the console shows changes */
  version = signal(0);
  /** where the console is: names from the root, its place */
  cwd: string[] = [];
  entries: Entry[] = [];
  history: string[];
  #watches = new Map<number, Watch>();
  #n = 0;
  #w = 0;
  #saved?: (history: string[]) => void;

  constructor(
    readonly world: World,
    o: { history?: string[]; saved?: (history: string[]) => void } = {},
  ) {
    this.history = [...(o.history ?? [])];
    this.#saved = o.saved;
  }

  /** The top of the page's stack: what every command goes through. */
  get api(): Scheduler {
    return this.world.scheduler;
  }

  /** The prompt: where the console is. */
  get prompt(): string {
    return showPath(this.cwd);
  }

  /** Who and where: the acting agent, at the console's place. */
  acting(): { agent: string; place: string[] } {
    return { agent: this.world.agent, place: [...this.cwd] };
  }

  /** The site of a change a console line makes: the line, as a file of its own. */
  cause(n: number): { cause: Json } {
    return { cause: { file: `console-${n}`, line: 1, column: 1 } };
  }

  /** The command typed as line n, if this page has it. */
  line(n: number): string | undefined {
    const e = this.entries.find((x) => x.kind === "command" && x.n === n);
    return e?.kind === "command" ? e.text : this.#typed.get(n);
  }

  /** every command's text, by its number, so a site names it after a clear */
  #typed = new Map<number, string>();

  bump() {
    this.version.value++;
  }

  /** Runs a line: a command and its words. Answers with what it printed. */
  run(text: string): Entry | undefined {
    const t = text.trim();
    if (!t) return;
    if (this.history[this.history.length - 1] !== t) {
      this.history.push(t);
      if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
      this.#saved?.(this.history);
    }
    const n = ++this.#n;
    this.#typed.set(n, t);
    const entry: Entry & { kind: "command" } = {
      kind: "command",
      n,
      text: t,
      cwd: [...this.cwd],
      agent: this.world.agent,
      out: [],
      ok: true,
    };
    this.#here(entry.out);
    this.entries.push(entry);
    const words = tokens(t);
    const name = word(words[0].raw);
    try {
      const cmd = commandNamed(name);
      if (!cmd) throw new Error(`${name}: no such command. help lists them`);
      const rest = words.slice(1);
      cmd.run(this, {
        n,
        words: rest,
        rest: (i) => (rest[i] ? t.slice(rest[i].start) : ""),
        out: entry.out,
      });
    } catch (e) {
      entry.ok = false;
      entry.out.push(errorLine(e));
    }
    this.#trim();
    this.bump();
    return entry;
  }

  /** Empties the console; the history and the watches stay. */
  clear() {
    this.entries = [];
    this.bump();
  }

  /** If the place reaches nothing now (another project, a node unplaced), back to the root. */
  #here(out: Line[]) {
    if (!this.cwd.length) return;
    const items = this.tryRead([]);
    if (items === "refused" || items.some((i) => "value" in i)) return;
    out.push(line(span(`${showPath(this.cwd)} reaches nothing now: back to /`, "dim")));
    this.cwd = [];
  }

  #trim() {
    if (this.entries.length > 400) this.entries.splice(0, this.entries.length - 400);
  }

  /** A read as the acting agent from here, or "refused". */
  tryRead(address: Address): ReturnType<Scheduler["read"]> | "refused" {
    try {
      return this.api.read({ ...this.acting(), address });
    } catch (e) {
      if (e instanceof ErmineError && e.kind === "refused") return "refused";
      throw e;
    }
  }

  /** The value the address reaches, read as the acting agent. */
  valueAt(address: Address): Json | undefined {
    const items = this.tryRead(address);
    if (items === "refused") throw new Error("you may not read it, so the console cannot patch it");
    return items.find((i): i is ValueItem => "value" in i)?.value;
  }

  /** The ids in a slot, read as the acting agent. */
  slot(address: Address, name: string): Id[] {
    const d = this.api.directory({ ...this.acting(), address, name });
    return "items" in d ? d.items.map((i) => i.id) : [];
  }

  /** The id a walk takes in a slot: the first whose node is here. */
  first(address: Address, name: string): Id {
    const d = this.api.directory({ ...this.acting(), address, name });
    const items = "items" in d ? d.items : [];
    const it = items.find((i) => !i.pending) ?? items[0];
    if (!it) throw new Error(`no slot ${escapeName(name)} there`);
    return it.id;
  }

  /** An id no node here has, from a name. */
  freshId(name: string): Id {
    const base = name.trim().replace(/\s+/g, "-") || "node";
    if (!this.world.made.has(base)) return base;
    for (let i = 2;; i++) if (!this.world.made.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  /**
   * What a write's path names: a node, and keys inside its value after
   * dots. A name may have dots in it, so the longest name that reaches a
   * node wins: notes/today.text is the node notes/today.text if there is
   * one, and otherwise the key text of notes/today. A "\." is a dot in a
   * name.
   */
  target(raw: string): Parsed & { keys: string[] } {
    let t = raw.trim();
    if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) t = t.slice(1, -1);
    const parts = splitRaw(t, "/");
    const last = parts[parts.length - 1];
    const segs = splitRaw(last, ".");
    const dotted = last !== "." && last !== ".." && segs.length > 1 && segs.every((s) => s !== "");
    if (!dotted) return { ...parsePath(t, this.cwd), keys: [] };
    const head = parts.slice(0, -1).join("/") + (parts.length > 1 ? "/" : "");
    for (let i = segs.length; i >= 1; i--) {
      const p = parsePath(head + segs.slice(0, i).join("."), this.cwd);
      const items = this.tryRead(p.address);
      if (items === "refused" || items.some((x) => "value" in x)) {
        return { ...p, keys: segs.slice(i).map(unescape) };
      }
    }
    return { ...parsePath(t, this.cwd), keys: [] };
  }

  /** One name of a listing: what it holds, and, long, its id and who last changed its slot. */
  listed(address: Address, name: string, items: SlotItem[], width: number, long: boolean): Line {
    const first = items.find((i) => !i.pending) ?? items[0];
    const id = first.id;
    const w = this.world;
    const folder = w.slotsOf(id).length > 0;
    const proc = w.isProcess(id);
    const glyph = proc ? "◉ " : first.pending ? "… " : first.ephemeral ? "~ " : "  ";
    const shown = escapeName(name) + (folder ? "/" : "");
    const out: Line = [
      span(glyph, proc ? "proc" : "dim"),
      span(shown.padEnd(width + 1), folder ? "folder" : proc ? "proc" : "name", { node: id }),
    ];
    if (first.pending) out.push(span("pending: not here yet", "dim"));
    else {
      let v: Json | undefined;
      try {
        v = this.api.read({ ...this.acting(), address: [...address, name] })
          .find((i): i is ValueItem => "value" in i)?.value;
      } catch {
        out.push(span("⊘ refused", "bad"));
      }
      if (v !== undefined && !(folder && (v === null || isEmptyMap(v)))) {
        out.push(span(peek(v, long ? 32 : 48), "num"));
      }
    }
    if (items.length > 1) out.push(span(`  +${items.length - 1} more in the slot`, "dim"));
    if (long) {
      out.push(span(`  ${id}`, "id"));
      const ch = first.change;
      if (ch) {
        out.push(
          span(`  @${ch.time}`, "ref", { ref: ch.time }),
          span(` ${who(ch.agent)}`, "agent"),
        );
      }
    }
    return out;
  }

  /** Why an item: its route, and the change that set it, back through the run that made it. */
  explain(it: ValueItem): Line[] {
    const out: Line[] = [];
    const route = it.from.route;
    out.push(line(
      span("from ", "dim"),
      span(
        route.length
          ? route.map((s) => `${escapeName(s.name)}${s.position ? `[${s.position}]` : ""}`).join(
            "/",
          )
          : ".",
        "path",
      ),
      span(route.length ? `  → ${route[route.length - 1].node}` : "", "dim"),
      span(route.some((s) => s.position) ? "  [n]: not the first in its slot" : "", "dim"),
      span(it.ephemeral ? "  ephemeral: nobody keeps it" : "", "dim"),
    ));
    out.push(...printValue(it.value).map(indent));
    const ch = it.change;
    if (!ch) {
      out.push(line(span("no change set it: the root's first value, as the host gave it", "dim")));
      return out;
    }
    out.push(...this.change(ch));
    return out;
  }

  /** A change's header, as why tells it: what, who, when, why; for a process's, the run. */
  change(ch: Header | Change): Line[] {
    const out: Line[] = [];
    const w = this.world;
    const peer = peerOf(ch.agent);
    out.push(line(
      span(`${ch.kind} `, "strong"),
      span(`@${ch.time}`, "ref", { ref: ch.time }),
      span(" by ", "dim"),
      span(who(ch.agent), "agent"),
      span(peer ? `  ⇄ peer ${peer.slice(0, 8)}…` : "", "dim"),
      span(ch.process ? "  as " : "", "dim"),
      ...(ch.process ? [span(`◉ ${ch.process}`, "proc", { node: ch.process })] : []),
      span(ch.ephemeral ? "  ephemeral" : "", "dim"),
    ));
    if (ch.process) {
      const run = w.producedBy.get(ch.time);
      if (run && "run" in run) {
        out.push(line(
          span("    set by run ", "dim"),
          span(`#${run.run}`, "strong"),
          span(` of ◉ ${run.process}, which ended ${run.ending}`, "dim"),
          ...(run.marked.length
            ? [
              span(", marked by ", "dim"),
              ...run.marked.flatMap((
                t,
                i,
              ) => [span(i ? " " : ""), span(`@${t}`, "ref", { ref: t })]),
            ]
            : [span(", its first", "dim")]),
        ));
      } else if (run) {
        out.push(line(span("    in a handler call, outside any run", "dim")));
      } else {
        out.push(line(span("    through its lasting interface, outside any run", "dim")));
      }
    }
    const site = siteOf(ch.cause);
    if (site) {
      const m = site.file.match(/^(console|snippet)-(\d+)$/);
      const text = m?.[1] === "console"
        ? this.line(Number(m[2]))
        : m
        ? w.snippets[Number(m[2]) - 1]?.code.split("\n")[site.line - 1]?.trim()
        : undefined;
      out.push(line(
        span("    site ", "dim"),
        span(`${site.file}:${site.line}:${site.column}`, "site"),
        span(w.linked.has(ch.time) ? "  on a mounter's page" : "", "dim"),
        span(text ? `  ${text}` : "", "code"),
      ));
    } else if (ch.cause !== undefined) {
      out.push(line(span("    cause ", "dim"), span(peek(ch.cause, 80), "num")));
    }
    return out;
  }

  // --- watches ---

  /** The watches running on the page's stack now: one made on a graph since reset is gone. */
  *watching(): Iterable<Watch> {
    for (const [n, w] of this.#watches) {
      if (w.scheduler !== this.api) this.#watches.delete(n);
      else yield w;
    }
  }

  /** Subscribes to what a path reaches; each change it receives is printed. Answers with its number. */
  watch(p: Parsed): number {
    const n = ++this.#w;
    const path = showPath(p.names);
    const scheduler = this.api;
    const { sub } = scheduler.subscribe({
      ...this.acting(),
      address: p.address,
      send: (e) => this.#received(n, path, e),
    });
    this.#watches.set(n, { n, sub, path, scheduler });
    return n;
  }

  unwatch(n: number) {
    const w = this.#watches.get(n);
    if (!w) return;
    this.#watches.delete(n);
    try {
      w.scheduler.unsubscribe({ agent: this.world.agent, sub: w.sub });
    } catch { /* its graph is gone */ }
    this.bump();
  }

  #received(n: number, path: string, e: Event) {
    const out: Line[] = [];
    if ("record" in e) {
      out.push(line(
        span(`#${n} `, "dim"),
        span(`run #${e.record.run} of ◉ ${e.record.process}`, "proc", { node: e.record.process }),
        span(` ended ${e.record.ending}`, "dim"),
        ...(e.record.value === undefined ? [] : [span("  " + peek(e.record.value, 60), "num")]),
      ));
    } else {
      const c = e.change;
      out.push(line(
        span(`#${n} `, "dim"),
        span(`${c.kind} `, "strong"),
        span(`@${c.time}`, "ref", { ref: c.time }),
        span(" by ", "dim"),
        span(who(c.agent), "agent"),
        span(c.process ? ` as ◉ ${c.process}` : "", "dim"),
        span("  ", ""),
        span(changeText(c), "num"),
      ));
      if (e.reaches) {
        const first = e.reaches.find((i) => "value" in i);
        out.push(line(
          span("    now reaches ", "dim"),
          span(first ? first.from.route.at(-1)?.node ?? "." : "nothing", "id"),
          ...(first ? [span("  " + peek(first.value, 60), "num")] : []),
        ));
      }
    }
    this.entries.push({ kind: "event", watch: n, path, out });
    this.#trim();
    this.bump();
  }

  // --- completion ---

  /**
   * Completes the word before the caret: a command's name first, a path's
   * last name after. Answers with the line, the caret, and the choices when
   * there are several.
   */
  complete(text: string, caret = text.length): { text: string; caret: number; options: string[] } {
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const words = tokens(before);
    const atSpace = before === "" || /\s$/.test(before);
    const partial = atSpace ? "" : words[words.length - 1]?.raw ?? "";
    const index = atSpace ? words.length : words.length - 1;
    const replace = (done: string, options: string[]) => {
      const head = before.slice(0, before.length - partial.length) + done;
      return { text: head + after, caret: head.length, options };
    };
    if (index === 0) {
      const options = commandNames.filter((c) => c.startsWith(partial));
      if (options.length === 1) return replace(options[0] + " ", []);
      return replace(common(options, partial), options);
    }
    // a path: the folder before the last unescaped "/", and the start of a name in it
    const quoted = partial.startsWith('"') || partial.startsWith("'");
    const body = quoted ? partial.slice(1) : partial;
    const parts = splitRaw(body, "/");
    const start = parts[parts.length - 1];
    const folder = body.slice(0, body.length - start.length);
    const prefix = unescape(start);
    let names: [string, boolean][] = [];
    try {
      const p = parsePath(folder || ".", this.cwd);
      const d = this.api.directory({ ...this.acting(), address: p.address });
      if ("directory" in d) {
        names = d.directory.map(([n, items]) => {
          const id = (items.find((i) => !i.pending) ?? items[0])?.id;
          return [n, id !== undefined && this.world.slotsOf(id).length > 0];
        });
      }
    } catch { /* nothing to complete from */ }
    const found = names.filter(([n]) => n.startsWith(prefix));
    const lead = (quoted ? partial[0] : "") + folder;
    if (found.length === 1) {
      const [n, isFolder] = found[0];
      return replace(lead + escapeName(n) + (isFolder ? "/" : quoted ? "" : " "), []);
    }
    const options = found.map(([n, f]) => n + (f ? "/" : ""));
    const shared = common(found.map(([n]) => n), prefix);
    return replace(lead + escapeName(shared), options);
  }
}

/** The longest start every option shares, at least the start given. */
function common(options: string[], start: string): string {
  if (!options.length) return start;
  let s = options[0];
  for (const o of options) while (!o.startsWith(s)) s = s.slice(0, -1);
  return s.length >= start.length ? s : start;
}

function isEmptyMap(v: Json): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !isBytes(v) && !kindOf(v) &&
    Object.keys(v).length === 0;
}

/** What a change did, in a few words. */
function changeText(c: Change): string {
  if (c.kind === "write") {
    if (c.patches.length === 1 && c.patches[0].type === "snapshot") {
      return "= " + peek(c.patches[0].value, 60);
    }
    return c.patches.map((p) =>
      p.type === "set"
        ? `.${[...p.path, p.key].join(".")} ${
          p.value === undefined ? "deleted" : "= " + peek(p.value, 30)
        }`
        : p.type === "splice"
        ? `.${p.path.join(".")}[${p.range[0]}, ${p.range[1]}) ${
          p.value === undefined ? "deleted" : "= " + peek(p.value, 30)
        }`
        : "= " + peek(p.value, 40)
    ).join("; ");
  }
  if (c.kind === "place") {
    return `${escapeName(c.name)} ← ${c.id}${c.position === undefined ? "" : ` at ${c.position}`}${
      c.value === undefined ? "" : " = " + peek(c.value, 30)
    }`;
  }
  return `${escapeName(c.name)} ✕ ${c.id}`;
}
