// Rebasing concurrent writes to one value, after eg-walker (Gentle and
// Kleppmann, EuroSys 2025; plans/eg-walker.org): the second way to merge a
// shared value that SUBDUCTION_SYNC.tex plans, opt-in per node.
//
// The input is a set of commits closed under parents, each a list of
// patches made on the value at its parents. The output is one value, a pure
// function of the set: every device that knows the same commits gets the
// same value, whatever order they arrived in.
//
// How. The commits are replayed in one order every device agrees on, the
// ascending agreed order (Lamport number, then name), which puts parents
// first. A CRDT state is built only for the replay and thrown away after.
// Each of its pieces has two states, as in eg-walker: its state at the
// version the commit being replayed was made on (prepare), where the
// commit's own positions, keys and paths mean what they meant to its maker,
// and its state once everything is merged (end). Before a commit is
// replayed, the commits in the prepare version that are not its ancestors
// are retreated, in reverse, and its ancestors not in it are advanced.
//
// The pieces:
// - a register for the whole value and for each key of each map: every set
//   (or snapshot) of it is a write, visible at prepare when its commit is;
//   the write first in the agreed order wins, at prepare among the visible
//   ones and at the end among all. A causal successor is always later in
//   that order, so a later write always beats the one it was made on.
// - a sequence for each string (code points), list, bytes and typed array:
//   items in the Fugue order of eg-walker's reference, each inserted,
//   not yet inserted, or deleted some number of times at prepare, and
//   inserted or deleted at the end.
// - a container (map, sequence) is made by the write or item that holds it,
//   and named by it: a path is followed at prepare, so a patch lands in the
//   container its maker saw, not one put in its place concurrently.
//
// A patch has an effect at the end when the container it lands in is still
// reached from the root (and, for a set or snapshot, when its write still
// wins). merge() compares the effects at each head with those of the merge,
// so what a merge drops is named rather than lost silently.

import { codePoints, define, isBytes, isObject, type Kind, kindOf, KINDS } from "../patch.ts";
import { type Json, ours, type Patch, type Typed } from "../types.ts";
import type { Hash } from "./commit.ts";

ours(import.meta.url);

/** A commit as the replay needs it. */
export type Event = {
  hash: Hash;
  lamport: number;
  parents: readonly Hash[];
  patches: readonly Patch[];
};

/** A patch of a commit, by the commit's name and the patch's index. */
export type PatchRef = { commit: Hash; patch: number };

/** Where a piece was made: the commit's place in the replay, the patch, the element. */
type Ord = readonly [number, number, number];

const cmp = (a: Ord, b: Ord) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

type Node = MapNode | SeqNode | Atom;
type Atom = { t: "atom"; v: Json };
type MapNode = { t: "map"; keys: Map<string, Reg> };
type SeqNode = { t: "seq"; sort: "string" | "list" | "bytes" | Kind; items: Item[] };
/** A register: the writes of one key, or of the whole value. */
type Reg = { writes: Write[] };
/** A write: undefined node deletes the key. */
type Write = { ord: Ord; node: Node | undefined; cur: boolean };
type Element = string | number | bigint | Node;
type Item = {
  id: Ord;
  /** at prepare: -1 not yet inserted, 0 inserted, n deleted n times */
  cur: number;
  /** at the end */
  deleted: boolean;
  left: Item | null;
  right: Item | null;
  content: Element;
};

type Op =
  | { k: "ins"; items: Item[] }
  | { k: "del"; items: Item[] }
  | { k: "set"; w: Write };

/** What a patch landed in and wrote, to tell its effect at the end. */
type Landed = { tag: string; on: Node | "root"; w?: Write; reg: Reg };

class RebaseError extends Error {
  override name = "RebaseError";
}

