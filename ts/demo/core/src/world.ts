/// <reference lib="dom" />
// The world the demo plays with: drive(protect(watch(graph(root)), may), root, load),
// a log of everything that happened, and the workspace that every outside act
// goes through, so that each change from outside carries a real site as its
// cause: the snippet, line and column it was made from.
//
// The graph is reached by address only. The host keeps its own copy of the
// graph, learned from the changes as the driver learns it, and turns the ids
// the workspace and the panes name into addresses from the root that reach them.

import { signal } from "@preact/signals";
import * as ermine from "../../../src/mod.ts";
import {
  type Address,
  applyPatches,
  back,
  byCodePoint,
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
  members,
  parseAddress,
  type Patch,
  PENDING,
  placed,
  protect,
  type ReadEntry,
  type Record as Run,
  Refused,
  type Searched,
  type Settled,
  type Site,
  type SlotFrom,
  type SlotItem,
  type Step,
  subject,
  type ValueItem,
  type View,
  walk,
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

/** What reverses a change from outside. */
export type Inverse =
  | { op: "write"; node: Id; value: Json }
  | { op: "unplace"; parent: Id; name: string; id: Id }
  | { op: "place"; parent: Id; name: string; id: Id; position: number };

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

/**
 * A read as the acting agent: the items, and the first one's value, if there
 * is one; and the address it read, if one from the root reaches the node.
 */
export type Reading = { items: ValueItem[]; value?: Json; address?: Address } | {
  refused: string;
};

/** A process the driver's walk reaches: where it runs, and the route to it. */
export type Running = { cwd: string[]; name: string; parent: Id; route: Step[] };

/** A lookup tried from a place: each directory searched, nearest first, and what it found. */
export type Found = { searched: Searched[]; found: Id[]; items: SlotItem[] };

export const key = (r: ChangeRef) => `${r.node}@${r.time}`;
export const J = (v: unknown) => JSON.stringify(v);

/** A cause that is a site: the file, line and column a change from outside was made at. */
export function siteOf(cause: Json | undefined): Site | undefined {
  if (cause === null || typeof cause !== "object" || Array.isArray(cause)) return;
  const { file, line, column } = cause as { [k: string]: Json };
  if (typeof file !== "string" || typeof line !== "number" || typeof column !== "number") return;
  return { file, line, column };
}

/** The node whose slot a directory item is in: the last of its route, or the root. */
function slotNode(item: SlotItem): Id {
  const route = (item.from as SlotFrom).route ?? [];
  return route.length ? route[route.length - 1].node : ROOT;
}

export function problem(e: unknown): Problem {
  if (e instanceof ErmineError) return { kind: e.kind, why: e.message, op: e.op };
  if (e instanceof Error) return { kind: "thrown", why: e.message };
  return { kind: "thrown", why: String(e) };
}

const AGENT_COLORS = ["rose", "lilac", "mint", "butter", "sky", "peach"];

/** One frame of a snippet in a stack: snippets are evaluated with a sourceURL. */
const SNIPPET_FRAME = /ermine:snippet-(\d+)(?:, <anonymous>)?:(\d+):(\d+)/;
/** Snippets are wrapped in one line of function header. */
const HEADER_LINES = 1;

export class World {
  version = signal(0);
  log: Entry[] = [];
  /**
   * every node made, in the order made, with the placement that made it; the
   * root, which the host gave when the graph was made, with none
   */
  made = new Map<Id, Change | undefined>();
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
  #guarded!: Interface;
  #n = 0;
  /** which reset made the graph being watched */
  #gen = 0;
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
    for (const [id, p] of this.#previews) this.#unpreview(id, p);
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
    this.#values.clear();
    this.#dirs.clear();
    this.#byTime.clear();
    this.#t++;
    // a graph is made with one node, its root, which the host gives: its value is null
    this.made.set(ROOT, undefined);
    this.#values.set(ROOT, null);
    this.inverses.clear();
    this.undoable = [];
    this.redoable = [];
    this.thrown.clear();
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
    // a graph from before a reset may still run, as a timer an effect set does;
    // what it does is not this world's, and would spoil the host's copy
    const gen = ++this.#gen;
    this.bare = watch(graph(ROOT), {
      change: (c) => gen === this.#gen && this.#change(c),
      record: (r) => gen === this.#gen && this.#record(r),
    });
    this.#guarded = protect(this.bare, may);
    this.driver = drive(this.#guarded, ROOT, this.#load);
    this.driver.top(this.driver);
    // shown to the ermine devtools panel, as the host sees it: beneath protect
    const shown =
      ((globalThis as { __ermine?: { name: string; api: Interface }[] }).__ermine ??= []);
    const at = shown.findIndex((g) => g.name === "demo");
    shown.splice(at < 0 ? shown.length : at, at < 0 ? 0 : 1, { name: "demo", api: this.bare });
    this.bump();
  }

  #previewing = false;

  bump() {
    if (this.#bump || this.#previewing) return;
    this.#bump = true;
    queueMicrotask(() => {
      this.#bump = false;
      // a screen lasts as long as its process runs, however it was stopped
      const running = this.running();
      for (const [id, box] of this.screens) {
        if (!running.has(id)) {
          box.remove();
          this.screens.delete(id);
        }
      }
      this.#follow();
      this.version.value++;
    });
  }

  /** Each screen drawn again for an agent its process does not run as: when, and its cleanup. */
  #previews = new Map<Id, { agent: string; t: number; value?: Json; cleanup?: () => void }>();

  /**
   * The stage follows the acting agent. A process runs as its starter, and
   * its screen shows what that agent sees. For any other agent the screen is
   * drawn again beside it, from the same programs run as that agent: reads
   * through protect, writes nowhere. It is drawn again when the graph changes.
   */
  #follow() {
    for (const [id, p] of this.#previews) {
      if (!this.screens.has(id)) this.#unpreview(id, p);
    }
    for (const [id, box] of this.screens) {
      const own = box.querySelector(":scope > .own") as HTMLElement;
      const starter = this.records.get(id)?.at(-1)?.agent;
      if (starter === undefined || starter === this.agent) {
        const p = this.#previews.get(id);
        if (p) this.#unpreview(id, p);
        own.style.display = "";
        continue;
      }
      own.style.display = "none";
      const was = this.#previews.get(id);
      if (was?.agent === this.agent && was.t === this.#t) continue;
      if (was && was.agent !== this.agent) this.#unpreview(id, was);
      let seen = box.querySelector(":scope > .seen") as HTMLElement | null;
      if (!seen) {
        seen = document.createElement("div");
        seen.className = "seen";
        box.insertBefore(seen, own.nextSibling);
      }
      this.#previewing = true;
      try {
        this.#preview(id, seen, was?.agent === this.agent ? was : undefined);
      } finally {
        this.#previewing = false;
      }
    }
  }

  #unpreview(id: Id, p: { cleanup?: () => void }) {
    this.#previews.delete(id);
    try {
      p.cleanup?.();
    } catch { /* a preview's cleanup is not the process's */ }
    this.screens.get(id)?.querySelector(":scope > .seen")?.remove();
  }

  /** Draws on seen what a process would show the acting agent, or why it shows nothing. */
  #preview(id: Id, seen: HTMLElement, was?: { value?: Json; cleanup?: () => void }) {
    const agent = this.agent;
    const note = (text: string) => {
      const d = document.createElement("div");
      d.className = "label";
      d.textContent = text;
      seen.replaceChildren(d);
    };
    const preview: { agent: string; t: number; value?: Json; cleanup?: () => void } = {
      agent,
      t: this.#t,
    };
    try {
      was?.cleanup?.();
    } catch { /* as above */ }
    this.#previews.set(id, preview);
    const at = this.running().get(id);
    const code = (part: string) => {
      const node = this.slotOf(id, part)[0];
      return node === undefined ? undefined : this.valueOf(node);
    };
    const compute = code("compute");
    if (!at || compute === undefined) return note(`nothing to show ${agent}`);
    try {
      const api = this.#guarded.bind(this.#guarded, {
        agent,
        process: id,
        place: at.cwd,
        writes: false,
      });
      const value = (this.#load(compute, "compute") as Compute)({
        api,
        self: id,
        cwd: at.cwd,
        name: at.name,
        changes: [],
      });
      if (value === PENDING || value === undefined) return note(`waiting, as ${agent}`);
      preview.value = value;
      const effect = code("effect");
      if (effect === undefined) return note(J(value));
      const nothing: Interface = new Proxy({} as Interface, { get: () => () => undefined });
      // the effect's screen() is this one, and its writes go nowhere
      const draw = this.screenFor;
      this.screenFor = (p: Id) => p === id ? seen : draw.call(this, p);
      try {
        const after = (this.#load(effect, "effect") as Effect)({
          api: nothing,
          lasting: nothing,
          self: id,
          cwd: at.cwd,
          name: at.name,
          value,
          ...(was?.value === undefined ? {} : { previous: was.value }),
          handler: () => {},
        });
        if (typeof after === "function") preview.cleanup = after;
      } finally {
        this.screenFor = draw;
      }
    } catch (e) {
      note(`${agent}: ${problem(e).why}`);
    }
  }

  #push(e: Unnumbered) {
    // a preview is not part of the history
    if (this.#previewing) return;
    this.log.push({ ...e, n: ++this.#n } as Entry);
    this.bump();
  }

  /**
   * Whether nobody may read a node: a rule, on, refuses everything on it to
   * everyone. The host keeps its value out of its own copy, so nothing the
   * demo shows has it, not even the host's eye; only revealed() reads it.
   */
  secret(node: Id): boolean {
    return this.rules.some((r) =>
      r.on && !r.allow && r.node === node && r.agent === undefined && r.op === undefined &&
      r.process === undefined
    );
  }

  /** What stands for a secret's value in the host's copy, the log and boot images. */
  static HIDDEN = "•••";

  /** A secret's value, read beneath protect, for the host to hand on. Nothing shows it. */
  revealed(node: Id): Json | undefined {
    const address = this.addressOf(node);
    if (!address) return undefined;
    return this.bare.read({ agent: "host", address })[0]?.value;
  }

  #change(change: Change) {
    // a secret's change is kept with its value hidden
    const c: Change = change.kind === "write" && this.secret(change.node)
      ? { ...change, patches: [{ type: "snapshot", value: World.HIDDEN }] }
      : change.kind === "place" && change.value !== undefined && this.secret(change.id)
      ? { ...change, value: World.HIDDEN }
      : change;
    this.#t++;
    this.#byTime.set(c.time, c);
    // a placement with a value made the node it placed: the parent's change and the node's first
    if (c.kind === "place" && c.value !== undefined && !this.made.has(c.id)) {
      this.made.set(c.id, c);
      this.latest.set(c.id, c.time);
    }
    this.#inverse(c);
    this.latest.set(c.node, c.time);
    this.changes.set(key(c), c);
    const s = this.#snippet;
    if (s && !c.process) this.snippets.find((x) => x.n === s.n)?.times.push(c.time);
    this.#push({ t: "change", change: c });
  }

  // --- undo: what each change from outside would take to reverse ---

  /**
   * values and slots as they were before each change, for its inverse: the
   * host's own copy of the graph, learned from the changes, as the driver
   * learns it, since the graph is read by address and not by id
   */
  #values = new Map<Id, Json>();
  #dirs = new Map<Id, Map<string, Id[]>>();
  /** the inverse of each change, by "node@time" */
  inverses = new Map<string, Inverse>();
  /** snippets that can be undone, last first; and undos that can be redone */
  undoable: number[] = [];
  redoable: number[] = [];

  #inverse(c: Change) {
    const k = key(c);
    switch (c.kind) {
      case "write": {
        const before = this.#values.get(c.node) ?? null;
        try {
          this.#values.set(c.node, applyPatches(before, c.patches));
        } catch {
          // the graph applied it; a copy that disagrees is the host's own trouble
        }
        // a secret's old value is not the host's to keep, so its write is not undone
        if (!c.process && !this.secret(c.node)) {
          this.inverses.set(k, { op: "write", node: c.node, value: before });
        }
        break;
      }
      case "place":
      case "unplace": {
        // a placement with a value made the node it placed
        if (c.kind === "place" && c.value !== undefined) this.#values.set(c.id, c.value);
        const before = this.slotOf(c.node, c.name);
        this.#setSlot(
          c.node,
          c.name,
          c.kind === "place" ? placed(before, c.id, c.position) : before.filter((x) => x !== c.id),
        );
        if (c.process) break;
        const was = before.indexOf(c.id);
        // a position is a gap in the slot as it is: one moved earlier goes back past its old place
        const now = this.slotOf(c.node, c.name).indexOf(c.id);
        this.inverses.set(
          k,
          c.kind === "place" && was < 0
            ? { op: "unplace", parent: c.node, name: c.name, id: c.id }
            : {
              op: "place",
              parent: c.node,
              name: c.name,
              id: c.id,
              position: Math.max(0, now >= 0 && now < was ? was + 1 : was),
            },
        );
        break;
      }
    }
  }

  /** Code that reverses a snippet's changes from outside, last first. */
  inverseOf(n: number): string | undefined {
    const s = this.snippets[n - 1];
    if (!s?.times.length) return;
    const lines: string[] = [];
    for (const t of [...s.times].reverse()) {
      const c = [...this.changes.values()].find((x) => x.time === t);
      const inv = c && this.inverses.get(key(c));
      if (!inv) continue;
      if (inv.op === "write") lines.push(`write(${J(inv.node)}, ${J(inv.value)})`);
      else if (inv.op === "unplace") {
        lines.push(`unplace(${J(inv.parent)}, ${J(inv.name)}, ${J(inv.id)})`);
      } else lines.push(`place(${J(inv.parent)}, ${J(inv.name)}, ${J(inv.id)}, ${inv.position})`);
    }
    if (!lines.length) return;
    return `because({ undo: ${n} }, () => batch(() => {\n${
      lines.map((l) => "  " + l).join("\n")
    }\n}))`;
  }

  undo(): Snippet | undefined {
    const n = this.undoable.pop();
    if (n === undefined) return;
    const code = this.inverseOf(n);
    if (!code) return this.undo();
    const s = this.run(code, `undo snippet-${n}`, "undo");
    if (s.ok) this.redoable.push(s.n);
    return s;
  }

  redo(): Snippet | undefined {
    const n = this.redoable.pop();
    if (n === undefined) return;
    const code = this.inverseOf(n);
    if (!code) return;
    const s = this.run(code, `redo (undo snippet-${n})`, "redo");
    if (s.ok) this.undoable.push(s.n);
    return s;
  }

  // --- the host's copy of the graph, and the addresses it finds in it ---

  /** the change at each time: times in one graph are unique */
  #byTime = new Map<number, Change>();
  /** how many changes there have been: what is worked out from the copy is kept until the next */
  #t = 0;
  #kept: { t: number; [k: string]: unknown } = { t: -1 };

  #keep<T>(name: string, make: () => T): T {
    if (this.#kept.t !== this.#t) this.#kept = { t: this.#t };
    if (!(name in this.#kept)) this.#kept[name] = make();
    return this.#kept[name] as T;
  }

  /** What a walk reads of the host's copy: whether a node is here, and its slots. */
  #view: View = {
    here: (id) => this.made.has(id),
    slot: (id, name) => this.slotOf(id, name),
  };

  #setSlot(node: Id, name: string, ids: Id[]) {
    let d = this.#dirs.get(node);
    if (!d) this.#dirs.set(node, d = new Map());
    // a slot with no ids in it is gone
    if (ids.length) d.set(name, ids);
    else d.delete(name);
  }

  /** The change made at a time, whichever node it was made to. */
  at(time: number): Change | undefined {
    return this.#byTime.get(time);
  }

  /** A node's value, as the host's copy has it, read by nothing; undefined if it is not here. */
  valueOf(node: Id): Json | undefined {
    return this.#values.has(node) ? this.#values.get(node) : undefined;
  }

  /** The ids in one of a node's slots, as the host's copy has them. */
  slotOf(node: Id, name: string): Id[] {
    return this.#dirs.get(node)?.get(name) ?? [];
  }

  /** A node's directory, as the host's copy has it: [name, ids] in code point order. */
  slotsOf(node: Id): [string, Id[]][] {
    return [...(this.#dirs.get(node) ?? [])]
      .map(([name, ids]): [string, Id[]] => [name, [...ids]])
      .sort(([a], [b]) => byCodePoint(a, b));
  }

  /** A step of a route: a node in a parent's slot, at its position there. */
  step(parent: Id, name: string, node: Id): Step {
    return { parent, name, node, position: Math.max(0, this.slotOf(parent, name).indexOf(node)) };
  }

  /**
   * The addresses from the root that the host's copy has, shortest first, as
   * the graph walks them: each name takes the first node in its slot that is
   * here and has the next name. reach is, for each node an address reaches,
   * the shortest; list is, for each node in a slot an address selects, the
   * shortest such address, whose listing, a union, has that node's slots.
   */
  #addresses(): { reach: Map<Id, string[]>; list: Map<Id, string[]> } {
    return this.#keep("addresses", () => {
      const reach = new Map<Id, string[]>([[ROOT, []]]);
      const list = new Map<Id, string[]>([[ROOT, []]]);
      const seen = new Set<string>();
      const queue: string[][] = [[]];
      while (queue.length) {
        const at = queue.shift()!;
        const names = new Set<string>();
        for (const m of members(this.#view, ROOT, at)) {
          for (const [n] of this.#dirs.get(m.node) ?? []) names.add(n);
        }
        for (const n of [...names].sort(byCodePoint)) {
          const next = [...at, n];
          const w = walk(this.#view, ROOT, next);
          const last = w.route[w.route.length - 1];
          if (w.node === undefined || !last) continue;
          const k = J([last.parent, n]);
          if (seen.has(k)) continue;
          seen.add(k);
          if (!reach.has(w.node)) reach.set(w.node, next);
          for (const id of this.slotOf(last.parent, n)) {
            if (this.made.has(id) && !list.has(id)) list.set(id, next);
          }
          queue.push(next);
        }
      }
      return { reach, list };
    });
  }

  /** Every node the root reaches, by placement after placement, addressed or not. */
  reachable(): Set<Id> {
    return this.#keep("reachable", () => {
      const seen = new Set<Id>();
      const queue: Id[] = this.made.has(ROOT) ? [ROOT] : [];
      while (queue.length) {
        const at = queue.shift()!;
        if (seen.has(at)) continue;
        seen.add(at);
        for (const [, ids] of this.slotsOf(at)) {
          for (const id of ids) if (this.made.has(id) && !seen.has(id)) queue.push(id);
        }
      }
      return seen;
    });
  }

  /** undo and redo may place again what they took out of the root's reach */
  #reviving = false;

  /**
   * Checks an id may be placed: one the graph does not have is mounted, and
   * one the root reaches is placed again. A node nothing reaches is gone, and
   * is not placed again (CORE.tex): a new node takes a new id.
   */
  #placeable(id: Id) {
    if (this.#reviving || !this.made.has(id) || this.reachable().has(id)) return;
    throw new Error(
      `${
        J(id)
      } is a node nothing reaches: it is gone, and cannot be placed again (CORE.tex); use another id`,
    );
  }

  /**
   * An address from the root that reaches the node: the route's names, if
   * they reach it, or else the shortest. Undefined when none does: a node
   * placed nowhere the root reaches, or only behind others in its slots.
   */
  addressOf(node: Id, route?: readonly { name: string }[]): string[] | undefined {
    if (route) {
      const names = route.map((s) => s.name);
      if (walk(this.#view, ROOT, names).node === node) return names;
    }
    return this.#addresses().reach.get(node);
  }

  /** The address of a node, or an error saying why there is none. */
  #need(node: Id | Address): Address {
    if (typeof node !== "string") return node;
    const address = this.addressOf(node);
    if (address) return address;
    throw new Error(
      this.made.has(node)
        ? `no address from the root reaches ${
          J(node)
        }: it is placed nowhere the root reaches, or only behind another node in its slots (CORE.tex: mount it under a name of its own)`
        : `${J(node)} is not here: no node has that id`,
    );
  }

  // --- what programs threw, for the editor to show where ---

  /** the last error each process's program threw, with the line, while it lasts */
  thrown = new Map<
    Id,
    { part: "compute" | "effect"; code: string; message: string; line?: number }
  >();

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

  /**
   * Subscribes to a node as the acting agent, by an address that reaches it;
   * protect checks it like any operation. It follows the address from then on.
   */
  subscribe(node: Id): Problem | undefined {
    try {
      const entry = { sub: 0, events: [] as Event[] };
      entry.sub = this.driver.subscribe({
        agent: this.agent,
        address: this.#need(node),
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

  /**
   * A node's value, read by an address that reaches it: the route's, if it
   * does, or the shortest. A node no address reaches reads as nothing.
   */
  read(node: Id, route?: readonly Step[], agent: Json = this.agent): Reading {
    if (this.secret(node)) return { refused: "nobody may read it" };
    const address = this.addressOf(node, route);
    if (!address) return { items: [] };
    try {
      // the first item is the node the address reaches; the rest are the others in its slot
      const items = this.view.read({ agent, address }).slice(0, 1);
      return items.length ? { items, value: items[0].value, address } : { items, address };
    } catch (e) {
      return { refused: problem(e).why };
    }
  }

  /**
   * The node's own directory, as [name, ids] in code point order. Where the
   * address selects a slot of several nodes, the graph lists their union;
   * this keeps the slots of the node asked for.
   */
  directory(node: Id, route?: readonly Step[]): [string, Id[]][] | { refused: string } | undefined {
    const address = this.addressOf(node, route) ?? this.#addresses().list.get(node);
    if (!address) return undefined;
    try {
      const d = this.view.directory({ agent: this.agent, address });
      if (!("directory" in d)) return undefined;
      const own: [string, Id[]][] = [];
      for (const [name, items] of d.directory) {
        const ids = items.filter((i) => slotNode(i) === node).map((i) => i.id);
        if (ids.length) own.push([name, ids]);
      }
      return own;
    } catch (e) {
      return { refused: problem(e).why };
    }
  }

  /** Every slot each node is placed in, from the host's copy, beneath protect. */
  placements(): Map<Id, { parent: Id; name: string; index: number }[]> {
    return this.#keep("placements", () => {
      const where = new Map<Id, { parent: Id; name: string; index: number }[]>();
      for (const parent of this.made.keys()) {
        for (const [name, ids] of this.slotsOf(parent)) {
          ids.forEach((id, index) => {
            where.set(id, [...(where.get(id) ?? []), { parent, name, index }]);
          });
        }
      }
      return where;
    });
  }

  /** A process node is a node with a compute slot (DRIVER.tex). */
  isProcess(node: Id): boolean {
    return this.slotOf(node, "compute").length > 0;
  }

  /**
   * The processes the driver runs: its walk from the root, beneath protect,
   * depth first, names in code point order, as an address walks: where a slot
   * holds several nodes, their names are the union, and under each name the
   * first member that has it. Program slots are not walked, and no node is
   * entered twice. Each runs where it was reached.
   */
  running(): Map<Id, Running> {
    return this.#keep("running", () => {
      const reached = new Map<Id, Running>();
      const seen = new Set<Id>([ROOT]);
      const enter = (members: Id[], cwd: string[], route: Step[]) => {
        const names = new Set<string>();
        for (const m of members) for (const [n] of this.#dirs.get(m) ?? []) names.add(n);
        for (const name of [...names].sort(byCodePoint)) {
          if (name === "compute" || name === "effect") continue;
          const owner = members.find((m) => this.slotOf(m, name).length > 0)!;
          const slot = this.slotOf(owner, name);
          const here = slot.filter((id) => this.made.has(id));
          if (!here.length || seen.has(here[0])) continue;
          seen.add(here[0]);
          const to = [...route, {
            parent: owner,
            name,
            node: here[0],
            position: slot.indexOf(here[0]),
          }];
          if (this.isProcess(here[0])) {
            reached.set(here[0], { cwd, name, parent: owner, route: to });
          }
          enter(here, [...cwd, name], to);
        }
      };
      enter([ROOT], [], []);
      return reached;
    });
  }

  /** The node a run's read reached: the last of its route, or, with none, where it started. */
  readNode(process: Id, x: ReadEntry): Id | undefined {
    const last = x.route[x.route.length - 1];
    if (last) return last.node;
    const p = this.running().get(process);
    if (!p) return undefined;
    try {
      const { root, up } = parseAddress(x.address);
      // each ".." goes back one step the way the place was reached, along its walk
      if (root) return ROOT;
      return up > p.cwd.length ? undefined : back(this.#view, ROOT, p.cwd, up);
    } catch {
      return undefined;
    }
  }

  /**
   * A lookup from the directory the route's last node is in, as the acting
   * agent: each step an ordinary read of one slot, nearest first, as the graph
   * makes them, to show what was searched; then the lookup itself.
   */
  lookup(name: string, route: readonly Step[], agent: Json = this.agent): Found {
    const place = route.slice(0, -1).map((s) => s.name);
    const as = { agent, place };
    const searched: Searched[] = [];
    for (let k = 0; k <= place.length; k++) {
      // the directory the place's walk came through, k steps back
      const node = back(this.#view, ROOT, place, k);
      const address = Array.from({ length: k }, () => "..");
      try {
        const d = this.view.directory({ ...as, address, name });
        const items = "items" in d ? d.items : [];
        let saw: number | null = null;
        for (const i of items) if (saw === null || i.change.time > saw) saw = i.change.time;
        if (node !== undefined) searched.push({ node, saw });
        // a slot whose ids are all absent is passed over
        if (items.some((i) => !i.pending)) break;
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        if (node !== undefined) searched.push({ node, refused: true });
        break;
      }
    }
    const items = this.view.lookup({ ...as, name });
    return { searched, found: items.map((i) => i.id), items };
  }

  // --- the workspace: every act from outside is a snippet ---

  /**
   * The host interface for snippets: fills in the agent and the cause, which
   * is the snippet's site, unless because() gave another.
   */
  host(): Driver & { [op: string]: unknown } {
    const d = this.driver;
    const fill = <T extends object>(op: T) => {
      const s = this.#snippet;
      const out: Record<string, unknown> = { agent: s?.agent ?? this.agent, ...op };
      if (!("cause" in op)) out.cause = s?.cause !== undefined ? s.cause : siteHere();
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
      write: change(d.write),
      place: change(d.place),
      unplace: change(d.unplace),
      read: acting(d.read),
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

  /**
   * The words a snippet can use, besides api. A word names a node by its id,
   * or by an address; the host turns an id into an address from the root that
   * reaches it, from its own copy of the graph.
   */
  vocabulary() {
    const api = this.host();
    const has = (id: Id) => this.made.has(id);
    /** an id with that stem the graph does not have */
    const fresh = (stem: string) => {
      for (let i = 2;; i++) if (!has(`${stem}-${i}`)) return `${stem}-${i}`;
    };
    const at = (node: Id | Address) => this.#need(node);
    const value = (items: ValueItem[]) => items.length ? items[0].value : undefined;
    const words = {
      api,
      /**
       * Makes a node by placing it with its value, as CORE.tex has it: one
       * change, the parent's and the node's first. An id the graph has is
       * placed once more.
       */
      make: (parent: Id | Address, name: string, id: Id, value: Json = null) => {
        this.#placeable(id);
        return made(api, has, at(parent), name, id, value);
      },
      write: (node: Id | Address, value: Json) =>
        api.write({ address: at(node), patches: [{ type: "snapshot", value }] }),
      patch: (node: Id | Address, ...patches: Patch[]) => api.write({ address: at(node), patches }),
      splice: (
        node: Id | Address,
        path: (string | number)[],
        from: number,
        to: number,
        value?: Json,
      ) =>
        api.write({
          address: at(node),
          patches: [
            value === undefined
              ? { type: "splice", path, range: [from, to] }
              : { type: "splice", path, range: [from, to], value },
          ],
        }),
      set: (node: Id | Address, path: (string | number)[], key: string, value?: Json) =>
        api.write({
          address: at(node),
          patches: [
            value === undefined ? { type: "set", path, key } : { type: "set", path, key, value },
          ],
        }),
      place: (parent: Id | Address, name: string, id: Id, position?: number) => {
        this.#placeable(id);
        return api.place(
          position === undefined
            ? { address: at(parent), name, id }
            : { address: at(parent), name, id, position },
        );
      },
      unplace: (parent: Id | Address, name: string, id: Id) =>
        api.unplace({ address: at(parent), name, id }),
      /** A node's value: the first item's; undefined if no address reaches it. */
      read: (node: Id | Address) => {
        const address = typeof node === "string" ? this.addressOf(node) : node;
        return address ? value(api.read({ address })) : undefined;
      },
      /** A node's own slots: with a name, its ids; without, {name: ids}. */
      dir: (node: Id | Address, name?: string) => {
        const address = typeof node === "string" ? this.addressOf(node) : node;
        if (!address) return undefined;
        const d = api.directory(name === undefined ? { address } : { address, name });
        const mine = (items: SlotItem[]) =>
          items.filter((i) => typeof node !== "string" || slotNode(i) === node).map((i) => i.id);
        if ("items" in d) return mine(d.items);
        return Object.fromEntries(
          d.directory.map(([n, items]) => [n, mine(items)]).filter(([, ids]) => ids.length),
        );
      },
      /** The ids a lookup of name finds, from a place: names from the root. */
      lookup: (name: string, place?: string[]) =>
        api.lookup(place === undefined ? { name } : { name, place }).map((i) => i.id),
      /** A program node, JS source or a list of steps, made in a parent's slot of its name. */
      program: (parent: Id | Address, id: Id, code: Json) => {
        this.#placeable(id);
        return made(api, has, at(parent), id, id, code);
      },
      /**
       * A process: made by placing it in parent's slot name, then its programs
       * in its own slots. A process node the root reaches runs where it sits,
       * so its lookups search parent and up; it is all one batch, so it starts
       * with its programs there. Code that is not a program's id is made into
       * the process's own slot.
       */
      process: (
        parent: Id | Address,
        name: string,
        id: Id,
        o: { compute: Json; effect?: Json; value?: Json },
      ) => {
        this.#placeable(id);
        for (const part of ["compute", "effect"] as const) {
          const code = o[part];
          if (typeof code === "string" && this.made.has(code)) this.#placeable(code);
          else if (code !== undefined) this.#placeable(`${id}.${part}`);
        }
        api.batch(() => {
          made(api, has, at(parent), name, id, o.value ?? null);
          for (const part of ["compute", "effect"] as const) {
            const code = o[part];
            if (code === undefined) continue;
            if (typeof code === "string" && this.made.has(code)) {
              api.place({ address: at(id), name: part, id: code });
            } else {
              made(api, has, at(id), part, `${id}.${part}`, code);
            }
          }
        });
        return id;
      },
      /**
       * A UI that is reactive by construction, for a model too small to write
       * a compute and an effect: a process in parent's slot name whose compute,
       * shared, looks up each name in state and watch from where it sits and
       * reads it, so it runs again when any of them changes; and whose effect,
       * shared, draws with draw, the source of a function ({ h, state, set }) to
       * an element. set(name, value) writes that name through a handler, so a
       * click is credited to whoever clicked. State not found is made beside it.
       */
      ui: (
        parent: Id | Address,
        name: string,
        o: { state?: { [name: string]: Json }; watch?: string[]; draw: string; id?: Id },
      ) => {
        const id = o.id ?? (has(name) ? fresh(name) : name);
        const from = at(parent);
        api.batch(() => {
          for (const [k, v] of Object.entries(o.state ?? {})) {
            if (!api.lookup({ name: k, place: from }).length) {
              made(api, has, from, k, has(k) ? fresh(k) : k, v);
            }
          }
          if (!has("programs")) made(api, has, [], "programs", "programs", {});
          for (const [part, code] of [["compute", UI_COMPUTE], ["effect", UI_EFFECT]] as const) {
            if (!has(`ui-${part}`)) {
              made(api, has, at("programs"), `ui-${part}`, `ui-${part}`, code);
            }
          }
          made(api, has, from, name, id, null);
          api.place({ address: at(id), name: "compute", id: "ui-compute" });
          api.place({ address: at(id), name: "effect", id: "ui-effect" });
          made(api, has, at(id), "watch", `${id}.watch`, [
            ...new Set([...Object.keys(o.state ?? {}), ...(o.watch ?? [])]),
          ]);
          made(api, has, at(id), "draw", `${id}.draw`, o.draw);
        });
        return id;
      },
      start: (id: Id, under: Id | Address = ROOT, name: string = id) => {
        this.#placeable(id);
        return api.place({ address: at(under), name, id });
      },
      stop: (id: Id, under: Id | Address = ROOT, name: string = id) =>
        api.unplace({ address: at(under), name, id }),
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

  /**
   * Runs code as a snippet: its changes carry its site. It acts as the
   * world's agent, unless another is given. Returns the snippet.
   */
  run(
    code: string,
    label?: string,
    /** talk: a snippet that keeps a conversation, which undo passes over */
    kind: "act" | "undo" | "redo" | "boot" | "talk" = "act",
    agent?: string,
    /** words besides the vocabulary, for what must not be written into the code, such as a key */
    more: { [word: string]: unknown } = {},
  ): Snippet {
    const n = this.snippets.length + 1;
    const snippet: Snippet = { n, code, label, agent: agent ?? this.agent, times: [] };
    this.snippets.push(snippet);
    this.#push({ t: "snippet", snippet: n });
    const words = { ...this.vocabulary(), ...more };
    const names = Object.keys(words);
    const outer = this.#snippet;
    this.#snippet = { n, agent };
    const reviving = this.#reviving;
    this.#reviving = reviving || kind === "undo" || kind === "redo";
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
      this.#reviving = reviving;
      this.bump();
    }
    // a new act can be undone, and makes what was undone no longer redoable
    if (!outer && snippet.times.length && kind === "act") {
      this.undoable.push(n);
      this.redoable = [];
    }
    return snippet;
  }

  /** Runs a snippet whose last expression is its value, as print-it does. */
  print(code: string, label?: string, agent?: string): Snippet {
    const lines = code.trimEnd().split("\n");
    const last = lines.pop() ?? "";
    const body = /^\s*(return|const|let|var|if|for|while|function|class)\b/.test(last)
      ? code
      : [...lines, `return (${last.replace(/;\s*$/, "")})`].join("\n");
    return this.run(body, label, "act", agent);
  }

  // --- boot images: the graph as code that rebuilds it ---

  /**
   * A boot image: a snippet that, run in a fresh graph, makes everything the
   * root reaches, by placing it, in one batch so nothing runs until it is all
   * there. A node in several places is made in the first and placed in the
   * rest. Processes' values are left out: their computes give them again.
   * What the root does not reach cannot be addressed (CORE.tex), so it is not
   * here. It reads the host's copy of the graph, beneath protect.
   */
  image(from: Id = ROOT, skip: (id: Id) => boolean = () => false): string {
    const lit = (v: Json) => {
      if (typeof v === "string" && v.includes("\n") && !/[`]|\$\{|\\$/.test(v)) {
        return "String.raw`" + v + "`";
      }
      return JSON.stringify(
        v,
        null,
        v !== null && typeof v === "object" && JSON.stringify(v).length > 70 ? 2 : 0,
      );
    };
    const lines: string[] = [];
    // the root's value starts null, as the graph is made; another node's is written
    const fromValue = this.valueOf(from);
    if (fromValue !== undefined && (fromValue !== null || from !== ROOT)) {
      lines.push(`write(${J(from)}, ${lit(fromValue)})`);
    }
    const made = new Set<Id>([from]);
    const queue: Id[] = [from];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const [name, ids] of this.slotsOf(parent)) {
        for (const id of ids) {
          if (skip(id)) continue;
          if (made.has(id) || !this.made.has(id)) {
            lines.push(`place(${J(parent)}, ${J(name)}, ${J(id)})`);
            continue;
          }
          made.add(id);
          queue.push(id);
          const value = this.isProcess(id) ? null : this.valueOf(id) ?? null;
          lines.push(`make(${J(parent)}, ${J(name)}, ${J(id)}, ${lit(value)})`);
        }
      }
    }
    return [
      from === ROOT
        ? "// a boot image: run in a fresh graph, it makes everything the root reaches"
        : `// everything ${J(from)} reaches, as a boot image would make it`,
      "batch(() => {",
      ...lines.map((l) => "  " + l.replaceAll("\n", "\n  ")),
      "})",
    ].join("\n");
  }

  // --- what the stage and the loader need ---

  /**
   * The element a process's effect draws on. A process started by another
   * draws inside its starter's screen, so the stage nests as the process tree
   * does. The effect gets the screen's own part; its children go beside it.
   */
  screenFor(process: Id): HTMLElement {
    let box = this.screens.get(process);
    if (!box) {
      box = document.createElement("div");
      box.className = "screen";
      box.dataset.process = process;
      const own = document.createElement("div");
      own.className = "own";
      const kids = document.createElement("div");
      kids.className = "kids";
      box.append(own, kids);
      this.screens.set(process, box);
      const starter = (this.placements().get(process) ?? [])
        .map((p) => p.parent)
        .find((p) => p !== ROOT && this.isProcess(p));
      const home = starter
        ? this.screenFor(starter).parentElement!.querySelector(":scope > .kids")!
        : this.stage;
      home.append(box);
      this.bump();
    }
    return box.querySelector(":scope > .own") as HTMLElement;
  }

  /** Fires a handler from the world, such as a click on a screen, as the acting agent. */
  fireFromWorld(
    process: Id,
    handler: string,
    input?: Json,
    agent: Json = this.agent,
  ): Fired | undefined {
    try {
      const r = this.driver.fire(
        input === undefined ? { agent, process, handler } : { agent, process, handler, input },
      );
      this.#settled(r);
      if (r.error !== undefined) this.#push({ t: "error", error: problem(r.error) });
      return r;
    } catch (e) {
      this.#push({ t: "error", error: problem(e) });
    }
  }

  /** Runs a program, and keeps what it threw, with the line, for the editor. */
  #catching<T>(process: Id, part: "compute" | "effect", code: string, run: () => T): T {
    try {
      const v = run();
      if (this.#previewing) return v;
      const t = this.thrown.get(process);
      if (t?.part === part) this.thrown.delete(process);
      return v;
    } catch (e) {
      if (!this.#previewing && !(e instanceof ErmineError)) {
        const m = (e as Error)?.stack?.match(
          new RegExp(`ermine:${part}-\\d+(?:, <anonymous>)?:(\\d+):\\d+`),
        );
        this.thrown.set(process, {
          part,
          code,
          message: (e as Error)?.message ?? String(e),
          line: m ? Number(m[1]) - 1 : undefined,
        });
      }
      throw e;
    }
  }

  #compiled = new Map<string, Compute | Effect>();

  /**
   * What a program may import. "ermine" is the library; "demo" is this host:
   * screen(self), the element a process's effect draws on, h(tag, props,
   * ...children) to build with, and fire(process, handler, input?), which
   * fires a handler from the world, as the driver's fire does.
   */
  readonly modules: { [name: string]: { [member: string]: unknown } } = {
    ermine,
    demo: {
      h,
      screen: (process: Id) => this.screenFor(process),
      fire: (process: Id, handler: string, input?: Json) =>
        queueMicrotask(() => this.fireFromWorld(process, handler, input)),
    },
  };

  /**
   * A program is a module whose default export is the function the driver
   * calls, with the context drive gives it and nothing else. The page cannot
   * import a module synchronously, so the demo links it itself: each import
   * line takes its names from the module here, and the export is returned.
   * Lines are kept, so a thrown error's line is the program's.
   */
  /** A program that is neither part of a process: a module's default export, as #compile links it. */
  module(code: string, part: string): unknown {
    return this.#compile(code, part);
  }

  #compile(code: string, part: string): Compute | Effect {
    const k = part + "\0" + code;
    let fn = this.#compiled.get(k);
    if (!fn) {
      const linked = code.replace(
        // [ \t], not \s, at the ends: a line's newline stays, and the next line with it
        /^[ \t]*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'][ \t]*;?/gm,
        (_, names: string, from: string) => {
          if (!(from in this.modules)) {
            throw new Error(
              `a program can only import ${
                Object.keys(this.modules).map((m) => J(m)).join(" or ")
              }, not ${J(from)}`,
            );
          }
          return `const {${names}} = __modules[${J(from)}];`;
        },
      ).replace(/^[ \t]*export\s+default\s+/m, "return ");
      if (linked === code && !/\bexport\s+default\b/.test(code)) {
        throw new Error("a program is a module: export default function (ctx) { ... }");
      }
      const link = (0, eval)(
        `(function (__modules) {\n${linked}\n})\n//# sourceURL=ermine:${part}-${this.#compiled.size}`,
      ) as (modules: unknown) => unknown;
      const exported = link(this.modules);
      if (typeof exported !== "function") {
        throw new Error("a program's default export is a function");
      }
      fn = exported as Compute | Effect;
      this.#compiled.set(k, fn);
    }
    return fn;
  }

  /** The host's loader: JS source as a module, or a list of steps. */
  #load: Load = ((code: Json, part: "compute" | "effect") => {
    if (Array.isArray(code)) return steps(code, part as "compute");
    if (typeof code !== "string") {
      throw new Error("a program is JS source, or a list of steps");
    }
    // linked when first run, so what is wrong with it is shown at its line
    if (part === "compute") {
      const compute: Compute = (ctx) =>
        this.#catching(
          ctx.self,
          "compute",
          code,
          () => (this.#compile(code, part) as Compute)(ctx),
        );
      return compute;
    }
    const effect: Effect = (ctx) => {
      // the inspector lists a process's handlers: the host notes each name it is given
      const handler = (name: string, run: (input?: Json) => void) => {
        ctx.handler(name, run);
        const set = this.handlers.get(ctx.self) ?? new Set();
        set.add(name);
        this.handlers.set(ctx.self, set);
      };
      return this.#catching(
        ctx.self,
        "effect",
        code,
        () => (this.#compile(code, part) as Effect)({ ...ctx, handler }),
      );
    };
    return effect;
  }) as Load;
}

/** The layer above the graph that tells the demo every change and record. */
function watch(api: Interface, sink: { change(c: Change): void; record(r: Run): void }): Interface {
  return {
    write: (op) => tap(api.write(op), sink),
    place: (op) => tap(api.place(op), sink),
    unplace: (op) => tap(api.unplace(op), sink),
    read: (op) => api.read(op),
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
    cwd: api.cwd,
    // protect learns the node an address reaches from the layer below
    reach: api.reach,
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

/**
 * Makes a node by placing it with its value: one change. An id the graph has
 * is only placed. Whether it has it is the host's knowledge, since an
 * effect's interface cannot read, and a value for an id the graph has is
 * invalid, which would end its run.
 */
function made(
  api: Interface,
  has: (id: Id) => boolean,
  parent: Address,
  name: string,
  id: Id,
  value: Json,
) {
  return api.place(has(id) ? { address: parent, name, id } : { address: parent, name, id, value });
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

/** ui()'s compute: each watched name, looked up from where the UI sits, and read. */
const UI_COMPUTE = `// ui(): looks up each name the UI watches, from where it sits, and reads it;
// a read marks the process, so it runs again when any of them changes
export default function ({ api, name }) {
  const own = (slot) => api.read({ address: [name, slot] })[0]?.value
  const values = {}, at = {}
  for (const n of own("watch") ?? []) {
    const [it] = api.lookup({ name: n })
    if (!it) continue
    at[n] = it.from.path
    values[n] = api.read({ address: it.from.path })[0]?.value ?? null
  }
  return { values, at, draw: own("draw") ?? "" }
}`;

/** ui()'s effect: draws with the UI's draw, and writes what set() is given through a handler. */
const UI_EFFECT = `// ui(): draws with the UI's draw function. set(name, value) fires the handler
// "set", which writes through the lasting interface as whoever fired it. The
// focused element is focused again after a redraw, found by its name attribute
import { h, screen, fire } from "demo"
export default function ({ self, value, lasting, handler }) {
  const el = screen(self)
  handler("set", (input) => {
    const at = value.at[input.name]
    if (at) lasting.write({ address: at, patches: [{ type: "snapshot", value: input.value }] })
    else lasting.place({ address: [], name: input.name, id: input.name + "-" + Date.now(), value: input.value })
  })
  const set = (n, v) => fire(self, "set", { name: n, value: v })
  const draw = new Function("return (" + value.draw + ")")()
  const active = document.activeElement
  const keep = active && el.contains(active) ? active.getAttribute("name") : null
  const caret = keep && typeof active.selectionStart === "number"
    ? [active.selectionStart, active.selectionEnd] : null
  const out = draw({ h, state: value.values, set, self })
  el.replaceChildren(...(Array.isArray(out) ? out : [out]))
  if (keep) {
    const again = el.querySelector('[name="' + keep + '"]')
    if (again) {
      again.focus()
      if (caret && again.setSelectionRange) again.setSelectionRange(caret[0], caret[1])
    }
  }
}`;
