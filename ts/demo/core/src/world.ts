/// <reference lib="dom" />
// The world the demo plays with:
//
//   schedule(protect(watch(keep(graph(root))), may), loaders)
//
// a log of everything that happened, and the workspace that every outside act
// goes through, so that each change from outside carries a real site as its
// cause: the snippet, line and column it was made from.
//
// The loaders are the steps loader, for programs given as lists of steps, and
// the same-thread loader, for JavaScript modules, which import what they use:
// "demo" and "ermine" are this host's modules, found by the page's import map.
// Programs are nodes under programs/, loaders are nodes under loaders/, and a
// process is started with start(address, program): its pid is the scheduler's.
//
// The graph is reached by address only. The host keeps its own copy of the
// graph, learned from the changes as they are made, and turns the ids the
// workspace and the panes name into addresses from the root that reach them.
//
// The graph is kept, by the keeper, in IndexedDB. Processes are not: a page
// that loads a kept graph takes out the process nodes it kept, and runs the
// project's boot image only for its starts (reopen).

import { signal } from "@preact/signals";
import {
  type Address,
  applyPatch,
  applyPatches,
  back,
  byCodePoint,
  type Change,
  codePoints,
  equal,
  ErmineError,
  type Event,
  graph,
  type Header,
  type Id,
  type Interface,
  Invalid,
  isBytes,
  isLive,
  isName,
  type Json,
  type Kept,
  kindOf,
  KINDS,
  matches,
  members,
  parseAddress,
  type Patch,
  placed,
  protect,
  type ReadEntry,
  type Record as Run,
  Refused,
  type Searched,
  type Site,
  type SlotFrom,
  type SlotItem,
  type Step,
  type ValueItem,
  type View,
  walk,
} from "../../../src/mod.ts";
import {
  actorOf as schedulerActor,
  type Fired,
  type HandlerRecord,
  type ProcessItem,
  schedule,
  type Scheduler,
} from "../../../src/schedule.ts";
import {
  errorJson,
  type Handler,
  type Identity,
  type Loaded,
  type Loader,
  PENDING,
  type Running as Started,
  sameThread,
  type StartOp,
  Thrown,
} from "../../../src/loaders.ts";
import { steps } from "../../../src/steps.ts";
import { type Backend, keep, type Keeper, load } from "../../../src/keeper.ts";
import { indexeddb } from "../../../src/indexeddb.ts";
import { type Builtin, builtin } from "../../../src/loaders.ts";
import { isObject } from "../../../src/patch.ts";
import { channel as freshChannel, type Transport } from "../../../src/link/wire.ts";
import { type Joining, later } from "../../../src/link/later.ts";
import { type Mirrors, mirrors } from "../../../src/link/mirror.ts";
import { kept, type KeptMirrors } from "../../../src/link/kept.ts";
import { isShare, shares } from "../../../src/link/share.ts";
import { channelOf } from "../../../src/link/name.ts";

export const ROOT = "root";

/** A pid: "@", the time of its start, "-", and five letters (SCHEDULER.tex, Processes). */
export const PID = /^@\d+-[a-z]{5}$/;

/** The IndexedDB database the demo keeps its graph in. */
export const DATABASE = "ermine-demo";

/** The Subduction server a share or a mount reaches its channel through, unless it names another. */
export const SERVER = "wss://galaxy.observer";

/**
 * How the host joins a link's channel through a server. The page's is
 * Subduction's (src/link/subduction.ts, built apart as link/subduction.js, so
 * the page runs without its wasm until a link needs it); a test's is a hub.
 */
export type Linker = (channel: string, url: string) => Promise<Transport>;

/** A share or a mount running here, as the host shows it. */
export type LinkInfo = {
  pid: Id;
  role: "share" | "mount";
  /** a mount's kind: live only (src/link/mirror.ts, ephemeral), or keeping a copy (src/link/kept.ts) */
  kind?: "live" | "kept";
  channel: string;
  /** the name the person gave the channel, when they gave one: channelOf(name) is the channel */
  named?: string;
  url: string;
  /** joining the channel through the server */
  joining: Joining;
  /** the process's status node's value: a share's, or a mirror's (src/link/share.ts, mirror.ts) */
  status?: { [k: string]: Json };
  /** a share's: the address served; a mount's: where its copy is */
  address: string[];
};

