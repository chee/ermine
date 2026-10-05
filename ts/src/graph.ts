// The bare graph (CORE.tex, The core). It holds nodes, applies changes, sends
// them to subscribers, remembers what each process's last run read, and marks
// the processes a change touches. It never runs anything.

import { applyPatches, byCodePoint, isObject, own, placed } from "./patch.ts";
import {
  type Acting,
  type Binding,
  type Bound,
  type Change,
  type Changed,
  type ChangeRef,
  type Common,
  type DataOp,
  type DirectoryOp,
  type Ending,
  ErmineError,
  type Event,
  type Finishing,
  type Fixed,
  type Found,
  type Id,
  type Interface,
  Invalid,
  type Json,
  type Listing,
  type Lookup,
  type LookupOp,
  type MakeOp,
  type Marked,
  naming,
  type Patch,
  type Path,
  type PlaceOp,
  type Program,
  type ProgramEntry,
  type Reading,
  type ReadOp,
  type Record,
  type RecordError,
  type Recording,
  Refused,
  type Searched,
  type Site,
  type Stamp,
  type SubscribeOp,
  told,
  type UnplaceOp,
  type UnsubscribeOp,
  type WriteOp,
} from "./types.ts";

type Node = {
  value: Json;
  /** name to slot; a slot with no ids is gone */
  directory: Map<string, Id[]>;
  /** its fixed data, as given; the core never reads it */
  data?: { given: Json };
  /** the time of its latest change */
  latest: number;
};

/** What one process's last run read. */
type Reads = { values: Set<Id>; slots: Map<Id, Set<string>>; wholes: Set<Id> };

/** One run being recorded. */
type Run = {
  process: Id;
  open: boolean;
  marked: ChangeRef[];
  compute?: ProgramEntry;
  effect?: ProgramEntry;
  lookups: Lookup[];
  reads: { node: Id; saw: number | null }[];
  directories: { node: Id; name?: string; saw: number | null }[];
  changes: ChangeRef[];
  errors: RecordError[];
};

const ENDINGS = new Set(["done", "pending", "failed", "refused"]);