/** A value as pieces made at ord: its maps' keys and sequences' items made there too. */
function build(value: Json, ord: Ord): Node {
  if (typeof value === "string") return seq("string", codePoints(value), ord);
  if (Array.isArray(value)) return seq("list", value.map((v) => build(v, ord)), ord);
  if (isBytes(value)) return seq("bytes", [...new Uint8Array(value)], ord);
  const kind = kindOf(value);
  if (kind) return seq(kind, [...(value as Typed)], ord);
  if (isObject(value)) {
    const keys = new Map<string, Reg>();
    for (const [k, v] of Object.entries(value)) {
      keys.set(k, { writes: [{ ord, node: build(v, ord), cur: true }] });
    }
    return { t: "map", keys };
  }
  return { t: "atom", v: value };
}

function seq(sort: SeqNode["sort"], elements: Element[], ord: Ord): SeqNode {
  const items: Item[] = [];
  let left: Item | null = null;
  elements.forEach((content, i) => {
    const item: Item = {
      id: [ord[0], ord[1], -elements.length + i],
      cur: 0,
      deleted: false,
      left,
      right: null,
      content,
    };
    items.push(item);
    left = item;
  });
  return { t: "seq", sort, items };
}

/** The write that wins: the latest in the replay among those given. */
function winner(writes: readonly Write[], prepare: boolean): Write | undefined {
  let best: Write | undefined;
  for (const w of writes) {
    if (prepare && !w.cur) continue;
    if (!best || cmp(w.ord, best.ord) > 0) best = w;
  }
  return best;
}

/** The index past the n-th item inserted at prepare: where an insert at n goes. */
function past(items: readonly Item[], n: number): number {
  let seen = 0, i = 0;
  while (seen < n) {
    if (i >= items.length) throw new RebaseError(`position ${n} is past the end`);
    if (items[i].cur === 0) seen++;
    i++;
  }
  return i;
}

/**
 * Where a new item goes among the items not yet inserted at prepare, between
 * its left and its right: eg-walker reference's integrate(), Fugue's order.
 * Positions are looked up in the run it scans, not searched for: an item's
 * left is before it and its right after it, so one outside the run is
 * before the new item's left, or after the run.
 */
function integrate(items: Item[], item: Item, at: number): number {
  if (at >= items.length || items[at].cur !== -1) return at;
  // the run of items not yet inserted, and the one after it
  let end = at;
  while (end < items.length && items[end].cur === -1) end++;
  const where = new Map<Item, number>();
  for (let i = at; i <= end && i < items.length; i++) where.set(items[i], i);
  const leftIdx = at - 1;
  const rightIdx = item.right === null ? items.length : where.get(item.right)!;
  const leftOf = (x: Item | null) =>
    x === null ? -1 : leftIdx >= 0 && x === items[leftIdx] ? leftIdx : where.get(x) ?? -2;
  const rightOf = (x: Item | null) =>
    x === null ? items.length : where.get(x) ?? (rightIdx === items.length ? items.length - 0.5 : end + 0.5);
  let scanning = false;
  let i = at;
  while (i < items.length) {
    const other = items[i];
    if (other.cur !== -1) break;
    const oleft = leftOf(other.left);
    if (oleft < leftIdx) break;
    if (oleft === leftIdx) {
      const oright = rightOf(other.right);
      if (oright === rightIdx && cmp(item.id, other.id) < 0) break;
      scanning = oright < rightIdx;
    }
    i++;
    if (!scanning) at = i;
  }
  return at;
}

function insert(node: SeqNode, pos: number, content: Element, id: Ord): Item {
  const items = node.items;
  const at = past(items, pos);
  const left = at === 0 ? null : items[at - 1];
  let right: Item | null = null;
  for (let i = at; i < items.length; i++) {
    if (items[i].cur !== -1) {
      right = items[i].left === left ? items[i] : null;
      break;
    }
  }
  const item: Item = { id, cur: 0, deleted: false, left, right, content };
  items.splice(integrate(items, item, at), 0, item);
  return item;
}

/** The state of a replay: the root register, and the ops of each commit replayed. */
type State = { root: Reg; ops: Op[][]; landed: Landed[] };

