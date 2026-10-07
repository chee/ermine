// A keeper: storage for a graph, as CORE.tex's Ephemeral nodes and What the
// graph holds say whoever keeps the graph must keep it. No ephemeral node and
// no ephemeral change is kept; each slot keeps the ids that changes that were
// not ephemeral put there, and its last change that was not ephemeral; the
// highest time is kept, so times after a load are greater than every time
// before.
//
// It is a wrapper (CORE.tex, Running and wrapping), made directly over the
// bare graph, beneath every other wrapper, so every change passes through it,
// a scheduler's bookkeeping included. It learns the graph from the changes
// that come back, as a shadow of every node here, ephemeral ones included,
// since a position counts every id in a slot and letting an ephemeral node go
// takes apart what it held. It asks the graph nothing, and adds no operation
// to it: loading is making the graph from what was kept, graph(root, kept).
//
// What is kept goes to a backend, one record per ordinary node and one for
// the root and the highest time, each in CBOR. Changes are written in
// batches, after the operation that made them, or when flush() is called.

import { decode, encode, type Value } from "./cbor.ts";
import type { Kept, KeptNode } from "./graph.ts";
import { applyPatches, own, placed } from "./patch.ts";
import {
  type Changed,
  type Header,
  type Id,
  type Interface,
  type Json,
  ours,
  told,
} from "./types.ts";

ours(import.meta.url);

/**
 * Where records are kept, by key. A write's sets and deletes happen together
 * or not at all; a whole write replaces every record there is.
 */
export interface Backend {
  read(): Promise<Map<string, Uint8Array>>;
  write(batch: ReadonlyMap<string, Uint8Array | null>, whole: boolean): Promise<void>;
}

/** A backend in memory, for tests and for hosts that keep nothing. */
export function memory(): Backend & { records: Map<string, Uint8Array> } {
  const records = new Map<string, Uint8Array>();
  return {
    records,
    read: () => Promise.resolve(new Map(records)),
    write: (batch, whole) => {
      if (whole) records.clear();
      for (const [k, v] of batch) v === null ? records.delete(k) : records.set(k, v.slice());
      return Promise.resolve();
    },
  };
}

/** Storage that is not what a keeper wrote, or a keeper that missed a change. */
export class KeepError extends Error {
  override name = "KeepError";
}

/** The record of the root and the highest time; each node's is NODE + its id. */
export const META = "meta";
export const NODE = "node:";

/** What a keeper adds to the interface it wraps. */
export type Keeper = Interface & {
  /** Writes what changed since the last flush; resolves once it, and every earlier one, is kept. */
  flush(): Promise<void>;
  /** What keeping the graph now keeps. */
  kept(): Kept;
};

export type KeepOptions = {
  /** what the graph was made from, if it was loaded; otherwise it is new, its root alone */
  kept?: Kept;
  /** whether to flush after each operation that changed something; true unless said */
  auto?: boolean;
  /** told of a flush that failed and that nobody awaited */
  failed?: (error: unknown) => void;
};

/** A node as the keeper knows it. An ephemeral node's value is never held. */
type Shadow = {
  ephemeral: boolean;
  value: Json;
  change?: Header;
  directory: Map<string, Id[]>;
  /** the last change to each slot that was not ephemeral */
  slots: Map<string, Header>;
  /** the ids in each slot that an ephemeral change put there */
  fleeting: Map<string, Set<Id>>;
};

/** A change as an item carries it: without its patches or a placement's value. */
function header(change: Changed["change"]): Header {
  const { patches: _p, value: _v, ...rest } = change as Changed["change"] & {
    patches?: unknown;
    value?: unknown;
  };
  return Object.freeze(rest) as Header;
}

/**
 * Keeps the graph api, which must be the bare graph, or what passes every
 * change to it unchanged, made from opts.kept or new. The host builds the
 * rest of the stack over what this returns, and makes no change around it.
 */