export function graph(): Interface {
  const nodes = new Map<Id, Node>();
  let last = 0;

  const subs = new Map<number, { node: Id; send: (event: Event) => void }>();
  const watching = new Map<Id, Set<number>>();
  let nextSub = 1;

  // what each process's last run read, and who read each thing
  const memory = new Map<Id, Reads>();
  const valueReaders = new Map<Id, Set<Id>>();
  const slotReaders = new Map<Id, Map<string, Set<Id>>>();
  const wholeReaders = new Map<Id, Set<Id>>();
  const runs = new Map<Id, number>();

  const bindings = new WeakMap<object, Binding>();
  const recordings = new WeakMap<object, Run>();

  let up: Interface;

  function saw(id: Id): number | null {
    return nodes.get(id)?.latest ?? null;
  }

  // reads

  function remember(process: Id, node: Id, name?: string | null) {
    let reads = memory.get(process);
    if (!reads) {
      memory.set(process, reads = { values: new Set(), slots: new Map(), wholes: new Set() });
    }
    if (name === undefined) {
      reads.values.add(node);
      add(valueReaders, node, process);
    } else if (name === null) {
      reads.wholes.add(node);
      add(wholeReaders, node, process);
    } else {
      let names = reads.slots.get(node);
      if (!names) reads.slots.set(node, names = new Set());
      names.add(name);
      let byName = slotReaders.get(node);
      if (!byName) slotReaders.set(node, byName = new Map());
      add(byName, name, process);
    }
  }

  function forget(process: Id) {
    const reads = memory.get(process);
    if (!reads) return;
    memory.delete(process);
    for (const node of reads.values) drop(valueReaders, node, process);
    for (const node of reads.wholes) drop(wholeReaders, node, process);
    for (const [node, names] of reads.slots) {
      const byName = slotReaders.get(node)!;
      for (const name of names) drop(byName, name, process);
      if (byName.size === 0) slotReaders.delete(node);
    }
  }

  function marks(change: Change): Marked[] {
    const found = new Set<Id>();
    const take = (readers?: Set<Id>) => readers?.forEach((p) => found.add(p));
    if (change.kind === "make") {
      take(valueReaders.get(change.node));
      slotReaders.get(change.node)?.forEach(take);
      take(wholeReaders.get(change.node));
    } else if (change.kind === "write") {
      take(valueReaders.get(change.node));
    } else {
      take(slotReaders.get(change.node)?.get(change.name));
      take(wholeReaders.get(change.node));
    }
    if (change.process !== undefined) found.delete(change.process);
    const by = { node: change.node, time: change.time };
    return [...found].sort(byCodePoint).map((process) => ({ process, by }));
  }

  // changes

  function deliver(node: Id, event: Event) {
    const ids = watching.get(node);
    if (!ids) return;
    for (const sub of [...ids]) {
      const s = subs.get(sub);
      if (!s) continue;
      try {
        s.send(event);
      } catch (e) {
        // the change stands; the subscriber's trouble is reported apart
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }

  /** Checks a change's agent, process, time and site, before anything applies. */
  function stamp(op: Acting & Stamp): number {
    acting(op);
    const time = op.time;
    if (typeof time !== "number" || !Number.isInteger(time) || time < 1) {
      throw new Invalid("a change needs a time, a whole number from 1");
    }
    if (time <= last) throw new Invalid(`time ${time} is not after ${last}`);
    if (op.process === undefined && op.site === undefined) {
      throw new Invalid("a change from outside any process carries its site");
    }
    return time;
  }

  /** agent, process, cause and site, as a change carries them; made before anything changes */
  function common(op: Acting & Stamp) {
    const c: Common = { agent: own(op.agent) };
    if (op.process !== undefined) c.process = op.process;
    if ("cause" in op && op.cause !== undefined) c.cause = own(op.cause);
    if (op.site !== undefined) c.site = own(op.site) as unknown as Site;
    return c;
  }

  function apply(node: Node, change: Change): Changed {
    last = change.time;
    node.latest = change.time;
    Object.freeze(change);
    const marked = marks(change);
    deliver(change.node, { change });
    return { change, marked };
  }

  function existing(id: unknown, what: string): Node {
    if (typeof id !== "string") throw new Invalid(`${what} is an id, a string`);
    const node = nodes.get(id);
    if (!node) throw new Invalid(`there is no node ${JSON.stringify(id)}`);
    return node;
  }

  function make(op: MakeOp): Changed {
    if (typeof op.id !== "string") throw new Invalid("make needs an id, a string");
    if (nodes.has(op.id)) throw new Invalid(`a node ${JSON.stringify(op.id)} exists`);
    if (!("value" in op) || op.value === undefined) throw new Invalid("make needs a value");
    const time = stamp(op);
    const value = own(op.value);
    const change = { node: op.id, time, kind: "make", value } as Change & { data?: Json };
    const node: Node = { value, directory: new Map(), latest: time };
    if ("data" in op && op.data !== undefined) {
      node.data = { given: own(op.data) };
      change.data = node.data.given;
    }
    Object.assign(change, common(op));
    nodes.set(op.id, node);
    return apply(node, change);
  }

  function write(op: WriteOp): Changed {
    const node = existing(op.node, "write's node");
    const value = applyPatches(node.value, op.patches);
    const time = stamp(op);
    const patches = own(op.patches) as unknown as readonly Patch[];
    const change: Change = { node: op.node, time, kind: "write", patches, ...common(op) };
    node.value = value;
    return apply(node, change);
  }

  function place(op: PlaceOp): Changed {
    const node = existing(op.parent, "place's parent");
    names(op);
    const slot = node.directory.get(op.name) ?? [];
    const p = op.position;
    if (p !== undefined) {
      const rest = slot.filter((id) => id !== op.id);
      if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > rest.length + 1) {
        throw new Invalid(`position ${p} is outside the slot`);
      }
    }
    const time = stamp(op);
    const change = { node: op.parent, time, kind: "place", name: op.name, id: op.id } as Change & {
      position?: number;
    };
    if (op.position !== undefined) change.position = op.position;
    Object.assign(change, common(op));
    node.directory.set(op.name, placed(slot, op.id, p));
    return apply(node, change);
  }

  function unplace(op: UnplaceOp): Changed {
    const node = existing(op.parent, "unplace's parent");
    names(op);
    const slot = node.directory.get(op.name) ?? [];
    if (!slot.includes(op.id)) {
      throw new Invalid(`${JSON.stringify(op.id)} is not in slot ${JSON.stringify(op.name)}`);
    }
    const time = stamp(op);
    const change: Change = {
      node: op.parent,
      time,
      kind: "unplace",
      name: op.name,
      id: op.id,
      ...common(op),
    };
    const next = slot.filter((id) => id !== op.id);
    if (next.length) node.directory.set(op.name, next);
    else node.directory.delete(op.name);
    return apply(node, change);
  }

  function read(op: ReadOp): Reading {
    acting(op);
    if (typeof op.node !== "string") throw new Invalid("read needs a node, a string");
    const node = nodes.get(op.node);
    return node ? { value: node.value } : { absent: true };
  }

  function data(op: DataOp): Fixed {
    acting(op);
    if (typeof op.node !== "string") throw new Invalid("data needs a node, a string");
    const node = nodes.get(op.node);
    return node ? { data: node.data ? node.data.given : null } : { absent: true };
  }

  function directory(op: DirectoryOp): Listing {
    acting(op);
    if (typeof op.node !== "string") throw new Invalid("directory needs a node, a string");
    if (op.name !== undefined && typeof op.name !== "string") {
      throw new Invalid("a name is a string");
    }
    const node = nodes.get(op.node);
    if (!node) return { absent: true };
    if (op.name !== undefined) return { slot: [...node.directory.get(op.name) ?? []] };
    const names = [...node.directory.keys()].sort(byCodePoint);
    return { directory: names.map((name) => [name, [...node.directory.get(name)!]]) };
  }

  function lookup(op: LookupOp): Found {
    acting(op);
    if (typeof op.name !== "string") throw new Invalid("lookup needs a name, a string");
    const path = op.path ?? [];
    checkPath(path);
    const searched: Searched[] = [];
    let found: Id[] = [];
    // from the parent of the last step up; each step a read of one slot
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i].parent;
      let listing: Listing;
      try {
        listing = up.directory({ ...who(op), node, name: op.name });
      } catch (e) {
        if (e instanceof Refused) {
          searched.push({ node, refused: true });
          break;
        }
        throw e;
      }
      searched.push({ node, saw: saw(node) });
      const ids = "slot" in listing ? listing.slot : [];
      if (ids.length) {
        found = ids;
        break;
      }
    }
    return { found, searched };
  }

  function subscribe(op: SubscribeOp): { sub: number } {
    acting(op);
    if (typeof op.node !== "string") throw new Invalid("subscribe needs a node, a string");
    if (typeof op.send !== "function") throw new Invalid("subscribe needs a send function");
    const sub = nextSub++;
    subs.set(sub, { node: op.node, send: op.send });
    add(watching, op.node, sub);
    return { sub };
  }

  function unsubscribe(op: UnsubscribeOp): void {
    acting(op);
    const s = subs.get(op.sub);
    if (!s) throw new Invalid(`there is no subscription ${op.sub}`);
    subs.delete(op.sub);
    drop(watching, s.node, op.sub);
  }

  // binding

  function bind(api: Interface, binding: Binding): Bound {
    if (!isObject(binding)) throw new Invalid("bind needs a binding");
    if (binding.agent === undefined) throw new Invalid("a binding has an agent");
    if (binding.process !== undefined && typeof binding.process !== "string") {
      throw new Invalid("a binding's process is an id");
    }
    if (binding.path !== undefined) checkPath(binding.path);
    const fixed = { ...binding, agent: own(binding.agent) };
    const as = who(fixed);
    const path = fixed.path ?? [];
    let ended = false;
    const open = (op: string, part?: "reads" | "writes") => {
      if (ended) throw new Invalid(`${op}: this interface has ended`, op);
      if (part === "writes" && !fixed.writes) {
        throw new Invalid(`${op}: this interface only reads`, op);
      }
      if (part === "reads" && fixed.reads === false) {
        throw new Invalid(`${op}: this interface only writes`, op);
      }
    };
    const none = (op: string) => () => {
      throw new Invalid(`${op}: a bound interface cannot ${op} runs`, op);
    };
    const bound: Bound = {
      make: (op) => (open("make", "writes"), api.make({ ...strip(op), ...as })),
      write: (op) => (open("write", "writes"), api.write({ ...strip(op), ...as })),
      place: (op) => (open("place", "writes"), api.place({ ...strip(op), ...as })),
      unplace: (op) => (open("unplace", "writes"), api.unplace({ ...strip(op), ...as })),
      read: (op) => (open("read", "reads"), api.read({ ...strip(op), ...as })),
      data: (op) => (open("data", "reads"), api.data({ ...strip(op), ...as })),
      directory: (op) => (open("directory", "reads"), api.directory({ ...strip(op), ...as })),
      lookup: (op) => (open("lookup", "reads"), api.lookup({ ...strip(op), ...as, path })),
      subscribe: (op) => (open("subscribe"), api.subscribe({ ...strip(op), ...as })),
      unsubscribe: (op) => (open("unsubscribe"), api.unsubscribe({ ...strip(op), ...as })),
      // the holder cannot change the agent, process or path, nor do more than this does
      bind: (inner, b) => {
        open("bind");
        if (!isObject(b)) throw new Invalid("bind needs a binding", "bind");
        const kept: Binding = { ...b, agent: fixed.agent, writes: !!b.writes && !!fixed.writes };
        if (fixed.process === undefined) delete kept.process;
        else kept.process = fixed.process;
        if (fixed.path === undefined) delete kept.path;
        else kept.path = fixed.path;
        if (fixed.reads === false) kept.reads = false;
        return api.bind(inner, kept);
      },
      // runs are recorded and finished by whoever holds the stack, not by a run
      record: none("record"),
      finish: none("finish"),
      top: () => {
        throw new Invalid("a bound interface cannot change the top of the stack", "top");
      },
      end: () => {
        ended = true;
      },
    };
    bindings.set(bound, fixed);
    return bound;
  }

  // recording

  function record(api: Interface, marked: readonly ChangeRef[]): Recording {
    const binding = bindings.get(api);
    if (!binding || binding.process === undefined) {
      throw new Invalid("record needs an interface bound to a process");
    }
    if (!Array.isArray(marked)) throw new Invalid("record needs the changes that marked the run");
    const process = binding.process;
    forget(process);
    const run = (runs.get(process) ?? 0) + 1;
    runs.set(process, run);
    const state: Run = {
      process,
      open: true,
      marked: marked.map((c) => ({ node: c.node, time: c.time })),
      lookups: [],
      reads: [],
      directories: [],
      changes: [],
      errors: [],
    };

    const attempt = <T>(op: string, fn: () => T): T => {
      if (!state.open) throw new Invalid(`${op}: this run has finished`);
      try {
        return fn();
      } catch (e) {
        if (e instanceof ErmineError) state.errors.push({ kind: e.kind, op, why: e.message });
        throw e;
      }
    };
    const changed = (answer: Changed) => {
      state.changes.push({ node: answer.change.node, time: answer.change.time });
      return answer;
    };

    const recorded = (inner: Interface): Interface => ({
      make: (op) => attempt("make", () => changed(inner.make(op))),
      write: (op) => attempt("write", () => changed(inner.write(op))),
      place: (op) => attempt("place", () => changed(inner.place(op))),
      unplace: (op) => attempt("unplace", () => changed(inner.unplace(op))),
      read: (op) =>
        attempt("read", () => {
          const answer = inner.read(op);
          remember(process, op.node);
          state.reads.push({ node: op.node, saw: saw(op.node) });
          return answer;
        }),
      // fixed data never changes, but an absent node's data is read like its value
      data: (op) =>
        attempt("data", () => {
          const answer = inner.data(op);
          remember(process, op.node);
          state.reads.push({ node: op.node, saw: saw(op.node) });
          return answer;
        }),
      directory: (op) =>
        attempt("directory", () => {
          const answer = inner.directory(op);
          const entry: Run["directories"][number] = op.name === undefined
            ? { node: op.node, saw: saw(op.node) }
            : { node: op.node, name: op.name, saw: saw(op.node) };
          remember(process, op.node, op.name ?? null);
          state.directories.push(entry);
          return answer;
        }),
      lookup: (op) =>
        attempt("lookup", () => {
          const answer = inner.lookup(op);
          for (const s of answer.searched) {
            if (!("refused" in s)) remember(process, s.node, op.name);
          }
          state.lookups.push({ name: op.name, searched: answer.searched, found: answer.found });
          return answer;
        }),
      subscribe: (op) => attempt("subscribe", () => inner.subscribe(op)),
      unsubscribe: (op) => attempt("unsubscribe", () => inner.unsubscribe(op)),
      bind: (a, b) => attempt("bind", () => inner.bind(a, b)),
      record: (a, m) => attempt("record", () => inner.record(a, m)),
      finish: (r, ending, f) => attempt("finish", () => inner.finish(r, ending, f)),
      top: () => {
        throw new Invalid("a recording cannot change the top of the stack");
      },
    });

    const programs: Id[] = [];
    function program(slot: "compute" | "effect"): Program | undefined {
      if (slot !== "compute" && slot !== "effect") {
        throw new Invalid("a program is in the compute or effect slot");
      }
      const listing = attempt("directory", () => api.directory({ node: process, name: slot }));
      remember(process, process, slot);
      programs.push(process);
      const ids = "slot" in listing ? listing.slot : [];
      if (!ids.length) return undefined;
      const node = ids[0];
      let reading: Reading;
      try {
        reading = attempt("read", () => api.read({ node }));
      } catch (e) {
        if (e instanceof Refused) state[slot] = { node, refused: true, slot: ids };
        throw e;
      }
      remember(process, node);
      programs.push(node);
      state[slot] = "value" in reading
        ? { node, saw: saw(node)!, slot: ids }
        : { node, absent: true, slot: ids };
      return { node, slot: ids, ...reading };
    }

    const recording: Recording = {
      ...recorded(api),
      process,
      agent: binding.agent,
      run,
      reads: state.reads,
      directories: state.directories,
      lookups: state.lookups,
      changes: state.changes,
      errors: state.errors,
      programs,
      through: recorded,
      program,
    };
    recordings.set(recording, state);
    return recording;
  }

  function finish(recording: Recording, ending: Ending, finishing: Finishing = {}): Record {
    const state = recordings.get(recording);
    if (!state) throw new Invalid("finish needs a recording of this graph");
    if (!state.open) throw new Invalid("this run has finished");
    if (!ENDINGS.has(ending)) throw new Invalid(`a run cannot end ${JSON.stringify(ending)}`);
    state.open = false;
    const r = { process: state.process, run: recording.run, agent: recording.agent } as Record;
    r.marked = state.marked;
    if (state.compute) r.compute = state.compute;
    if (state.effect) r.effect = state.effect;
    r.lookups = [...state.lookups];
    r.reads = [...state.reads];
    r.directories = [...state.directories];
    if (finishing.value !== undefined) r.value = own(finishing.value);
    r.cleanup = (finishing.cleanup ?? []).map((c) => ({ node: c.node, time: c.time }));
    r.changes = [...state.changes];
    r.ending = ending;
    r.errors = [...state.errors, ...finishing.errors ?? []];
    deliver(state.process, { record: r });
    return r;
  }

  const api: Interface = {
    make: naming("make", make),
    read: naming("read", read),
    data: naming("data", data),
    directory: naming("directory", directory),
    lookup: naming("lookup", lookup),
    write: naming("write", write),
    place: naming("place", place),
    unplace: naming("unplace", unplace),
    subscribe: naming("subscribe", subscribe),
    unsubscribe: naming("unsubscribe", unsubscribe),
    bind: naming("bind", bind),
    record: naming("record", record),
    finish: naming("finish", finish),
    top: told((top: Interface) => {
      up = top;
    }),
  };
  up = api;
  return api;
}

