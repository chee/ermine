// The reference scheduler (SCHEDULER.tex), "schedule". It keeps the clock,
// starts processes, and runs what the graph marks, in rounds: computes first,
// lowest height first, then effects. A process is a node placed by start; it
// runs the program found by searching up from its place, through the loader
// found the same way (LOADERS.tex), and keeps both for as long as it runs.
//
// Its bookkeeping is beneath the wrappers: it reads, subscribes, records,
// writes items and unplaces at a kill through the bare graph it is given.
// What it does on a process's behalf goes from the top of the stack, so
// protect decides it as it would anything else.

import { parseAddress, type Parsed } from "./address.ts";
import { byCodePoint, equal, isObject, ownField } from "./patch.ts";
import { acting, fields } from "./graph.ts";
import {
  type Acts,
  errorJson,
  type Handler,
  type Identity,
  type Loaded,
  type Loader,
  PENDING,
  type Program,
  type Running,
  type StartOp,
  Thrown,
} from "./loaders.ts";
import {
  type Acting,
  type Address,
  type Bound,
  type Change,
  type Changed,
  type DirectoryOp,
  ErmineError,
  type ErrorJson,
  type Event,
  type Id,
  type Interface,
  invalid,
  type Json,
  type Listing,
  type Lookup,
  type LookupOp,
  type Made,
  type Marked,
  missing,
  ours,
  type PlaceOp,
  type ReadEntry,
  type ReadOp,
  type Record,
  type Recording,
  Refused,
  type RefusedItem,
  type Route,
  type Searched,
  type SlotItem,
  type SubscribeOp,
  told,
  type UnplaceOp,
  type UnsubscribeOp,
  type ValueItem,
  type WriteOp,
  wrongField,
} from "./types.ts";

ours(import.meta.url);

/** A process the request killed: its cleanup's changes, its ephemeral nodes' unplacements, what went. */
export type Stop = { process: Id; changes: Change[]; errors: ErrorJson[]; gone?: Id[] };

/** What the scheduler did before answering: the records it finished, in order, and what it killed. */
export type Settled = { runs: Record[]; stopped: Stop[] };

/** A change made from outside, and what ran before it answered. */
export type Scheduled = Changed & Settled;

/** A handler call's log: a record without run, marked, value or cleanup. */
export type HandlerRecord = {
  process: Id;
  agent: Json;
  program: Identity;
  lookups: Lookup[];
  reads: ReadEntry[];
  changes: number[];
  ending: "done" | "failed" | "refused";
  errors: ErrorJson[];
};

export type FireOp = Acting & { process: Id; handler: string; input?: Json };

/** A handler call: its record, its changes, what ran after, and the error that ended it, if one did. */
export type Fired = Settled & { handler: HandlerRecord; changes: Change[]; error?: ErrorJson };

/** An item a scheduler puts in front of a process's value. */
export type ProcessItem =
  | { waiting: number[]; from: { process: Id } }
  | { stopped: true; from: { process: Id } }
  | { error: ErrorJson; from: { process: Id; run: number } }
  | { newer: Newer; from: { process: Id } };

/** What the program and loader searches would find now, where it is not what the process has. */
export type Newer = { program?: Identity | null; loader?: Identity | null };

export interface Scheduler extends Interface {
  write(op: WriteOp): Scheduled;
  place(op: PlaceOp): Scheduled;
  unplace(op: UnplaceOp): Scheduled;
  /** Starts the program at the path found from the node the address reaches; answers with its placement. */
  start(op: StartOp): Scheduled;
  /** Does fn; what its operations mark runs once, after the last. */
  batch(fn: () => void): Settled;
  /** Calls a process's handler as the world would, as the agent's actor, then runs what it marked. */
  fire(op: FireOp): Fired;
  /**
   * Drops everything the scheduler holds but its clock, as a host that
   * starts again would; for after the graph is loaded again (reload).
   */
  restart(): void;
  /** The time of the last change it stamped. */
  readonly time: number;
}

export type Options = {
  /**
   * The bare graph beneath the wrappers, for the scheduler's bookkeeping,
   * which the host that builds the stack trusts it with. The interface it
   * wraps if not given. Letting a killed process's ephemeral nodes go needs
   * its release.
   */
  graph?: Interface;
  /** The most runs one request may cause; 100000 if not given. */
  budget?: number;
  /** The last time already in the graph, so the clock goes on from there. */
  time?: number;
};

type Agent = { actor: Json; code: Json[] };
type Step = { [key: string]: Json };

/** A run whose compute returned a value, waiting for its turn to be finished. */
type Open = {
  p: Proc;
  rec: Recording;
  n: number;
  agent: Agent;
  given: Change[];
  value: Json;
};

/** Where a process's lasting interface is being used for the scheduler: a handler call or a cleanup. */
type Context = { agent: Agent; log: Log; kill?: true };

/** What a handler call or a cleanup did through the lasting interface. */
type Log = {
  lookups: Lookup[];
  reads: ReadEntry[];
  changes: Change[];
  errors: ErrorJson[];
  /** errors already in errors, so one that ends the call is not listed twice */
  seen: WeakSet<object>;
};

type Proc = {
  id: Id;
  /** names from the root to the node it was placed into; the first chroot are hidden */
  place: string[];
  chroot: number;
  cwd: string[];
  parentNode: Id;
  parent?: Proc;
  children: Proc[];
  actor: Json;
  /** its agent's code before its own step */
  prefix: Json[];
  program: Identity;
  code: Program;
  path: Parsed;
  loader: Loader;
  loaderId: Identity;
  height: number;
  runs: number;
  kept: Change[];
  computing: boolean;
  /** how many of its own parts or handler calls are running */
  busy: number;
  pendingLast: boolean;
  values: ReadonlySet<Id>;
  nodes: ReadonlySet<Id>;
  hasPrevious: boolean;
  previous?: Json;
  cleanup?: () => unknown;
  handlers: Map<string, Handler>;
  context?: Context;
  /** the ephemeral nodes it made, in the order made */
  ephemerals: Id[];
  error?: { error: ErrorJson; run: number };
  newer?: Newer;
  state: "running" | "killing" | "stopped" | "gone";
  open?: Open;
  /** its subscriptions beneath: to its address, then to its searches */
  address?: number;
  watching: number[];
  info: Running;
  /** the process node's own address, from the start of its place, for the scheduler's bookkeeping */
  self: Acting & { address: Address };
};

