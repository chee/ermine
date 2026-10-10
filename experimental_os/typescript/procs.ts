// procs.ts: the ermine OS's scheduler, a process layer in the setup shape
// (working/WHAT-IS-A-PROCESS.tex). An experiment, as
// experimental_layers/processes is. It keeps to what chee decided there on
// 2026-10-09 (next.org, Write into the papers):
//
// - A program is a setup, called once, untracked; it returns the process's
//   value, which the layer writes at the process's node, its pid.
// - A process writes into the directory it is in: that is its ".". What it
//   makes goes there; its node holds its value, and under it the nodes of
//   its computes and effects.
// - Reads that should update go in a compute or an effect. An effect's run
//   is not called when its compute gives an equal value.
// - Handlers are nodes at /proc/<pid>/on/<name> (layout A); a call acts as
//   its caller, and its changes name the caller and the handler.
// - call and start take an op, {address, ...}, as the graph's operations do.
// - New code is shown as new: the process's /proc node says so. Replacing it
//   is a person's or the host's choice (replace), and then setup runs with
//   it, and a kept effect runs again.
//
// What it adds that nobody decided, for the OS: a compute's word,
// "compute"; release, for an ephemeral node the process placed; owning the
// ephemeral nodes a process places, released when it ends; a live table.
//
// The graph never calls code. Every change goes through this layer's
// interface, which notes from each answer the readers it marked and the ids
// it let go; settle() runs what is due: loads, computes lowest height first,
// effects' computes, then the runs of effects whose value changed.
//
// Over the core graph as GRAPH.tex now has it: a read made with a reader is
// tracked for it, and forget drops what it read, so a compute forgets, then
// reads, each run; views are core's bind; a change from no process carries
// its site. There is no top: this layer is the top of its stack, and sync
// (layers/subduction/SYNC.tex), which wrapped it with arrive and top, waits
// for that layer to come over to this core.

import { type Graph } from "../../core/graph/typescript/graph.ts";
import { equal, isLive } from "../../core/graph/typescript/patch.ts";
import { bind as view } from "../../core/graph/typescript/view.ts";
import {
  type Address,
  type Bare,
  capture,
  type Change,
  type Changed,
  type Id,
  type Interface,
  invalid,
  type Item,
  type Json,
  type Site,
  type ValueItem,
} from "../../core/graph/typescript/types.ts";

/** What a compute returns when it has nothing yet. */
export const pending: unique symbol = Symbol.for("ermine.pending");
export type Pending = typeof pending;

/** An agent: the actor, and the code it went through, outermost first; a host may add more. */
export type Agent = { actor: Json; code: Json[]; [more: string]: Json };

/** A compute or an effect, as setup and runs hold it. */
export type Made = { id: Id; readonly [READER]: Reader };
const READER = Symbol("reader");

type PlaceOp = Parameters<Interface["place"]>[0];

/** The program's interface: the graph's operations, scoped to the process, and start, call, release. */
export type Api = Pick<Interface, "read" | "directory" | "lookup" | "write" | "unplace"> & {
  /** the graph's place; id may be left out, and the layer gives one, or the top does */
  place: (op: Omit<PlaceOp, "id"> & { id?: Id }) => Changed;
  /** starts a process in the directory the address reaches; gives its pid */
  start: (op: { address: Address; program: string | Setup; name?: string; data?: Json }) => string;
  /** calls the handler the address reaches, as this caller */
  call: (op: { address: Address; args?: unknown[] }) => unknown;
  /**
   * Lets go of an ephemeral node this process placed, by its id, wherever it
   * is now. The TS graph has no operation at an id (GRAPH.tex, Operations),
   * so this is the layer's own, given only for nodes the process placed: a
   * pin a driver moved into a grant that was revoked.
   */
  release: (op: { id: Id; cause?: Json }) => Changed;
};
export type Reads = Pick<Interface, "read" | "directory" | "lookup">;
/** What a handler is called with: whatever its caller passes. */
// deno-lint-ignore no-explicit-any
type Arg = any;

export type Compute = (r: {
  api: Reads;
  data: ValueItem[];
  changes: Change[];
  self: Id;
  pending: Pending;
}) => unknown;
export type Run = (value: unknown, t: Tools) => unknown;
export type Cleanup = (how: { killed: boolean; api: Api }) => void;

export type Tools = {
  api: Api;
  compute(name: string, compute: Compute, opts?: { data?: Json }): Made;
  effect(name: string, compute: Compute, run: Run, opts?: { data?: Json }): Made;
  handler(name: string, f: (h: { api: Api; caller: Agent }, ...args: Arg[]) => unknown): (...args: unknown[]) => unknown;
  onCleanup(f: Cleanup): void;
  self: Id;
};
export type Setup = (p: Tools & { data: ValueItem[]; name: string; cwd: readonly string[] }) => unknown;

// --- what the layer keeps

type Owner = { cleanups: Cleanup[]; kids: Map<string, Reader>; seen?: Set<string> };

