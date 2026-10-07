// The bare graph (CORE.tex, The core). It holds nodes, reached by address
// from the root the host gives; applies changes, sends them to the
// subscriptions whose address reaches the node or whose route they change;
// remembers what each process's runs read, and marks the processes a change
// touches. It never runs anything, and it never removes an ordinary node: one
// that no place reachable from the root holds cannot be addressed, and placing
// its id again brings it back as it was. An ephemeral node is in one slot,
// the one it was made in, and goes as soon as it is unplaced from it, the
// ephemeral nodes it held going first (CORE.tex, Ephemeral nodes).
//
// An operation is checked where, then when, then what (PROTOCOL.tex, Errors):
// its fields first, in the order fields() gives; then its address
// (above-root, nothing-there); then its time; then the change itself.

import {
  back,
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
  applyPatch,
  byCodePoint,
  isLive,
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
  type ForgetOp,
  type Header,
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
  type RefusedItem,
  type ReleaseOp,
  type Route,
  type Searched,
  type SlotFrom,
  type SlotItem,
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
  /** made so by the placement that made it; it stays so */
  ephemeral?: true;
  /** an ephemeral node's one slot, the one it was made in: its parent and the slot's name */
  home?: { node: Id; name: string };
  /** the header of the change that last set the value: the placement that made it, or a write; none for the root's first */
  change?: Header;
  /** name to slot; a slot with no ids is gone */
  directory: Map<string, Id[]>;
  /** the header of the last change to each slot that was not ephemeral */
  slots: Map<string, Header>;
  /** the ids in each slot that an ephemeral change put there: what keeping the graph drops */
  fleeting: Map<string, Set<Id>>;
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

/** Where an address got to: the node it reaches, and the route it took there. */
type Located = { node: Id; route: Step[] };

/** A subscription: who made it and where, its address, and where that is now, if anywhere. */
type Sub = { sub: number; op: Acting; parsed: Parsed; at?: Located; send: (event: Event) => void };

const ENDINGS = new Set(["done", "pending", "failed", "refused"]);

/** The keys of what a read depends on: a value, a slot, a whole directory, whether a node is here. */
const key = {
  value: (node: Id) => JSON.stringify(["v", node]),
  slot: (node: Id, name: string) => JSON.stringify(["s", node, name]),
  directory: (node: Id) => JSON.stringify(["d", node]),
  here: (node: Id) => JSON.stringify(["h", node]),
};

/** The bare graph: the interface, and what only whoever holds it can do. */
export type Graph = Interface & {
  /**
   * The graph as keeping it and loading it again would leave it
   * (PROTOCOL.tex, reload): every ordinary node with its value, its slots
   * without the ids ephemeral changes put there, and their last changes;
   * no ephemeral node, subscription or kept read. The highest time stays.
   */
  reload(): void;
  /** Unplaces an ephemeral node from its one slot, by its id (Interface.release). */
  release(op: ReleaseOp): Changed;
};

const node = (value: Json, change?: Header, ephemeral?: boolean): Node => ({
  value,
  ...(ephemeral ? { ephemeral: true as const } : {}),
  ...(change ? { change } : {}),
  directory: new Map(),
  slots: new Map(),
  fleeting: new Map(),
});

/** The largest time: 2^53 - 1. */
const LATEST = Number.MAX_SAFE_INTEGER;

/**
 * What whoever keeps the graph keeps (CORE.tex, What the graph holds): its
 * ordinary nodes, each with its value, its slots without the ids ephemeral
 * changes put there, and their last changes; and the highest time.
 */
export type Kept = {
  root: Id;
  time: number;
  nodes: ReadonlyMap<Id, KeptNode>;
};
export type KeptNode = {
  value: Json;
  change?: Header;
  directory: ReadonlyMap<string, readonly Id[]>;
  slots: ReadonlyMap<string, Header>;
};

/**
 * A graph made with one node, its root, whose value is null; or, given what
 * was kept, the graph as loading it leaves it: those nodes, and times after
 * its highest. Only whoever makes the graph gives it.
 */
export function graph(root: Id, kept?: Kept): Graph {
  if (typeof root !== "string") throw wrongField("root", "the root is an id, a string");
  const nodes = new Map<Id, Node>();
  nodes.set(root, node(null));
  let last = 0;
  /** for every id in any slot, the slots that hold it, by their reader keys: found, not walked */
  const holders = new Map<Id, Set<string>>();
  if (kept !== undefined) {
    if (kept.root !== root || !kept.nodes.has(root)) {
      throw wrongField("kept", "what was kept is of a graph with another root");
    }
    for (const [id, k] of kept.nodes) {
      const n = node(k.value, k.change);
      for (const [name, ids] of k.directory) {
        if (!ids.length) continue;
        n.directory.set(name, [...ids]);
        for (const held of ids) add(holders, held, key.slot(id, name));
        const change = k.slots.get(name);
        if (change) n.slots.set(name, change);
      }
      nodes.set(id, n);
    }
    last = kept.time;
  }

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

  /**
   * The node an address starts from: "/" starts at the start of the place;
   * otherwise the address starts at the node the place reaches, and each
   * ".." goes back one step the way the place was reached, to the node the
   * place's walk came through, never above its start. Undefined when the
   * start reaches nothing, or the place's walk does not get that far.
   */
  function origin(op: Acting, parsed: Parsed, track?: Track): Id | undefined {
    const { start, names } = placeOf(op, track);
    if (parsed.up > (parsed.root ? 0 : names.length)) {
      throw invalid("above-root", "the address goes back past the start of the place");
    }
    if (start === undefined) return undefined;
    return parsed.root ? start : back(view, start, names, parsed.up, track);
  }

  function resolve(op: Acting, parsed: Parsed, track?: Track): Walked {
    const from = origin(op, parsed, track);
    return from === undefined ? { route: [] } : walk(view, from, parsed.names, track);
  }

  /** The node an address reaches and the route it took, if it reaches one. */
  function locate(op: Acting, parsed: Parsed): Located | undefined {
    const w = resolve(op, parsed);
    return w.node === undefined ? undefined : { node: w.node, route: w.route };
  }

  /** The node an address reaches, for a change: invalid if none. */
  function target(op: Acting, parsed: Parsed): { id: Id; node: Node } {
    const id = resolve(op, parsed).node;
    if (id === undefined) throw invalid("nothing-there", "the address reaches nothing");
    return { id, node: nodes.get(id)! };
  }

  // items

  function valueItem(m: Located): ValueItem {
    const node = nodes.get(m.node)!;
    const item: ValueItem = { value: node.value, from: { route: m.route } };
    if (node.change) item.change = node.change;
    if (node.ephemeral) item.ephemeral = true;
    return item;
  }

  function slotItems(parent: Id, name: string, route: Route): SlotItem[] {
    const node = nodes.get(parent)!;
    const slot = node.directory.get(name);
    if (!slot) return [];
    const change = node.slots.get(name);
    return slot.map((id, position) => {
      const item: SlotItem = { id, from: { route, position } };
      if (change) item.change = change;
      const here = nodes.get(id);
      if (!here) item.pending = true;
      else if (here.ephemeral) item.ephemeral = true;
      return item;
    });
  }

  // reads

  /** What reading an address gives, with no checks: for a subscription's rows. */
  function reading(op: Acting, parsed: Parsed): ValueItem[] {
    let from: Id | undefined;
    try {
      from = origin(op, parsed);
    } catch {
      return [];
    }
    return from === undefined ? [] : members(view, from, parsed.names).map(valueItem);
  }

  /**
   * An item for each node the address's last name selects that is here, in
   * slot order, each with its own value, route and change: the first is the
   * node the address reaches. An address with no names reads the one node it
   * starts from; one that reaches nothing reads as none.
   */
  function read(op: ReadOp): ValueItem[] {
    const { parsed } = fields("read", op);
    const from = origin(op, parsed!);
    return from === undefined ? [] : members(view, from, parsed!.names).map(valueItem);
  }

  function directory(op: DirectoryOp): Listing {
    const { parsed, name } = fields("directory", op);
    const from = origin(op, parsed!);
    const all = from === undefined ? [] : members(view, from, parsed!.names);
    if (name !== undefined) return { items: all.flatMap((m) => slotItems(m.node, name, m.route)) };
    const names = new Set<string>();
    for (const m of all) for (const n of nodes.get(m.node)!.directory.keys()) names.add(n);
    const union = (n: string) => all.flatMap((m) => slotItems(m.node, n, m.route));
    return { directory: [...names].sort(byCodePoint).map((n) => [n, union(n)]) };
  }

  /**
   * Searches the directories the place's walk went through, from the one it
   * reaches, ".", back up to its start, each step an ordinary read of one
   * slot through the top of the stack, at the address of that many "..", and
   * takes the nearest slot with the name that holds a node that is here: all
   * its items. A slot whose ids are all absent is passed over. A refused step
   * ends the search, which then gives one item saying so, from the path to
   * that directory. Where the place's walk did not get, its step reads
   * nothing.
   */
  function lookup(op: LookupOp): (SlotItem | RefusedItem)[] {
    const name = fields("lookup", op).name!;
    const { start, names } = placeOf(op);
    const route = start === undefined ? [] : walk(view, start, names).route;
    const as = who(op);
    const searched: Searched[] = [];
    let levels = 0;
    let found: (SlotItem | RefusedItem)[] = [];
    for (let k = 0; k <= names.length; k++) {
      levels = k + 1;
      const depth = names.length - k;
      const node = depth === 0 ? start : route[depth - 1]?.node;
      const address = Array.from({ length: k }, () => "..");
      let listing: Listing;
      try {
        listing = up.directory({ ...as, address, name });
      } catch (e) {
        if (e instanceof Refused) {
          if (node !== undefined) searched.push({ node, refused: true });
          found = [{ refused: true, from: { path: address } }];
          break;
        }
        throw e;
      }
      const items = "items" in listing ? listing.items : [];
      if (node !== undefined) searched.push({ node, saw: latest(items) });
      if (items.some((item) => !item.pending)) {
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

  /**
   * The node an address reaches, and the nodes whose directories the walk of
   * its own names read, for a wrapper deciding about an operation. Following
   * the place to where the address starts is not part of it.
   */
  function reach(op: Acting & { address: Address }): { node?: Id; read: Id[] } {
    acting(op);
    const parsed = parseAddress(op.address);
    const from = origin(op, parsed);
    const read: Id[] = [];
    if (from === undefined) return { read };
    const track: Track = {
      slot: (node) => {
        if (!read.includes(node)) read.push(node);
      },
      here: () => {},
    };
    const node = parsed.names.length ? members(view, from, parsed.names, track)[0]?.node : from;
    return node === undefined ? { read } : { node, read };
  }

  // changes

  /**
   * The cause of a change that gives none, asked for in the cause's turn: a
   * process's change has none unless its program gives one; one from outside
   * any process has its site, captured where it entered the stack.
   */
  function causeOf(op: Acting, entry: "write" | "place" | "unplace") {
    return (): Json | undefined => {
      if (op.process !== undefined) return undefined;
      const site = capture(up?.[entry]);
      if (!site) throw missing("cause");
      return site;
    };
  }

  /** A change's time is greater than every time in the graph. */
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

  /** The change as an item carries it: without its patches or a placement's value. */
  function header(change: Change): Header {
    const { patches: _p, value: _v, ...rest } = change as Change & {
      patches?: unknown;
      value?: unknown;
    };
    return Object.freeze(rest) as Header;
  }

  /**
   * What one operation marked so far, each process with the first change
   * that marked it; and each change it made, with the processes that change
   * marked, for a scheduler that keeps every change that marks a process.
   */
  type Marking = Map<Id, number> & { made?: Made[] };

  /** Applies a change made: freezes it, marks its readers, sends it to subscribers. */
  function apply(change: Change, marking: Marking, here: Id[] = []) {
    last = change.time;
    Object.freeze(change);
    marks(change, marking, here);
    follow(change);
  }

  /** The answer to an operation: its change, what it and its letting go marked, what went. */
  function answer(change: Change, marking: Marking, gone: Id[] = []): Changed {
    const marked: Marked[] = [...marking.keys()].sort(byCodePoint)
      .map((process) => ({ process, by: marking.get(process)! }));
    const out: Changed = gone.length ? { change, marked, gone } : { change, marked };
    // not part of the answer's JSON: every change, its letting go's included, in order
    Object.defineProperty(out, "made", { value: marking.made ?? [] });
    return out;
  }

  /**
   * Changes a slot, keeping track of the slots that hold each id. The slot's
   * last change is set only by a change that is not ephemeral; a slot left
   * with no ids is gone.
   */
  function setSlot(at: Id, parent: Node, name: string, ids: Id[]) {
    const k = key.slot(at, name);
    const before = parent.directory.get(name) ?? [];
    for (const id of before) if (!ids.includes(id)) drop(holders, id, k);
    for (const id of ids) add(holders, id, k);
    if (ids.length) parent.directory.set(name, ids);
    else {
      parent.directory.delete(name);
      parent.slots.delete(name);
      parent.fleeting.delete(name);
    }
  }

  /** Applies the patches in order, each checked in turn: invalid, naming the first that fails. */
  function patched(
    value: Json,
    given: readonly unknown[],
    live: boolean,
  ): { value: Json; patches: Patch[] } {
    const patches: Patch[] = [];
    for (let index = 0; index < given.length; index++) {
      const patch = given[index] as Patch;
      value = applyPatch(value, patch, index, live);
      patches.push(patch);
    }
    return { value, patches };
  }

  function write(op: WriteOp): Changed {
    const f = fields("write", op, causeOf(op, "write"));
    const time = f.time!;
    const { id, node } = target(op, f.parsed!);
    if (!node.ephemeral && f.patches!.some(livens)) {
      throw wrongField("patches", "only an ephemeral node's value may be live");
    }
    checkTime(time);
    const { value, patches } = patched(node.value, f.patches!, !!node.ephemeral);
    const change: Change = { node: id, time, kind: "write", patches, ...common(op, f.cause) };
    if (node.ephemeral) change.ephemeral = true;
    node.value = value;
    node.change = header(change);
    const marking: Marking = new Map();
    apply(change, marking);
    return answer(change, marking);
  }

  function place(op: PlaceOp): Changed {
    const f = fields("place", op, causeOf(op, "place"));
    const name = f.name!;
    const id = f.id!;
    const time = f.time!;
    const { id: at, node: parent } = target(op, f.parsed!);
    checkTime(time);
    // a value given makes the node; null is a value
    const making = f.value !== undefined;
    if (making && nodes.has(id)) {
      throw invalid("exists", `the graph has ${JSON.stringify(id)}; a value makes a node`);
    }
    if (making && parent.ephemeral && !f.ephemeral) {
      throw invalid("ephemeral-parent", "an ordinary node cannot be made in an ephemeral one");
    }
    // an ephemeral node is in one slot, the one it was made in, and moves only within it
    const home = making ? undefined : nodes.get(id)?.home;
    if (
      making ? f.ephemeral && holders.has(id) : home && (home.node !== at || home.name !== name)
    ) {
      throw invalid("one-place", `${JSON.stringify(id)} would be ephemeral in a second slot`);
    }
    const slot = parent.directory.get(name) ?? [];
    if (f.position !== undefined && f.position > slot.length) {
      throw invalid("position", `position ${f.position} is past the slot's ${slot.length}`, {
        length: slot.length,
      });
    }
    const change = { node: at, time, kind: "place", name, id } as Change & {
      position?: number;
      value?: Json;
    };
    if (f.position !== undefined) change.position = f.position;
    if (making) change.value = f.value;
    Object.assign(change, common(op, f.cause));
    const ephemeral = !!parent.ephemeral ||
      (making ? !!f.ephemeral : !!nodes.get(id)?.ephemeral);
    if (ephemeral) change.ephemeral = true;
    if (making) {
      const made = node(f.value!, header(change), f.ephemeral);
      if (made.ephemeral) made.home = { node: at, name };
      nodes.set(id, made);
    }
    // placing an id the slot holds, with no position, leaves the slot as it is, as its last change
    const was = slot.includes(id);
    setSlot(at, parent, name, placed(slot, id, f.position));
    if (!ephemeral) {
      parent.slots.set(name, header(change));
      parent.fleeting.get(name)?.delete(id);
    } else if (!was) {
      let fleeting = parent.fleeting.get(name);
      if (!fleeting) parent.fleeting.set(name, fleeting = new Set());
      fleeting.add(id);
    }
    const marking: Marking = new Map();
    apply(change, marking, making ? [id] : []);
    return answer(change, marking);
  }

  function unplace(op: UnplaceOp): Changed {
    const f = fields("unplace", op, causeOf(op, "unplace"));
    const name = f.name!;
    const id = f.id!;
    const time = f.time!;
    const { id: at, node: parent } = target(op, f.parsed!);
    checkTime(time);
    const slot = parent.directory.get(name) ?? [];
    if (!slot.includes(id)) {
      throw invalid("not-in-slot", `${JSON.stringify(id)} is not in slot ${JSON.stringify(name)}`);
    }
    return taken(at, name, id, common(op, f.cause), time);
  }

  /**
   * Unplaces an ephemeral node from its one slot, found by its id: as
   * unplace does, with no address, so nothing above can keep it from going.
   */
  function release(op: ReleaseOp): Changed {
    acting(op);
    const id = (op as { id?: unknown }).id;
    if (id === undefined) throw missing("id");
    if (typeof id !== "string") throw wrongField("id", "an id is a string");
    const cause = op.cause === undefined ? undefined : ownField(op.cause, "cause");
    const time = op.time;
    if (time === undefined) throw missing("time");
    if (!whole(time) || time < 1 || time > LATEST) {
      throw wrongField("time", "a time is a whole number from 1");
    }
    const home = nodes.get(id)?.home;
    if (!home) {
      throw invalid("nothing-there", `${JSON.stringify(id)} is not an ephemeral node here`);
    }
    checkTime(time);
    return taken(home.node, home.name, id, common(op, cause), time);
  }

  /** Takes an id out of a slot and lets go what that lets go: the answer to an unplacement. */
  function taken(at: Id, name: string, id: Id, c: Common, time: number): Changed {
    const marking: Marking = new Map();
    const gone: Id[] = [];
    const change = out(at, name, id, c, time, marking);
    letGo(id, change, marking, gone);
    return answer(change, marking, gone);
  }

  /**
   * Takes an id out of a slot, as one change at that time, ephemeral when
   * the parent or the id's node is, and applies it.
   */
  function out(at: Id, name: string, id: Id, c: Common, time: number, marking: Marking): Change {
    const parent = nodes.get(at)!;
    const change: Change = { node: at, time, kind: "unplace", name, id, ...c };
    const ephemeral = !!parent.ephemeral || !!nodes.get(id)?.ephemeral;
    if (ephemeral) change.ephemeral = true;
    parent.fleeting.get(name)?.delete(id);
    setSlot(at, parent, name, parent.directory.get(name)!.filter((x) => x !== id));
    if (!ephemeral && parent.directory.has(name)) parent.slots.set(name, header(change));
    apply(change, marking);
    return change;
  }

  /**
   * Lets an ephemeral node go, just unplaced from its one slot (CORE.tex,
   * Ephemeral nodes): its slots are taken apart, by name in code point order,
   * the ids of each in slot order, each taking-out a change of its own with
   * the next time, made as the change that let it go was; each ephemeral
   * member, whose one slot that was, is taken apart the same way before the
   * next, and goes after what it held. An ordinary member stays, here but
   * unreachable. An ephemeral node has one parent, so there is no cycle to
   * meet. Keeps its own stack, so a deep tree needs no deep one.
   */
  function letGo(id: Id, by: Change, marking: Marking, gone: Id[]) {
    if (!nodes.get(id)?.ephemeral) return;
    const { agent, process, cause } = by;
    const c: Common = { agent };
    if (process !== undefined) c.process = process;
    if (cause !== undefined) c.cause = cause;
    const stack: { id: Id; names: string[]; at: number }[] = [];
    const open = (id: Id) =>
      stack.push({ id, names: [...nodes.get(id)!.directory.keys()].sort(byCodePoint), at: 0 });
    open(id);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const going = nodes.get(frame.id)!;
      const name = frame.names[frame.at];
      if (name === undefined) {
        stack.pop();
        nodes.delete(frame.id);
        gone.push(frame.id);
        continue;
      }
      const slot = going.directory.get(name);
      if (!slot?.length) {
        frame.at++;
        continue;
      }
      const child = slot[0];
      out(frame.id, name, child, c, last + 1, marking);
      if (nodes.get(child)?.ephemeral) open(child);
    }
  }

  // marking

  /**
   * Adds the processes a change marks: a write marks the readers of the
   * node's value; a placement or an unplacement the readers of that slot and
   * of the whole directory. A change that makes an id's node here marks the
   * readers of every slot that holds that id.
   */
  function marks(change: Change, marking: Marking, here: readonly Id[]) {
    const hit = new Set<Id>();
    const take = (k: string) =>
      readers.get(k)?.forEach((p) => {
        hit.add(p);
        if (!marking.has(p)) marking.set(p, change.time);
      });
    if (change.kind === "write") take(key.value(change.node));
    else {
      take(key.slot(change.node, change.name));
      take(key.directory(change.node));
    }
    for (const id of here) {
      take(key.here(id));
      for (const k of holders.get(id) ?? []) {
        take(k);
        take(key.directory((JSON.parse(k) as string[])[1]));
      }
    }
    (marking.made ??= []).push({ change, marked: [...hit].sort(byCodePoint) });
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

  /**
   * Follows every subscription's address, and sends it the change if it
   * changed the address's route, whether or not the address then reaches
   * another node, with what reading the address now gives; or if it is to
   * the node the address reached.
   */
  function follow(change: Change) {
    const due: [Sub, Event][] = [];
    for (const s of subs.values()) {
      const before = s.at;
      if (change.kind !== "write") s.at = locate(s.op, s.parsed);
      if (!sameRoute(before, s.at)) {
        due.push([s, { change, reaches: reading(s.op, s.parsed) }]);
      } else if (change.node === before?.node) due.push([s, { change }]);
    }
    for (const [s, event] of due) send(s, event);
  }

  function subscribe(op: SubscribeOp): { sub: number } {
    const { parsed } = fields("subscribe", op);
    const as = who(op);
    if (as.place) as.place = [...as.place];
    const at = locate(as, parsed!);
    const sub = nextSub++;
    subs.set(sub, { sub, op: as, parsed: parsed!, at, send: op.send });
    return { sub };
  }

  function unsubscribe(op: UnsubscribeOp): void {
    const { sub } = fields("unsubscribe", op);
    if (typeof sub !== "number" || !subs.has(sub)) {
      throw wrongField("sub", `there is no subscription ${JSON.stringify(sub) ?? String(sub)}`);
    }
    subs.delete(sub);
  }

  /** Drops the reads kept for an id, so nothing marks it any more. */
  function forget(op: ForgetOp): void {
    acting(op);
    const id = (op as { id?: unknown }).id;
    if (id === undefined) throw missing("id");
    if (typeof id !== "string") throw wrongField("id", "an id is a string");
    for (const k of memory.get(id) ?? []) drop(readers, k, id);
    memory.delete(id);
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
      throw fail("wrong-part", `a bound interface cannot ${op}`, op);
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
      // what the graph keeps for a process is for whoever runs it
      forget: none("forget"),
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
   * walk tried, the place's whole walk included, and the values or slots of
   * every member it read. Gives the route to the node the address reaches,
   * or as far as it went, or undefined if the address reads nothing at all.
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
    const all = members(view, from, parsed.names, track);
    if (kind === "read") {
      for (const m of all) depend(state, key.value(m.node), m.node, true);
      return all.length ? all[0].route : walk(view, from, parsed.names).route;
    }
    for (const m of all) {
      const k = op.name === undefined ? key.directory(m.node) : key.slot(m.node, op.name);
      depend(state, k, m.node);
    }
    return all[0]?.route ?? [];
  }

  /**
   * Remembers what a lookup's search depended on, up to where it stopped:
   * the place's walk, which decides the directories; the slot of the name in
   * each directory searched; and whether each id in it is here, which
   * decides whether the search stopped there.
   */
  function traceLookup(state: Run, op: LookupOp, frame: Frame) {
    if (!isName(op?.name)) return;
    const at = { ...op, ...state.acting };
    const track = tracker(state);
    const { start, names } = placeOf(at, track);
    if (start === undefined) return;
    const { route } = walk(view, start, names, track);
    const levels = frame.done ? frame.levels : names.length + 1;
    for (let k = 0; k < levels; k++) {
      const depth = names.length - k;
      const node = depth === 0 ? start : route[depth - 1]?.node;
      if (node === undefined) continue;
      depend(state, key.slot(node, op.name), node);
      for (const id of view.slot(node, op.name)) depend(state, key.here(id));
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
      marked: marked.map((c) => typeof c === "number" ? c : (c as { time: number }).time),
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
      state.changes.push(answer.change.time);
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
          let found: (SlotItem | RefusedItem)[] | undefined;
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
            found: found!.flatMap((i) => "id" in i ? [i.id] : []),
          });
          return found!;
        }),
      subscribe: (op) => attempt("subscribe", () => inner.subscribe(op)),
      unsubscribe: (op) => attempt("unsubscribe", () => inner.unsubscribe(op)),
      forget: (op) => attempt("forget", () => inner.forget(op)),
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
    if (finishing.program !== undefined) r.program = own(finishing.program);
    if (finishing.value !== undefined) r.value = own(finishing.value);
    r.cleanup = (finishing.cleanup ?? []).map((c) =>
      typeof c === "number" ? c : (c as { time: number }).time
    );
    r.changes = [...state.changes];
    r.ending = ending;
    r.errors = [...state.errors, ...finishing.errors ?? []];
    for (const s of [...subs.values()]) if (s.at?.node === state.process) send(s, { record: r });
    return r;
  }

  /** Keeps the ordinary nodes and the highest time, and drops the rest, as storing and loading would. */
  function reload() {
    for (const [id, n] of nodes) if (n.ephemeral) nodes.delete(id);
    holders.clear();
    for (const [at, n] of nodes) {
      for (const [name, slot] of n.directory) {
        const fleeting = n.fleeting.get(name);
        const kept = fleeting ? slot.filter((id) => !fleeting.has(id)) : slot;
        n.fleeting.delete(name);
        if (kept.length) n.directory.set(name, kept);
        else {
          n.directory.delete(name);
          n.slots.delete(name);
        }
        for (const id of kept) add(holders, id, key.slot(at, name));
      }
    }
    subs.clear();
    memory.clear();
    readers.clear();
    runs.clear();
  }

  const api: Graph = {
    read: naming("read", read),
    directory: naming("directory", directory),
    lookup: naming("lookup", lookup),
    write: naming("write", write),
    place: naming("place", place),
    unplace: naming("unplace", unplace),
    subscribe: naming("subscribe", subscribe),
    unsubscribe: naming("unsubscribe", unsubscribe),
    forget: naming("forget", forget),
    bind: naming("bind", bind),
    record: naming("record", record),
    finish: naming("finish", finish),
    top: told((top: Interface) => {
      up = top;
    }),
    cwd: Object.freeze([]),
    reach: naming("reach", reach),
    release: naming("unplace", release),
    reload,
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

/** The operations whose fields fields() checks. */
export type Kind =
  | "read"
  | "directory"
  | "lookup"
  | "write"
  | "place"
  | "unplace"
  | "subscribe"
  | "unsubscribe";

/** An operation's fields, as fields() gives them once they are checked. */
export type Fields = {
  parsed?: Parsed;
  name?: string;
  id?: Id;
  position?: number;
  value?: Json;
  ephemeral?: boolean;
  patches?: readonly unknown[];
  cause?: Json;
  time?: number;
  sub?: unknown;
};

/**
 * The fields each operation takes besides who makes it and where, in the
 * order they are checked, each required or not. The graph never requires a
 * cause: a change that gives none is given one, in the cause's turn.
 */
const TAKES: { readonly [kind in Kind]: readonly (readonly [string, boolean])[] } = {
  read: [["address", true]],
  directory: [["address", true], ["name", false]],
  lookup: [["name", true]],
  write: [["address", true], ["patches", true], ["cause", false], ["time", true]],
  place: [
    ["address", true],
    ["name", true],
    ["id", true],
    ["position", false],
    ["value", false],
    ["ephemeral", false],
    ["cause", false],
    ["time", true],
  ],
  unplace: [["address", true], ["name", true], ["id", true], ["cause", false], ["time", true]],
  subscribe: [["address", true], ["send", true]],
  unsubscribe: [["sub", true]],
};

/**
 * Checks an operation's fields in the order PROTOCOL.tex gives (Errors):
 * agent, process, place, chroot, address, name, id, position, value,
 * patches, cause, time, then those only that operation has. The first that
 * is missing or of the wrong kind answers, before the graph looks at
 * anything. A change that gives no cause takes what cause() returns, asked
 * in the cause's turn; a harness, whose every change from outside carries a
 * cause, passes one that throws missing. Gives the fields as the graph keeps
 * them: the address taken apart, the value and cause copied.
 */
export function fields(
  kind: Kind,
  op: Acting & { readonly [field: string]: unknown },
  cause?: () => Json | undefined,
): Fields {
  acting(op);
  const out: Fields = {};
  for (const [field, required] of TAKES[kind]) {
    const given = op[field];
    if (field === "send") {
      if (typeof given !== "function") throw wrongField("send", "subscribe needs a send function");
      continue;
    }
    if (given === undefined) {
      if (field === "value" && op.ephemeral === true) throw missing("value");
      if (field === "cause") {
        const c = cause?.();
        if (c !== undefined) out.cause = c;
      } else if (required) throw missing(field);
      continue;
    }
    switch (field) {
      case "address":
        out.parsed = parseAddress(given);
        break;
      case "name":
        if (!isName(given)) throw wrongField("name", 'a name is a string, never ".", ".." or "/"');
        out.name = given;
        break;
      case "id":
        if (typeof given !== "string") throw wrongField("id", "an id is a string");
        out.id = given;
        break;
      case "position":
        if (!whole(given)) throw wrongField("position", "a position is a whole number from 0");
        out.position = given;
        break;
      case "value":
        // a live value only as the whole value of an ephemeral node
        out.value = ownField(given, "value", op.ephemeral === true);
        break;
      case "ephemeral":
        if (typeof given !== "boolean") throw wrongField("ephemeral", "ephemeral is a boolean");
        out.ephemeral = given;
        break;
      case "patches":
        if (!Array.isArray(given)) throw wrongField("patches", "patches are a list");
        out.patches = given.map(ownPatch);
        break;
      case "cause":
        out.cause = ownField(given, "cause");
        break;
      case "time":
        if (!whole(given) || given < 1 || given > LATEST) {
          throw wrongField("time", "a time is a whole number from 1 to 2^53 - 1");
        }
        out.time = given;
        break;
      case "sub":
        // whether it names a subscription is for the graph to say
        out.sub = given;
        break;
    }
  }
  return out;
}

/**
 * A patch as the graph keeps it: its value a copy, which may be live only as
 * a snapshot's whole value; a value that is not one is wrong-field. What is
 * not a patch is left for the patch's own checks, in its turn.
 */
function ownPatch(patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const { value, ...rest } = patch as { value?: unknown };
  let kept: Json;
  try {
    kept = own(rest);
  } catch (e) {
    if (e instanceof NotJson) return patch;
    throw e;
  }
  if (value === undefined) return kept;
  return Object.freeze({
    ...(kept as object),
    value: ownField(value, "patches", (rest as { type?: unknown }).type === "snapshot"),
  });
}

/** Whether a patch makes a value live: a snapshot to a live value. */
function livens(patch: unknown): boolean {
  return isObject(patch) && patch.type === "snapshot" && isLive(patch.value);
}

/** Whether two addresses got to the same node by the same route, or both to nothing. */
function sameRoute(a: Located | undefined, b: Located | undefined): boolean {
  if (!a || !b) return a === b;
  return a.node === b.node && a.route.length === b.route.length &&
    a.route.every((s, i) => {
      const t = b.route[i];
      return s.parent === t.parent && s.name === t.name && s.node === t.node &&
        s.position === t.position;
    });
}

/** The time of the latest change among the items, null if none. */
function latest(items: readonly { change?: { time: number } }[]): number | null {
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
