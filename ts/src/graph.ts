// The bare graph (CORE.tex, The core). It holds nodes, reached by address
// from the root the host gives; applies changes, sends them to the
// subscriptions whose address reaches the node or that they switch;
// remembers what each process's runs read, and marks the processes a change
// touches. It never runs anything, and it never removes a node: one that no
// place reachable from the root holds cannot be addressed, and placing its id
// again brings it back as it was.

import {
  isName,
  members,
  parseAddress,
  type Parsed,
  type Track,
  type View,
  walk,
  type Walked,
} from "./address.ts";
import {
  applyPatches,
  byCodePoint,
  isObject,
  NotJson,
  own,
  ownField,
  placed,
  whole,
} from "./patch.ts";
import {
  type Acting,
  type Address,
  type Binding,
  type Bound,
  capture,
  type Change,
  type Changed,
  type ChangeRef,
  type Common,
  type DirectoryOp,
  type Ending,
  ErmineError,
  type Event,
  type Finishing,
  type Id,
  type Interface,
  invalid,
  type Json,
  type Listing,
  type Lookup,
  type LookupOp,
  type Marked,
  missing,
  naming,
  ours,
  type Patch,
  type PlaceOp,
  type Program,
  type ProgramEntry,
  type ReadEntry,
  type ReadOp,
  type Record,
  type RecordError,
  type Recording,
  Refused,
  type Route,
  type Searched,
  type SlotFrom,
  type SlotItem,
  type Stamp,
  type Step,
  type SubscribeOp,
  told,
  type UnplaceOp,
  type UnsubscribeOp,
  type ValueItem,
  type WriteOp,
  wrongField,
} from "./types.ts";

ours(import.meta.url);

type Node = {
  value: Json;
  /** the change that last set the value: the placement that made it, or a write; none for the root's first */
  change?: Change;
  /** name to slot; a slot with no ids is gone */
  directory: Map<string, Id[]>;
  /** the change that last set each slot */
  slots: Map<string, Change>;
};

/** One run being recorded. */
type Run = {
  process: Id;
  /** the agent, process and place of the interface it records */
  acting: Acting;
  open: boolean;
  marked: ChangeRef[];
  compute?: ProgramEntry;
  effect?: ProgramEntry;
  lookups: Lookup[];
  reads: ReadEntry[];
  changes: ChangeRef[];
  errors: RecordError[];
  /** what its reads depend on, as keys of readers */
  deps: Set<string>;
  values: Set<Id>;
  nodes: Set<Id>;
};

/** What a lookup reports to the recording that made it: what it searched, and how far. */
type Frame = { done: boolean; searched: Searched[]; levels: number };

type Sub = { sub: number; op: Acting; parsed: Parsed; node?: Id; send: (event: Event) => void };

const ENDINGS = new Set(["done", "pending", "failed", "refused"]);

/** The keys of what a read depends on: a value, a slot, a whole directory, whether a node is here. */
const key = {
  value: (node: Id) => JSON.stringify(["v", node]),
  slot: (node: Id, name: string) => JSON.stringify(["s", node, name]),
  directory: (node: Id) => JSON.stringify(["d", node]),
  here: (node: Id) => JSON.stringify(["h", node]),
};