export type Rule = {
  agent?: string;
  /** the key a link verified, which an owner stamps on a mounter's agent (PROTECT.tex, Rules) */
  peer?: string;
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
  | { t: "handler"; n: number; record: HandlerRecord }
  | { t: "stopped"; n: number; process: Id }
  | { t: "error"; n: number; error: Problem; snippet?: number }
  | { t: "snippet"; n: number; snippet: number };

/** What reverses a change from outside. */
export type Inverse =
  | { op: "write"; node: Id; value: Json }
  | { op: "unplace"; parent: Id; name: string; id: Id }
  | { op: "place"; parent: Id; name: string; id: Id; position: number }
  | { op: "start"; parent: Id; program: string[]; value?: Json };

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
 * A read as the acting agent: the items, the first value item's value, if
 * there is one, and what a scheduler put in front of it; and the address it
 * read, if one from the root reaches the node.
 */
export type Reading = {
  items: ValueItem[];
  value?: Json;
  /** the items in front of a process's value: waiting, stopped, error, newer */
  front: ProcessItem[];
  address?: Address;
} | { refused: string };

/** A process that runs: where, and the route to it from the root. */
export type Running = { cwd: string[]; name: string; parent: Id; route: Step[] };

/** A process the scheduler started, as the host saw it start. */
export type Proc = {
  pid: Id;
  /** the node it was placed into: its ".", where it runs */
  parent: Id;
  cwd: string[];
  /** the program it kept: the node and the time of the change that last set it */
  program: Identity;
  /** the path start was given, such as ["programs", "editor"] */
  path?: string[];
  /** the first value start was given, if any */
  value?: Json;
  /** the process that started it, if one did */
  by?: Id;
  /** who it acts for */
  actor: Json;
  state: "running" | "killed";
  /** the time of its start */
  started: number;
  /** the program's value as it was when it started: its kind and its parts */
  code: Json;
};

/** A lookup tried from a place: each directory searched, nearest first, and what it found. */
export type Found = { searched: Searched[]; found: Id[]; items: SlotItem[] };

export const J = (v: unknown) => JSON.stringify(v);

/**
 * A channel as a person gave it: 64 hex digits stand for themselves; anything
 * else is a name, whose channel is channelOf(name) (src/link/name.ts), and
 * the name is kept beside it, to show.
 */
export function channelNamed(given: string): { channel: string; named?: string } {
  const channel = channelOf(given);
  const t = given.trim();
  return channel === t.toLowerCase() ? { channel } : { channel, named: t };
}

/** A cause that is a site: the file, line and column a change from outside was made at. */
export function siteOf(cause: Json | undefined): Site | undefined {
  if (cause === null || typeof cause !== "object" || Array.isArray(cause)) return;
  const { file, line, column } = cause as { [k: string]: Json };
  if (typeof file !== "string" || typeof line !== "number" || typeof column !== "number") return;
  return { file, line, column };
}

/** The node whose slot a directory item is in: the last of its route, or the root. */
/**
 * The peer a mounter's change came from: an owner stamps every change a
 * mounter makes {"actor": claimed, "peer": key} (src/link/serve.ts).
 */
export function peerOf(agent: Json | undefined): string | undefined {
  return isObject(agent) && Object.hasOwn(agent, "actor") && typeof agent.peer === "string" &&
      !Array.isArray(agent.code)
    ? agent.peer
    : undefined;
}

/** The actor of an agent: a scheduler's agent's actor, or a mounter's claimed one. */
export function actorOf(agent: Json): Json {
  return peerOf(agent) === undefined
    ? schedulerActor(agent)
    : actorOf((agent as { actor: Json }).actor);
}

function slotNode(item: SlotItem): Id {
  const route = (item.from as SlotFrom).route ?? [];
  return route.length ? route[route.length - 1].node : ROOT;
}

export function problem(e: unknown): Problem {
  if (e instanceof ErmineError) return { kind: e.kind, why: e.message, op: e.op };
  if (e instanceof Thrown) return { kind: "thrown", why: e.message, op: e.op };
  if (e instanceof Error) return { kind: "thrown", why: e.message };
  // an error as JSON, as an answer carries one
  if (e && typeof e === "object" && "kind" in e && "why" in e) {
    const j = e as { kind: string; op?: string; why: { code: string; text?: string } };
    return {
      kind: j.kind,
      why: j.why.text ?? String((j.why as { message?: unknown }).message ?? j.why.code),
      ...(j.op ? { op: j.op } : {}),
    };
  }
  return { kind: "thrown", why: String(e) };
}

/** Whether a value is a program: {kind, compute, effect?} (SCHEDULER.tex, Programs). */
export function isProgram(
  v: Json | undefined,
): v is { kind: string; compute: Json; effect?: Json } {
  return !!v && typeof v === "object" && !Array.isArray(v) && !isBytes(v) && !kindOf(v) &&
    typeof (v as { kind?: unknown }).kind === "string" &&
    Object.hasOwn(v as object, "compute");
}

/** Whether a value is a loader node's: {loader: name} (LOADERS.tex). */
export function isLoader(v: Json | undefined): v is { loader: string } {
  return !!v && typeof v === "object" && !Array.isArray(v) && !isBytes(v) && !kindOf(v) &&
    typeof (v as { loader?: unknown }).loader === "string";
}

const AGENT_COLORS = ["rose", "lilac", "mint", "butter", "sky", "peach"];

/** One frame of a snippet in a stack: snippets are evaluated with a sourceURL. */
const SNIPPET_FRAME = /ermine:snippet-(\d+)(?:, <anonymous>)?:(\d+):(\d+)/;
/** Snippets are wrapped in one line of function header. */
const HEADER_LINES = 1;

/** Where the host's loaders come from: the browser's own import, or the test's. */
export type Importer = (url: string) => Promise<unknown>;

export class World {
  version = signal(0);
  log: Entry[] = [];
  /**
   * every node the host knows, with the placement that made it: the root,
   * which the host gave when the graph was made, and a node loaded from what
   * was kept, with none
   */
  made = new Map<Id, Change | undefined>();
  /** the ephemeral nodes here: nobody keeps them */
  ephemeral = new Set<Id>();
  /** the time of each node's latest change */
  latest = new Map<Id, number>();
  records = new Map<Id, Run[]>();
  /** the record of the run, or the handler call, that made each change, by its time */
  producedBy = new Map<number, Run | HandlerRecord>();
  /** the runs each change marked, by its time */
  marked = new Map<number, Run[]>();
  /** the handlers each process's effect named */
  handlers = new Map<Id, Set<string>>();
  /** every process started since the graph was made, by pid */
  procs = new Map<Id, Proc>();
  /**
   * The key a process may be handed, beneath protect, if any: "demo"'s
   * key(self). The ask pane says which processes, and which key.
   */
  keyFor?: (process: Id) => string | undefined;
  snippets: Snippet[] = [];
  rules: Rule[] = [];
  agents = ["chee", "bun", "hop"];
  agent = "chee";
  /** read everything beneath protect, as the host may */
  seeAll = false;
  /** the stage that effects draw on: one screen per process */
  stage = document.createElement("div");
  screens = new Map<Id, HTMLElement>();
  /** what the graph was loaded from, when it was kept: the highest time, and how many nodes */
  kept?: { time: number; nodes: number };

  /** the top of the stack: the scheduler, as the host sees it */
  scheduler!: Scheduler;
  /** the layer under protect: what the trusted host sees */
  bare!: Interface;
  /** the keeper, when the graph is kept */
  keeper?: Keeper;
  #guarded!: Interface;
  #n = 0;
  /** which reset made the graph being watched */
  #gen = 0;
  #snippet?: { n: number; cause?: Json; agent?: string };
  #bump = false;
  /** the starts under way, innermost last, so a process's start says its program's path */
  #starting: StartOp[] = [];
  /** the loaders, before the host's hooks: for drawing a screen again for another agent */
  #raw: { [name: string]: Loader } = {};
  #backend: () => Backend;
  #importer: Importer;
  /** how this host joins a link's channel: Subduction's, unless the world was given another */
  linker: Linker;
  /** the mirrors' wrapper and program, made again with each graph */
  #mirrors!: Mirrors;
  /** the kept mirrors' program, made again with each graph */
  #keeps!: KeptMirrors;
  /** how each link's transport is joining, by role and channel: "mount <channel>" */
  joins = new Map<string, Joining>();
  /** the times of the changes mounters made here, through a share: their sites are not this page's */
  linked = new Set<number>();
  /** how deep the host is in a mounter's operation, through a share */
  #fromLink = 0;

  constructor(
    o: { backend?: () => Backend; importer?: Importer; link?: Linker } = {},
  ) {
    let db: Backend | undefined;
    this.#backend = o.backend ?? (() => db ??= indexeddb(DATABASE));
    this.#importer = o.importer ?? ((url) => import(url));
    this.linker = o.link ?? (async (channel, url) => {
      // built apart: the page loads Subduction and its wasm when a link first needs them
      const m = await this.#importer(new URL("./link/subduction.js", document.baseURI).href) as {
        subduction: (channel: string, o: { url: string }) => Promise<Transport>;
      };
      return m.subduction(channel, { url });
    });
    this.stage.className = "stage-root";
    // what a program imports: "ermine" is the library; "demo" is this host
    (globalThis as { __ermineDemo?: unknown }).__ermineDemo = {
      ermine: {
        PENDING,
        equal,
        applyPatch,
        applyPatches,
        codePoints,
        parseAddress,
        isBytes,
        isLive,
        kindOf,
        errorJson,
        ErmineError,
        Invalid,
        Refused,
        Thrown,
      },
      demo: {
        h,
        screen: (process: Id) => this.screenFor(process),
        fire: (process: Id, handler: string, input?: Json) =>
          queueMicrotask(() => this.fireFromWorld(process, handler, input)),
        key: (process: Id) => this.keyFor?.(process),
        load: (code: string) => this.module(String(code), "api"),
      },
    };
    this.reset();
  }

  colorOf(agent: Json): string {
    const actor = actorOf(agent);
    const name = typeof actor === "string" ? actor : J(actor);
    let i = this.agents.indexOf(name);
    if (i < 0) {
      i = [...name].reduce((h, c) => (h * 31 + c.codePointAt(0)!) >>> 0, 7);
    }
    return AGENT_COLORS[i % AGENT_COLORS.length];
  }

  /** What the keeper kept, if it kept anything; undefined if not, or if it cannot be read. */
  async loadKept(): Promise<Kept | undefined> {
    try {
      return await load(this.#backend());
    } catch (e) {
      console.warn("ermine: what was kept could not be loaded", e);
      return undefined;
    }
  }

  /** Throws away what is kept, so the next page starts from the boot image. */
  async forgetKept(): Promise<void> {
    await this.#backend().write(new Map(), true);
  }

  /**
   * A fresh graph: everything made so far is gone. Rules and agents stay.
   * With keep, the keeper keeps it; with kept, it is the graph that was kept,
   * and the host's copy is what the root reaches of it.
   */
  reset(o: { kept?: Kept; keep?: boolean } = {}) {
    this.#stopAll();
    for (const [id, p] of this.#previews) this.#unpreview(id, p);
    for (const el of this.screens.values()) el.remove();
    this.screens.clear();
    this.log = [];
    this.made.clear();
    this.ephemeral.clear();
    this.latest.clear();
    this.records.clear();
    this.producedBy.clear();
    this.marked.clear();
    this.handlers.clear();
    this.procs.clear();
    this.snippets = [];
    this.subs.clear();
    this.#values.clear();
    this.#dirs.clear();
    this.#byTime.clear();
    this.#headers.clear();
    this.#starting = [];
    this.kept = undefined;
    this.#t++;
    // a graph is made with one node, its root, which the host gives: its value is null
    this.made.set(ROOT, undefined);
    this.#values.set(ROOT, null);
    this.inverses.clear();
    this.joins.clear();
    this.linked.clear();
    this.undoable = [];
    this.redoable = [];
    this.thrown.clear();
    // protect's own matching (PROTECT.tex, Rules), over the rules that are on
    const may = (agent: Json, process: Id | undefined, op: string, args: object) => {
      for (const r of this.rules) {
        if (!r.on) continue;
        const { on: _on, allow, ...given } = r;
        if (matches(given, agent, process, op, args)) return allow;
      }
      return true;
    };
    // a graph from before a reset may still run, as a timer an effect set does;
    // what it does is not this world's, and would spoil the host's copy
    const gen = ++this.#gen;
    const live = () => gen === this.#gen;
    const g = graph(ROOT, o.kept);
    let base: Interface = g;
    this.keeper = undefined;
    if (o.keep) {
      const backend = this.#backend();
      // a keeper of an older graph writes nothing
      const only: Backend = {
        read: () => backend.read(),
        write: (batch, whole) => live() ? backend.write(batch, whole) : Promise.resolve(),
      };
      this.keeper = keep(g, only, ROOT, {
        ...(o.kept ? { kept: o.kept } : {}),
        failed: (e) =>
          live() && this.#push({ t: "error", error: { kind: "keep", why: String(e) } }),
      });
      base = this.keeper;
      // a new graph replaces whatever was kept before it
      if (!o.kept) this.keeper.flush().catch(() => {});
    }
    this.bare = watch(base, {
      change: (c) => live() && this.#change(c),
      gone: (ids) => live() && this.#gone(ids),
      record: (r) => live() && this.#record(r),
    });
    if (o.kept) this.#seed(o.kept);
    this.#guarded = protect(this.bare, may);
    // links: a share serves a subtree on a channel; a mount mirrors one here.
    // Each is a process running a program built into the host (loaders/host)
    const joined = (role: string, channel: string, url: string) =>
      later(this.linker(channel, url), 60000, (j) => {
        if (!live()) return;
        this.joins.set(`${role} ${channel}`, j);
        this.#t++;
        this.bump();
      });
    const acting = () => this.agent;
    this.#mirrors = mirrors({
      connect: (channel) => joined("mount", channel, this.#urlOf(channel)),
      // the mirror reads and follows the owner as whoever acts here
      get agent() {
        return acting();
      },
    });
    // a mount that keeps a copy: ordinary nodes, kept here, no wrapper
    this.#keeps = kept({
      connect: (channel) => joined("mount", channel, this.#urlOf(channel)),
      get agent() {
        return acting();
      },
      api: () => this.scheduler,
    });
    const sharing = shares({
      connect: (channel, value) => joined("share", channel, value.url ?? SERVER),
      api: () => this.#served(),
    });
    const loaders = this.#loaders(live, {
      mirror: this.#mirrors.program,
      "mirror-kept": this.#keeps.program,
      share: sharing.program,
    });
    const s = schedule(this.#guarded, loaders, {
      graph: this.bare,
      ...(o.kept ? { time: o.kept.time } : {}),
    });
    // the mirrors' wrapper is the top: a write to a mirrored node is sent to its
    // owner, and shows here at once as a layer in front of the copy
    this.scheduler = this.#mirrors.wrap(observe(s, this.#starting));
    // shown to the ermine devtools panel, as the host sees it: beneath protect
    const shown =
      ((globalThis as { __ermine?: { name: string; api: Interface }[] }).__ermine ??= []);
    const at = shown.findIndex((x) => x.name === "demo");
    shown.splice(at < 0 ? shown.length : at, at < 0 ? 0 : 1, { name: "demo", api: this.bare });
    this.bump();
  }

  /**
   * Kills what the graph being left runs, by unplacing each process the host
   * started, so their cleanups run and their timers stop. It is not this
   * world's any more, so nothing is logged and nothing is kept.
   */
  #stopAll() {
    const s = this.scheduler;
    if (!s) return;
    this.#gen++;
    for (const p of [...this.procs.values()].reverse()) {
      if (p.state !== "running" || p.by !== undefined) continue;
      const address = this.addressOf(p.parent);
      if (!address) continue;
      try {
        s.unplace({ agent: "host", address, name: p.pid, id: p.pid, cause: { reset: true } });
      } catch { /* it is going anyway */ }
    }
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
   * The stage follows the acting agent. A process acts for whoever started
   * it, and its screen shows what that agent sees. For any other agent the
   * screen is drawn again beside it, from the same program run as that agent:
   * reads through protect, writes nowhere. It is drawn again when the graph
   * changes.
   */
  #follow() {
    for (const [id, p] of this.#previews) {
      if (!this.screens.has(id)) this.#unpreview(id, p);
    }
    for (const [id, box] of this.screens) {
      const own = box.querySelector(":scope > .own") as HTMLElement;
      const starter = this.procs.get(id)?.actor;
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
    const p = this.procs.get(id);
    const code = p?.code;
    if (!p || p.state !== "running" || !isProgram(code)) return note(`nothing to show ${agent}`);
    const loader = this.#raw[code.kind === "steps" ? "steps" : "same-thread"];
    try {
      const api = this.#guarded.bind(this.#guarded, {
        agent,
        process: id,
        place: p.cwd,
        writes: false,
      });
      const nothing: Interface = new Proxy({} as Interface, { get: () => () => undefined });
      const info: Started = {
        id,
        name: id,
        cwd: p.cwd,
        program: p.program,
        reads: api,
        lasting: nothing as Started["lasting"],
      };
      const compute = loader.load(code.compute, "compute", info);
      const value = compute(
        {
          api,
          self: id,
          cwd: p.cwd,
          name: id,
          changes: [],
          pending: PENDING,
        } as unknown as Parameters<Loaded>[0],
      );
      if (value === PENDING || value === undefined) return note(`waiting, as ${agent}`);
      preview.value = value as Json;
      if (code.effect === undefined) return note(J(value));
      const effect = loader.load(code.effect, "effect", info);
      // the effect's screen() is this one, and its writes go nowhere
      const draw = this.screenFor;
      this.screenFor = (q: Id) => q === id ? seen : draw.call(this, q);
      try {
        const after = effect(
          {
            api: nothing,
            lasting: nothing,
            self: id,
            cwd: p.cwd,
            name: id,
            value,
            ...(was?.value === undefined ? {} : { previous: was.value }),
            handler: () => {},
          } as unknown as Parameters<Loaded>[0],
        );
        if (typeof after === "function") preview.cleanup = after as () => void;
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
      r.process === undefined && r.peer === undefined
    );
  }

  /** What stands for a secret's value in the host's copy, the log and boot images. */
  static HIDDEN = "•••";

  /** A secret's value, read beneath protect, for the host to hand on. Nothing shows it. */
  revealed(node: Id): Json | undefined {
    const address = this.addressOf(node);
    if (!address) return undefined;
    return this.bare.read({ agent: "host", address }).find((i) => "value" in i)?.value;
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
      if (c.ephemeral) this.ephemeral.add(c.id);
    }
    // a change a mounter made, through a share: its cause is a site on the mounter's page
    if (this.#fromLink && !c.process) this.linked.add(c.time);
    this.#inverse(c);
    this.latest.set(c.node, c.time);
    const s = this.#snippet;
    if (s && !c.process) this.snippets.find((x) => x.n === s.n)?.times.push(c.time);
    this.#push({ t: "change", change: c });
  }

  /**
   * Ephemeral nodes that went: the graph has them no more, nor does the host.
   * A live value is let go, in the order they went, by its Symbol.dispose.
   */
  #gone(ids: readonly Id[]) {
    for (const id of ids) {
      const v = this.#values.get(id) as { [Symbol.dispose]?: () => void } | undefined;
      if (isLive(v)) {
        try {
          v?.[Symbol.dispose]?.();
        } catch (e) {
          console.warn(`ermine: ${id}'s live value did not let go`, e);
        }
      }
      this.made.delete(id);
      this.#values.delete(id);
      this.#dirs.delete(id);
      this.ephemeral.delete(id);
    }
    if (ids.length) this.#t++;
  }

  // --- undo: what each change from outside would take to reverse ---

  /**
   * values and slots as they were before each change, for its inverse: the
   * host's own copy of the graph, learned from the changes, since the graph
   * is read by address and not by id
   */
  #values = new Map<Id, Json>();
  #dirs = new Map<Id, Map<string, Id[]>>();
  /** the inverse of each change from outside, by its time */
  inverses = new Map<number, Inverse>();
  /** snippets that can be undone, last first; and undos that can be redone */
  undoable: number[] = [];
  redoable: number[] = [];

  #inverse(c: Change) {
    switch (c.kind) {
      case "write": {
        const before = this.#values.get(c.node) ?? null;
        try {
          this.#values.set(c.node, applyPatches(before, c.patches));
        } catch {
          // the graph applied it; a copy that disagrees is the host's own trouble
        }
        // a secret's old value is not the host's to keep, so its write is not undone;
        // nor is an ephemeral node's, which only a process may make again
        if (!c.process && !c.ephemeral && !this.secret(c.node)) {
          this.inverses.set(c.time, { op: "write", node: c.node, value: before });
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
        if (c.process || c.ephemeral) break;
        const was = before.indexOf(c.id);
        const p = this.procs.get(c.id);
        if (c.kind === "unplace" && p?.path && p.parent === c.node && c.name === c.id) {
          // a process unplaced is killed: placing its node again would not start it, so a new one is
          this.inverses.set(c.time, {
            op: "start",
            parent: c.node,
            program: p.path,
            ...(p.value !== undefined ? { value: p.value } : {}),
          });
          break;
        }
        // a position is a gap in the slot as it is: one moved earlier goes back past its old place
        const now = this.slotOf(c.node, c.name).indexOf(c.id);
        this.inverses.set(
          c.time,
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
      const inv = this.inverses.get(t);
      if (!inv) continue;
      if (inv.op === "write") lines.push(`write(${J(inv.node)}, ${jsOf(inv.value)})`);
      else if (inv.op === "unplace") {
        lines.push(`unplace(${J(inv.parent)}, ${J(inv.name)}, ${J(inv.id)})`);
      } else if (inv.op === "start") {
        lines.push(
          `start(${J(inv.parent)}, ${J(inv.program)}${
            inv.value === undefined ? "" : ", " + jsOf(inv.value)
          })`,
        );
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
  /** the headers of changes from before the graph was kept, as its items carry them */
  #headers = new Map<number, Header>();
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

  /**
   * The host's copy, from what was kept: every node the root reaches, its
   * value, slots, and the headers of their last changes. A kept node nothing
   * reaches stays in the graph, where placing its id again brings it back.
   */
  #seed(kept: Kept) {
    const seen = new Set<Id>([ROOT]);
    const queue: Id[] = [ROOT];
    while (queue.length) {
      const k = kept.nodes.get(queue.shift()!);
      for (const ids of k?.directory.values() ?? []) {
        for (const x of ids) {
          if (!seen.has(x) && kept.nodes.has(x)) {
            seen.add(x);
            queue.push(x);
          }
        }
      }
    }
    for (const id of seen) {
      const k = kept.nodes.get(id)!;
      this.made.set(id, undefined);
      this.#values.set(id, k.value);
      for (const [name, ids] of k.directory) this.#setSlot(id, name, [...ids]);
      let t = 0;
      for (const h of [...(k.change ? [k.change] : []), ...k.slots.values()]) {
        this.#headers.set(h.time, h);
        t = Math.max(t, h.time);
      }
      if (t) this.latest.set(id, t);
    }
    this.kept = { time: kept.time, nodes: kept.nodes.size };
    this.#t++;
  }

  /**
   * Process nodes that were kept: placed under their pid, as start places
   * them. One beneath another goes with it, so only the outermost are listed.
   */
  #stale(): { parent: Id; name: string }[] {
    const out: { parent: Id; name: string }[] = [];
    for (const parent of this.made.keys()) {
      const address = this.addressOf(parent);
      if (!address || address.some((n) => PID.test(n))) continue;
      for (const [name, ids] of this.slotsOf(parent)) {
        if (PID.test(name) && ids.includes(name) && !this.procs.has(name)) {
          out.push({ parent, name });
        }
      }
    }
    return out;
  }

  /** Forgets, in the host's copy, the nodes loaded from what was kept that the root no longer reaches. */
  #prune() {
    const reach = this.reachable();
    for (const [id, made] of [...this.made]) {
      if (made !== undefined || id === ROOT || reach.has(id)) continue;
      this.made.delete(id);
      this.#values.delete(id);
      this.#dirs.delete(id);
    }
    this.#t++;
  }

  /**
   * Opens a graph that was kept. Its processes did not outlive the page that
   * ran them: their nodes were kept as any node is, and nothing runs them. So
   * they are taken out, by a snippet, and the boot image is run only for its
   * starts: everything else it makes is here already.
   */
  reopen(image: string, label: string) {
    const stale = this.#stale();
    if (stale.length) {
      this.run(
        [
          "// a process does not outlive the page that ran it: its node was kept as",
          "// any node is, and nothing runs it now. each is taken out; the boot image",
          "// starts them again",
          "batch(() => {",
          ...stale.map((s) => `  unplace(${J(s.parent)}, ${J(s.name)}, ${J(s.name)})`),
          "})",
        ].join("\n"),
        "reopen: processes from before",
        "boot",
      );
      this.#prune();
    }
    if (image.trim()) this.run(image, label, "boot", undefined, {}, true);
  }

  /** The change made at a time, whichever node it was made to. */
  at(time: number): Change | undefined {
    return this.#byTime.get(time);
  }

  /** A change's header, from this page or kept from before it. */
  header(time: number): Header | Change | undefined {
    return this.#byTime.get(time) ?? this.#headers.get(time);
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

  /** The route from the root an address takes, in the host's copy. */
  routeOf(address: readonly string[]): Step[] {
    return walk(this.#view, ROOT, address).route;
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

  /** the last error each process's code threw, with the line, while it lasts */
  thrown = new Map<
    Id,
    { part: string; code: string; program?: Id; message: string; line?: number }
  >();

  #record(r: Run) {
    const list = this.records.get(r.process) ?? [];
    list.push(r);
    this.records.set(r.process, list);
    for (const t of [...r.cleanup, ...r.changes]) this.producedBy.set(t, r);
    for (const t of r.marked) this.marked.set(t, [...(this.marked.get(t) ?? []), r]);
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
      entry.sub = this.scheduler.subscribe({
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
      this.scheduler.unsubscribe({ agent: this.agent, sub: entry.sub });
      this.subs.delete(node);
      this.bump();
    } catch (e) {
      return problem(e);
    }
  }

  /** A handler call's answer: its record, and what went wrong, into the log. */
  #fired(r: Fired) {
    for (const t of r.handler.changes) this.producedBy.set(t, r.handler);
    this.#push({ t: "handler", record: r.handler });
    if (r.error !== undefined) this.#push({ t: "error", error: problem(r.error) });
  }

  // --- reading, as the acting agent or beneath protect ---

  get view(): Interface {
    return this.seeAll ? this.bare : this.scheduler;
  }

  /**
   * A node's value, read by an address that reaches it: the route's, if it
   * does, or the shortest. A node no address reaches reads as nothing. What a
   * scheduler puts in front of a process's value comes apart, as front.
   */
  read(node: Id, route?: readonly Step[], agent: Json = this.agent): Reading {
    if (this.secret(node)) return { refused: "nobody may read it" };
    const address = this.addressOf(node, route);
    if (!address) return { items: [], front: [] };
    try {
      const all = this.view.read({ agent, address });
      // the first value item is the node the address reaches; the rest are the others in its slot
      const i = all.findIndex((x) => "value" in x);
      const front = (i < 0 ? all : all.slice(0, i)) as unknown as ProcessItem[];
      const items = i < 0 ? [] : [all[i]];
      return items.length
        ? { items, value: items[0].value, front, address }
        : { items, front, address };
    } catch (e) {
      return { refused: problem(e).why };
    }
  }

  /** What the scheduler puts in front of a process's value, read as the acting agent. */
  front(node: Id): ProcessItem[] {
    const address = this.addressOf(node);
    if (!address) return [];
    try {
      return this.scheduler.read({ agent: this.agent, address })
        .filter((i) => !("value" in i)) as unknown as ProcessItem[];
    } catch {
      return [];
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

  /** A process node: one the scheduler started (SCHEDULER.tex, Processes). */
  isProcess(node: Id): boolean {
    return this.procs.has(node);
  }

  /** The processes the scheduler runs: where each runs, and the route to it. */
  running(): Map<Id, Running> {
    return this.#keep("running", () => {
      const out = new Map<Id, Running>();
      for (const p of this.procs.values()) {
        if (p.state !== "running") continue;
        const address = this.addressOf(p.pid);
        out.set(p.pid, {
          cwd: p.cwd,
          name: p.pid,
          parent: p.parent,
          route: address ? this.routeOf(address) : [],
        });
      }
      return out;
    });
  }

  /** The node a run's read reached: the last of its route, or, with none, where it started. */
  readNode(process: Id, x: ReadEntry): Id | undefined {
    const last = x.route[x.route.length - 1];
    if (last) return last.node;
    const p = this.procs.get(process);
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
        for (const i of items) {
          const t = i.change?.time;
          if (t !== undefined && (saw === null || t > saw)) saw = t;
        }
        if (node !== undefined) searched.push({ node, saw });
        // a slot whose ids are all absent is passed over
        if (items.some((i) => !i.pending)) break;
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        if (node !== undefined) searched.push({ node, refused: true });
        break;
      }
    }
    const items = this.view.lookup({ ...as, name }).filter((i): i is SlotItem => "id" in i);
    return { searched, found: items.map((i) => i.id), items };
  }

  // --- the workspace: every act from outside is a snippet ---

  /**
   * The host interface for snippets: fills in the agent and the cause, which
   * is the snippet's site, unless because() gave another.
   */
  host(): Scheduler {
    const d = this.scheduler;
    const fill = <T extends object>(op: T) => {
      const s = this.#snippet;
      const out: { [k: string]: unknown } = { agent: s?.agent ?? this.agent, ...op };
      if (!("cause" in op)) out.cause = s?.cause !== undefined ? s.cause : siteHere();
      return out as T;
    };
    const acting = <T extends object, R>(f: (op: T) => R) => (op: T) =>
      f({ agent: this.#snippet?.agent ?? this.agent, ...op });
    return {
      ...d,
      write: (op) => d.write(fill(op)),
      place: (op) => d.place(fill(op)),
      unplace: (op) => d.unplace(fill(op)),
      start: (op) => d.start(fill(op)),
      read: acting(d.read),
      directory: acting(d.directory),
      lookup: acting(d.lookup),
      fire: (op) => {
        const r = d.fire({ agent: this.#snippet?.agent ?? this.agent, ...op });
        this.#fired(r);
        return r;
      },
      batch: (fn) => d.batch(fn),
      get time() {
        return d.time;
      },
    } as Scheduler;
  }

  // --- links: shares and mounts ---

  /** The server a mount of the channel joins through: its start's url, or the default. */
  #urlOf(channel: string): string {
    for (const p of [...this.procs.values()].reverse()) {
      const v = p.value as { channel?: Json; url?: Json } | undefined;
      if (
        p.state === "running" && isObject(v) && v.channel === channel && typeof v.url === "string"
      ) return v.url;
    }
    return SERVER;
  }

  /**
   * What a share serves: the top of the stack, as the host's acts use it,
   * noting the changes a mounter makes through it. Each carries the agent and
   * cause the mounter sent, as serve.ts has it.
   */
  #served(): Scheduler {
    const d = this.scheduler;
    const from = <T, R>(f: (op: T) => R) => (op: T): R => {
      this.#fromLink++;
      try {
        return f(op);
      } finally {
        this.#fromLink--;
      }
    };
    return {
      ...d,
      write: from((op) => d.write(op)),
      place: from((op) => d.place(op)),
      unplace: from((op) => d.unplace(op)),
      get time() {
        return d.time;
      },
    } as Scheduler;
  }

  /** The program a process runs, if it is one built into the host: "share", "mirror" or "mirror-kept". */
  builtinOf(pid: Id): string | undefined {
    const code = this.procs.get(pid)?.code;
    return isProgram(code) && code.kind === "host" && typeof code.compute === "string"
      ? code.compute
      : undefined;
  }

  /** The shares and mounts running here, in the order they started. */
  links(): LinkInfo[] {
    const out: LinkInfo[] = [];
    for (const p of this.procs.values()) {
      const role = this.builtinOf(p.pid);
      if (
        p.state !== "running" || (role !== "share" && role !== "mirror" && role !== "mirror-kept")
      ) continue;
      const v = p.value as {
        channel?: Json;
        url?: Json;
        name?: Json;
        address?: Json;
        named?: Json;
      };
      if (!isObject(v) || typeof v.channel !== "string") continue;
      const status = this.valueOf(this.slotOf(p.pid, "link")[0] ?? "");
      const r = role === "share" ? "share" : "mount";
      out.push({
        pid: p.pid,
        role: r,
        ...(r === "mount"
          ? { kind: role === "mirror-kept" ? "kept" as const : "live" as const }
          : {}),
        channel: v.channel,
        ...(typeof v.named === "string" ? { named: v.named } : {}),
        url: typeof v.url === "string" ? v.url : SERVER,
        joining: this.joins.get(`${r} ${v.channel}`) ?? { state: "connecting" },
        ...(isObject(status) ? { status: status as { [k: string]: Json } } : {}),
        address: r === "share"
          ? (isShare(v) ? [...v.address] : [])
          : [...p.cwd, typeof v.name === "string" ? v.name : ""],
      });
    }
    return out;
  }

  /**
   * The mount a node is in, if it is one of a mirror's copies or layers, its
   * path there, and the mount's kind. A kept copy's node is known by its id
   * before its mount has followed it (after a reload): its path is then not.
   */
  mountOf(node: Id): { pid: Id; path?: string[]; kind: "live" | "kept" } | undefined {
    for (const [pid, link] of this.#mirrors.links) {
      const path = link.pathOf(node);
      if (path) return { pid, path, kind: "live" };
    }
    for (const [pid, link] of this.#keeps.links) {
      const path = link.pathOf(node);
      if (path) return { pid, path, kind: "kept" };
      if (node.startsWith(link.prefix)) return { pid, kind: "kept" };
    }
  }

  /** Whether node is top or a node top holds, by placement after placement, in the host's copy. */
  #holds(top: Id, node: Id): boolean {
    const seen = new Set<Id>();
    const queue = [top];
    while (queue.length) {
      const at = queue.shift()!;
      if (at === node) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const [, ids] of this.slotsOf(at)) for (const id of ids) queue.push(id);
    }
    return false;
  }

  /** whether a boot image is being run to reopen a kept graph: only its starts are made */
  #reopening = false;

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
      if (!has(stem)) return stem;
      for (let i = 2;; i++) if (!has(`${stem}-${i}`)) return `${stem}-${i}`;
    };
    const at = (node: Id | Address) => this.#need(node);
    const value = (items: ValueItem[]) => items.find((i) => "value" in i)?.value;
    /** reopening a kept graph: what was kept is here, so nothing is made again */
    const kept = () => this.#reopening;
    const path = (program: string | readonly string[]) =>
      typeof program === "string" ? ["programs", program] : [...program];
    const start = (where: Id | Address, program: string | readonly string[], first?: Json) => {
      const op: StartOp = { address: at(where), program: path(program) };
      if (first !== undefined) op.value = first;
      const answer = api.start(op);
      return answer.change.kind === "place" ? answer.change.id : undefined;
    };
    /** The loaders and the programs folder in the root, if the root has none. */
    const runtime = () => {
      if (!this.slotOf(ROOT, "loaders").length) {
        made(api, has, [], "loaders", fresh("loaders"), {});
      }
      const loaders = this.slotOf(ROOT, "loaders")[0];
      for (const [kind, loader] of [["js", "same-thread"], ["steps", "steps"]]) {
        if (!this.slotOf(loaders, kind).length) {
          made(api, has, at(loaders), kind, fresh(`loader-${kind}`), { loader });
        }
      }
      if (!this.slotOf(ROOT, "programs").length) {
        made(api, has, [], "programs", fresh("programs"), {});
      }
      return this.slotOf(ROOT, "programs")[0];
    };
    /**
     * What a share or a mount needs, made if the root has none: the host's
     * loader, loaders/host; and the program, programs/<name>, built into the
     * host.
     */
    const linking = (name: "share" | "mirror" | "mirror-kept") => {
      const programs = runtime();
      const loaders = this.slotOf(ROOT, "loaders")[0];
      if (!this.slotOf(loaders, "host").length) {
        made(api, has, at(loaders), "host", fresh("loader-host"), { loader: "host" });
      }
      if (!this.slotOf(programs, name).length) {
        made(api, has, at(programs), name, fresh(name), {
          kind: "host",
          compute: name,
          effect: name,
        });
      }
    };
    /** A name in a folder's directory that no slot has yet. */
    const free = (folder: Id, name: string) => {
      if (!this.slotOf(folder, name).length) return name;
      for (let i = 2;; i++) if (!this.slotOf(folder, `${name}-${i}`).length) return `${name}-${i}`;
    };
    const words = {
      api,
      /**
       * Makes a node by placing it with its value, as CORE.tex has it: one
       * change, the parent's and the node's first. An id the graph has is
       * placed once more.
       */
      make: (parent: Id | Address, name: string, id: Id, value: Json = null) => {
        if (kept()) return;
        this.#placeable(id);
        return made(api, has, at(parent), name, id, value);
      },
      write: (node: Id | Address, value: Json) =>
        kept()
          ? undefined
          : api.write({ address: at(node), patches: [{ type: "snapshot", value }] }),
      patch: (node: Id | Address, ...patches: Patch[]) =>
        kept() ? undefined : api.write({ address: at(node), patches }),
      splice: (
        node: Id | Address,
        path: (string | number)[],
        from: number,
        to: number,
        value?: Json,
      ) =>
        kept() ? undefined : api.write({
          address: at(node),
          patches: [
            value === undefined
              ? { type: "splice", path, range: [from, to] }
              : { type: "splice", path, range: [from, to], value },
          ],
        }),
      set: (node: Id | Address, path: (string | number)[], key: string, value?: Json) =>
        kept() ? undefined : api.write({
          address: at(node),
          patches: [
            value === undefined ? { type: "set", path, key } : { type: "set", path, key, value },
          ],
        }),
      place: (parent: Id | Address, name: string, id: Id, position?: number) => {
        if (kept()) return;
        this.#placeable(id);
        return api.place(
          position === undefined
            ? { address: at(parent), name, id }
            : { address: at(parent), name, id, position },
        );
      },
      unplace: (parent: Id | Address, name: string, id: Id) =>
        kept() ? undefined : api.unplace({ address: at(parent), name, id }),
      /** A node's value: the first value item's; undefined if no address reaches it. */
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
        api.lookup(place === undefined ? { name } : { name, place }).flatMap((i) =>
          "id" in i ? [i.id] : []
        ),
      /**
       * A program node, {kind, compute, effect?}, made in parent's slot name:
       * JS module source, or a list of steps; or the program itself. Its id is
       * its name, or one like it if that is taken.
       */
      program: (parent: Id | Address, name: string, compute: Json, effect?: Json) => {
        if (kept()) return;
        const id = fresh(name);
        made(api, has, at(parent), name, id, programOf(compute, effect));
        return id;
      },
      /**
       * Starts the program found at path, searching up from the node where
       * reaches, as start does (SCHEDULER.tex): a name is ["programs", name].
       * Answers with its pid.
       */
      start: (where: Id | Address, program: string | readonly string[], first?: Json) =>
        start(where, program, first),
      /** Kills a process, by unplacing it from where it was started. */
      stop: (pid: Id) => {
        const p = this.procs.get(pid);
        if (!p) throw new Error(`${J(pid)} is not a process the scheduler started`);
        return api.unplace({ address: at(p.parent), name: pid, id: pid });
      },
      /**
       * Replaces a process, as SCHEDULER.tex says: starts its program again
       * where it was, and unplaces the old one. Answers with the new pid.
       */
      replace: (pid: Id) => {
        const p = this.procs.get(pid);
        if (!p?.path) throw new Error(`${J(pid)}: the host did not see it start, so cannot again`);
        let next: Id | undefined;
        api.batch(() => {
          next = start(p.parent, p.path!, p.value);
          api.unplace({ address: at(p.parent), name: pid, id: pid });
        });
        return next;
      },
      /**
       * A program and a process running it, in one batch: the program is made
       * in the root's programs/, under name or one like it, and the process is
       * started in parent, where it runs. Answers with its pid. The id, if
       * given, is the program node's.
       */
      process: (
        parent: Id | Address,
        name: string,
        a: Id | { compute: Json; effect?: Json; value?: Json },
        b?: { compute: Json; effect?: Json; value?: Json },
      ) => {
        if (kept()) return;
        const o = typeof a === "string" ? b! : a;
        let pid: Id | undefined;
        api.batch(() => {
          const programs = runtime();
          const slot = free(programs, name);
          const id = typeof a === "string" && !has(a) ? a : fresh(slot);
          made(api, has, at(programs), slot, id, programOf(o.compute, o.effect));
          pid = start(parent, ["programs", slot], o.value);
        });
        return pid;
      },
      /**
       * A UI that is reactive by construction, for a model too small to write
       * a compute and an effect: a node in parent's slot name, holding what it
       * watches and how it draws, and a process in it running the shared
       * program programs/ui, whose compute looks up each name in state and
       * watch from there and reads it, so it runs again when any of them
       * changes; and whose effect draws with draw, the source of a function
       * ({ h, state, set }) to an element. set(name, value) writes that name
       * through a handler, so a click is credited to whoever clicked. State
       * not found is made beside it. Answers with its pid; its draw is the
       * node pid + ".draw".
       */
      ui: (
        parent: Id | Address,
        name: string,
        o: { state?: { [name: string]: Json }; watch?: string[]; draw: string; id?: Id },
      ) => {
        if (kept()) return;
        const from = at(parent);
        let pid: Id | undefined;
        api.batch(() => {
          for (const [k, v] of Object.entries(o.state ?? {})) {
            if (!api.lookup({ name: k, place: from }).length) made(api, has, from, k, fresh(k), v);
          }
          const programs = runtime();
          if (!this.slotOf(programs, "ui").length) {
            made(api, has, at(programs), "ui", fresh("ui"), programOf(UI_COMPUTE, UI_EFFECT));
          }
          const id = o.id ?? fresh(name);
          made(api, has, from, name, id, { "@type": "ui" });
          pid = start(id, ["programs", "ui"]);
          made(api, has, at(id), "watch", `${pid}.watch`, [
            ...new Set([...Object.keys(o.state ?? {}), ...(o.watch ?? [])]),
          ]);
          made(api, has, at(id), "draw", `${pid}.draw`, o.draw);
        });
        return pid;
      },
      fire: (process: Id, handler: string, input?: Json) =>
        api.fire(input === undefined ? { process, handler } : { process, handler, input }),
      /**
       * Shares a node's subtree, or with ROOT the whole workspace: a process
       * running programs/share, started in the root's shares/, serves the
       * subtree at the node's address on a channel, through the server at url
       * (wss://galaxy.observer if not given), until it is stopped. The channel
       * is a fresh random one, or, given a name, the channel that name stands
       * for (src/link/name.ts), which anyone who knows the name can mount.
       * Answers with the channel. o is the url, or {url?, name?}.
       */
      share: (node: Id | Address, o?: string | { url?: string; name?: string }) => {
        if (kept()) return;
        const { url, name } = typeof o === "string" ? { url: o, name: undefined } : o ?? {};
        const address = at(node);
        const { channel, named } = name === undefined || !name.trim()
          ? { channel: freshChannel(), named: undefined }
          : channelNamed(name);
        api.batch(() => {
          linking("share");
          if (!this.slotOf(ROOT, "shares").length) {
            made(api, has, [], "shares", fresh("shares"), {});
          }
          start(this.slotOf(ROOT, "shares")[0], ["programs", "share"], {
            channel,
            address,
            ...(url ? { url } : {}),
            ...(named ? { named } : {}),
          });
        });
        return channel;
      },
      /**
       * Mounts a channel, given as its 64 hex digits or as a name: a process
       * running programs/mirror, started in the folder at (the root if not
       * given), keeps a copy of what the owner on the channel serves in that
       * folder, under the name given, or the channel's name, or its first
       * eight digits, and sends the owner every write, place and unplace made
       * there. Answers with its pid. kind "live" (the default) keeps the copy
       * in the mount's ephemeral nodes, which go with it (src/link/mirror.ts);
       * "kept" runs programs/mirror-kept instead, whose copy is ordinary nodes
       * this page keeps, there after a reload as it was last seen
       * (src/link/kept.ts). The arguments after the channel are url, kind
       * and at, or one map {url?, kind?, at?, name?}.
       */
      mount: (
        given: string,
        a?: string | { url?: string; kind?: "live" | "kept"; at?: Id | Address; name?: string },
        b?: "live" | "kept",
        c?: Id | Address,
      ) => {
        if (kept()) return;
        const o = a !== null && typeof a === "object" ? a : { url: a, kind: b, at: c };
        const kind = o.kind ?? "live";
        if (kind !== "live" && kind !== "kept") {
          throw new Error('a mount\'s kind is "live" (the default) or "kept"');
        }
        if (typeof given !== "string" || !given.trim()) {
          throw new Error("mount what? a channel, 64 hex digits, or a name");
        }
        const { channel, named } = channelNamed(given);
        const address = o.at === undefined ? [] : at(o.at);
        const folder = walk(this.#view, ROOT, address).node;
        if (folder === undefined) throw new Error(`nothing at /${address.join("/")} to mount into`);
        // a copy inside what this page shares on that channel would copy itself, forever
        for (const l of this.links()) {
          if (l.role !== "share" || l.channel !== channel) continue;
          const served = walk(this.#view, ROOT, l.address).node;
          if (served !== undefined && this.#holds(served, folder)) {
            throw new Error(
              `this page shares that channel, and the copy would go inside what it shares (/${
                l.address.join("/")
              }): it would copy itself into itself forever. mount it somewhere outside`,
            );
          }
        }
        const wanted = o.name ?? named ?? channel.slice(0, 8);
        const base = isName(wanted) ? wanted : channel.slice(0, 8);
        let pid: Id | undefined;
        api.batch(() => {
          const program = kind === "kept" ? "mirror-kept" : "mirror";
          linking(program);
          pid = start(address, ["programs", program], {
            channel,
            name: free(folder, base),
            ...(o.url ? { url: o.url } : {}),
            ...(named ? { named } : {}),
          });
        });
        return pid;
      },
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
      /** Bytes, from base64: what a file or an image holds. */
      bytes: (base64: string) => fromBase64(base64),
      /** A typed array of a kind, from its elements: int64 and uint64 elements may be strings. */
      typed: (kind: keyof typeof KINDS, elements: (number | string)[]) => {
        const big = kind === "int64" || kind === "uint64";
        // deno-lint-ignore no-explicit-any
        return new (KINDS[kind] as any)(elements.map((x) => big ? BigInt(x) : Number(x)));
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
    /** a boot image run to reopen a kept graph: only its starts are made */
    reopening = false,
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
    const wasReopening = this.#reopening;
    this.#reopening = reopening;
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
      this.#reopening = wasReopening;
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
   * there, and then starts the processes the host started. A node in several
   * places is made in the first and placed in the rest. A process's node, and
   * what only it holds, is left out: a start makes a new one, which its
   * program fills again. Ephemeral nodes are left out: nobody keeps them.
   * What the root does not reach cannot be addressed (CORE.tex), so it is
   * not here. It reads the host's copy of the graph, beneath protect.
   */
  image(from: Id = ROOT, skip: (id: Id) => boolean = () => false): string {
    const lines: string[] = [];
    // the root's value starts null, as the graph is made; another node's is written
    const fromValue = this.valueOf(from);
    if (fromValue !== undefined && (fromValue !== null || from !== ROOT)) {
      lines.push(`write(${J(from)}, ${jsOf(fromValue)})`);
    }
    const left = (id: Id) =>
      skip(id) || this.ephemeral.has(id) || this.procs.has(id) || (PID.test(id));
    const made = new Set<Id>([from]);
    const queue: Id[] = [from];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const [name, ids] of this.slotsOf(parent)) {
        for (const id of ids) {
          if (left(id)) continue;
          if (made.has(id) || !this.made.has(id)) {
            lines.push(`place(${J(parent)}, ${J(name)}, ${J(id)})`);
            continue;
          }
          made.add(id);
          queue.push(id);
          lines.push(`make(${J(parent)}, ${J(name)}, ${J(id)}, ${jsOf(this.valueOf(id) ?? null)})`);
        }
      }
    }
    // the processes the host started, in the order they were: a process's own children are its to start
    const starts = [...this.procs.values()]
      .filter((p) =>
        p.state === "running" && p.by === undefined && p.path && made.has(p.parent) &&
        this.addressOf(p.pid) !== undefined
      )
      .sort((a, b) => a.started - b.started)
      .map((p) =>
        `start(${J(p.parent)}, ${J(p.path)}${p.value === undefined ? "" : ", " + jsOf(p.value)})`
      );
    return [
      from === ROOT
        ? "// a boot image: run in a fresh graph, it makes everything the root reaches,\n" +
          "// then starts its processes"
        : `// everything ${J(from)} reaches, as a boot image would make it`,
      "batch(() => {",
      ...[...lines, ...starts].map((l) => "  " + l.replaceAll("\n", "\n  ")),
      "})",
    ].join("\n");
  }

  // --- what the stage and the loaders need ---

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
      const starter = this.procs.get(process)?.by;
      const home = starter && this.procs.has(starter)
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
      const r = this.scheduler.fire(
        input === undefined ? { agent, process, handler } : { agent, process, handler, input },
      );
      this.#fired(r);
      return r;
    } catch (e) {
      this.#push({ t: "error", error: problem(e) });
    }
  }

  /** The sources of the modules loaded, by the blob: URL each was imported from, for lines. */
  #sources = new Map<string, string>();
  #blobs = new Map<string, string>();

  /** A blob: URL for a module's source, so a frame in a stack names it and its line. */
  #blob(source: string): string {
    let url = this.#blobs.get(source);
    if (!url) {
      url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      this.#blobs.set(source, url);
      this.#sources.set(url, source);
    }
    return url;
  }

  /**
   * How the same-thread loader imports a module: a module given as its
   * source comes as a data: URL, which is imported as a blob: URL of the same
   * source, so an error's stack says the line. What it imports, "demo" and
   * "ermine", the page's import map resolves.
   */
  #import = (url: string): Promise<unknown> => {
    if (url.startsWith("data:")) {
      return this.#importer(this.#blob(decodeURIComponent(url.slice(url.indexOf(",") + 1))));
    }
    return this.#importer(url);
  };

  /**
   * The same-thread loader, told each process's program (LOADERS.tex's
   * Running.code), which the reference scheduler does not give it: so it
   * loads a program's compute and effect, two modules or one, before its
   * compute returns a value.
   */
  #told(inner: Loader): Loader {
    const told = <P extends Started>(p: P): P => {
      const code = this.procs.get(p.id)?.code;
      return isProgram(code) && p.code === undefined ? { ...p, code } : p;
    };
    return {
      started: (p) => inner.started?.(told(p)),
      killed: (p) => inner.killed?.(p),
      load: (code, part, p) => inner.load(code, part, told(p)),
    };
  }

  /**
   * The host's loaders: same-thread, for JS modules, and steps, for programs
   * as data. Each is told when a process starts and is killed, and the host
   * listens: it notes each process, the handlers its effect names, and what
   * its code threw, with the line.
   */
  #loaders(
    live: () => boolean,
    host: { [name: string]: Builtin },
  ): { [name: string]: Loader } {
    this.#raw = { "same-thread": this.#told(sameThread(this.#import)), steps: steps() };
    const hooked = (inner: Loader): Loader => ({
      started: (p) => {
        if (live()) this.#started(p);
        inner.started?.(p);
      },
      killed: (p) => {
        inner.killed?.(p);
        if (live()) this.#killed(p.id);
      },
      load: (code, part, p) => {
        let fn: Loaded;
        try {
          fn = inner.load(code, part, p);
        } catch (e) {
          if (live()) this.#threw(p.id, part, code, e);
          throw e;
        }
        return (given) => {
          let call = given;
          if (part === "effect" && live()) {
            // the inspector lists a process's handlers: the host notes each name it is given
            call = {
              ...given,
              handler: (name: string, f: Handler) => {
                given.handler(
                  name,
                  (input) => this.#calling(p.id, "handler", code, () => f(input)),
                );
                if (typeof name !== "string") return;
                const set = this.handlers.get(p.id) ?? new Set();
                set.add(name);
                this.handlers.set(p.id, set);
              },
            };
          }
          return live() ? this.#calling(p.id, part, code, () => fn(call)) : fn(call);
        };
      },
    });
    return {
      "same-thread": hooked(this.#raw["same-thread"]),
      steps: hooked(this.#raw.steps),
      // the programs built into this host: a share and a mount's mirror
      host: hooked(builtin(host)),
    };
  }

  /** A process started: the host notes it, its place, its program, and who started it. */
  #started(p: Started) {
    // the placement that made its node: its parent, and who made it, as whom
    const placement = this.made.get(p.id);
    const op = this.#starting[this.#starting.length - 1];
    this.procs.set(p.id, {
      pid: p.id,
      parent: placement?.node ?? ROOT,
      cwd: [...p.cwd],
      program: p.program,
      ...(op ? { path: [...op.program] } : {}),
      ...(op?.value !== undefined ? { value: op.value } : {}),
      ...(placement?.process !== undefined ? { by: placement.process } : {}),
      actor: actorOf(placement?.agent ?? null),
      state: "running",
      started: placement?.time ?? 0,
      code: this.valueOf(p.program.node) ?? null,
    });
    this.#t++;
    this.bump();
  }

  /** A process killed: its screen and handlers go; its node may stay, stopped. */
  #killed(pid: Id) {
    const p = this.procs.get(pid);
    if (p) p.state = "killed";
    this.#push({ t: "stopped", process: pid });
    this.screens.get(pid)?.remove();
    this.screens.delete(pid);
    this.handlers.delete(pid);
    this.#t++;
  }

  /** Runs a part of a process, and keeps what it threw, with the line, for the editor. */
  #calling<T>(pid: Id, part: string, code: Json, run: () => T): T {
    try {
      const v = run();
      if (this.#previewing) return v;
      const t = this.thrown.get(pid);
      if (t?.part === part) this.thrown.delete(pid);
      return v;
    } catch (e) {
      this.#threw(pid, part, code, e);
      throw e;
    }
  }

  #threw(pid: Id, part: string, code: Json, e: unknown) {
    if (this.#previewing) return;
    // a refusal or an invalid operation is the run's record's to tell, not a throw
    if (e instanceof ErmineError && e.why.code !== "not-a-program") return;
    const stack = String((e as Error)?.stack ?? "");
    let line: number | undefined;
    for (const m of stack.matchAll(/(blob:[^\s)]+?):(\d+):(\d+)/g)) {
      if (this.#sources.has(m[1])) {
        line = Number(m[2]);
        break;
      }
    }
    this.thrown.set(pid, {
      part,
      code: typeof code === "string" ? code : J(code),
      program: this.procs.get(pid)?.program.node,
      message: (e as Error)?.message ?? String(e),
      ...(line ? { line } : {}),
    });
  }

  /**
   * A module that is not a process's part, such as an LLM's api: its default
   * export, linked here. The page cannot import a module synchronously, so
   * each import line takes its names from the host's modules, and the export
   * is returned. Lines are kept, so a thrown error's line is the module's.
   */
  module(code: string, part: string): unknown {
    const k = part + "\0" + code;
    let fn = this.#compiled.get(k);
    if (!fn) {
      const modules = (globalThis as { __ermineDemo?: { [name: string]: unknown } }).__ermineDemo!;
      const linked = code.replace(
        // [ \t], not \s, at the ends: a line's newline stays, and the next line with it
        /^[ \t]*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'][ \t]*;?/gm,
        (_, names: string, from: string) => {
          if (!(from in modules)) {
            throw new Error(
              `a module here can only import ${
                Object.keys(modules).map((m) => J(m)).join(" or ")
              }, not ${J(from)}`,
            );
          }
          return `const {${names}} = __modules[${J(from)}];`;
        },
      ).replace(/^[ \t]*export\s+default\s+/m, "return ");
      if (linked === code && !/\bexport\s+default\b/.test(code)) {
        throw new Error("a module here has a default export: export default function (o) { ... }");
      }
      const link = (0, eval)(
        `(function (__modules) {\n${linked}\n})\n//# sourceURL=ermine:${part}-${this.#compiled.size}`,
      ) as (modules: unknown) => unknown;
      fn = link(modules);
      if (typeof fn !== "function") throw new Error("a module's default export is a function");
      this.#compiled.set(k, fn);
    }
    return fn;
  }

  #compiled = new Map<string, unknown>();
}

