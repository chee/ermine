/// <reference lib="dom" />
// The world the demo plays with: drive(protect(watch(graph()), may), root, load),
// a log of everything that happened, and the workspace that every outside act
// goes through, so that each change from outside carries a real site: the
// snippet, line and column it was made from.

import { signal } from "@preact/signals";
import {
  type Change,
  type ChangeRef,
  type Compute,
  drive,
  type Driver,
  type Effect,
  ErmineError,
  type Event,
  type Fired,
  graph,
  type Id,
  type Interface,
  type Json,
  type Load,
  type Patch,
  type Path,
  PENDING,
  protect,
  type Record as Run,
  type Settled,
  type Site,
  type Step,
  subject,
} from "../../../src/mod.ts";
import { loader as steps } from "../../../harness/programs.ts";

export const ROOT = "root";

export type Rule = {
  agent?: string;
  process?: string;
  op?: string;
  node?: string;
  allow: boolean;
  on: boolean;
};

export type Problem = { kind: string; why: string; op?: string };

export type Entry =
  | { t: "change"; n: number; change: Change }
  | { t: "record"; n: number; record: Run }
  | { t: "stopped"; n: number; process: Id }
  | { t: "error"; n: number; error: Problem; snippet?: number }
  | { t: "snippet"; n: number; snippet: number };

/** An entry before the log numbers it. */
type Unnumbered = Entry extends infer E ? E extends Entry ? Omit<E, "n"> : never : never;

export type Snippet = {
  n: number;
  code: string;
  label?: string;
  agent: string;
  ok?: boolean;
  result?: string;
  error?: Problem;
  /** the times of the changes it made from outside */
  times: number[];
};

export const key = (r: ChangeRef) => `${r.node}@${r.time}`;
export const J = (v: unknown) => JSON.stringify(v);

export function problem(e: unknown): Problem {
  if (e instanceof ErmineError) return { kind: e.kind, why: e.message, op: e.op };
  if (e instanceof Error) return { kind: "thrown", why: e.message };
  return { kind: "thrown", why: String(e) };
}

const AGENT_COLORS = ["rose", "lilac", "mint", "butter", "sky", "peach"];

/** One frame of a snippet in a stack: snippets are evaluated with a sourceURL. */
const SNIPPET_FRAME = /ermine:snippet-(\d+):(\d+):(\d+)/;
/** Snippets are wrapped in one line of function header. */
const HEADER_LINES = 1;

export class World {
  version = signal(0);
  log: Entry[] = [];
  /** every node made, in the order made, with its making */
  made = new Map<Id, Change>();
  /** the time of each node's latest change */
  latest = new Map<Id, number>();
  changes = new Map<string, Change>();
  records = new Map<Id, Run[]>();
  /** the record of the run that made each change */
  producedBy = new Map<string, Run>();
  /** the runs each change marked */
  marked = new Map<string, Run[]>();
  handlers = new Map<Id, Set<string>>();
  snippets: Snippet[] = [];
  rules: Rule[] = [];
  agents = ["chee", "bun", "hop"];
  agent = "chee";
  /** read everything beneath protect, as the host may */
  seeAll = false;
  /** the stage that effects draw on: one screen per process */
  stage = document.createElement("div");
  screens = new Map<Id, HTMLElement>();

  driver!: Driver;
  /** the layer under protect: what the trusted host sees */
  bare!: Interface;
  #n = 0;
  #snippet?: { n: number; cause?: Json; agent?: string };
  #bump = false;

  constructor() {
    this.stage.className = "stage-root";
    this.reset();
  }

  colorOf(agent: Json): string {
    const name = typeof agent === "string" ? agent : J(agent);
    let i = this.agents.indexOf(name);
    if (i < 0) {
      i = [...name].reduce((h, c) => (h * 31 + c.codePointAt(0)!) >>> 0, 7);
    }
    return AGENT_COLORS[i % AGENT_COLORS.length];
  }