/** Checks that an operation says who makes it. */
function acting(op: Acting) {
  if (!isObject(op)) throw new Invalid("an operation is an object");
  if (op.agent === undefined) throw new Invalid("an operation carries an agent");
  if (op.process !== undefined && typeof op.process !== "string") {
    throw new Invalid("a process is an id, a string");
  }
}

/** The agent and process of an operation, as another operation carries them. */
function who(op: Acting): Acting {
  return op.process === undefined ? { agent: op.agent } : { agent: op.agent, process: op.process };
}

function strip<T extends Acting>(op: T): T {
  const { agent: _a, process: _p, ...rest } = op;
  return rest as T;
}

function names(op: { name: unknown; id: unknown }) {
  if (typeof op.name !== "string") throw new Invalid("a slot's name is a string");
  if (typeof op.id !== "string") throw new Invalid("an id is a string");
}

/**
 * A path's shape: a list of steps, each with a parent, a name and a node,
 * each step's parent the node of the step before.
 */
export function checkPath(path: unknown): asserts path is Path {
  if (!Array.isArray(path)) throw new Invalid("a path is a list of steps");
  path.forEach((step, i) => {
    if (
      !isObject(step) || typeof step.parent !== "string" || typeof step.name !== "string" ||
      typeof step.node !== "string"
    ) {
      throw new Invalid("a path step has a parent, a name and a node");
    }
    if (i > 0 && step.parent !== path[i - 1].node) {
      throw new Invalid(`step ${i}'s parent is not the node of the step before`);
    }
  });
}

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let set = map.get(key);
  if (!set) map.set(key, set = new Set());
  set.add(value);
}

function drop<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}