/** Marks an operation as a start made through an interface whose place is the only way in. */
const START = Symbol("start");
/** Marks a start's own placement, with its time. */
const STARTING = Symbol("starting");

/** A request reached the budget. Not an error a program can catch. */
class Budget {}

const CONSONANTS = "bcdfghjklmnpqrstvwxz";
const VOWELS = "aeiou";

/** The pid of a start at time t, its letters those of k (PROTOCOL.tex, Pids). */
export function pidOf(t: number, k = t): Id {
  let n = k;
  let letters = "";
  for (let i = 0; i < 5; i++) {
    const set = i % 2 === 0 ? CONSONANTS : VOWELS;
    letters += set[n % set.length];
    n = Math.floor(n / set.length);
  }
  return `@${t}-${letters}`;
}

const isAgent = (agent: Json): agent is Agent =>
  isObject(agent) && Object.hasOwn(agent, "actor") && Array.isArray(agent.code);

/** The actor of an agent: an agent not of the scheduler's shape is the actor. */
export function actorOf(agent: Json): Json {
  return isAgent(agent) ? agent.actor : agent;
}

/** The names from the graph's root an address reaches, from a place: "/" its start, ".." back. */
function absolute(place: readonly string[], chroot: number, parsed: Parsed): string[] {
  const base = parsed.root ? place.slice(0, chroot) : place.slice(0, place.length - parsed.up);
  return [...base, ...parsed.names];
}

const ups = (k: number): string[] => Array.from({ length: k }, () => "..");