  /** A fresh graph: everything made so far is gone. Rules and agents stay. */
  reset() {
    for (const el of this.screens.values()) el.remove();
    this.screens.clear();
    this.log = [];
    this.made.clear();
    this.latest.clear();
    this.changes.clear();
    this.records.clear();
    this.producedBy.clear();
    this.marked.clear();
    this.handlers.clear();
    this.snippets = [];
    this.subs.clear();
    const may = (agent: Json, process: Id | undefined, op: string, args: object) => {
      const node = subject(op, args);
      for (const r of this.rules) {
        if (!r.on) continue;
        if (r.agent !== undefined && r.agent !== agent) continue;
        if (r.process !== undefined && r.process !== process) continue;
        if (r.op !== undefined && r.op !== op) continue;
        if (r.node !== undefined && r.node !== node) continue;
        return r.allow;
      }
      return true;
    };
    this.bare = watch(graph(), {
      change: (c) => this.#change(c),
      record: (r) => this.#record(r),
    });
    this.driver = drive(protect(this.bare, may), ROOT, this.#load);
    this.driver.top(this.driver);
    // a graph is made with one node, its root, which the host gives
    this.run(
      `as("host", () => api.make({ id: ${J(ROOT)}, value: {} }))`,
      "the host gives the root",
    );
  }

  bump() {
    if (this.#bump) return;
    this.#bump = true;
    queueMicrotask(() => {
      this.#bump = false;
      this.version.value++;
    });
  }

  #push(e: Unnumbered) {
    this.log.push({ ...e, n: ++this.#n } as Entry);
    this.bump();
  }

  #change(c: Change) {
    if (c.kind === "make") this.made.set(c.node, c);
    this.latest.set(c.node, c.time);
    this.changes.set(key(c), c);
    const s = this.#snippet;
    if (s && !c.process) this.snippets.find((x) => x.n === s.n)?.times.push(c.time);
    this.#push({ t: "change", change: c });
  }

  #record(r: Run) {
    const list = this.records.get(r.process) ?? [];
    list.push(r);
    this.records.set(r.process, list);
    for (const c of r.changes) this.producedBy.set(key(c), r);
    for (const m of r.marked) {
      const k = key(m);
      this.marked.set(k, [...(this.marked.get(k) ?? []), r]);
    }
    this.#push({ t: "record", record: r });
  }

  /** Subscriptions the inspector made, by node: what each has received. */
  subs = new Map<Id, { sub: number; events: Event[] }>();

  /** Subscribes to a node as the acting agent; protect checks it like any operation. */
  subscribe(node: Id): Problem | undefined {
    try {
      const entry = { sub: 0, events: [] as Event[] };
      entry.sub = this.driver.subscribe({
        agent: this.agent,
        node,
        send: (e) => {
          entry.events.push(e);
          this.bump();
        },
      }).sub;
      this.subs.set(node, entry);
      this.bump();
    } catch (e) {
      return problem(e);
    }
  }

  unsubscribe(node: Id): Problem | undefined {
    const entry = this.subs.get(node);
    if (!entry) return;
    try {
      this.driver.unsubscribe({ agent: this.agent, sub: entry.sub });
      this.subs.delete(node);
      this.bump();
    } catch (e) {
      return problem(e);
    }
  }

  #settled(s: Settled | undefined) {
    for (const st of s?.stopped ?? []) {
      this.#push({ t: "stopped", process: st.process });
      this.screens.get(st.process)?.remove();
      this.screens.delete(st.process);
      this.handlers.delete(st.process);
    }
  }

  // --- reading, as the acting agent or beneath protect ---

  get view(): Interface {
    return this.seeAll ? this.bare : this.driver;
  }

  read(node: Id): { value: Json } | { absent: true } | { refused: string } {
    try {
      return this.view.read({ agent: this.agent, node });
    } catch (e) {
      return { refused: problem(e).why };
    }
  }