export function keep(api: Interface, backend: Backend, root: Id, opts: KeepOptions = {}): Keeper {
  const shadows = new Map<Id, Shadow>();
  let time = 0;
  if (opts.kept) {
    if (opts.kept.root !== root) throw new KeepError("what was kept is of another root");
    for (const [id, k] of opts.kept.nodes) {
      shadows.set(id, {
        ephemeral: false,
        value: k.value,
        ...(k.change ? { change: k.change } : {}),
        directory: new Map([...k.directory].map(([n, ids]) => [n, [...ids]])),
        slots: new Map(k.slots),
        fleeting: new Map(),
      });
    }
    time = opts.kept.time;
  } else {
    shadows.set(root, blank(false, null));
  }

  // what the next flush writes: a new graph is written whole, replacing what was there
  let whole = !opts.kept;
  const dirty = new Set<Id>(whole ? [root] : []);
  let saved = whole ? -1 : time;
  let missed: KeepError | undefined;
  let chain: Promise<void> = Promise.resolve();
  let lost: unknown;
  let queued = false;

  // changes made while one is being made, as a subscriber may, come back first
  let depth = 0;
  let held: Changed[] = [];

  function learning<T extends Changed>(fn: () => T): T {
    depth++;
    let answer: T | undefined;
    try {
      answer = fn();
      held.push(answer);
      return answer;
    } finally {
      if (--depth === 0) {
        const all = held.sort((a, b) => a.change.time - b.change.time);
        held = [];
        for (const a of all) learn(a);
        if (all.length && opts.auto !== false && !queued) {
          queued = true;
          queueMicrotask(() => {
            queued = false;
            flush().catch((e) => opts.failed ? opts.failed(e) : (lost ??= e));
          });
        }
      }
    }
  }

  function learn({ change: c, gone }: Changed) {
    if (missed) return;
    if (c.time > time) time = c.time;
    const at = shadows.get(c.node);
    if (!at) {
      missed = new KeepError(`a change to ${JSON.stringify(c.node)}, which the keeper never saw`);
      return;
    }
    if (c.kind === "write") {
      if (!c.ephemeral) {
        at.value = applyPatches(at.value, c.patches);
        at.change = header(c);
        dirty.add(c.node);
      }
    } else if (c.kind === "place") {
      if (c.value !== undefined) {
        const made = blank(!!c.ephemeral, c.ephemeral ? null : c.value);
        made.change = header(c);
        shadows.set(c.id, made);
        if (!c.ephemeral) dirty.add(c.id);
      }
      const slot = at.directory.get(c.name) ?? [];
      const was = slot.includes(c.id);
      at.directory.set(c.name, placed(slot, c.id, c.position));
      if (!c.ephemeral) {
        at.slots.set(c.name, header(c));
        at.fleeting.get(c.name)?.delete(c.id);
        dirty.add(c.node);
      } else if (!was) {
        let f = at.fleeting.get(c.name);
        if (!f) at.fleeting.set(c.name, f = new Set());
        f.add(c.id);
      }
    } else {
      at.fleeting.get(c.name)?.delete(c.id);
      const rest = (at.directory.get(c.name) ?? []).filter((id) => id !== c.id);
      if (rest.length) {
        at.directory.set(c.name, rest);
        if (!c.ephemeral) at.slots.set(c.name, header(c));
      } else {
        at.directory.delete(c.name);
        at.slots.delete(c.name);
        at.fleeting.delete(c.name);
      }
      if (!at.ephemeral) dirty.add(c.node);
    }
    // each id in each slot of a node let go was taken out by a change of its own, with the next time
    let next = c.time;
    for (const id of gone ?? []) {
      const going = shadows.get(id);
      if (going) { for (const ids of going.directory.values()) next += ids.length; }
      shadows.delete(id);
    }
    if (next > time) time = next;
  }

  function kept(): Kept {
    const nodes = new Map<Id, KeptNode>();
    for (const [id, s] of shadows) if (!s.ephemeral) nodes.set(id, keptNode(s));
    return { root, time, nodes };
  }

  function flush(): Promise<void> {
    if (missed) return Promise.reject(missed);
    if (lost !== undefined) {
      const e = lost;
      lost = undefined;
      return Promise.reject(e);
    }
    if (!whole && !dirty.size && saved === time) return chain;
    const batch = new Map<string, Uint8Array | null>();
    const ids = whole ? [...shadows.keys()] : [...dirty];
    for (const id of ids) {
      const s = shadows.get(id);
      if (s && !s.ephemeral) batch.set(NODE + id, encodeNode(keptNode(s)));
    }
    batch.set(META, encode({ root, time }));
    const all = whole;
    dirty.clear();
    whole = false;
    saved = time;
    chain = chain.catch(() => {}).then(() => backend.write(batch, all)).catch((e) => {
      // what this batch held is not known to be kept: write everything next time
      whole = true;
      saved = -1;
      throw e;
    });
    return chain;
  }

  const wrapped: Keeper = {
    ...api,
    write: (op) => learning(() => api.write(op)),
    place: (op) => learning(() => api.place(op)),
    unplace: (op) => learning(() => api.unplace(op)),
    ...(api.release ? { release: (op) => learning(() => api.release!(op)) } : {}),
    flush,
    kept,
  };
  // the bare graph's reload drops what keeping drops; so does the keeper's shadow
  const reload = (api as { reload?: () => void }).reload;
  if (typeof reload === "function") {
    (wrapped as Keeper & { reload(): void }).reload = () => {
      reload.call(api);
      for (const [id, s] of shadows) {
        if (s.ephemeral) shadows.delete(id);
        else {
          const k = keptNode(s);
          s.directory = new Map([...k.directory].map(([n, ids]) => [n, [...ids]]));
          s.slots = new Map(k.slots);
          s.fleeting.clear();
        }
      }
    };
  }
  const below = api.top(wrapped);
  wrapped.top = told(below);
  return wrapped;
}