function follow(state: State, path: readonly (string | number)[]): Node {
  let node = winner(state.root.writes, true)?.node;
  for (const key of path) {
    if (!node) break;
    if (node.t === "map" && typeof key === "string") {
      const reg = node.keys.get(key);
      node = reg ? winner(reg.writes, true)?.node : undefined;
    } else if (node.t === "seq" && node.sort === "list" && typeof key === "number") {
      const at = past(node.items, key + 1) - 1;
      node = node.items[at].content as Node;
    } else node = undefined;
  }
  if (!node) throw new RebaseError(`the path ${JSON.stringify(path)} is not there`);
  return node;
}

function elements(node: SeqNode, value: Json | undefined, ord: Ord): Element[] {
  if (value === undefined) return [];
  const made = build(value, ord);
  if (made.t !== "seq" || made.sort !== node.sort) {
    throw new RebaseError(`a ${node.sort} is spliced with a ${made.t}`);
  }
  return made.items.map((i) => i.content);
}

/** Replays one patch at prepare, at ord, recording its ops. */
function play(state: State, patch: Patch, ord: Ord, ops: Op[], tag: string) {
  if (patch.type === "snapshot") {
    const w: Write = { ord, node: build(patch.value, ord), cur: true };
    state.root.writes.push(w);
    ops.push({ k: "set", w });
    state.landed.push({ tag, on: "root", w, reg: state.root });
    return;
  }
  const node = follow(state, patch.path);
  if (patch.type === "set") {
    if (node.t !== "map") throw new RebaseError("a set needs a map");
    let reg = node.keys.get(patch.key);
    if (!reg) node.keys.set(patch.key, reg = { writes: [] });
    const w: Write = {
      ord,
      node: patch.value === undefined ? undefined : build(patch.value, ord),
      cur: true,
    };
    reg.writes.push(w);
    ops.push({ k: "set", w });
    state.landed.push({ tag, on: node, w, reg });
    return;
  }
  if (node.t !== "seq") {
    throw new RebaseError("a splice needs a string, list, bytes or typed array");
  }
  const [from, to] = patch.range;
  const start = past(node.items, from);
  const gone: Item[] = [];
  for (let i = start; gone.length < to - from; i++) {
    if (i >= node.items.length) throw new RebaseError("the range is past the end");
    const item = node.items[i];
    if (item.cur !== 0) continue;
    item.cur = 1;
    item.deleted = true;
    gone.push(item);
  }
  if (gone.length) ops.push({ k: "del", items: gone });
  const made = elements(node, patch.value, ord).map((content, i) =>
    insert(node, from + i, content, [ord[0], ord[1], i])
  );
  if (made.length) ops.push({ k: "ins", items: made });
  state.landed.push({ tag, on: node, reg: state.root });
}

function retreat(ops: readonly Op[]) {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.k === "set") op.w.cur = false;
    else if (op.k === "ins") { for (const it of op.items) it.cur = -1; }
    else for (const it of op.items) it.cur--;
  }
}

function advance(ops: readonly Op[]) {
  for (const op of ops) {
    if (op.k === "set") op.w.cur = true;
    else if (op.k === "ins") { for (const it of op.items) it.cur = 0; }
    else for (const it of op.items) it.cur++;
  }
}

/** The value at the end, and the containers it reaches. */
function materialize(node: Node | undefined, reached: Set<Node>): Json {
  if (!node) return null;
  reached.add(node);
  if (node.t === "atom") return node.v;
  if (node.t === "map") {
    const out: { [k: string]: Json } = {};
    for (const k of [...node.keys.keys()].sort()) {
      const w = winner(node.keys.get(k)!.writes, false);
      if (w?.node) define(out, k, materialize(w.node, reached));
    }
    return Object.freeze(out);
  }
  const live = node.items.filter((i) => !i.deleted).map((i) => i.content);
  switch (node.sort) {
    case "string":
      return (live as string[]).join("");
    case "list":
      return Object.freeze(live.map((n) => materialize(n as Node, reached)));
    case "bytes":
      return Uint8Array.from(live as number[]).buffer;
    default:
      // deno-lint-ignore no-explicit-any
      return (KINDS[node.sort] as any).from(live) as Typed;
  }
}