export function schedule(
  api: Interface,
  loaders: { readonly [name: string]: Loader },
  options: Options = {},
): Scheduler {
  const below = api;
  const graph = options.graph ?? api;
  const budget = options.budget ?? 100000;
  let clock = options.time ?? 0;
  let up: Interface;

  const procs = new Map<Id, Proc>();
  /** pids of processes killed and gone, so fire on one is stopped */
  const killed = new Set<Id>();
  /** the due list: each process with the time of its first mark */
  const due = new Map<Id, number>();
  /**
   * ephemeral nodes made through the scheduler that have not gone, each with
   * the process that made it: a gone node's id may be made again, by another
   */
  const ephemeral = new Map<Id, Proc>();
  /** kills waiting for their process's part to return, or for the change that made them to end */
  const kills: { p: Proc; by: Change }[] = [];
  const rechecks = new Set<Proc>();
  /** subscriptions made through the scheduler, to send them handler records */
  const subs = new Map<number, { op: Acting & { address: Address }; send: (e: Event) => void }>();
  /** the changes of the request in progress, by time, for heights */
  const recent = new Map<number, Change>();

  let depth = 0;
  let req: Settled & { count: number } | undefined;
  let draining = false;
  let roundOpen: Open[] = [];
  let inRound = false;

  // bookkeeping beneath the wrappers

  /** The node an operation's address reaches, beneath the wrappers; undefined if none. */
  function reach(op: Acting & { address: Address }): Id | undefined {
    try {
      return graph.reach?.(op).node;
    } catch {
      return undefined;
    }
  }

  function agentOf(p: Proc, step: Step): Agent {
    return { actor: p.actor, code: [...p.prefix, { process: p.id, program: p.program, ...step }] };
  }

  function bindAs(p: Proc, agent: Agent, reads = true, writes = true): Bound {
    return graph.bind(up, {
      agent,
      process: p.id,
      place: p.place,
      chroot: p.chroot,
      reads,
      writes,
    });
  }

  /** Takes in what an operation made: the clock, what went, and every process it marked. */
  function note(answer: Changed) {
    const made: readonly Made[] = answer.made ?? [{ change: answer.change, marked: [] }];
    for (const m of made) {
      if (m.change.time > clock) clock = m.change.time;
      recent.set(m.change.time, m.change);
    }
    for (const id of answer.gone ?? []) ephemeral.delete(id);
    for (const m of made) {
      for (const pid of m.marked) {
        const p = procs.get(pid);
        if (!p || p.state !== "running") continue;
        if (!p.kept.some((c) => c.time === m.change.time)) p.kept.push(m.change);
        if (!due.has(pid)) due.set(pid, m.change.time);
      }
    }
  }

  /** The scheduler's own write: an empty list of patches to the process node, for an item. */
  function item(p: Proc, k: "stopped" | "error" | "newer") {
    const at = { ...p.self, agent: agentOf(p, { item: k }), process: p.id };
    if (reach(at) !== p.id) return;
    try {
      note(graph.write({ ...at, patches: [], time: clock + 1 }));
    } catch (e) {
      if (!(e instanceof ErmineError)) throw e;
    }
  }

  /** The items in front of a process's value, in order. */
  function itemsOf(p: Proc): ProcessItem[] {
    const from = { process: p.id };
    const out: ProcessItem[] = [];
    if (p.state === "stopped") return [{ stopped: true, from }];
    if (p.state !== "running") return out;
    if (due.has(p.id) || p.computing || p.pendingLast) {
      out.push({ waiting: p.kept.map((c) => c.time), from });
    }
    if (p.error) out.push({ error: p.error.error, from: { process: p.id, run: p.error.run } });
    if (p.newer) out.push({ newer: p.newer, from });
    return out;
  }

  /** A read's items, each process's own in front of its value. */
  function dress(op: ReadOp, items: ValueItem[]): ValueItem[] {
    const out: unknown[] = [];
    for (const it of items) {
      const route = it.from?.route ?? [];
      const node = route.length ? route[route.length - 1].node : reach(op);
      const p = node === undefined ? undefined : procs.get(node);
      if (p) out.push(...itemsOf(p));
      out.push(it);
    }
    return out as ValueItem[];
  }

  // searching

  type Found = { node: Id; time: number; value: Json };

  /** The addresses a search of a path tries, nearest first. */
  function tries(path: Parsed, levels: number): Address[] {
    if (path.root) return [["/", ...path.names]];
    return Array.from({ length: levels + 1 }, (_, k) => [...ups(k), ...path.names]);
  }

  /** The first address from which the path reaches a node that is here; a refused read ends it. */
  function search(
    reader: Pick<Interface, "read">,
    path: Parsed,
    levels: number,
  ): Found | undefined {
    for (const address of tries(path, levels)) {
      let items: ValueItem[];
      try {
        items = reader.read({ address });
      } catch (e) {
        if (e instanceof Refused) return undefined;
        throw e;
      }
      const it = items.find((i) => Object.hasOwn(i, "value") && Array.isArray(i.from?.route));
      if (it) {
        const route = it.from.route;
        return { node: route[route.length - 1].node, time: it.change?.time ?? 0, value: it.value };
      }
    }
  }

  const same = (a: Found | undefined, b: Identity) =>
    a !== undefined && a.node === b.node && a.time === b.time;

  /** Whether the searches would find another program or loader now, and the newer item if so. */
  function recheck(p: Proc) {
    if (p.state !== "running") return;
    const at = { agent: agentOf(p, { item: "newer" }), place: p.place, chroot: p.chroot };
    const reader = { read: (op: ReadOp) => graph.read({ ...op, ...at }) };
    const levels = p.place.length - p.chroot;
    const program = search(reader, p.path, levels);
    const loader = search(reader, parseAddress(["loaders", p.code.kind]), levels);
    const newer: Newer = {};
    if (!same(program, p.program)) {
      newer.program = program ? { node: program.node, time: program.time } : null;
    }
    if (!same(loader, p.loaderId)) {
      newer.loader = loader ? { node: loader.node, time: loader.time } : null;
    }
    const next = Object.keys(newer).length ? newer : undefined;
    if (equal((next ?? null) as Json, (p.newer ?? null) as Json)) return;
    p.newer = next;
    item(p, "newer");
  }

  /** Runs the kills and the newer checks waiting, outside any graph operation. */
  function drain() {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const i = kills.findIndex((k) => k.p.busy === 0);
        if (i >= 0) {
          const [k] = kills.splice(i, 1);
          if (k.p.state === "running") kill(k.p, k.by, false);
          continue;
        }
        const next = rechecks.values().next();
        if (!next.done) {
          rechecks.delete(next.value);
          recheck(next.value);
          continue;
        }
        break;
      }
    } finally {
      draining = false;
    }
  }

  // killing

  /** A route change to a process's address: if it no longer reaches the process, it is killed. */
  function moved(p: Proc, change: Change, reaches: ValueItem[]) {
    const route = reaches[0]?.from.route ?? [];
    if (route[route.length - 1]?.node === p.id) return;
    if (p.state === "stopped") return forgetStopped(p);
    if (p.state === "running" && !kills.some((k) => k.p === p)) kills.push({ p, by: change });
  }

  /** A stopped process unplaced: nothing is left of it. */
  function forgetStopped(p: Proc) {
    unwatch(p, true);
    procs.delete(p.id);
    killed.add(p.id);
  }

  function unwatch(p: Proc, address: boolean) {
    const at = { agent: p.actor ?? null };
    for (const sub of p.watching) graph.unsubscribe({ ...at, sub });
    p.watching = [];
    if (address && p.address !== undefined) {
      graph.unsubscribe({ ...at, sub: p.address });
      p.address = undefined;
    }
  }

  /**
   * Kills a process: its children first, most recently started first, then
   * its cleanup; then each ephemeral node it made that is still here is
   * unplaced from its one slot, beneath the wrappers, most recently made
   * first, each as whoever made the change that killed it, and the graph forgets
   * it. A child killed with its parent stays placed, stopped.
   */
  function kill(p: Proc, by: Change, child: boolean) {
    p.state = "killing";
    due.delete(p.id);
    for (let i = kills.length - 1; i >= 0; i--) if (kills[i].p === p) kills.splice(i, 1);
    for (const c of [...p.children].reverse()) if (c.state === "running") kill(c, by, true);
    const changes: Change[] = [];
    const errors: ErrorJson[] = [];
    if (p.cleanup) {
      const log = cleanup(p, agentOf(p, { cleanup: true }), true);
      changes.push(...log.changes);
      errors.push(...log.errors);
    }
    p.state = child ? "stopped" : "gone";
    p.handlers.clear();
    p.context = undefined;
    const gone: Id[] = [];
    const cause = { killed: p.id, by: by.time };
    const at = { agent: by.agent, ...(by.process === undefined ? {} : { process: by.process }) };
    // each from its one slot, by its id: no address, so nothing above can keep it
    for (const id of [...p.ephemerals].reverse()) {
      if (ephemeral.get(id) !== p) continue;
      if (!graph.release) throw new Error("the scheduler needs the bare graph's release");
      const answer = graph.release({ ...at, id, cause, time: clock + 1 });
      note(answer);
      for (const m of answer.made ?? [{ change: answer.change }]) changes.push(m.change);
      gone.push(...answer.gone ?? []);
    }
    p.ephemerals = [];
    graph.forget({ agent: by.agent, id: p.id });
    try {
      p.loader.killed?.(p.info);
    } catch {
      // a loader's trouble does not stop a kill
    }
    if (child) {
      unwatch(p, false);
      p.error = undefined;
      p.newer = undefined;
      rechecks.delete(p);
    } else {
      unwatch(p, true);
      procs.delete(p.id);
      killed.add(p.id);
    }
    const stop: Stop = { process: p.id, changes, errors };
    if (gone.length) stop.gone = gone;
    req?.stopped.push(stop);
    if (child) item(p, "stopped");
  }

  // logs of the lasting interface

  function newLog(): Log {
    return { lookups: [], reads: [], changes: [], errors: [], seen: new WeakSet() };
  }

  /** The route a read took as far as it went, beneath the wrappers. */
  function routeOf(at: Acting, address: Address): Route {
    let parsed: Parsed;
    try {
      parsed = parseAddress(address);
    } catch {
      return [];
    }
    for (let k = parsed.names.length; k > 0; k--) {
      const prefix = [
        ...(parsed.root ? ["/"] : []),
        ...ups(parsed.up),
        ...parsed.names.slice(0, k),
      ];
      try {
        const items = graph.read({ ...at, address: prefix });
        if (items.length) return items[0].from.route;
      } catch {
        return [];
      }
    }
    return [];
  }

  const latest = (items: readonly { change?: { time: number } }[]): number | null => {
    let t: number | null = null;
    for (const i of items) {
      const time = i.change?.time;
      if (time !== undefined && (t === null || time > t)) t = time;
    }
    return t;
  };

  /** A lookup's search, as the graph would record it, rebuilt from what it gave. */
  function searched(at: Acting, name: string, found: (SlotItem | RefusedItem)[]): Searched[] {
    const levels = (at.place?.length ?? 0) - (at.chroot ?? 0);
    const last = found[found.length - 1];
    let end = levels;
    let refused = false;
    if (last && "refused" in last) {
      end = last.from.path.length;
      refused = true;
    } else if (last) end = (last.from as { path: Address }).path.length - 1;
    const out: Searched[] = [];
    for (let k = 0; k <= end; k++) {
      const node = reach({ ...at, address: ups(k) });
      if (node === undefined) continue;
      if (refused && k === end) {
        out.push({ node, refused: true });
        continue;
      }
      try {
        const listing = graph.directory({ ...at, address: ups(k), name }) as { items: SlotItem[] };
        out.push({ node, saw: latest(listing.items) });
      } catch {
        out.push({ node, saw: null });
      }
    }
    return out;
  }

  /** An operation through the lasting interface, logged into the call it is part of. */
  function logged(
    log: Log,
    at: Acting,
    op: string,
    args: { [key: string]: unknown },
    got: unknown,
  ) {
    switch (op) {
      case "read":
      case "directory": {
        const address = args.address as Address;
        const items =
          (Array.isArray(got)
            ? got
            : "items" in (got as Listing)
            ? (got as { items: SlotItem[] }).items
            : (got as { directory: [string, SlotItem[]][] }).directory.flatMap(([, i]) => i)) as {
              change?: { time: number };
            }[];
        const entry: ReadEntry = {
          op,
          address: [...address],
          route: routeOf(at, address),
          saw: latest(items),
        };
        if (op === "directory" && typeof args.name === "string") entry.name = args.name;
        log.reads.push(entry);
        return;
      }
      case "lookup": {
        const found = got as (SlotItem | RefusedItem)[];
        log.lookups.push({
          name: args.name as string,
          searched: searched(at, args.name as string, found),
          found: found.flatMap((i) => "id" in i ? [i.id] : []),
        });
        return;
      }
      case "write":
      case "place":
      case "unplace":
      case "start":
        log.changes.push((got as Changed).change);
    }
  }

  /** A refused read, logged as the graph would record it. */
  function refusedRead(log: Log, at: Acting, op: string, args: { [key: string]: unknown }) {
    if (op !== "read" && op !== "directory") return;
    const address = args.address as Address;
    const entry: ReadEntry = {
      op,
      address: [...address],
      route: routeOf(at, address),
      saw: null,
      refused: true,
    };
    if (op === "directory" && typeof args.name === "string") entry.name = args.name;
    log.reads.push(entry);
  }

  /**
   * A process's lasting interface, handed out by its effect run n: it reads
   * and writes until the process is killed. Its changes carry the step
   * {"lasting": n}; in a handler call or a cleanup, that call's agent, and
   * what it does is logged there. Its reads are never kept.
   */
  function lastingFor(p: Proc, n: () => number): Acts {
    const op = (name: string) => (args: { [key: string]: unknown }) => {
      if (
        p.state === "stopped" || p.state === "gone" || (p.state === "killing" && !p.context?.kill)
      ) {
        const e = invalid("stopped", `${name}: the process has been killed`);
        e.op = name;
        throw e;
      }
      const ctx = p.context;
      const agent = ctx ? ctx.agent : agentOf(p, { lasting: n() });
      const bound = bindAs(p, agent);
      const at: Acting = { agent, process: p.id, place: p.place, chroot: p.chroot };
      try {
        const got = name === "start"
          ? bound.place({ ...args, [START]: true } as unknown as PlaceOp)
          // deno-lint-ignore no-explicit-any
          : (bound as any)[name](args);
        if (ctx) logged(ctx.log, at, name, args, got);
        return got;
      } catch (e) {
        if (ctx && e instanceof ErmineError) {
          if (e.op === undefined) e.op = name;
          if (e instanceof Refused) refusedRead(ctx.log, at, name, args);
          ctx.log.errors.push(e.toJSON());
          ctx.log.seen.add(e);
        }
        throw e;
      }
    };
    const none = (name: string) => () => {
      const e = invalid("wrong-part", `the lasting interface cannot ${name}`);
      e.op = name;
      throw e;
    };
    return {
      read: op("read"),
      directory: op("directory"),
      lookup: op("lookup"),
      write: op("write"),
      place: op("place"),
      unplace: op("unplace"),
      subscribe: op("subscribe"),
      unsubscribe: op("unsubscribe"),
      start: op("start"),
      forget: none("forget"),
      bind: none("bind"),
      record: none("record"),
      finish: none("finish"),
      top: none("top"),
      cwd: Object.freeze([...p.cwd]),
    } as unknown as Acts;
  }

  /** Runs a process's cleanup through its lasting interface, as agent, logging what it did. */
  function cleanup(p: Proc, agent: Agent, isKill: boolean): Log {
    const log = newLog();
    const f = p.cleanup;
    p.cleanup = undefined;
    if (!f) return log;
    p.context = { agent, log, ...(isKill ? { kill: true as const } : {}) };
    p.busy++;
    try {
      f();
    } catch (e) {
      if (e instanceof Budget) throw e;
      if (!(e instanceof Object) || !log.seen.has(e)) log.errors.push(errorJson(e));
      (log as Log & { ended?: unknown }).ended = e;
    } finally {
      p.context = undefined;
      p.busy--;
    }
    return log;
  }

  // the interfaces a run is handed

  /**
   * An interface that works only while its part runs, and offers start as
   * a placement marked START, so that whatever records it records the start.
   */
  function gated(view: Interface, alive: () => boolean, seen: WeakSet<object>): Acts {
    const wrap = <A extends unknown[], R>(name: string, f: (...a: A) => R) => (...a: A): R => {
      if (!alive()) {
        const e = invalid("stopped", `${name}: this part has returned`);
        e.op = name;
        throw e;
      }
      try {
        return f(...a);
      } catch (e) {
        if (e instanceof Object) seen.add(e);
        throw e;
      }
    };
    return {
      ...view,
      read: wrap("read", view.read),
      directory: wrap("directory", view.directory),
      lookup: wrap("lookup", view.lookup),
      write: wrap("write", view.write),
      place: wrap("place", view.place),
      unplace: wrap("unplace", view.unplace),
      subscribe: wrap("subscribe", view.subscribe),
      unsubscribe: wrap("unsubscribe", view.unsubscribe),
      start: wrap(
        "start",
        (op: StartOp) => view.place({ ...op, [START]: true } as unknown as PlaceOp),
      ),
    } as Acts;
  }

  /** A view of an interface that only reads: a write, a placement or a start is read-only. */
  function readOnly(base: Interface): Interface {
    const no = (name: string) => (op?: object) => {
      const as = name === "place" && op && START in op ? "start" : name;
      const e = invalid("read-only", `${as}: a compute only reads`);
      e.op = as;
      throw e;
    };
    return { ...base, write: no("write"), place: no("place"), unplace: no("unplace") } as Interface;
  }

  // runs

  /** The error that ended a part, as the record and the error item show it. */
  function ended(e: unknown, rec?: Recording): ErrorJson {
    const json = errorJson(e);
    if (e instanceof ErmineError && e.op === undefined && rec) {
      const last = rec.errors[rec.errors.length - 1];
      if (last && equal(last.why as Json, json.why as Json)) return last;
    }
    return json;
  }

  /** Finishes a run's record, sends it, and updates the error item. */
  function finishRun(
    run: { p: Proc; rec: Recording; n: number },
    ending: "done" | "pending" | "failed" | "refused",
    extra: { value?: Json; cleanup?: number[]; errors?: ErrorJson[]; error?: ErrorJson },
  ) {
    const { p, rec, n } = run;
    const record = graph.finish(rec, ending, {
      program: p.program,
      ...(extra.value === undefined ? {} : { value: extra.value }),
      cleanup: extra.cleanup ?? [],
      errors: extra.errors ?? [],
    });
    req?.runs.push(record);
    if (p.open === run) p.open = undefined;
    if (p.state !== "running") return;
    p.pendingLast = ending === "pending";
    const error = (ending === "failed" || ending === "refused") && extra.error
      ? { error: extra.error, run: n }
      : undefined;
    if (!equal((error ?? null) as Json, (p.error ?? null) as Json)) {
      p.error = error;
      item(p, "error");
    }
  }

  /** Raises the height of each other process whose last compute read anything in nodes. */
  function raise(p: Proc, read: (q: Proc) => boolean) {
    for (const q of procs.values()) {
      if (q === p || q.state !== "running" || !read(q)) continue;
      if (q.height <= p.height) q.height = p.height + 1;
    }
  }

  /** The process's value as the graph holds it, beneath the wrappers. */
  function valueOf(p: Proc): { value: Json } | undefined {
    try {
      const items = graph.read({ ...p.self, agent: p.actor });
      return items.length ? { value: items[0].value } : undefined;
    } catch {
      return undefined;
    }
  }

  function computeRun(p: Proc) {
    if (req && req.count >= budget) throw new Budget();
    if (req) req.count++;
    if (p.open) {
      // an earlier run in this round: finished now, with its value and no effect
      const early = p.open;
      roundOpen = roundOpen.filter((r) => r !== early);
      finishRun(early, "done", { value: early.value });
    }
    due.delete(p.id);
    const n = ++p.runs;
    const agent = agentOf(p, { run: n });
    const base = bindAs(p, agent);
    const given = [...p.kept];
    const rec = graph.record(base, given.map((c) => c.time));
    const seen = new WeakSet<object>();
    let alive = true;
    const view = gated(rec.through(readOnly(base)), () => alive, seen);
    p.computing = true;
    p.busy++;
    let outcome: { value: unknown } | { pending: true } | { error: unknown; errors: ErrorJson[] };
    try {
      let fn: Loaded | undefined;
      try {
        fn = p.loader.load(p.code.compute, "compute", p.info);
      } catch (e) {
        if (e instanceof Budget) throw e;
        outcome = { error: e, errors: [errorJson(e)] };
      }
      if (fn) {
        try {
          const v = fn(
            {
              api: view,
              self: p.id,
              cwd: p.cwd,
              name: p.id,
              changes: given,
              pending: PENDING,
            } as unknown as Parameters<Loaded>[0],
          );
          outcome = v === PENDING ? { pending: true } : { value: v };
        } catch (e) {
          if (e instanceof Budget) throw e;
          outcome = { error: e, errors: e instanceof Object && seen.has(e) ? [] : [errorJson(e)] };
        }
      }
    } catch (e) {
      // the budget: this run stops where it is, and the process stays due
      alive = false;
      p.computing = false;
      p.busy--;
      graph.finish(rec, "done", { program: p.program });
      if (!due.has(p.id)) due.set(p.id, given[0]?.time ?? clock);
      throw e;
    }
    alive = false;
    p.computing = false;
    p.busy--;
    p.values = new Set(rec.values);
    p.nodes = new Set(rec.nodes);
    raise(p, (q) => q.values.has(p.id));
    const run = { p, rec, n };
    const o = outcome!;
    if ("pending" in o) {
      finishRun(run, "pending", {});
    } else if ("error" in o) {
      const error = ended(o.error, rec);
      finishRun(run, o.error instanceof Refused ? "refused" : "failed", {
        errors: o.errors,
        error,
      });
    } else {
      let value: Json;
      try {
        if (o.value === undefined) throw new Thrown({ code: "missing-value" });
        value = ownField(o.value, "value");
      } catch (e) {
        finishRun(run, "failed", { errors: [errorJson(e)], error: errorJson(e) });
        drain();
        return;
      }
      const now = valueOf(p);
      if (now === undefined || !equal(value, now.value) || p.pendingLast) {
        try {
          rec.write({ address: [p.id], patches: [{ type: "snapshot", value }] });
        } catch (e) {
          if (!(e instanceof ErmineError)) throw e;
          finishRun(run, e instanceof Refused ? "refused" : "failed", {
            value,
            error: ended(e, rec),
          });
          drain();
          return;
        }
      }
      // its last run returned a value: no longer pending
      p.pendingLast = false;
      const open: Open = { p, rec, n, agent, given, value };
      p.open = open;
      roundOpen.push(open);
    }
    drain();
  }

  /** A run's turn after the computes: the previous cleanup, the effect, and its record. */
  function finishAtTurn(run: Open) {
    const { p, rec, n, agent, value } = run;
    if (p.state !== "running") {
      finishRun(run, "done", { value });
      return;
    }
    const errors: ErrorJson[] = [];
    let error: unknown;
    let cleanupTimes: number[] = [];
    const changed: number[] = [];
    if (p.code.effect !== undefined) {
      if (p.cleanup) {
        const log = cleanup(p, agent, false);
        cleanupTimes = log.changes.map((c) => c.time);
        changed.push(...cleanupTimes);
        errors.push(...log.errors);
        const end = (log as Log & { ended?: unknown }).ended;
        if (end !== undefined) error = end;
      }
      let fn: Loaded | undefined;
      try {
        fn = p.loader.load(p.code.effect, "effect", p.info);
      } catch (e) {
        errors.push(errorJson(e));
        error ??= e;
      }
      if (fn && p.state === "running") {
        const seen = new WeakSet<object>();
        let alive = true;
        const view = gated(rec.through(bindAs(p, agent, false, true)), () => alive, seen);
        const lasting = lastingFor(p, () => n);
        const before = rec.changes.length;
        p.busy++;
        try {
          const out = fn(
            {
              api: view,
              self: p.id,
              cwd: p.cwd,
              name: p.id,
              value,
              ...(p.hasPrevious ? { previous: p.previous } : {}),
              lasting,
              handler: (name: string, f: Handler) => {
                if (!alive) return;
                if (typeof name !== "string" || typeof f !== "function") {
                  throw wrongField("handler", "a handler is a name and a function");
                }
                p.handlers.set(name, f);
              },
            } as unknown as Parameters<Loaded>[0],
          );
          if (typeof out === "function") p.cleanup = out as () => unknown;
        } catch (e) {
          if (e instanceof Budget) throw e;
          if (!(e instanceof Object && seen.has(e))) errors.push(errorJson(e));
          error ??= e;
        } finally {
          alive = false;
          p.busy--;
        }
        p.hasPrevious = true;
        p.previous = value;
        changed.push(...rec.changes.slice(before));
      }
    }
    // it reached its effect, or it has none: the changes it was given are let go
    p.kept = p.kept.filter((c) => !run.given.includes(c));
    const nodes = new Set(changed.flatMap((t) => recent.has(t) ? [recent.get(t)!.node] : []));
    if (nodes.size) raise(p, (q) => [...nodes].some((node) => q.nodes.has(node)));
    const ending = error === undefined ? "done" : error instanceof Refused ? "refused" : "failed";
    finishRun(run, ending, {
      value,
      cleanup: cleanupTimes,
      errors,
      ...(error === undefined ? {} : { error: ended(error, rec) }),
    });
    drain();
  }

  /** The process due next: the lowest height, then the oldest first mark, then the lowest id. */
  function pick(): Proc {
    let best: Proc | undefined;
    let bestMark = 0;
    for (const [id, mark] of due) {
      const p = procs.get(id)!;
      if (
        !best || p.height < best.height ||
        (p.height === best.height &&
          (mark < bestMark || (mark === bestMark && byCodePoint(p.id, best.id) < 0)))
      ) {
        best = p;
        bestMark = mark;
      }
    }
    return best!;
  }

  function round() {
    inRound = true;
    roundOpen = [];
    try {
      while (due.size) {
        computeRun(pick());
        drain();
      }
      while (roundOpen.length) {
        finishAtTurn(roundOpen.shift()!);
        drain();
      }
    } catch (e) {
      if (!(e instanceof Budget)) throw e;
      // what is still due stays due; the runs waiting for their turn end here, letting nothing go
      for (const run of roundOpen) finishRun(run, "done", { value: run.value });
      roundOpen = [];
      throw invalid("budget", `the request caused ${budget} runs`, { budget });
    } finally {
      inRound = false;
    }
  }

  /** Runs rounds while anything is due. */
  function settle() {
    for (const p of [...due.keys()]) if (procs.get(p)?.state !== "running") due.delete(p);
    while (due.size) round();
  }

  /**
   * Makes a request: an operation from outside any round, which answers once
   * nothing is due. One made inside, by a part or while a request is under
   * way, is not queued: it is made, and what it marks is due.
   */
  function request<T extends object>(fn: () => T): T & Settled {
    if (depth > 0) return fn() as T & Settled;
    depth++;
    const r = req = { runs: [], stopped: [], count: 0 };
    try {
      const out = fn();
      drain();
      settle();
      return { ...out, runs: r.runs, stopped: r.stopped };
    } finally {
      depth--;
      req = undefined;
      recent.clear();
    }
  }

  // operations

  /** A change through the scheduler: stamped with the clock, checked, made, and noted. */
  function change<O extends Acting & { address: Address }>(
    kind: "write" | "place" | "unplace",
    op: O,
  ): Changed {
    const starting = (op as { [STARTING]?: number })[STARTING];
    if (starting !== undefined) {
      const { [STARTING]: _, ...rest } = op as O & { [STARTING]?: number };
      const answer = below.place({ ...rest, time: starting } as unknown as PlaceOp);
      note(answer);
      return answer;
    }
    const stamped = { ...op, time: clock + 1 } as O & { time: number };
    fields(kind, stamped, () => undefined);
    if (kind === "place") checkPlace(stamped as unknown as PlaceOp);
    // deno-lint-ignore no-explicit-any
    const answer: Changed = (below as any)[kind](stamped);
    if (kind === "place") placed(stamped as unknown as PlaceOp);
    note(answer);
    drain();
    return answer;
  }

  /** Whether an operation acts as a process that may make or place an ephemeral node. */
  const asProcess = (op: Acting) => {
    const p = op.process === undefined ? undefined : procs.get(op.process);
    return p !== undefined && (p.state === "running" || p.state === "killing");
  };

  /** The interface's checks on a placement: only processes place ephemeral nodes; a process is in one place. */
  function checkPlace(op: PlaceOp) {
    const making = op.value !== undefined;
    const eph = making ? op.ephemeral === true : ephemeral.has(op.id);
    if (eph && !asProcess(op)) {
      const e = invalid("not-a-process", "only a process makes or places an ephemeral node");
      e.op = "place";
      throw e;
    }
    const p = procs.get(op.id);
    if (p && (p.state === "running" || p.state === "stopped")) {
      const at = reach(op);
      if (at !== p.parentNode || op.name !== p.id) {
        const e = invalid("one-place", "a process is placed in one place");
        e.op = "place";
        throw e;
      }
    }
  }

  /** After a placement: the ephemeral nodes a process makes, to unplace when it is killed. */
  function placed(op: PlaceOp) {
    if (op.value === undefined || op.ephemeral !== true) return;
    const p = op.process === undefined ? undefined : procs.get(op.process);
    if (p && (p.state === "running" || p.state === "killing")) {
      ephemeral.set(op.id, p);
      p.ephemerals.push(op.id);
    }
  }

  /** The program path given to start: a first "/" and names, never "..". */
  function programPath(program: unknown): Parsed {
    if (program === undefined) throw missing("program");
    const parsed = parseAddress(program, "program");
    if (parsed.up > 0 || parsed.names.length === 0) {
      throw wrongField("program", "a program's path is names, perhaps after a first /");
    }
    return parsed;
  }

  function isProgram(v: Json): v is Program {
    return isObject(v) && typeof v.kind === "string" && v.kind !== "" && v.kind !== "." &&
      v.kind !== ".." && v.kind !== "/" && Object.hasOwn(v, "compute");
  }

  function doStart(op: StartOp): Changed {
    // the request's fields, in PROTOCOL.tex's order, then the program
    acting(op);
    const parsed = parseAddress(op.address);
    const value = op.value === undefined ? null : ownField(op.value, "value");
    if (op.cause !== undefined) ownField(op.cause, "cause");
    const path = programPath(op.program);
    const caller = op.process === undefined ? undefined : procs.get(op.process);
    if (caller && caller.state !== "running") {
      throw invalid("stopped", "a process being killed cannot start anything");
    }
    const place = [...(op.place ?? [])];
    const chroot = op.chroot ?? 0;
    if (!parsed.root && parsed.up > place.length - chroot) {
      throw invalid("above-root", "the address goes back past the start of the place");
    }
    const names = absolute(place, chroot, parsed);
    const levels = names.length - chroot;
    // the searches, as the caller's reads, at the new process's place
    const reader = graph.bind(up, {
      agent: op.agent!,
      ...(op.process === undefined ? {} : { process: op.process }),
      place: names,
      chroot,
      writes: false,
    });
    const program = search(reader, path, levels);
    if (!program) throw invalid("no-program", "no program was found");
    if (!isProgram(program.value)) throw invalid("not-a-program", "the program found is not one");
    const code = program.value;
    const lpath = parseAddress(["loaders", code.kind]);
    const loader = search(reader, lpath, levels);
    const lname = loader && isObject(loader.value) ? loader.value.loader : undefined;
    if (!loader || typeof lname !== "string" || !Object.hasOwn(loaders, lname)) {
      throw invalid("no-loader", "no loader was found for the program's kind");
    }
    // the placement, through the stack, made as the caller
    const t = clock + 1;
    let answer: Changed;
    for (let k = t;; k++) {
      const pid = pidOf(t, k);
      try {
        answer = up.place({
          agent: op.agent,
          ...(op.process === undefined ? {} : { process: op.process }),
          place,
          chroot,
          address: op.address,
          name: pid,
          id: pid,
          value,
          ...(op.cause === undefined ? {} : { cause: op.cause }),
          [STARTING]: t,
        } as unknown as PlaceOp);
        break;
      } catch (e) {
        if (e instanceof ErmineError && e.why.code === "exists") continue;
        throw e;
      }
    }
    const change = answer.change as Change & { kind: "place" };
    const pid = change.id;
    const agent = (op.agent ?? null) as Json;
    const p: Proc = {
      id: pid,
      place: names,
      chroot,
      cwd: names.slice(chroot),
      parentNode: change.node,
      ...(caller ? { parent: caller } : {}),
      children: [],
      actor: actorOf(agent),
      prefix: isAgent(agent) ? [...agent.code] : [],
      program: { node: program.node, time: program.time },
      code,
      path,
      loader: loaders[lname],
      loaderId: { node: loader.node, time: loader.time },
      height: 0,
      runs: 0,
      kept: [change],
      computing: false,
      busy: 0,
      pendingLast: false,
      values: new Set(),
      nodes: new Set(),
      hasPrevious: false,
      handlers: new Map(),
      ephemerals: [],
      state: "running",
      watching: [],
      info: undefined as unknown as Running,
      self: {
        agent: null,
        place: names.slice(0, chroot),
        chroot,
        address: [...names.slice(chroot), pid],
      },
    };
    p.info = {
      id: pid,
      name: pid,
      cwd: Object.freeze([...p.cwd]),
      program: p.program,
      reads: bindAs(p, agentOf(p, { lasting: 0 }), true, false),
      lasting: lastingFor(p, () => p.runs),
    };
    procs.set(pid, p);
    caller?.children.push(p);
    // its address, to know when it is killed; and its searches, to know when they would find another
    const at = { agent: p.actor ?? null, place: p.place, chroot: p.chroot };
    p.address = graph.subscribe({
      ...p.self,
      agent: at.agent,
      send: (event) => {
        if ("change" in event && event.reaches !== undefined) moved(p, event.change, event.reaches);
      },
    }).sub;
    const watch = (event: Event) => {
      if ("change" in event && p.state === "running") rechecks.add(p);
    };
    for (const address of [...tries(path, levels), ...tries(lpath, levels)]) {
      p.watching.push(graph.subscribe({ ...at, address, send: watch }).sub);
    }
    try {
      p.loader.started?.(p.info);
    } catch {
      // a loader's trouble shows when the part is loaded
    }
    // marked by its start
    due.set(pid, change.time);
    const marked: Marked[] = [...answer.marked.filter((m) => m.process !== pid), {
      process: pid,
      by: change.time,
    }].sort((a, b) => byCodePoint(a.process, b.process));
    const out: Changed = { change, marked };
    if (answer.gone) out.gone = answer.gone;
    return out;
  }

  function fire(op: FireOp): Fired {
    acting(op);
    const pid = (op as { process?: unknown }).process;
    if (pid === undefined) throw missing("process");
    if (typeof pid !== "string") throw wrongField("process", "a process is an id, a string");
    const name = (op as { handler?: unknown }).handler;
    if (name === undefined) throw missing("handler");
    if (typeof name !== "string") throw wrongField("handler", "a handler is named by a string");
    if (op.input !== undefined) ownField(op.input, "input");
    const p = procs.get(pid);
    if (!p) {
      if (killed.has(pid)) throw invalid("stopped", `${pid} has been killed`);
      throw invalid("unknown-process", `there is no process ${pid}`);
    }
    if (p.state !== "running") throw invalid("stopped", `${pid} has been killed`);
    const f = p.handlers.get(name);
    if (!f) throw invalid("unknown-handler", `${pid} has no handler ${name}`);
    return request(() => {
      const agent: Agent = {
        actor: actorOf(op.agent as Json),
        code: [...p.prefix, { process: p.id, program: p.program, handler: name }],
      };
      const log = newLog();
      p.context = { agent, log };
      p.busy++;
      let error: unknown;
      try {
        f(op.input);
      } catch (e) {
        if (e instanceof Budget) throw e;
        error = e;
        if (!(e instanceof Object && log.seen.has(e))) log.errors.push(errorJson(e));
      } finally {
        p.context = undefined;
        p.busy--;
      }
      const record: HandlerRecord = {
        process: p.id,
        agent,
        program: p.program,
        lookups: log.lookups,
        reads: log.reads,
        changes: log.changes.map((c) => c.time),
        ending: error === undefined ? "done" : error instanceof Refused ? "refused" : "failed",
        errors: log.errors,
      };
      send(p.id, record);
      drain();
      const out: { handler: HandlerRecord; changes: Change[]; error?: ErrorJson } = {
        handler: record,
        changes: log.changes,
      };
      if (error !== undefined) out.error = errorJson(error);
      return out;
    });
  }

  /** Sends a handler record to whatever is subscribed to the process. */
  function send(pid: Id, record: HandlerRecord) {
    for (const s of subs.values()) {
      if (reach(s.op) !== pid) continue;
      try {
        s.send({ record } as unknown as Event);
      } catch {
        // the subscriber's trouble is its own
      }
    }
  }

  const scheduler: Scheduler = {
    read(op) {
      const reader = op?.process === undefined ? undefined : procs.get(op.process);
      if (reader?.computing && inRound && op?.address !== undefined) {
        // a compute reading a due process runs that process's compute first
        const node = reach(op);
        const q = node === undefined ? undefined : procs.get(node);
        if (q && q !== reader && q.state === "running" && due.has(q.id) && !q.computing) {
          computeRun(q);
        }
      }
      return dress(op, below.read(op));
    },
    directory: (op: DirectoryOp) => below.directory(op),
    lookup: (op: LookupOp) => below.lookup(op),
    write: (op) => request(() => change("write", op)),
    place: (op) =>
      START in op
        ? request(() => doStart(op as unknown as StartOp))
        : request(() => change("place", op)),
    unplace: (op) => request(() => change("unplace", op)),
    start: (op) => request(() => doStart(op)),
    subscribe(op: SubscribeOp) {
      const answer = below.subscribe(op);
      const { send: _s, ...kept } = op;
      subs.set(answer.sub, { op: kept, send: op.send });
      return answer;
    },
    unsubscribe(op: UnsubscribeOp) {
      below.unsubscribe(op);
      subs.delete(op.sub);
    },
    forget: (op) => below.forget(op),
    bind: (inner, binding) => below.bind(inner, binding),
    record: (inner, marked) => below.record(inner, marked),
    finish: (recording, ending, finishing) => below.finish(recording, ending, finishing),
    top: told((top) => {
      up = top;
      tell(top);
    }),
    cwd: Object.freeze([]),
    ...(below.reach ? { reach: (op: Acting & { address: Address }) => below.reach!(op) } : {}),
    batch(fn) {
      let thrown: { e: unknown } | undefined;
      const settled = request(() => {
        try {
          fn();
        } catch (e) {
          thrown = { e };
        }
        drain();
        return {};
      });
      if (thrown) throw thrown.e;
      return { runs: settled.runs, stopped: settled.stopped };
    },
    fire,
    restart() {
      procs.clear();
      killed.clear();
      due.clear();
      ephemeral.clear();
      kills.length = 0;
      rechecks.clear();
      subs.clear();
      roundOpen = [];
    },
    get time() {
      return clock;
    },
  };
  up = scheduler;
  const tell = below.top(scheduler);
  return scheduler;
}