/**
 * The layer above the graph that tells the demo every change, every ephemeral
 * node that went, and every record. It is beneath protect, and the
 * scheduler's bookkeeping goes through it.
 */
function watch(
  api: Interface,
  sink: { change(c: Change): void; gone(ids: readonly Id[]): void; record(r: Run): void },
): Interface {
  const tap = <T extends { change: Change; made?: readonly { change: Change }[]; gone?: Id[] }>(
    r: T,
  ): T => {
    for (const m of r.made ?? [{ change: r.change }]) sink.change(m.change);
    if (r.gone?.length) sink.gone(r.gone);
    return r;
  };
  const out: Interface = {
    ...api,
    write: (op) => tap(api.write(op)),
    place: (op) => tap(api.place(op)),
    unplace: (op) => tap(api.unplace(op)),
    finish: (rec, ending, f) => {
      const r = api.finish(rec, ending, f);
      sink.record(r);
      return r;
    },
    top: (t) => api.top(t),
  };
  if (api.release) out.release = (op) => tap(api.release!(op));
  return out;
}

/**
 * The top of the stack, over the scheduler: it passes everything on, and
 * notes each start under way, so the host knows the path a process's program
 * was found by, to start it again.
 */
function observe(s: Scheduler, starting: StartOp[]): Scheduler {
  const noting = <T>(op: unknown, f: () => T): T => {
    const start = op !== null && typeof op === "object" && "program" in op;
    if (start) starting.push(op as StartOp);
    try {
      return f();
    } finally {
      if (start) starting.pop();
    }
  };
  return {
    read: (op) => s.read(op),
    directory: (op) => s.directory(op),
    lookup: (op) => s.lookup(op),
    write: (op) => s.write(op),
    place: (op) => noting(op, () => s.place(op)),
    unplace: (op) => s.unplace(op),
    start: (op) => noting(op, () => s.start(op)),
    subscribe: (op) => s.subscribe(op),
    unsubscribe: (op) => s.unsubscribe(op),
    forget: (op) => s.forget(op),
    bind: (inner, binding) => s.bind(inner, binding),
    record: (inner, marked) => s.record(inner, marked),
    finish: (recording, ending, finishing) => s.finish(recording, ending, finishing),
    top: (t) => s.top(t),
    cwd: s.cwd,
    ...(s.reach
      ? { reach: (op: Parameters<NonNullable<Interface["reach"]>>[0]) => s.reach!(op) }
      : {}),
    batch: (fn) => s.batch(fn),
    fire: (op) => s.fire(op),
    restart: () => s.restart(),
    get time() {
      return s.time;
    },
  };
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
 * is only placed. Whether it has it is the host's knowledge, since a value
 * for an id the graph has is invalid.
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

/** A program's value: JS module source is kind js, a list of steps is kind steps. */
function programOf(compute: Json, effect?: Json): Json {
  if (isProgram(compute)) return compute;
  const kind = Array.isArray(compute) ? "steps" : "js";
  return effect === undefined ? { kind, compute } : { kind, compute, effect };
}

/** A tiny element builder for effects: h("button", { onclick }, "hop"). */
export function h(
  tag: string,
  props: { [k: string]: unknown } = {},
  ...children: (Node | string | number | null | undefined | false)[]
): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) (el as unknown as { [k: string]: unknown })[k] = v;
    else if (k in el && typeof v !== "string") (el as unknown as { [k: string]: unknown })[k] = v;
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
  if (isBytes(v) || kindOf(v)) return jsOf(v as Json);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Whether a value is plain JSON all through: no bytes, typed arrays, live values or odd numbers. */