/** A graph made with one node, its root, whose value is null. */
export function graph(root: Id): Interface {
  if (typeof root !== "string") throw wrongField("root", "the root is an id, a string");
  const nodes = new Map<Id, Node>();
  nodes.set(root, { value: null, directory: new Map(), slots: new Map() });
  let last = 0;

  const view: View = {
    here: (id) => nodes.has(id),
    slot: (id, name) => nodes.get(id)?.directory.get(name) ?? [],
  };

  const subs = new Map<number, Sub>();
  let nextSub = 1;

  // what each process's reads depend on: its last finished run's and its open run's
  const memory = new Map<Id, Set<string>>();
  const readers = new Map<string, Set<Id>>();
  const runs = new Map<Id, number>();
  const tracing: Frame[] = [];

  const bindings = new WeakMap<object, Acting>();
  const recordings = new WeakMap<object, Run>();

  let up: Interface;

  // places and addresses

  /** The start of an operation's place, its "/", if it reaches one, and the names below it. */
  function placeOf(op: Acting, track?: Track): { start?: Id; names: readonly string[] } {
    const place = op.place ?? [];
    const n = op.chroot ?? 0;
    const start = n === 0 ? root : walk(view, root, place.slice(0, n), track).node;
    return { start, names: place.slice(n) };
  }

  /** The node an address starts from: its place, or its start, gone up as it says. */
  function origin(op: Acting, parsed: Parsed, track?: Track): Id | undefined {
    const { start, names } = placeOf(op, track);
    const base = parsed.root ? [] : names;
    if (parsed.up > base.length) {
      throw invalid("above-root", "the address goes up past the start of the place");
    }
    if (start === undefined) return undefined;
    return walk(view, start, base.slice(0, base.length - parsed.up), track).node;
  }

  function resolve(op: Acting, parsed: Parsed, track?: Track): Walked {
    const from = origin(op, parsed, track);
    return from === undefined ? { route: [] } : walk(view, from, parsed.names, track);
  }

  /** The node an address reaches, for a write or a placement: invalid if none. */
  function target(op: Acting, parsed: Parsed): { id: Id; node: Node } {
    const id = resolve(op, parsed).node;
    if (id === undefined) throw invalid("nothing-there", "the address reaches nothing");
    return { id, node: nodes.get(id)! };
  }

  // items

  function valueItems(w: Walked): ValueItem[] {
    if (w.node === undefined) return [];
    const node = nodes.get(w.node)!;
    const item: ValueItem = { value: node.value, from: { route: w.route } };
    if (node.change) item.change = node.change;
    return [item];
  }

  function slotItems(parent: Id, name: string, route: Route): SlotItem[] {
    const node = nodes.get(parent)!;
    const slot = node.directory.get(name);
    if (!slot) return [];
    const change = node.slots.get(name)!;
    return slot.map((id, position) => {
      const item: SlotItem = { id, from: { route, position }, change };
      if (!nodes.has(id)) item.pending = true;
      return item;
    });
  }

  // reads

  function read(op: ReadOp): ValueItem[] {
    acting(op);
    return valueItems(resolve(op, parseAddress(op.address)));
  }

  function directory(op: DirectoryOp): Listing {
    acting(op);
    const parsed = parseAddress(op.address);
    if (op.name !== undefined && !isName(op.name)) throw wrongField("name", "a name is a string");
    const from = origin(op, parsed);
    const all = from === undefined ? [] : members(view, from, parsed.names);
    const name = op.name;
    if (name !== undefined) return { items: all.flatMap((m) => slotItems(m.node, name, m.route)) };
    const names = new Set<string>();
    for (const m of all) for (const n of nodes.get(m.node)!.directory.keys()) names.add(n);
    const union = (n: string) => all.flatMap((m) => slotItems(m.node, n, m.route));
    return { directory: [...names].sort(byCodePoint).map((n) => [n, union(n)]) };
  }

  /**
   * Searches from the place's directory up to its start, each step an
   * ordinary read of one slot through the top of the stack, and takes the
   * nearest slot with the name. A refused step ends the search.
   */
  function lookup(op: LookupOp): SlotItem[] {
    acting(op);
    if (op.name === undefined) throw missing("name");
    if (!isName(op.name)) throw wrongField("name", "a name is a string");
    const name = op.name;
    const { start, names } = placeOf(op);
    const as = who(op);
    const searched: Searched[] = [];
    let levels = 0;
    let found: SlotItem[] = [];
    for (let k = 0; k <= names.length; k++) {
      levels = k + 1;
      const node = start === undefined
        ? undefined
        : walk(view, start, names.slice(0, names.length - k)).node;
      const address = Array.from({ length: k }, () => "..");
      let listing: Listing;
      try {
        listing = up.directory({ ...as, address, name });
      } catch (e) {
        if (e instanceof Refused) {
          if (node !== undefined) searched.push({ node, refused: true });
          break;
        }
        throw e;
      }
      const items = "items" in listing ? listing.items : [];
      if (node !== undefined) searched.push({ node, saw: latest(items) });
      if (items.length) {
        found = items.map((item) => ({
          ...item,
          from: { path: [...address, name], position: (item.from as SlotFrom).position },
        }));
        break;
      }
    }
    const frame = tracing[tracing.length - 1];
    if (frame && !frame.done) Object.assign(frame, { done: true, searched, levels });
    return found;
  }

  /** The node an address reaches, for a wrapper deciding about an operation. */
  function reach(op: Acting & { address: Address }): Id | undefined {
    acting(op);
    return resolve(op, parseAddress(op.address)).node;
  }

  // changes

  /** A change's time and cause: a cause given, or, from outside any process, its site. */
  function stamp(op: Acting & Stamp, entry: "write" | "place" | "unplace") {
    if (op.time === undefined) throw missing("time");
    if (typeof op.time !== "number" || !Number.isInteger(op.time)) {
      throw wrongField("time", "a time is a whole number");
    }
    let cause: Json | undefined;
    if (op.cause !== undefined) cause = ownField(op.cause, "cause");
    else if (op.process === undefined) {
      const site = capture(up?.[entry]);
      if (!site) throw missing("cause");
      cause = site;
    }
    return { time: op.time, cause };
  }

  function checkTime(time: number) {
    if (time <= last) throw invalid("time", `time ${time} is not after ${last}`, { last });
  }

  /** agent, process and cause, as a change carries them */
  function common(op: Acting, cause: Json | undefined): Common {
    const c: Common = { agent: own(op.agent) };
    if (op.process !== undefined) c.process = op.process;
    if (cause !== undefined) c.cause = cause;
    return c;
  }

  function apply(change: Change): Changed {
    last = change.time;
    Object.freeze(change);
    const marked = marks(change);
    follow(change);
    return { change, marked };
  }

  function write(op: WriteOp): Changed {
    acting(op);
    const parsed = parseAddress(op.address);
    if (op.patches === undefined) throw missing("patches");
    if (!Array.isArray(op.patches)) throw wrongField("patches", "patches are a list");
    const { time, cause } = stamp(op, "write");
    const { id, node } = target(op, parsed);
    const value = applyPatches(node.value, op.patches);
    const patches = op.patches.map((patch, index) => {
      try {
        return own(patch) as Patch;
      } catch (e) {
        if (e instanceof NotJson) throw invalid("not-a-patch", e.message, { index });
        throw e;
      }
    });
    checkTime(time);
    const change: Change = { node: id, time, kind: "write", patches, ...common(op, cause) };
    node.value = value;
    node.change = change;
    return apply(change);
  }

  function place(op: PlaceOp): Changed {
    acting(op);
    const parsed = parseAddress(op.address);
    const { name, id } = slotFields(op);
    if (op.position !== undefined && !whole(op.position)) {
      throw wrongField("position", "a position is a whole number");
    }
    const making = op.value !== undefined;
    const value = making ? ownField(op.value, "value") : undefined;
    const { time, cause } = stamp(op, "place");
    const { id: at, node: parent } = target(op, parsed);
    if (making && nodes.has(id)) {
      throw invalid("exists", `the graph has ${JSON.stringify(id)}; a value makes a node`);
    }
    const slot = parent.directory.get(name) ?? [];
    if (op.position !== undefined && op.position > slot.length) {
      throw invalid("position", `position ${op.position} is past the slot's ${slot.length}`, {
        length: slot.length,
      });
    }
    checkTime(time);
    const change = { node: at, time, kind: "place", name, id } as Change & {
      position?: number;
      value?: Json;
    };
    if (op.position !== undefined) change.position = op.position;
    if (making) change.value = value;
    Object.assign(change, common(op, cause));
    if (making) nodes.set(id, { value: value!, change, directory: new Map(), slots: new Map() });
    parent.directory.set(name, placed(slot, id, op.position));
    parent.slots.set(name, change);
    return apply(change);
  }

  function unplace(op: UnplaceOp): Changed {
    acting(op);
    const parsed = parseAddress(op.address);
    const { name, id } = slotFields(op);
    const { time, cause } = stamp(op, "unplace");
    const { id: at, node: parent } = target(op, parsed);
    const slot = parent.directory.get(name) ?? [];
    if (!slot.includes(id)) {
      throw invalid("not-in-slot", `${JSON.stringify(id)} is not in slot ${JSON.stringify(name)}`);
    }
    checkTime(time);
    const change: Change = { node: at, time, kind: "unplace", name, id, ...common(op, cause) };
    const next = slot.filter((x) => x !== id);
    if (next.length) parent.directory.set(name, next);
    else parent.directory.delete(name);
    parent.slots.set(name, change);
    return apply(change);
  }

  // marking

  function marks(change: Change): Marked[] {
    const found = new Set<Id>();
    const take = (k: string) => readers.get(k)?.forEach((p) => found.add(p));
    if (change.kind === "write") take(key.value(change.node));
    else {
      take(key.slot(change.node, change.name));
      take(key.directory(change.node));
      if (change.kind === "place" && change.value !== undefined) take(key.here(change.id));
    }
    const by = { node: change.node, time: change.time };
    return [...found].sort(byCodePoint).map((process) => ({ process, by }));
  }

  // subscriptions

  function send(s: Sub, event: Event) {
    if (subs.get(s.sub) !== s) return;
    try {
      s.send(event);
    } catch (e) {
      // the change stands; the subscriber's trouble is reported apart
      queueMicrotask(() => {
        throw e;
      });
    }
  }

  /** Follows every subscription's address, and sends the change where it reaches or switched. */
  function follow(change: Change) {
    const due: Sub[] = [];
    for (const s of subs.values()) {
      const before = s.node;
      if (change.kind !== "write") s.node = resolve(s.op, s.parsed).node;
      if (s.node !== before || change.node === before) due.push(s);
    }
    for (const s of due) send(s, { change });
  }

  function subscribe(op: SubscribeOp): { sub: number } {
    acting(op);
    const parsed = parseAddress(op.address);
    if (typeof op.send !== "function") throw wrongField("send", "subscribe needs a send function");
    const as = who(op);
    if (as.place) as.place = [...as.place];
    const node = resolve(as, parsed).node;
    const sub = nextSub++;
    subs.set(sub, { sub, op: as, parsed, node, send: op.send });
    return { sub };
  }

  function unsubscribe(op: UnsubscribeOp): void {
    acting(op);
    if (op.sub === undefined) throw missing("sub");
    if (!subs.has(op.sub)) throw wrongField("sub", `there is no subscription ${op.sub}`);
    subs.delete(op.sub);
  }

  // binding

  function bind(api: Interface, binding: Binding): Bound {
    if (!isObject(binding)) throw wrongField("binding", "bind needs a binding");
    const as = who(binding);
    acting(as);
    as.agent = own(as.agent);
    if (as.place) as.place = Object.freeze([...as.place]);
    const writes = !!binding.writes;
    const reads = binding.reads !== false;
    let ended = false;
    const fail = (code: string, text: string, op: string) => {
      const e = invalid(code, `${op}: ${text}`);
      e.op = op;
      return e;
    };
    const open = (op: string, part?: "reads" | "writes") => {
      if (ended) throw fail("stopped", "this interface has stopped working", op);
      if (part === "writes" && !writes) throw fail("read-only", "this interface only reads", op);
      if (part === "reads" && !reads) throw fail("write-only", "this interface only writes", op);
    };
    const fix = <T extends Acting>(op: T): T => ({ ...strip(op), ...as });
    const none = (op: string) => () => {
      throw fail("wrong-part", `a bound interface cannot ${op} runs`, op);
    };
    const bound: Bound = {
      write: (op) => (open("write", "writes"), api.write(fix(op))),
      place: (op) => (open("place", "writes"), api.place(fix(op))),
      unplace: (op) => (open("unplace", "writes"), api.unplace(fix(op))),
      read: (op) => (open("read", "reads"), api.read(fix(op))),
      directory: (op) => (open("directory", "reads"), api.directory(fix(op))),
      lookup: (op) => (open("lookup", "reads"), api.lookup(fix(op))),
      subscribe: (op) => (open("subscribe"), api.subscribe(fix(op))),
      unsubscribe: (op) => (open("unsubscribe"), api.unsubscribe(fix(op))),
      // the holder cannot change the agent, process or place, nor do more than this does
      bind: (inner, b) => {
        open("bind");
        if (!isObject(b)) throw fail("wrong-field", "bind needs a binding", "bind");
        const kept: Binding = {
          ...strip(b as Binding & Acting),
          ...as,
          writes: !!b.writes && writes,
        };
        if (!reads) kept.reads = false;
        return api.bind(inner, kept);
      },
      // runs are recorded and finished by whoever holds the stack, not by a run
      record: none("record"),
      finish: none("finish"),
      top: () => {
        throw fail("wrong-part", "a bound interface cannot change the top of the stack", "top");
      },
      cwd: Object.freeze((as.place ?? []).slice(as.chroot ?? 0)),
      end: () => {
        ended = true;
      },
    };
    bindings.set(bound, as);
    return bound;
  }

  // recording

  function depend(state: Run, k: string, node?: Id, value = false) {
    state.deps.add(k);
    let mine = memory.get(state.process);
    if (!mine) memory.set(state.process, mine = new Set());
    if (!mine.has(k)) {
      mine.add(k);
      add(readers, k, state.process);
    }
    if (node !== undefined) {
      state.nodes.add(node);
      if (value) state.values.add(node);
    }
  }

  function tracker(state: Run): Track {
    return {
      slot: (node, name) => depend(state, key.slot(node, name), node),
      here: (id) => depend(state, key.here(id)),
    };
  }

  /**
   * Remembers what a read through a recording depends on: every slot each
   * walk tried, the place's included, and the value or slots it reached.
   * Gives the route, or undefined if the address reads nothing at all.
   */
  function trace(state: Run, kind: "read" | "directory", op: DirectoryOp): Step[] | undefined {
    let parsed: Parsed;
    try {
      parsed = parseAddress(op?.address);
    } catch {
      return;
    }
    const at = { ...op, ...state.acting };
    const track = tracker(state);
    let from: Id | undefined;
    try {
      from = origin(at, parsed, track);
    } catch {
      return;
    }
    if (from === undefined) return [];
    if (kind === "read") {
      const w = walk(view, from, parsed.names, track);
      if (w.node !== undefined) depend(state, key.value(w.node), w.node, true);
      return w.route;
    }
    const all = members(view, from, parsed.names, track);
    for (const m of all) {
      const k = op.name === undefined ? key.directory(m.node) : key.slot(m.node, op.name);
      depend(state, k, m.node);
    }
    return all[0]?.route ?? [];
  }

  /** Remembers the slots a lookup searched, up to where it stopped. */
  function traceLookup(state: Run, op: LookupOp, frame: Frame) {
    if (!isName(op?.name)) return;
    const at = { ...op, ...state.acting };
    const track = tracker(state);
    const { start, names } = placeOf(at, track);
    if (start === undefined) return;
    const levels = frame.done ? frame.levels : names.length + 1;
    for (let k = 0; k < levels; k++) {
      const node = walk(view, start, names.slice(0, names.length - k), track).node;
      if (node !== undefined) depend(state, key.slot(node, op.name), node);
    }
  }

  function record(api: Interface, marked: readonly ChangeRef[]): Recording {
    const as = bindings.get(api);
    if (!as || as.process === undefined) {
      throw wrongField("api", "record needs an interface bound to a process");
    }
    if (!Array.isArray(marked)) {
      throw wrongField("marked", "record needs the changes that marked the run");
    }
    const process = as.process;
    const run = (runs.get(process) ?? 0) + 1;
    runs.set(process, run);
    const state: Run = {
      process,
      acting: as,
      open: true,
      marked: marked.map((c) => ({ node: c.node, time: c.time })),
      lookups: [],
      reads: [],
      changes: [],
      errors: [],
      deps: new Set(),
      values: new Set(),
      nodes: new Set(),
    };

    const attempt = <T>(op: string, fn: () => T): T => {
      if (!state.open) {
        const e = invalid("stopped", `${op}: this run has finished`);
        e.op = op;
        throw e;
      }
      try {
        return fn();
      } catch (e) {
        if (e instanceof ErmineError) {
          state.errors.push(e.op === undefined ? { kind: e.kind, op, why: e.why } : e.toJSON());
        }
        throw e;
      }
    };
    const changed = (answer: Changed) => {
      state.changes.push({ node: answer.change.node, time: answer.change.time });
      return answer;
    };
    /** A read through a recording: recorded, and remembered, if it read or was refused. */
    const reading = <T extends ValueItem[] | Listing>(
      kind: "read" | "directory",
      op: DirectoryOp,
      fn: () => T,
    ): T =>
      attempt(kind, () => {
        let got: T | undefined;
        let refused = false;
        try {
          got = fn();
          return got;
        } catch (e) {
          refused = e instanceof Refused;
          throw e;
        } finally {
          if (got !== undefined || refused) {
            const route = trace(state, kind, op);
            if (route) {
              state.reads.push({
                op: kind,
                address: [...op.address],
                ...(kind === "directory" && op.name !== undefined ? { name: op.name } : {}),
                route,
                saw: got === undefined ? null : sawOf(got),
                ...(refused ? { refused: true as const } : {}),
              });
            }
          }
        }
      });

    const recorded = (inner: Interface): Interface => ({
      write: (op) => attempt("write", () => changed(inner.write(op))),
      place: (op) => attempt("place", () => changed(inner.place(op))),
      unplace: (op) => attempt("unplace", () => changed(inner.unplace(op))),
      read: (op) => reading("read", op, () => inner.read(op)),
      directory: (op) => reading("directory", op, () => inner.directory(op)),
      lookup: (op) =>
        attempt("lookup", () => {
          const frame: Frame = { done: false, searched: [], levels: 0 };
          tracing.push(frame);
          let found: SlotItem[] | undefined;
          let refused = false;
          try {
            found = inner.lookup(op);
          } catch (e) {
            refused = e instanceof Refused;
            throw e;
          } finally {
            tracing.splice(tracing.lastIndexOf(frame), 1);
            if (found !== undefined || refused) traceLookup(state, op, frame);
          }
          state.lookups.push({
            name: op.name,
            searched: frame.searched,
            found: found!.map((i) => i.id),
          });
          return found!;
        }),
      subscribe: (op) => attempt("subscribe", () => inner.subscribe(op)),
      unsubscribe: (op) => attempt("unsubscribe", () => inner.unsubscribe(op)),
      bind: (a, b) => attempt("bind", () => inner.bind(a, b)),
      record: (a, m) => attempt("record", () => inner.record(a, m)),
      finish: (r, ending, f) => attempt("finish", () => inner.finish(r, ending, f)),
      top: () => {
        throw invalid("wrong-part", "a recording cannot change the top of the stack");
      },
      cwd: inner.cwd,
    });

    function program(part: "compute" | "effect", at: Address): Program | undefined {
      if (part !== "compute" && part !== "effect") {
        throw wrongField("part", "a program is in the compute or effect slot");
      }
      parseAddress(at, "at");
      const slotOp = { address: at, name: part };
      let listing: Listing;
      try {
        listing = attempt("directory", () => api.directory(slotOp));
      } finally {
        trace(state, "directory", slotOp);
      }
      const items = "items" in listing ? listing.items : [];
      if (!items.length) return undefined;
      const slot = items.map((item) => item.id);
      const used = items.find((item) => !item.pending);
      if (!used) {
        state[part] = { node: slot[0], saw: null, slot };
        return { slot, items: [] };
      }
      const readOp = { address: [...at, part] };
      let values: ValueItem[];
      try {
        values = attempt("read", () => api.read(readOp));
      } catch (e) {
        if (e instanceof Refused) state[part] = { node: used.id, refused: true, slot };
        throw e;
      } finally {
        trace(state, "read", readOp);
      }
      state[part] = { node: used.id, saw: values[0]?.change?.time ?? null, slot };
      return { node: used.id, slot, items: values };
    }

    const recording: Recording = {
      ...recorded(api),
      process,
      agent: as.agent as Json,
      run,
      reads: state.reads,
      lookups: state.lookups,
      changes: state.changes,
      errors: state.errors,
      values: state.values,
      nodes: state.nodes,
      through: recorded,
      program,
    };
    recordings.set(recording, state);
    return recording;
  }

  function finish(recording: Recording, ending: Ending, finishing: Finishing = {}): Record {
    const state = recordings.get(recording);
    if (!state) throw wrongField("recording", "finish needs a recording of this graph");
    if (!state.open) throw invalid("stopped", "this run has finished");
    if (!ENDINGS.has(ending)) {
      throw wrongField("ending", `a run cannot end ${JSON.stringify(ending)}`);
    }
    state.open = false;
    // this run's reads replace the last run's
    const mine = memory.get(state.process) ?? new Set();
    for (const k of mine) if (!state.deps.has(k)) drop(readers, k, state.process);
    memory.set(state.process, new Set(state.deps));
    const r = { process: state.process, run: recording.run, agent: recording.agent } as Record;
    r.marked = state.marked;
    if (state.compute) r.compute = state.compute;
    if (state.effect) r.effect = state.effect;
    r.lookups = [...state.lookups];
    r.reads = [...state.reads];
    if (finishing.value !== undefined) r.value = own(finishing.value);
    r.cleanup = (finishing.cleanup ?? []).map((c) => ({ node: c.node, time: c.time }));
    r.changes = [...state.changes];
    r.ending = ending;
    r.errors = [...state.errors, ...finishing.errors ?? []];
    for (const s of [...subs.values()]) if (s.node === state.process) send(s, { record: r });
    return r;
  }

  const api: Interface = {
    read: naming("read", read),
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
    cwd: Object.freeze([]),
    reach: naming("reach", reach),
  };
  up = api;
  return api;
}