function blank(ephemeral: boolean, value: Json): Shadow {
  return { ephemeral, value, directory: new Map(), slots: new Map(), fleeting: new Map() };
}

/** An ordinary node as it is kept: its slots without the ids ephemeral changes put there. */
function keptNode(s: Shadow): KeptNode {
  const directory = new Map<string, Id[]>();
  const slots = new Map<string, Header>();
  for (const [name, ids] of s.directory) {
    const f = s.fleeting.get(name);
    const kept = f ? ids.filter((id) => !f.has(id)) : [...ids];
    if (!kept.length) continue;
    directory.set(name, kept);
    const change = s.slots.get(name);
    if (change) slots.set(name, change);
  }
  return { value: s.value, ...(s.change ? { change: s.change } : {}), directory, slots };
}

// records

/** A node's record: {value, change?, directory: {name: [id]}, slots: {name: header}}. */
export function encodeNode(n: KeptNode): Uint8Array {
  const record: { [k: string]: Value } = {
    value: n.value as Value,
    directory: Object.fromEntries(n.directory) as Value,
    slots: Object.fromEntries(n.slots) as unknown as Value,
  };
  if (n.change) record.change = n.change as unknown as Value;
  return encode(record);
}

const isMap = (x: unknown): x is { [k: string]: unknown } =>
  typeof x === "object" && x !== null && !Array.isArray(x) && !ArrayBuffer.isView(x) &&
  !(x instanceof ArrayBuffer);

function isHeader(x: unknown): x is Header {
  return isMap(x) && typeof x.node === "string" && typeof x.time === "number" &&
    (x.kind === "write" || x.kind === "place" || x.kind === "unplace") && "agent" in x &&
    x.ephemeral === undefined;
}

export function decodeNode(bytes: Uint8Array): KeptNode {
  const r = decode(bytes) as unknown;
  if (!isMap(r) || !("value" in r) || !isMap(r.directory) || !isMap(r.slots)) {
    throw new KeepError("a node's record is not one");
  }
  const directory = new Map<string, Id[]>();
  for (const [name, ids] of Object.entries(r.directory)) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      throw new KeepError(`slot ${JSON.stringify(name)} is not a list of ids`);
    }
    directory.set(name, ids);
  }
  const slots = new Map<string, Header>();
  for (const [name, h] of Object.entries(r.slots)) {
    if (!isHeader(h) || !directory.has(name)) {
      throw new KeepError(`slot ${JSON.stringify(name)}'s change is not one`);
    }
    slots.set(name, own(h) as unknown as Header);
  }
  if (r.change !== undefined && !isHeader(r.change)) {
    throw new KeepError("a node's change is not one");
  }
  const node: KeptNode = { value: own(r.value), directory, slots };
  if (r.change !== undefined) node.change = own(r.change) as unknown as Header;
  return node;
}

/** What a backend keeps, ready for graph(root, kept); undefined if it keeps nothing yet. */
export async function load(backend: Backend): Promise<Kept | undefined> {
  const records = await backend.read();
  const meta = records.get(META);
  if (!meta) return undefined;
  const m = decode(meta) as unknown;
  if (!isMap(m) || typeof m.root !== "string" || typeof m.time !== "number") {
    throw new KeepError("the meta record is not one");
  }
  const nodes = new Map<Id, KeptNode>();
  for (const [k, bytes] of records) {
    if (k === META) continue;
    if (!k.startsWith(NODE)) throw new KeepError(`a record ${JSON.stringify(k)} is not a keeper's`);
    nodes.set(k.slice(NODE.length), decodeNode(bytes));
  }
  if (!nodes.has(m.root)) throw new KeepError("the root's record is missing");
  return { root: m.root, time: m.time, nodes };
}