export function plain(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0);
  if (Array.isArray(v)) return v.every(plain);
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.values(v as object).every(plain);
  }
  return false;
}

export function toBase64(b: ArrayBuffer): string {
  let s = "";
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/=+$/, "");
}

export function fromBase64(text: string): ArrayBuffer {
  const s = atob(text);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

/**
 * A value as JS for a boot image: JSON as itself, a long string with lines
 * as a String.raw template, and bytes and typed arrays as the words that make
 * them, bytes(base64) and typed(kind, elements).
 */
export function jsOf(v: Json): string {
  if (typeof v === "string" && v.includes("\n") && !/[`]|\$\{|\\$/.test(v)) {
    return "String.raw`" + v + "`";
  }
  if (plain(v)) {
    return JSON.stringify(
      v,
      null,
      v !== null && typeof v === "object" && JSON.stringify(v).length > 70 ? 2 : 0,
    );
  }
  if (isBytes(v)) return `bytes(${J(toBase64(v))})`;
  const kind = kindOf(v);
  if (kind) {
    const els = Array.from(
      v as ArrayLike<number | bigint>,
      (x) => typeof x === "bigint" ? String(x) : Number.isFinite(x) ? x : String(x),
    );
    return `typed(${J(kind)}, ${J(els)})`;
  }
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (Array.isArray(v)) return `[${v.map(jsOf).join(", ")}]`;
  if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return `{ ${Object.entries(v).map(([k, x]) => `${J(k)}: ${jsOf(x as Json)}`).join(", ")} }`;
  }
  return "null /* a live value: it never leaves its host */";
}

/** ui()'s compute: each watched name, looked up from where the UI sits, and read. */
const UI_COMPUTE = `// ui(): runs in the UI's node, so [] is it. looks up each name the UI watches,
// from there, and reads it; a read marks the process, so it runs again when
// any of them changes
export default function ({ api }) {
  const own = (slot) => api.read({ address: [slot] }).find((i) => "value" in i)?.value
  const values = {}, at = {}
  for (const n of own("watch") ?? []) {
    const [it] = api.lookup({ name: n })
    if (!it || !it.from.path) continue
    at[n] = it.from.path
    values[n] = api.read({ address: it.from.path }).find((i) => "value" in i)?.value ?? null
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
    else lasting.place({ address: [".."], name: input.name, id: input.name + "-" + Date.now(), value: input.value })
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