export type Rebased = {
  value: Json;
  /** the patches whose effect is in the value, as "hash:index" */
  kept: Set<string>;
};

const tagOf = (commit: Hash, patch: number) => `${commit}:${patch}`;

/** The ascending agreed order: lower Lamport number first, then the lesser name. */
export function ascending(a: Event, b: Event): number {
  return a.lamport - b.lamport || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
}

/**
 * The commits replayed in the version a commit was made on (prepare) that
 * are not in the version wanted, and those wanted that are not: walked back
 * from both, the later first, until what is left is in both (eg-walker's
 * diff). Each replayed commit is named by its place in the replay, its
 * parents' places before its own.
 */
function diff(
  parents: readonly (readonly number[])[],
  from: readonly number[],
  to: readonly number[],
): { out: number[]; into: number[] } {
  const ONE = 1, TWO = 2, BOTH = 3;
  const flag = new Map<number, number>();
  /** a max-heap of the places queued */
  const heap: number[] = [];
  let apart = 0;
  const push = (x: number) => {
    heap.push(x);
    for (let i = heap.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (heap[up] >= heap[i]) break;
      [heap[up], heap[i]] = [heap[i], heap[up]];
      i = up;
    }
  };
  const pop = (): number => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l] > heap[m]) m = l;
        if (r < heap.length && heap[r] > heap[m]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const mark = (x: number, f: number) => {
    const was = flag.get(x);
    if (was === undefined) {
      flag.set(x, f);
      push(x);
      if (f !== BOTH) apart++;
    } else if ((was | f) !== was) {
      flag.set(x, was | f);
      if (was !== BOTH) apart--;
    }
  };
  for (const x of from) mark(x, ONE);
  for (const x of to) mark(x, TWO);
  const out: number[] = [], into: number[] = [];
  while (apart > 0) {
    const x = pop();
    const f = flag.get(x)!;
    flag.delete(x);
    if (f !== BOTH) {
      apart--;
      (f === ONE ? out : into).push(x);
    }
    for (const p of parents[x]) mark(p, f);
  }
  return { out, into: into.reverse() };
}

/**
 * A replay of commits in the ascending agreed order, kept so that a commit
 * later in that order than every one replayed is added to it without
 * replaying the rest: the merge, made incrementally.
 */
export class Replay {
  #state: State;
  #index = new Map<Hash, number>();
  #parents: number[][] = [];
  #last: Event | undefined;
  /** the version at prepare: the commits whose ops are applied there */
  #cur: number[] = [];
  #result: Rebased | undefined;