type Reader = Owner & {
  kind: "compute" | "effect";
  proc: Proc;
  name: string;
  /** its id, the reader the graph tracks */
  id: Id;
  /** its node's id, and the names of it from the root */
  node: Id;
  at: string[];
  maker: Owner;
  compute: Compute;
  run?: Run;
  data?: Json;
  height: number;
  order: number;
  runs: number;
  computes: number;
  last?: unknown;
  runDue: boolean;
  /** what its run started from: the readers whose changes led to it this settle, itself included */
  taint?: Set<Id>;
  /** a loop it closed, parked: the value one more lap gave, who closed it, and when */
  parked?: { value: unknown; by: string[]; kept: number[] };
  gone: boolean;
};

type Handler = {
  name: string;
  node: Id;
  /** the process it belongs to; none for the host's own */
  proc?: Proc;
  of: string;
  f: (h: { api: Api; caller: Agent }, ...args: Arg[]) => unknown;
};

type Code = { source: string; node?: Id; time?: number; setup: Setup };

type Proc = Owner & {
  pid: string;
  /** the order it was started in */
  seq: number;
  /** its "." from the root: the directory it was started in; and how many names of it its "/" hides */
  place: string[];
  chroot: number;
  name: string;
  actor: Json;
  parent?: string;
  program: string | Setup;
  code?: Code;
  /** new code its program reached, shown and not run until replaced */
  next?: Code;
  setups: number;
  state: "starting" | "running" | "failed" | "pending";
  error?: string;
  failures: { [reader: string]: string };
  /** loops its readers closed, parked (WHAT-IS-A-PROCESS, decided 10-09) */
  loops: { [reader: string]: { by: string[]; kept: number[] } };
  handlers: Map<string, Handler>;
  handled?: Set<string>;
  /** the ephemeral nodes it placed, oldest first */
  owned: Id[];
  children: string[];
  follows?: Reader;
  value?: unknown;
  ended: boolean;
  replacing: boolean;
};

type Frame = { proc: Proc; owner: Owner; at: string[]; open: boolean };

export type StartOp = {
  /** the names of the directory it starts in, from the root: its "." */
  at: readonly string[];
  program: string | Setup;
  name?: string;
  data?: Json;
  actor?: Json;
  parent?: string;
  /** how many names of its "." its "/" hides: its chroot */
  chroot?: number;
  cause?: Json;
  /** the agent its nodes are placed as; the host's if not given */
  by?: Agent;
};

/** A change made elsewhere, as an operation at an id (GRAPH.tex, Operations, At an id). */
export type Arrival = { kind: "write" | "place" | "unplace" | "move"; at: Id; agent: Json; [field: string]: unknown };


export type Options = {
  /** the bare graph, for forgetting what a reader read */
  graph: Graph;
  /** the stack beneath this layer: protect over the bare graph */
  below: Interface;
  /**
   * The bare graph as it is kept, beneath protect: an ephemeral node is let
   * go by its id there, and a change made elsewhere is made there, at an id
   * (GRAPH.tex, Operations, At an id); once a wrapper is made over the stack,
   * through its bookkeeping instead (top).
   */
  kept: Bare;
  /** the clock: each change's time */
  clock: () => number;
  /** the host's agent, for its own changes */
  host: Agent;
  /** told of each id that went whose value was live, after its release */
  gone?: (id: Id, value: unknown) => void;
  /** told of what no process holds */
  log?: (text: string) => void;
};

export type Procs = {
  /** the interface every change goes through: the stack, with each answer noted */
  api: Interface & { readonly time: number; arrive(arrival: Arrival): Changed };
  /**
   * A wrapper (sync) made over the stack beneath this layer is the top, which
   * programs' interfaces are bound over from here; this layer's own
   * bookkeeping goes beneath it, through the wrapper's bookkeeping. Gives the
   * top with its changes stamped, as a program's are.
   */
  top(over: Interface, bookkeeping: Bare): Interface;
  start(op: StartOp): string;
  kill(pid: string, cause?: Json): void;
  /** runs setup with the new code the process's program reached */
  replace(pid: string): boolean;
  /** calls the handler an address from the root reaches, as caller */
  call(address: readonly string[], caller: Agent, args: unknown[]): unknown;
  /** a handler of the host's own, at address/on/name */
  hostHandler(address: readonly string[], name: string, f: Handler["f"]): void;
  /** runs what is due, at most budget runs; gives how many ran */
  settle(budget: number): number;
  due(): number;
  pids(): string[];
  /** the pid whose node or handler node that is */
  owner(id: Id): string | undefined;
  /** the program node of the process an agent's last step names, for protect */
  programOf(agent: Json): Id | undefined;
  live(): Map<Id, unknown>;
};

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
/** The node an item's address reached: the last step of its route, if it has one. */
const reached = (item: Item | undefined): Id | undefined =>
  item && "route" in item.from ? item.from.route.at(-1)?.node : undefined;
const snapshot = (value: unknown) => [{ type: "snapshot" as const, value: value as Json }];
const abs = (names: readonly string[]) => ["/", ...names];
const CONSONANTS = "bdfgjklmnprstvz";
const VOWELS = "aiou";

/** A program's setup from its source: the default export of a module with no imports. */
export function compile(source: string): Setup {
  const body = source.replace(/\bexport\s+default\s+/, "return ");
  const made = new Function(body)();
  if (typeof made !== "function") throw new TypeError("a program's default export is its setup");
  return made as Setup;
}