  data(node: Id): Json | undefined {
    try {
      const d = this.view.data({ agent: this.agent, node });
      return "data" in d ? d.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** The node's directory, as [name, ids] in code point order. */
  directory(node: Id): [string, Id[]][] | { refused: string } | undefined {
    try {
      const d = this.view.directory({ agent: this.agent, node });
      return "directory" in d ? d.directory : undefined;
    } catch (e) {
      return { refused: problem(e).why };
    }
  }

  /** Every slot each node is placed in, read beneath protect. */
  placements(): Map<Id, { parent: Id; name: string; index: number }[]> {
    const where = new Map<Id, { parent: Id; name: string; index: number }[]>();
    for (const parent of this.made.keys()) {
      const d = this.bare.directory({ agent: "host", node: parent });
      if (!("directory" in d)) continue;
      for (const [name, ids] of d.directory) {
        ids.forEach((id, index) => {
          where.set(id, [...(where.get(id) ?? []), { parent, name, index }]);
        });
      }
    }
    return where;
  }

  isProcess(node: Id): boolean {
    const m = this.made.get(node);
    const d = m && m.kind === "make" ? m.data : undefined;
    return typeof d === "object" && d !== null && !Array.isArray(d) && "path" in d;
  }

  /** The processes the driver runs: the walk of PROTOCOL.tex, beneath protect. */
  running(): Set<Id> {
    const seen = new Set<Id>([ROOT]);
    const out = new Set<Id>();
    const go = (node: Id) => {
      const d = this.bare.directory({ agent: "host", node });
      if (!("directory" in d)) return;
      for (const [name, ids] of d.directory) {
        if (name === "compute" || name === "effect") continue;
        for (const id of ids) {
          if (seen.has(id) || !this.isProcess(id)) continue;
          seen.add(id);
          out.add(id);
          go(id);
        }
      }
    };
    go(ROOT);
    return out;
  }

  // --- the workspace: every act from outside is a snippet ---

  /** The host interface for snippets: fills in the agent, the cause and the site. */
  host(): Driver & { [op: string]: unknown } {
    const d = this.driver;
    const fill = <T extends object>(op: T) => {
      const s = this.#snippet;
      const out: Record<string, unknown> = { agent: s?.agent ?? this.agent, ...op };
      if (!("site" in op)) out.site = siteHere();
      if (s?.cause !== undefined && !("cause" in op)) out.cause = s.cause;
      return out as T;
    };
    const change = <T extends object>(f: (op: T) => Settled) => (op: T) => {
      const r = f(fill(op));
      this.#settled(r);
      return r;
    };
    const acting = <T extends object, R>(f: (op: T) => R) => (op: T) =>
      f({ agent: this.#snippet?.agent ?? this.agent, ...op });
    return {
      ...d,
      make: change(d.make),
      write: change(d.write),
      place: change(d.place),
      unplace: change(d.unplace),
      read: acting(d.read),
      data: acting(d.data),
      directory: acting(d.directory),
      lookup: acting(d.lookup),
      fire: (op) => {
        const r = d.fire({ agent: this.#snippet?.agent ?? this.agent, ...op });
        this.#settled(r);
        if (r.error !== undefined) this.#push({ t: "error", error: problem(r.error) });
        return r;
      },
      batch: (fn) => {
        const r = d.batch(fn);
        this.#settled(r);
        return r;
      },
    } as Driver & { [op: string]: unknown };
  }

  /** The words a snippet can use, besides api. */
  vocabulary() {
    const api = this.host();
    const has = (id: Id) => this.made.has(id);
    const value = (r: { value: Json } | { absent: true }) => "value" in r ? r.value : undefined;
    const words = {
      api,
      /**
       * Makes a node by placing it, as CORE.tex has it: the making is its first
       * change and the placement follows. An id the graph has is placed once more.
       */
      make: (parent: Id, name: string, id: Id, value: Json = null, data?: Json) =>
        made(api, has, parent, name, id, value, data),
      write: (node: Id, value: Json) => api.write({ node, patches: [{ type: "snapshot", value }] }),
      patch: (node: Id, ...patches: Patch[]) => api.write({ node, patches }),
      splice: (node: Id, path: (string | number)[], from: number, to: number, value?: Json) =>
        api.write({
          node,
          patches: [
            value === undefined
              ? { type: "splice", path, range: [from, to] }
              : { type: "splice", path, range: [from, to], value },
          ],
        }),
      set: (node: Id, path: (string | number)[], key: string, value?: Json) =>
        api.write({
          node,
          patches: [
            value === undefined ? { type: "set", path, key } : { type: "set", path, key, value },
          ],
        }),
      place: (parent: Id, name: string, id: Id, position?: number) =>
        api.place(position === undefined ? { parent, name, id } : { parent, name, id, position }),
      unplace: (parent: Id, name: string, id: Id) => api.unplace({ parent, name, id }),
      read: (node: Id) => value(api.read({ node })),
      data: (node: Id) => {
        const d = api.data({ node });
        return "data" in d ? d.data : undefined;
      },
      dir: (node: Id, name?: string) => {
        const d = api.directory(name === undefined ? { node } : { node, name });
        if ("absent" in d) return undefined;
        return "slot" in d ? d.slot : Object.fromEntries(d.directory);
      },
      lookup: (name: string, path: Path) => api.lookup({ name, path }).found,
      /** A path through these nodes, each placed in the one before: path("root", "home", "note"). */
      path: (...ids: Id[]): Step[] => {
        const steps: Step[] = [];
        for (let i = 1; i < ids.length; i++) {
          const d = this.bare.directory({ agent: "host", node: ids[i - 1] });
          const slot = "directory" in d
            ? d.directory.find(([, xs]) => xs.includes(ids[i]))
            : undefined;
          if (!slot) throw new Error(`${J(ids[i])} is not placed in ${J(ids[i - 1])}`);
          steps.push({ parent: ids[i - 1], name: slot[0], node: ids[i] });
        }
        return steps;
      },
      /** A program node, JS source or a list of steps, made in a parent's slot of its name. */
      program: (parent: Id, id: Id, code: Json) => made(api, has, parent, id, id, code),
      /**
       * A process, made in its programs' slots and placed in parent's slot name.
       * Placing it under the root or a process starts it, so it is all one batch.
       * Its place is where it is put, so its lookups search parent and up,
       * unless a path is given. Code that is not a program's id is made into
       * the process's own slot.
       */
      process: (
        parent: Id,
        name: string,
        id: Id,
        o: { compute: Json; effect?: Json; path?: Path; value?: Json },
      ) => {
        api.batch(() => {
          const path = o.path ?? [{ parent, name, node: id }];
          api.make({ id, value: o.value ?? null, data: { path: path as unknown as Json } });
          for (const part of ["compute", "effect"] as const) {
            const code = o[part];
            if (code === undefined) continue;
            if (typeof code === "string" && this.made.has(code)) {
              api.place({ parent: id, name: part, id: code });
            } else {
              made(api, has, id, part, `${id}.${part}`, code);
            }
          }
          api.place({ parent, name, id });
        });
        return id;
      },
      start: (id: Id, under: Id = ROOT, name: string = id) =>
        api.place({ parent: under, name, id }),
      stop: (id: Id, under: Id = ROOT, name: string = id) =>
        api.unplace({ parent: under, name, id }),
      fire: (process: Id, handler: string, input?: Json) =>
        api.fire(input === undefined ? { process, handler } : { process, handler, input }),
      batch: (fn: () => void) => api.batch(fn),
      /** Acts as another agent for the length of fn. */
      as: <R>(agent: string, fn: () => R): R => {
        const s = this.#snippet!;
        const was = s.agent;
        s.agent = agent;
        try {
          return fn();
        } finally {
          s.agent = was;
        }
      },
      /** Gives every change fn makes this cause. */
      because: <R>(cause: Json, fn: () => R): R => {
        const s = this.#snippet!;
        const was = s.cause;
        s.cause = cause;
        try {
          return fn();
        } finally {
          s.cause = was;
        }
      },
      PENDING,
    };
    return words;
  }

  /** Runs code as a snippet: its changes carry its site. Returns the snippet. */
  run(code: string, label?: string): Snippet {
    const n = this.snippets.length + 1;
    const snippet: Snippet = { n, code, label, agent: this.agent, times: [] };
    this.snippets.push(snippet);
    this.#push({ t: "snippet", snippet: n });
    const words = this.vocabulary();
    const names = Object.keys(words);
    const outer = this.#snippet;
    this.#snippet = { n };
    try {
      const fn = (0, eval)(
        `(function (${names.join(", ")}) {\n${code}\n})\n//# sourceURL=ermine:snippet-${n}`,
      );
      const result = fn(...names.map((k) => words[k as keyof typeof words]));
      snippet.ok = true;
      snippet.result = show(result);
    } catch (e) {
      snippet.ok = false;
      snippet.error = problem(e);
      this.#push({ t: "error", error: snippet.error, snippet: n });
    } finally {
      this.#snippet = outer;
      this.bump();
    }
    return snippet;
  }

  /** Runs a snippet whose last expression is its value, as print-it does. */
  print(code: string, label?: string): Snippet {
    const lines = code.trimEnd().split("\n");
    const last = lines.pop() ?? "";
    const body = /^\s*(return|const|let|var|if|for|while|function|class)\b/.test(last)
      ? code
      : [...lines, `return (${last.replace(/;\s*$/, "")})`].join("\n");
    return this.run(body, label);
  }

  // --- what the stage and the loader need ---

  screenFor(process: Id): HTMLElement {
    let el = this.screens.get(process);
    if (!el) {
      el = document.createElement("div");
      el.className = "screen";
      el.dataset.process = process;
      this.screens.set(process, el);
      this.stage.append(el);
      this.bump();
    }
    return el;
  }

  /** Fires a handler from the world, such as a click on a screen, as the acting agent. */
  fireFromWorld(process: Id, handler: string, input?: Json): Fired | undefined {
    try {
      const r = this.driver.fire(
        input === undefined
          ? { agent: this.agent, process, handler }
          : { agent: this.agent, process, handler, input },
      );
      this.#settled(r);
      if (r.error !== undefined) this.#push({ t: "error", error: problem(r.error) });
      return r;
    } catch (e) {
      this.#push({ t: "error", error: problem(e) });
    }
  }

  #compiled = new Map<string, (...args: unknown[]) => unknown>();

  #compile(code: string, part: "compute" | "effect", names: string[]) {
    const k = part + "\0" + code;
    let fn = this.#compiled.get(k);
    if (!fn) {
      fn = (0, eval)(
        `(function (${
          names.join(", ")
        }) {\n${code}\n})\n//# sourceURL=ermine:${part}-${this.#compiled.size}`,
      ) as (...args: unknown[]) => unknown;
      this.#compiled.set(k, fn);
    }
    return fn;
  }

  /** The host's loader: JS source as a function body, or a list of steps. */
  #load: Load = ((code: Json, part: "compute" | "effect") => {
    if (Array.isArray(code)) return steps(code, part as "compute");
    if (typeof code !== "string") {
      throw new Error("a program is JS source, or a list of steps");
    }
    if (part === "compute") {
      const names = [
        "ctx",
        "read",
        "data",
        "dir",
        "lookup",
        "find",
        "where",
        "self",
        "path",
        "changes",
        "PENDING",
      ];
      const fn = this.#compile(code, part, names);
      const compute: Compute = (ctx) => {
        const r = readers(ctx.api);
        const v = fn(
          ctx,
          r.read,
          r.data,
          r.dir,
          r.lookup,
          r.find,
          r.where,
          ctx.self,
          ctx.path,
          ctx.changes,
          PENDING,
        );
        return v as Json;
      };
      return compute;
    }
    const names = [
      "ctx",
      "value",
      "previous",
      "self",
      "write",
      "patch",
      "make",
      "place",
      "unplace",
      "later",
      "handler",
      "fire",
      "screen",
      "h",
    ];
    const fn = this.#compile(code, part, names);
    const effect: Effect = (ctx) => {
      const has = (id: Id) => this.made.has(id);
      const w = writers(ctx.api, has);
      const later = writers(ctx.lasting, has);
      const handler = (name: string, run: (input?: Json) => void) => {
        ctx.handler(name, run);
        const set = this.handlers.get(ctx.self) ?? new Set();
        set.add(name);
        this.handlers.set(ctx.self, set);
      };
      const fire = (name: string, input?: Json) =>
        queueMicrotask(() => this.fireFromWorld(ctx.self, name, input));
      const screen = () => this.screenFor(ctx.self);
      return fn(
        ctx,
        ctx.value,
        ctx.previous,
        ctx.self,
        w.write,
        w.patch,
        w.make,
        w.place,
        w.unplace,
        later,
        handler,
        fire,
        screen,
        h,
      ) as void | (() => void);
    };
    return effect;
  }) as Load;
}

/** The layer above the graph that tells the demo every change and record. */
function watch(api: Interface, sink: { change(c: Change): void; record(r: Run): void }): Interface {
  return {
    make: (op) => tap(api.make(op), sink),
    write: (op) => tap(api.write(op), sink),
    place: (op) => tap(api.place(op), sink),
    unplace: (op) => tap(api.unplace(op), sink),
    read: (op) => api.read(op),
    data: (op) => api.data(op),
    directory: (op) => api.directory(op),
    lookup: (op) => api.lookup(op),
    subscribe: (op) => api.subscribe(op),
    unsubscribe: (op) => api.unsubscribe(op),
    bind: (a, b) => api.bind(a, b),
    record: (a, m) => api.record(a, m),
    finish: (rec, ending, f) => {
      const r = api.finish(rec, ending, f);
      sink.record(r);
      return r;
    },
    top: (t) => api.top(t),
  };
}

function tap<T extends { change: Change }>(r: T, sink: { change(c: Change): void }): T {
  sink.change(r.change);
  return r;
}

/** The site of the snippet frame on the stack, as file, line and column. */
function siteHere(): Site {
  // the snippet's frame can sit under a batch and helpers, deeper than the default ten
  const E = Error as { stackTraceLimit?: number };
  const limit = E.stackTraceLimit;
  E.stackTraceLimit = 100;
  const stack = new Error().stack ?? "";
  E.stackTraceLimit = limit;
  const m = stack.match(SNIPPET_FRAME);
  if (!m) return { file: "demo", line: 0, column: 0 };
  return { file: `snippet-${m[1]}`, line: Number(m[2]) - HEADER_LINES, column: Number(m[3]) };
}

function readers(api: Interface) {
  return {
    read: (node: Id) => {
      const r = api.read({ node });
      return "value" in r ? r.value : undefined;
    },
    data: (node: Id) => {
      const r = api.data({ node });
      return "data" in r ? r.data : undefined;
    },
    dir: (node: Id, name?: string) => {
      const r = api.directory(name === undefined ? { node } : { node, name });
      if ("absent" in r) return name === undefined ? undefined : [];
      return "slot" in r ? r.slot : Object.fromEntries(r.directory);
    },
    lookup: (name: string) => api.lookup({ name }).found,
    /** The id of the nearest node by that name, searching up the place. */
    where: (name: string): Id | undefined => api.lookup({ name }).found[0],
    /** The value of the nearest node by that name, or undefined. */
    find: (name: string): Json | undefined => {
      const id = api.lookup({ name }).found[0];
      if (id === undefined) return undefined;
      const r = api.read({ node: id });
      return "value" in r ? r.value : undefined;
    },
  };
}

/**
 * Makes a node and places it: a node is made by placing it. An id the graph
 * has is only placed. Whether it has it is the host's knowledge, since an
 * effect's interface cannot read, and an invalid make would end its run.
 */
function made(
  api: Interface,
  has: (id: Id) => boolean,
  parent: Id,
  name: string,
  id: Id,
  value: Json,
  data?: Json,
) {
  if (!has(id)) api.make(data === undefined ? { id, value } : { id, value, data });
  return api.place({ parent, name, id });
}

function writers(api: Interface, has: (id: Id) => boolean) {
  return {
    api,
    write: (node: Id, value: Json) => api.write({ node, patches: [{ type: "snapshot", value }] }),
    patch: (node: Id, ...patches: Patch[]) => api.write({ node, patches }),
    make: (parent: Id, name: string, id: Id, value: Json = null, data?: Json) =>
      made(api, has, parent, name, id, value, data),
    place: (parent: Id, name: string, id: Id, position?: number) =>
      api.place(position === undefined ? { parent, name, id } : { parent, name, id, position }),
    unplace: (parent: Id, name: string, id: Id) => api.unplace({ parent, name, id }),
  };
}

/** A tiny element builder for effects: h("button", { onclick }, "hop"). */
export function h(
  tag: string,
  props: { [k: string]: unknown } = {},
  ...children: (Node | string | number | null | undefined | false)[]
): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) (el as unknown as Record<string, unknown>)[k] = v;
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "object" ? c : String(c));
  }
  return el;
}

export function show(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "function") return "ƒ";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