  constructor(start: Json) {
    this.#state = {
      root: { writes: [{ ord: [-1, 0, 0], node: build(start, [-1, 0, 0]), cur: true }] },
      ops: [],
      landed: [],
    };
  }

  /** How many commits are replayed. */
  get size(): number {
    return this.#parents.length;
  }

  /** Whether the commit is replayed. */
  has(h: Hash): boolean {
    return this.#index.has(h);
  }

  /** Whether the commit can be added: later in the order than every one replayed. */
  fits(e: Event): boolean {
    return !this.#last || ascending(this.#last, e) < 0;
  }

  /** Replays one more commit, whose parents are all replayed. */
  add(e: Event): void {
    if (!this.fits(e)) throw new RebaseError(`${e.hash} is not after every commit replayed`);
    const ps = e.parents.map((p) => {
      const x = this.#index.get(p);
      if (x === undefined) throw new RebaseError(`${e.hash} has a parent ${p} not given`);
      return x;
    });
    const n = this.#parents.length;
    const { out, into } = diff(this.#parents, this.#cur, ps);
    const state = this.#state;
    for (const x of out) retreat(state.ops[x]);
    for (const x of into) advance(state.ops[x]);
    const ops: Op[] = [];
    e.patches.forEach((p, k) => play(state, p, [n, k, 0], ops, tagOf(e.hash, k)));
    state.ops[n] = ops;
    this.#index.set(e.hash, n);
    this.#parents.push(ps);
    this.#cur = [n];
    this.#last = e;
    this.#result = undefined;
  }

  /** The value at the end, and the patches whose effect is in it. */
  result(): Rebased {
    if (this.#result) return this.#result;
    const state = this.#state;
    const reached = new Set<Node>();
    const value = materialize(winner(state.root.writes, false)?.node, reached);
    const kept = new Set<string>();
    for (const l of state.landed) {
      const there = l.on === "root" || reached.has(l.on);
      const wins = !l.w || winner(l.reg.writes, false) === l.w;
      if (there && wins) kept.add(l.tag);
    }
    return this.#result = { value, kept };
  }
}

/**
 * The merged value of a set of commits closed under parents, from the value
 * the node had before the first: one value, the same for the same set.
 */
export function rebase(start: Json, given: Iterable<Event>): Rebased {
  const replay = new Replay(start);
  for (const e of [...given].sort(ascending)) replay.add(e);
  return replay.result();
}

/** The commits of the given heads and all their ancestors, from a log by name. */
export function history(log: (h: Hash) => Event | undefined, heads: readonly Hash[]): Event[] {
  const seen = new Map<Hash, Event>();
  const todo = [...heads];
  while (todo.length) {
    const h = todo.pop()!;
    if (seen.has(h)) continue;
    const e = log(h);
    if (!e) throw new RebaseError(`${h} is not known`);
    seen.set(h, e);
    todo.push(...e.parents);
  }
  return [...seen.values()];
}

export type Merged = {
  /** the heads' merge */
  value: Json;
  /**
   * the patches a head kept and the merge did not: overwritten by a
   * concurrent write first in the agreed order, or made in a container a
   * concurrent write took out; in ascending order. A patch the heads made on
   * its commit take out between them is not dropped: they saw it, so its
   * loss is theirs (a write over it), not a concurrent one's.
   */
  dropped: PatchRef[];
  /** the heads that kept a dropped patch, in the order given */
  losing: Hash[];
};

/** The merge of several heads, and what it drops that each head alone kept. */
export function merge(
  start: Json,
  log: (h: Hash) => Event | undefined,
  heads: readonly Hash[],
  at?: (heads: readonly Hash[]) => Rebased,
): Merged {
  const of = at ?? ((hs) => rebase(start, history(log, hs)));
  const all = of(heads);
  if (heads.length < 2) return { value: all.value, dropped: [], losing: [] };
  const dropped = new Set<string>();
  const losing: Hash[] = [];
  // the heads each commit is in the history of
  const seen = new Map<Hash, Set<Hash>>(
    heads.map((h) => [h, new Set(history(log, [h]).map((e) => e.hash))]),
  );
  /** whether the merge of the heads made on t's commit keeps t: else they took it out themselves */
  const settled = new Map<string, boolean>();
  const theirs = (t: string): boolean => {
    let s = settled.get(t);
    if (s === undefined) {
      const commit = t.slice(0, t.indexOf(":"));
      const on = heads.filter((h) => seen.get(h)!.has(commit));
      s = on.length < heads.length && of(on).kept.has(t);
      settled.set(t, s);
    }
    return s;
  };
  for (const h of heads) {
    let lost = false;
    for (const t of of([h]).kept) {
      if (!all.kept.has(t) && theirs(t)) {
        dropped.add(t);
        lost = true;
      }
    }
    if (lost) losing.push(h);
  }
  const refs = [...dropped].map((t): PatchRef => {
    const [commit, patch] = t.split(":");
    return { commit, patch: Number(patch) };
  });
  const order = (r: PatchRef) => log(r.commit)!;
  refs.sort((a, b) => ascending(order(a), order(b)) || a.patch - b.patch);
  return { value: all.value, dropped: refs, losing };
}