/** The names from the root an address reaches from a place, under a chroot. */
export function resolve(place: readonly string[], chroot: number, address: Address): string[] {
  const names = address[0] === "/" ? place.slice(0, chroot) : [...place];
  for (const n of address[0] === "/" ? address.slice(1) : address) {
    if (n === "..") {
      if (names.length <= chroot) throw invalid("above-root", "the address goes above the root");
      names.pop();
    } else names.push(n);
  }
  return names;
}

export function procs(o: Options): Procs {
  const { graph: g, below, clock } = o;
  let bare = o.kept;
  let serial = 0;
  let order = 0;
  let pids = 0;
  /** each reader marked since it last ran, with the changes that marked it */
  const marks = new Map<Id, Change[]>();
  const readers = new Map<Id, Reader>();
  const byNode = new Map<Id, Reader>();
  const all = new Map<string, Proc>();
  const handlers = new Map<Id, Handler>();
  const live = new Map<Id, unknown>();

  // --- every change passes here

  /** the time of the last change stamped here */
  let last = 0;
  const stamp = <T extends object>(op: T): T & { time: number } => {
    let out = ("time" in op && typeof op.time === "number" ? op : { ...op, time: clock() }) as T & { time: number };
    // a change from no process says where it was made (GRAPH.tex, Changes)
    if (!("process" in out && out.process !== undefined) && !("site" in out && out.site !== undefined)) {
      out = { ...out, site: capture() ?? { file: "experimental_os/typescript/procs.ts", line: 0 } };
    }
    last = Math.max(last, out.time);
    return out;
  };

  /** what the run under way started from (a set of readers), and each change of this settle's, by its time */
  let running: Set<Id> | null = null;
  const taints = new Map<number, Set<Id>>();
  /** the members of loops found this settle that are parked as they come round */
  const parkNext = new Set<Id>();

  function noted(answer: Changed): Changed {
    {
      const { change, marked } = answer;
      if (change.kind === "place" && change.value !== undefined && isLive(change.value)) {
        live.set(change.id, change.value);
      }
      // where it came from, this settle: the readers whose runs led to it
      if (running) taints.set(change.time, running);
      const taint = running;
      for (const reader of marked) {
        if (reader === change.process) continue;
        if (!readers.has(reader) && !all.has(reader)) continue;
        const r = readers.get(reader);
        if (r?.parked) {
          // a parked loop waits for a change from outside it
          if (taint?.has(reader)) continue;
          r.parked = undefined;
          // it runs at the next change, whatever it gives: what it last held was before the loop
          r.last = undefined;
          delete r.proc.loops[reader];
          writeStatus(r.proc);
        }
        const kept = marks.get(reader);
        if (kept) kept.push(change);
        else marks.set(reader, [change]);
      }
    }
    if (answer.gone?.length) letGo(answer.gone);
    return answer;
  }

  /** an interface with every change made through it stamped, and each answer noted */
  const noting = (b: Interface): Interface => ({
    ...b,
    write: (op) => noted(b.write(stamp(op))),
    place: (op) => noted(b.place(stamp(op))),
    unplace: (op) => noted(b.unplace(stamp(op))),
    move: (op) => noted(b.move(stamp(op))),
  });
  const api: Procs["api"] = {
    ...noting(below),
    arrive: ({ kind, at, time: _, ...op }) => noted(bare[kind](stamp({ address: [], ...op, at }) as never)),
    get time() {
      return last;
    },
  };
  /** the top of the stack, which programs' interfaces are bound over; this layer's own until a wrapper is made over the stack beneath it */
  let up: Interface = api;
  let topped = false;

  /** an ephemeral node let go by its id, wherever it is (GRAPH.tex: an unplace given only at) */
  const release = ({ id, ...op }: { id: Id; agent: Json; cause?: Json; process?: Id }) => noted(bare.unplace(stamp({ ...op, at: id })));

  /** The ids an answer let go: live things released, readers and processes ended. */
  function letGo(ids: readonly Id[]) {
    for (const id of ids) {
      if (live.has(id)) {
        const value = live.get(id);
        live.delete(id);
        try {
          (value as { release?: () => void }).release?.();
        } catch (e) {
          o.log?.(`releasing ${id}: ${message(e)}`);
        }
        o.gone?.(id, value);
      }
      const r = byNode.get(id);
      if (r && !r.gone) end(r, false);
    }
    for (const id of ids) {
      const p = all.get(id);
      if (p && !p.ended) finish(p);
    }
  }

  // --- interfaces

  /**
   * A view of the stack as story at the process's place (GRAPH.tex, An
   * interface fixes its agent and its place), its reads tracked for reader if
   * given, which stops working when its run ends; values: the nodes whose
   * values it read.
   */
  type Bound = Interface & { end(): void; values: Set<Id> };
  const bind = (p: Proc, story: Agent, process: Id, writes: boolean, reader?: Id): Bound => {
    const v = view(up, { agent: story as Json, process, ...(reader !== undefined ? { reader } : {}), place: p.place, chroot: p.chroot, writes });
    let open = true;
    const values = new Set<Id>();
    const guard = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => {
      if (!open) throw invalid("stopped", "this interface has stopped working: setup or this run has returned");
      return f(...a);
    };
    return {
      read: guard((op) => {
        const items = v.read(op);
        for (const i of items) if ("value" in i) values.add(i.from.route.at(-1)?.node ?? "");
        return items;
      }),
      directory: guard((op) => v.directory(op)),
      lookup: guard((op) => v.lookup(op)),
      lookups: guard((op) => v.lookups(op)),
      write: guard((op) => v.write(op)),
      place: guard((op) => v.place(op)),
      unplace: guard((op) => v.unplace(op)),
      move: guard((op) => v.move(op)),
      subscribe: guard((op) => v.subscribe(op)),
      take: guard((op) => v.take(op)),
      unsubscribe: guard((op) => v.unsubscribe(op)),
      cwd: guard((op) => v.cwd(op)),
      end: () => (open = false),
      values,
    };
  };

  /** The program's interface over a bound one: ids filled in, ephemeral placements owned, start, call, release. */
  function wrap(p: Proc, b: Interface, story: Agent): Api {
    return {
      read: (op) => b.read(op),
      directory: (op) => b.directory(op),
      lookup: (op) => b.lookup(op),
      write: (op) => b.write(op),
      unplace: (op) => b.unplace(op),
      place(op) {
        // a node made by name is given an id here, unless the top gives it (a document: SYNC.tex, Making and mounting)
        const id = op.id ?? (topped && !op.ephemeral ? undefined : `${p.pid}.${++serial}`);
        const answer = b.place({ ...op, id } as PlaceOp);
        if (op.ephemeral) p.owned.push(id!);
        return answer;
      },
      start(op) {
        return start({
          at: resolve(p.place, p.chroot, op.address),
          program: op.program,
          name: op.name,
          data: op.data,
          actor: story.actor,
          parent: p.pid,
          chroot: p.chroot,
          by: story,
        });
      },
      call(op) {
        const items = b.read({ address: op.address });
        const node = reached(items[0]);
        const h = node === undefined ? undefined : handlers.get(node);
        if (!h) throw invalid("not-a-handler", `${op.address.join("/")} reaches no handler`);
        return invoke(h, story, op.args ?? []);
      },
      release(op) {
        if (!p.owned.includes(op.id)) throw invalid("not-yours", `${p.pid} did not place ${op.id}`);
        p.owned = p.owned.filter((id) => id !== op.id);
        return release({ agent: story as Json, process: p.pid, id: op.id, ...(op.cause !== undefined ? { cause: op.cause } : {}) });
      },
    };
  }

  /** The layer's own story for a process, for what it does on the process's behalf. */
  const book = (p: Proc): Agent => ({ ...o.host, code: [{ process: p.pid }] });
  /** A step of a process's code: its pid, the program it runs as {node, time}, and what ran. */
  const step = (p: Proc, extra: { [k: string]: Json }): Json => {
    const s: { [k: string]: Json } = { process: p.pid };
    if (p.code?.node) s.program = { node: p.code.node, time: p.code.time ?? null };
    return { ...s, ...extra };
  };
  const nodeOf = (p: Proc) => [...p.place, p.name];

  // --- tools

  function tools(p: Proc, frame: Frame, a: Api): Tools {
    const open = () => {
      if (!frame.open) throw invalid("stopped", "setup or this run has returned");
    };
    return {
      api: a,
      self: p.pid,
      compute(name, fn, opts) {
        open();
        return make(frame, "compute", name, fn, undefined, opts?.data);
      },
      effect(name, fn, run, opts) {
        open();
        return make(frame, "effect", name, fn, run, opts?.data);
      },
      handler(name, f) {
        open();
        return handler(p, name, f);
      },
      onCleanup(f) {
        open();
        frame.owner.cleanups.push(f);
      },
    };
  }

  function named(name: unknown): string {
    if (typeof name !== "string" || ["", ".", ".."].includes(name) || name.includes("/")) {
      throw invalid("wrong-field", `${JSON.stringify(name)} is not a name`);
    }
    return name;
  }

  /** A compute or an effect: made again by name, kept, with its functions swapped; a new one runs. */
  function make(f: Frame, kind: Reader["kind"], rawName: string, fn: Compute, run?: Run, data?: Json): Made {
    const name = named(rawName);
    const p = f.proc;
    const owner = f.owner;
    if (owner.seen?.has(name)) throw invalid("twice", `${name} was made twice in one run`);
    owner.seen?.add(name);
    let r = owner.kids.get(name);
    if (r && r.kind === kind && !r.gone) {
      r.compute = fn;
      r.run = run;
      if (data !== undefined && !equal(data, r.data as Json)) {
        r.data = data;
        api.write({ agent: book(p) as Json, process: r.id, address: [...abs(r.at), "data"], patches: snapshot(data) });
      }
      // new code: a kept effect runs again
      if (p.replacing) {
        due(r.id);
        if (r.kind === "effect") r.runDue = true;
      }
      return { id: r.node, [READER]: r };
    }
    if (r) end(r, true);
    const at = [...f.at, name];
    const path = at.slice(nodeOf(p).length);
    r = {
      kind,
      proc: p,
      name,
      id: `${p.pid}/${path.join("/")}`,
      node: `${p.pid}.${path.join("/")}`,
      at,
      maker: owner,
      compute: fn,
      run,
      data,
      height: 0,
      order: ++order,
      runs: 0,
      computes: 0,
      runDue: false,
      gone: false,
      cleanups: [],
      kids: new Map(),
    };
    owner.kids.set(name, r);
    readers.set(r.id, r);
    byNode.set(r.node, r);
    const place = (address: string[], name: string, id: Id, value: Json) =>
      api.place({ agent: book(p) as Json, process: p.pid, address, name, id, value, ephemeral: true });
    place(abs(f.at), name, r.node, null);
    if (data !== undefined) place(abs(at), "data", `${r.node}/data`, data);
    due(r.id);
    return { id: r.node, [READER]: r };
  }

  function due(id: Id) {
    if (!marks.has(id)) marks.set(id, []);
  }

  function handler(p: Proc, rawName: string, fn: Handler["f"]) {
    const name = named(rawName);
    let h = p.handlers.get(name);
    if (h) h.f = fn;
    else {
      h = { name, node: `${p.pid}.on/${name}`, proc: p, of: p.pid, f: fn };
      api.place({
        agent: book(p) as Json,
        process: p.pid,
        address: ["/", "proc", p.pid, "on"],
        name,
        id: h.node,
        value: { handler: name },
        ephemeral: true,
      });
      p.handlers.set(name, h);
      handlers.set(h.node, h);
    }
    p.handled?.add(name);
    const it = h;
    // for the world: called from outside any process, the host is the caller
    return (...args: unknown[]) => {
      if (p.handlers.get(name) !== it || p.ended) throw invalid("stopped", `${p.pid} has no handler ${name} now`);
      return invoke(it, { ...o.host, code: [] }, args);
    };
  }

  /** Runs a handler as its caller: its changes name the caller, then the handler and the setup that made it. */
  function invoke(h: Handler, caller: Agent, args: unknown[]): unknown {
    const p = h.proc;
    const story: Agent = {
      ...caller,
      code: [...caller.code, p ? { handler: h.name, of: h.of, run: p.setups } : { handler: h.name, of: h.of }],
    };
    if (!p) return h.f({ api: hostApi(story, h.node), caller }, ...args);
    const b = bind(p, story, h.node, true);
    try {
      const out = h.f({ api: wrap(p, b, story), caller }, ...args);
      delete p.failures[`on/${h.name}`];
      return out;
    } catch (e) {
      p.failures[`on/${h.name}`] = message(e);
      throw e;
    } finally {
      b.end();
    }
  }

  /** An interface for a host handler: absolute addresses, unbound. */
  function hostApi(story: Agent, process: Id): Api {
    const fix = <T>(op: T) => ({ ...op, agent: story as Json, process });
    return {
      read: (op) => api.read(fix(op)),
      directory: (op) => api.directory(fix(op)),
      lookup: (op) => api.lookup(fix(op)),
      write: (op) => api.write(fix(op)),
      unplace: (op) => api.unplace(fix(op)),
      place: (op) => api.place(fix({ ...op, id: op.id ?? `host.${++serial}` }) as PlaceOp),
      release: (op) => release(fix(op)),
      start: (op) => start({ at: resolve([], 0, op.address), program: op.program, name: op.name, data: op.data, by: story }),
      call: (op) => call(resolve([], 0, op.address), story, op.args ?? []),
    };
  }

  // --- running

  function runCleanups(p: Proc, owner: Owner, killed: boolean) {
    const fns = owner.cleanups.splice(0).reverse();
    if (!fns.length) return;
    const story: Agent = { actor: p.actor, code: [step(p, { cleanup: true })] };
    const b = bind(p, story, p.pid, true);
    try {
      for (const fn of fns) {
        try {
          fn({ killed, api: wrap(p, b, story) });
        } catch (e) {
          p.failures.cleanup = message(e);
        }
      }
    } finally {
      b.end();
    }
  }

  /** A compute or an effect goes: what it made, its node unless its maker's went, its cleanups, its reads. */
  function end(r: Reader, unplace: boolean) {
    if (r.gone) return;
    r.gone = true;
    for (const kid of [...r.kids.values()]) end(kid, false);
    if (unplace) {
      try {
        api.unplace({ agent: book(r.proc) as Json, process: r.proc.pid, address: abs(r.at.slice(0, -1)), name: r.name, id: r.node });
      } catch {
        // its maker's node went first
      }
    }
    runCleanups(r.proc, r, true);
    g.forget({ reader: r.id });
    marks.delete(r.id);
    readers.delete(r.id);
    byNode.delete(r.node);
    if (r.maker.kids.get(r.name) === r) r.maker.kids.delete(r.name);
    if (r.proc.follows === r) r.proc.follows = undefined;
  }

  /** The process's /proc node: what it runs, how it is, and new code if there is some. */
  function writeStatus(p: Proc) {
    if (p.ended) return;
    const status: { [k: string]: Json } = {
      node: "/" + nodeOf(p).join("/"),
      program: typeof p.program === "string" ? p.program : "(function)",
      actor: p.actor,
      state: p.state,
      setups: p.setups,
    };
    if (p.code?.node) status.code = { node: p.code.node, time: p.code.time ?? null };
    if (p.next) status.new = { node: p.next.node ?? null, time: p.next.time ?? null };
    if (p.parent) status.parent = p.parent;
    if (p.error) status.error = p.error;
    if (Object.keys(p.failures).length) status.failures = { ...p.failures };
    if (Object.keys(p.loops).length) status.loops = { ...p.loops };
    try {
      api.write({ agent: book(p) as Json, process: p.pid, address: ["/", "proc", p.pid], patches: snapshot(status) });
    } catch {
      // its /proc node is gone
    }
  }

  /** The process's value, at its node, when it differs. */
  function writeValue(p: Proc, value: unknown) {
    if (p.ended || value === undefined || value === pending) return;
    if (p.value === value) return;
    if (p.value !== undefined && !isLive(value) && !isLive(p.value) && equal(p.value as Json, value as Json)) return;
    p.value = value;
    api.write({
      agent: { actor: p.actor, code: [step(p, { value: true })] } as Json,
      process: p.pid,
      address: abs(nodeOf(p)),
      patches: snapshot(value),
    });
  }

  /** Loading: the program found by tracked reads, so new code marks it. The first code runs; later code waits. */
  function load(p: Proc) {
    marks.delete(p.pid);
    if (typeof p.program === "function") {
      if (!p.code) {
        p.code = { source: "(function)", setup: p.program };
        setup(p);
      }
      return;
    }
    // the reads that find it are tracked for the process, so new code marks it
    g.forget({ reader: p.pid });
    const b = bind(p, book(p), p.pid, false, p.pid);
    let item: ValueItem | undefined;
    try {
      const parts = p.program.split("/").filter((n) => n);
      let items: ValueItem[] = [];
      if (p.program.startsWith("/")) items = b.read({ address: ["/", ...parts] }) as ValueItem[];
      else {
        const found = b.lookup({ name: parts[0] });
        const first = found.find((i) => "id" in i && !i.pending) as { from: { path: string[] } } | undefined;
        if (first) items = b.read({ address: [...first.from.path, ...parts.slice(1)] }) as ValueItem[];
      }
      item = items.find((i) => "value" in i);
    } finally {
      b.end();
    }
    const source = item?.value;
    if (typeof source !== "string") {
      if (!p.code) {
        p.state = "pending";
        p.error = `no program at ${p.program}`;
        writeStatus(p);
      }
      return;
    }
    if (source === (p.next ?? p.code)?.source) return;
    let setupFn: Setup;
    try {
      setupFn = compile(source);
    } catch (e) {
      if (!p.code) {
        p.state = "failed";
        p.error = message(e);
      } else p.failures.new = `the new code does not compile: ${message(e)}`;
      writeStatus(p);
      return;
    }
    const code: Code = { source, node: item!.from.route.at(-1)?.node, time: item!.change?.time, setup: setupFn };
    if (!p.code) {
      p.code = code;
      setup(p);
      return;
    }
    if (source === p.code.source) {
      p.next = undefined;
    } else {
      // shown as new; replacing it is a choice
      p.next = code;
      delete p.failures.new;
    }
    writeStatus(p);
  }

  function replace(pid: string): boolean {
    const p = all.get(pid);
    if (!p?.next) return false;
    p.code = p.next;
    p.next = undefined;
    runCleanups(p, p, false);
    p.replacing = true;
    try {
      setup(p);
    } finally {
      p.replacing = false;
    }
    return true;
  }

  function setup(p: Proc) {
    p.setups++;
    p.error = undefined;
    const story: Agent = { actor: p.actor, code: [step(p, { setup: p.setups })] };
    const frame: Frame = { proc: p, owner: p, at: nodeOf(p), open: true };
    p.seen = new Set();
    p.handled = new Set();
    const b = bind(p, story, p.pid, true);
    let returned: unknown;
    try {
      let data: ValueItem[] = [];
      try {
        data = api.read({ agent: book(p) as Json, address: ["/", "proc", p.pid, "data"] }) as ValueItem[];
      } catch { /* none */ }
      returned = p.code!.setup({ ...tools(p, frame, wrap(p, b, story)), data, name: p.name, cwd: p.place.slice(p.chroot) });
      p.state = "running";
    } catch (e) {
      p.state = "failed";
      p.error = message(e);
    } finally {
      frame.open = false;
      b.end();
    }
    // what setup did not make again goes
    for (const [name, r] of [...p.kids]) if (!p.seen.has(name)) end(r, true);
    for (const [name, h] of [...p.handlers]) {
      if (p.handled.has(name)) continue;
      p.handlers.delete(name);
      handlers.delete(h.node);
      try {
        api.unplace({ agent: book(p) as Json, process: p.pid, address: ["/", "proc", p.pid, "on"], name, id: h.node });
      } catch { /* gone */ }
    }
    p.seen = undefined;
    p.handled = undefined;
    if (p.state === "running") {
      const m = returned as Made | undefined;
      if (m && typeof m === "object" && READER in m) {
        p.follows = m[READER];
        if (m[READER].computes > 0) writeValue(p, m[READER].last);
      } else {
        p.follows = undefined;
        if (returned !== undefined) writeValue(p, returned);
      }
    }
    writeStatus(p);
  }

  function compute(r: Reader) {
    const changes = marks.get(r.id) ?? [];
    marks.delete(r.id);
    const p = r.proc;
    r.computes++;
    // the readers whose runs led here, this settle; if it is among them, this is one more lap of a loop
    const taint = new Set<Id>([r.id]);
    let lap = false;
    for (const c of changes) {
      const t = taints.get(c.time);
      if (!t) continue;
      if (t.has(r.id)) lap = true;
      for (const id of t) taint.add(id);
    }
    r.taint = taint;
    running = taint;
    const story: Agent = { actor: p.actor, code: [step(p, { [r.kind]: r.at.slice(nodeOf(p).length).join("/"), run: r.computes })] };
    // what it read last time is dropped; what it reads now is tracked for it
    g.forget({ reader: r.id });
    const b = bind(p, story, r.id, false, r.id);
    let value: unknown;
    let failed: string | undefined;
    try {
      const data = r.data !== undefined ? b.read({ address: [...abs(r.at), "data"] }) as ValueItem[] : [];
      value = r.compute({ api: b, data, changes, self: r.node, pending });
    } catch (e) {
      failed = message(e);
    } finally {
      b.end();
    }
    const had = r.id in p.failures;
    if (failed) p.failures[r.id] = failed;
    else delete p.failures[r.id];
    // one more than the highest compute whose node it read
    let height = 0;
    for (const id of b.values) {
      const d = byNode.get(id);
      if (d && d !== r) height = Math.max(height, d.height + 1);
    }
    r.height = height;
    if (failed || had) writeStatus(p);
    if (failed || value === pending) return;
    if (value === undefined) value = null;
    const first = r.computes === 1 || r.last === undefined;
    const changed = first || (isLive(value) || isLive(r.last) ? r.last !== value : !equal(r.last as Json, value as Json));
    // an equal value: no write, and no run
    if (!changed) return;
    // one more lap would write a new value: the loop is parked, and shown, until a change from outside it.
    // Its newest member is parked, the process that joined it last, so a driver started at boot goes on;
    // when that is another reader, it is parked as it comes round
    let park = false
    if (lap || parkNext.has(r.id)) {
      const newest = [...taint].map((id) => readers.get(id)).filter((x): x is Reader => !!x && !x.gone)
        .reduce((a, b) => (b.proc.seq > a.proc.seq ? b : a), r)
      if (newest === r) {
        parkNext.delete(r.id)
        park = true
      } else parkNext.add(newest.id)
    }
    if (park) {
      const by = [...new Set(changes.filter((c) => taints.get(c.time)?.has(r.id)).map((c) => String(c.process ?? "host")))];
      r.parked = { value, by, kept: changes.map((c) => c.time) };
      p.loops[r.id] = { by, kept: r.parked.kept };
      writeStatus(p);
      return;
    }
    r.last = value;
    try {
      api.write({ agent: story as Json, process: r.id, address: abs(r.at), patches: snapshot(value) });
    } catch (e) {
      p.failures[r.id] = message(e);
    }
    if (p.follows === r) writeValue(p, value);
    if (r.kind === "effect") r.runDue = true;
  }

  function runEffect(r: Reader) {
    r.runDue = false;
    running = new Set([...(r.taint ?? []), r.id]);
    const p = r.proc;
    r.runs++;
    runCleanups(p, r, false);
    const story: Agent = { actor: p.actor, code: [step(p, { effect: r.at.slice(nodeOf(p).length).join("/"), run: r.runs })] };
    const frame: Frame = { proc: p, owner: r, at: r.at, open: true };
    r.seen = new Set();
    const b = bind(p, story, p.pid, true);
    const key = `${r.id} run`;
    const had = key in p.failures;
    try {
      r.run!(r.last, tools(p, frame, wrap(p, b, story)));
      delete p.failures[key];
    } catch (e) {
      p.failures[key] = message(e);
    } finally {
      frame.open = false;
      b.end();
    }
    for (const [name, kid] of [...r.kids]) if (!r.seen.has(name)) end(kid, true);
    r.seen = undefined;
    if (had || p.failures[key]) writeStatus(p);
  }

  function settle(budget: number): number {
    let n = 0;
    taints.clear();
    parkNext.clear();
    while (n < budget) {
      let pick: (() => void) | undefined;
      // loads first
      for (const id of marks.keys()) {
        const p = all.get(id);
        if (p && !p.ended) {
          pick = () => load(p);
          break;
        }
      }
      if (!pick) {
        let best: Reader | undefined;
        const rank = (x: Reader) => (x.kind === "compute" ? 0 : 1e12) + x.height * 1e6 + x.order;
        for (const id of [...marks.keys()]) {
          const r = readers.get(id);
          if (!r || r.gone) {
            marks.delete(id);
            continue;
          }
          if (!best || rank(r) < rank(best)) best = r;
        }
        if (best) pick = () => compute(best!);
      }
      if (!pick) {
        let best: Reader | undefined;
        for (const r of readers.values()) {
          if (r.runDue && !r.gone && (!best || r.order < best.order)) best = r;
        }
        if (best) pick = () => runEffect(best!);
      }
      if (!pick) break;
      n++;
      try {
        pick();
      } finally {
        running = null;
      }
    }
    return n;
  }

  // --- starting and ending

  function word(): string {
    let w = "";
    for (let i = 0; i < 5; i++) {
      const set = i % 2 ? VOWELS : CONSONANTS;
      w += set[Math.floor(Math.random() * set.length)];
    }
    return w;
  }

  function start(op: StartOp): string {
    const pid = `@${++pids}-${word()}`;
    const name = named(op.name ?? pid);
    const p: Proc = {
      pid,
      seq: pids,
      place: [...op.at],
      chroot: Math.min(op.chroot ?? 0, op.at.length),
      name,
      actor: op.actor ?? o.host.actor,
      parent: op.parent,
      program: op.program,
      setups: 0,
      state: "starting",
      failures: {},
      loops: {},
      handlers: new Map(),
      owned: [],
      children: [],
      ended: false,
      replacing: false,
      cleanups: [],
      kids: new Map(),
    };
    const by = (op.by ?? o.host) as Json;
    api.place({
      agent: by,
      address: abs(op.at),
      name,
      id: pid,
      value: null,
      ephemeral: true,
      ...(op.cause !== undefined ? { cause: op.cause } : {}),
    });
    all.set(pid, p);
    const sys = (address: string[], name: string, id: Id, value: Json) =>
      api.place({ agent: by, process: pid, address, name, id, value, ephemeral: true });
    sys(["/", "proc"], pid, `${pid}.proc`, null);
    sys(["/", "proc", pid], "program", `${pid}.program`, typeof op.program === "string" ? op.program : "(function)");
    sys(["/", "proc", pid], "data", `${pid}.data`, op.data ?? null);
    sys(["/", "proc", pid], "on", `${pid}.on`, null);
    if (op.parent) all.get(op.parent)?.children.push(pid);
    writeStatus(p);
    due(pid);
    return pid;
  }

  const unplaceNode = (p: Proc, cause?: Json) =>
    api.unplace({ agent: o.host as Json, address: abs(p.place), name: p.name, id: p.pid, ...(cause !== undefined ? { cause } : {}) });

  function kill(pid: string, cause?: Json) {
    const p = all.get(pid);
    if (!p || p.ended) return;
    try {
      unplaceNode(p, cause);
    } catch {
      finish(p);
    }
  }

  /** A process whose node went: its children, the nodes it placed, its cleanups, its reads, its /proc. */
  function finish(p: Proc) {
    if (p.ended) return;
    p.ended = true;
    const by = { killed: p.pid, by: clock() };
    for (const child of [...p.children].reverse()) {
      const c = all.get(child);
      if (!c || c.ended) continue;
      try {
        unplaceNode(c, by);
      } catch {
        finish(c);
      }
    }
    for (const id of [...p.owned].reverse()) {
      try {
        release({ agent: book(p) as Json, id, cause: by });
      } catch {
        // gone already
      }
    }
    for (const r of [...p.kids.values()]) end(r, false);
    runCleanups(p, p, true);
    g.forget({ reader: p.pid });
    marks.delete(p.pid);
    for (const h of p.handlers.values()) handlers.delete(h.node);
    try {
      release({ agent: book(p) as Json, id: `${p.pid}.proc`, cause: by });
    } catch {
      // gone already
    }
    all.delete(p.pid);
    if (p.parent) {
      const parent = all.get(p.parent);
      if (parent) parent.children = parent.children.filter((c) => c !== p.pid);
    }
  }

  function call(address: readonly string[], caller: Agent, args: unknown[]): unknown {
    const items = api.read({ agent: caller as Json, address: abs(address) });
    const node = reached(items[0]);
    const h = node === undefined ? undefined : handlers.get(node);
    if (!h) throw invalid("not-a-handler", `/${address.join("/")} reaches no handler`);
    return invoke(h, caller, args);
  }

  return {
    api,
    top(over, bookkeeping) {
      up = noting(over);
      Object.assign(api, noting({ ...below, ...bookkeeping }));
      bare = bookkeeping;
      topped = true;
      return up;
    },
    start,
    kill,
    replace,
    call,
    hostHandler(address, rawName, f) {
      const name = named(rawName);
      const base = `host.${address.join("/")}`;
      const on = api.directory({ agent: o.host as Json, address: abs(address), name: "on" });
      if (!("items" in on) || !on.items.length) {
        api.place({ agent: o.host as Json, address: abs(address), name: "on", id: `${base}.on`, value: null, ephemeral: true });
      }
      const node = `${base}.on/${name}`;
      api.place({ agent: o.host as Json, address: [...abs(address), "on"], name, id: node, value: { handler: name }, ephemeral: true });
      handlers.set(node, { name, node, of: "host", f });
    },
    settle,
    due: () => marks.size + [...readers.values()].filter((r) => r.runDue).length,
    pids: () => [...all.keys()],
    owner(id) {
      if (all.has(id)) return id;
      return handlers.get(id)?.proc?.pid;
    },
    programOf(agent) {
      const code = (agent as { code?: Json[] } | null)?.code;
      const last = Array.isArray(code) ? code[code.length - 1] as { process?: string; of?: string } : undefined;
      const pid = last?.process ?? last?.of;
      return pid ? all.get(pid)?.code?.node : undefined;
    },
    live: () => live,
  };
}