/**
 * Checks that an operation says who makes it, and where, before anything is
 * done (PROTOCOL.tex, Acting as someone): an agent, any JSON value; a process,
 * an id; a place, a list of names; a chroot, counting names of the place.
 * Missing or wrong-field, naming the field, otherwise.
 */
export function acting(op: Acting) {
  if (!isObject(op)) throw wrongField("operation", "an operation is an object");
  if (op.agent === undefined) throw missing("agent");
  ownField(op.agent, "agent");
  if (op.process !== undefined && typeof op.process !== "string") {
    throw wrongField("process", "a process is an id, a string");
  }
  if (op.place !== undefined && (!Array.isArray(op.place) || !op.place.every(isName))) {
    throw wrongField("place", "a place is a list of names");
  }
  if (op.chroot !== undefined && (!whole(op.chroot) || op.chroot > (op.place?.length ?? 0))) {
    throw wrongField("chroot", "chroot counts names of the place");
  }
}

/** The agent, process and place of an operation, as another operation carries them. */
function who(op: Acting): Acting {
  const as: Acting = { agent: op.agent };
  if (op.process !== undefined) as.process = op.process;
  if (op.place !== undefined) as.place = op.place;
  if (op.chroot !== undefined) as.chroot = op.chroot;
  return as;
}

function strip<T extends Acting>(op: T): T {
  const { agent: _a, process: _p, place: _l, chroot: _c, ...rest } = op;
  return rest as T;
}

/** A placement's name and id: missing or wrong-field before anything else is looked at. */
function slotFields(op: { name?: unknown; id?: unknown }): { name: string; id: Id } {
  if (op.name === undefined) throw missing("name");
  if (!isName(op.name)) throw wrongField("name", 'a name is a string, never ".", ".." or "/"');
  if (op.id === undefined) throw missing("id");
  if (typeof op.id !== "string") throw wrongField("id", "an id is a string");
  return { name: op.name, id: op.id };
}

/** The time of the latest change among the items, null if none. */
function latest(items: readonly { change?: Change }[]): number | null {
  let t: number | null = null;
  for (const item of items) {
    const time = item.change?.time;
    if (time !== undefined && (t === null || time > t)) t = time;
  }
  return t;
}

/** What a read saw: the change that made what it read; the latest, for a directory. */
function sawOf(got: ValueItem[] | Listing): number | null {
  if (Array.isArray(got)) return latest(got);
  if ("items" in got) return latest(got.items);
  return latest(got.directory.flatMap(([, items]) => items));
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
