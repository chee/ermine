// A local cache of compute results, as constructive traces (IDEAS.tex,
// Sharing what processes produce; Mokhov, Mitchell & Peyton Jones, Build
// Systems a la Carte). The design, and what is left open, is plans/cache.org.
//
// It is a loader wrapper. It wraps the function the inner loader gives for a
// compute; before calling it, it walks a tree of recorded runs by making each
// recorded read again through the run's own interface, so the reads are
// recorded and kept as any run's are. At a leaf it returns the value there
// and the code never runs. Where nothing matches it runs the code, handing it
// the reads it already made instead of making them twice, and records the
// trace.
//
// The tree is kept flat, each entry named by a chain of hashes:
//
//   k0     = BLAKE3(CBOR(["ermine-cache", key of the code]))
//   k(i+1) = BLAKE3(CBOR([k(i), hash of step i's answer]))
//
// The entry at k(i) is either the step to make next, {step, mode}, or a leaf,
// {leaf: value, from}. A step is a read, a directory, a lookup, or the first
// use of one of the given fields (self, name, cwd, changes). Its answer is
// hashed by its mode: "values" leaves out each item's from and change, so
// items equal in content give the same branch whatever change made them;
// "whole" keeps them. A step is "values" unless some run that took it touched
// the from or change of an item it gave.
//
// Only the compute of a program with no effect is cached, and only when the
// host gives its code a key (source, for the same-thread loader).

import { decode, encode, type Value } from "../cbor.ts";
import { digest, type Hash, hex } from "../sync/commit.ts";
import type { Backend } from "../keeper.ts";
import type { ComputeGiven, Loaded, Loader, Part, Running } from "../loaders.ts";
import { ErmineError, type Id, type Json } from "../types.ts";

/** What a leaf says about the run that made it. */
export type Made = { process: Id; marked: number[]; at: number };

type NodeEntry = { step: Value; mode: "values" | "whole"; used: number };
type LeafEntry = { leaf: Value; from: Made; used: number };
type Entry = NodeEntry | LeafEntry;

const isLeaf = (e: Entry): e is LeafEntry => "leaf" in e;

/** A hit, as the cache tells it: which process, which marks, the leaf, and the run it came from. */
export type Hit = { process: Id; marked: number[]; leaf: Hash; from: Made; steps: number };

export type Stats = {
  hits: number;
  misses: number;
  stored: number;
  /** runs that made reads other than the recorded ones in their place */
  diverged: number;
  /** runs that read something with no hash, a live value, or made another operation */
  unkeyed: number;
  evicted: number;
};

/** Where entries live: in memory, and, given a backend, kept there too. */
export type Store = {
  get(k: Hash): Entry | undefined;
  put(k: Hash, e: Entry): void;
  touch(k: Hash, used: number): void;
  tick(): number;
  readonly size: number;
  readonly bytes: number;
  evict(budget: number): number;
  /** Writes what changed to the backend, if there is one. */
  flush(): Promise<void>;
};

const encodeEntry = (e: Entry) => encode(e as unknown as Value);

/** A store, in memory, kept in the backend if one is given; it starts with what the backend holds. */
export async function store(backend?: Backend): Promise<Store> {
  const entries = new Map<Hash, { e: Entry; size: number }>();
  let bytes = 0;
  let clock = 0;
  if (backend) {
    for (const [k, v] of await backend.read()) {
      try {
        const e = decode(v) as unknown as Entry;
        if (typeof e?.used !== "number") continue;
        entries.set(k, { e, size: v.byteLength });
        bytes += v.byteLength;
        clock = Math.max(clock, e.used);
      } catch {
        // a cache, not the truth: what does not decode is dropped
      }
    }
  }
  const dirty = new Map<Hash, Uint8Array | null>();
  let queued = false;
  let writing: Promise<void> = Promise.resolve();
  const send = () => {
    queued = false;
    if (!backend || dirty.size === 0) return writing;
    const batch = new Map(dirty);
    dirty.clear();
    writing = writing.then(() => backend.write(batch, false));
    return writing;
  };
  const later = () => {
    if (!backend || queued) return;
    queued = true;
    queueMicrotask(send);
  };
  const set = (k: Hash, e: Entry) => {
    const bin = encodeEntry(e);
    const old = entries.get(k);
    if (old) bytes -= old.size;
    entries.set(k, { e, size: bin.byteLength });
    bytes += bin.byteLength;
    if (backend) dirty.set(k, bin);
    later();
  };
  return {
    get: (k) => entries.get(k)?.e,
    put: set,
    touch(k, used) {
      // in memory only: a stamp reaches the backend when its entry is next written
      const old = entries.get(k);
      if (old) old.e.used = used;
    },
    tick: () => ++clock,
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
    evict(budget) {
      if (bytes <= budget) return 0;
      // least recently used first; what is left unreachable ages out the same way
      const order = [...entries].sort((a, b) => a[1].e.used - b[1].e.used);
      let n = 0;
      for (const [k, { size }] of order) {
        if (bytes <= budget * 0.9) break;
        entries.delete(k);
        bytes -= size;
        if (backend) dirty.set(k, null);
        n++;
      }
      later();
      return n;
    },
    flush: () => send(),
  };
}

export type CacheOptions = {
  store: Store;
  /**
   * The key of a part's code: what the code is, never only where it is.
   * Undefined leaves the part uncached, as everything is by default: the
   * cache cannot tell what the inner loader makes of a string, source or a
   * builtin's name. For the same-thread loader, pass source.
   */
  key?: (code: Json, part: Part) => Value | undefined;
  /** the most bytes the store may hold before the least used entries go; 64 MiB by default */
  budget?: number;
  /** told of each hit, so whatever shows records can say the value came from here */
  onhit?: (hit: Hit) => void;
};

/**
 * The key for the same-thread loader: a string is source, and is its own key.
 * The source only: a module it imports by address is not in it.
 */
export const source = (code: Json): Value | undefined =>
  typeof code === "string" ? ["javascript-source", code] : undefined;

/** Drops fields left undefined, which CBOR cannot hold, all the way down. */
function plain(x: unknown): Value {
  if (Array.isArray(x)) return x.map(plain);
  if (x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
    const out: { [k: string]: Value } = {};
    for (const [k, v] of Object.entries(x)) if (v !== undefined) out[k] = plain(v);
    return out;
  }
  return x as Value;
}

const bin = (h: Hash) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out.buffer;
};

const chain = (k: Hash, h: Hash) => digest(encode([bin(k), bin(h)]));

const GIVEN = new Set(["self", "name", "cwd", "changes"]);
const OPS = new Set(["read", "directory", "lookup"]);

type Kind = "read" | "directory" | "lookup" | "given";

/** One step a run took: what it asked, what it got, and whether it looked at where that came from. */
type Step = {
  call: Value;
  bytes: string;
  kind: Kind;
  raw?: unknown;
  wrapped?: unknown;
  error?: unknown;
  touched: boolean;
};

/** A cache in front of a loader's computes. */
export function cached(inner: Loader, opts: CacheOptions): Loader & { stats: Stats } {
  const { store } = opts;
  const key = opts.key ?? (() => undefined);
  const budget = opts.budget ?? 64 * 2 ** 20;
  const stats: Stats = { hits: 0, misses: 0, stored: 0, diverged: 0, unkeyed: 0, evicted: 0 };

  // A frozen value never changes: its hash is kept by the value itself. Not by
  // node and time, which name another value in another graph this cache serves.
  const memo = new WeakMap<object, Hash>();
  const valueHash = (v: unknown): ArrayBuffer => {
    const frozen = v !== null && typeof v === "object" && Object.isFrozen(v);
    const known = frozen ? memo.get(v as object) : undefined;
    if (known) return bin(known);
    const h = digest(encode(plain(v)));
    if (frozen) memo.set(v as object, h);
    return bin(h);
  };

  const itemHash = (item: { [k: string]: unknown }, mode: NodeEntry["mode"]): ArrayBuffer => {
    if (mode === "whole") return bin(digest(encode(plain(item))));
    // from and change left out, but not whether they are there: the code sees
    // that without touching them, with "change" in item or Object.keys
    const { from: _f, change: _c, value, ...rest } = item;
    const has = ["from", "change"].filter((k) => Object.hasOwn(item, k));
    const v = Object.hasOwn(item, "value") ? [valueHash(value)] : [];
    return bin(digest(encode([plain(rest), v, has])));
  };

  /** An answer's shape with each item replaced by its hash. */
  const shape = (x: unknown, mode: NodeEntry["mode"]): Value => {
    if (Array.isArray(x)) return x.map((i) => itemHash(i, mode));
    const l = x as { items?: unknown[]; directory?: [string, unknown[]][] };
    if (l.items) return { items: shape(l.items, mode) };
    return { directory: l.directory!.map(([n, items]) => [n, shape(items, mode)]) };
  };

  /** The hash of a step's answer, by mode; throws when something in it has no hash. */
  const answerHash = (s: Step, mode: NodeEntry["mode"]): Hash => {
    if (s.error !== undefined) {
      const e = s.error as ErmineError;
      return digest(encode(["error", plain(e.toJSON())]));
    }
    if (s.kind === "given") return digest(encode(["given", plain(s.raw)]));
    return digest(encode(["ok", mode, shape(s.raw, mode)]));
  };

  /** Items as handed to the compute: from and change are there, and looking at them is noted. */
  const wrap = (x: unknown, s: Step): unknown => {
    if (Array.isArray(x)) {
      return x.map((item) => {
        const out: { [k: string]: unknown } = {};
        for (const [k, v] of Object.entries(item)) {
          if (k === "from" || k === "change") {
            Object.defineProperty(out, k, {
              enumerable: true,
              get: () => {
                s.touched = true;
                return v;
              },
            });
          } else out[k] = v;
        }
        return out;
      });
    }
    const l = x as { items?: unknown[]; directory?: [string, unknown[]][] };
    if (l.items) return { items: wrap(l.items, s) };
    return { directory: l.directory!.map(([n, items]) => [n, wrap(items, s)]) };
  };

  const field = (given: ComputeGiven, name: string): unknown =>
    name === "api.cwd" ? given.api.cwd : (given as unknown as { [k: string]: unknown })[name];

  const callOf = (kind: Kind, arg: unknown): Value => [kind, plain(arg)];

  /** Makes a step through the real given: a read through its api, or a field of it. */
  const make = (kind: Kind, arg: unknown, given: ComputeGiven, call: Value, bytes: string) => {
    const s: Step = { call, bytes, kind, touched: false };
    if (kind === "given") {
      s.raw = s.wrapped = field(given, arg as string);
      return s;
    }
    try {
      s.raw = (given.api as unknown as { [k: string]: (op: unknown) => unknown })[kind](arg);
      s.wrapped = wrap(s.raw, s);
    } catch (e) {
      if (!(e instanceof ErmineError)) throw e;
      s.error = e;
    }
    return s;
  };

  const compute = (p: Running, fn: Loaded, root: Hash): Loaded => (real) => {
    const given = real as unknown as ComputeGiven;
    const marked = given.changes.map((c) => c.time);

    // Replay: walk the tree, making each recorded step again.
    const steps: Step[] = [];
    let k = root;
    let unkeyed = false;
    const now = store.tick();
    for (;;) {
      const e = store.get(k);
      if (!e) break;
      store.touch(k, now);
      if (isLeaf(e)) {
        stats.hits++;
        opts.onhit?.({ process: p.id, marked, leaf: k, from: e.from, steps: steps.length });
        return decode(encode(e.leaf));
      }
      const [kind, arg] = e.step as [Kind, unknown];
      const bytes = hex(encode(e.step));
      const s = make(kind, arg, given, e.step, bytes);
      steps.push(s);
      try {
        k = chain(k, answerHash(s, e.mode));
      } catch {
        unkeyed = true; // a live value: the run goes on, and is not kept
        break;
      }
    }

    // Miss: run the code, handing it the steps already made, in order.
    stats.misses++;
    let served = 0;
    let diverged = false;
    const step = (kind: Kind, arg: unknown): unknown => {
      let call: Value;
      let bytes: string;
      try {
        call = callOf(kind, arg);
        bytes = hex(encode(call));
      } catch {
        unkeyed = true;
        return pass(kind, arg);
      }
      if (!diverged && served < steps.length) {
        const s = steps[served];
        if (s.bytes === bytes) {
          served++;
          if (s.error !== undefined) throw s.error;
          return s.wrapped;
        }
        diverged = true;
      }
      if (diverged || unkeyed) return pass(kind, arg);
      const s = make(kind, arg, given, call, bytes);
      steps.push(s);
      served++;
      if (s.error !== undefined) throw s.error;
      return s.wrapped;
    };
    const pass = (kind: Kind, arg: unknown) =>
      kind === "given"
        ? field(given, arg as string)
        : (given.api as unknown as { [k: string]: (op: unknown) => unknown })[kind](arg);

    const api = new Proxy(given.api, {
      get(t, name, r) {
        if (typeof name === "string" && OPS.has(name)) {
          return (op: unknown) => step(name as Kind, op);
        }
        if (name === "cwd") return given1("api.cwd");
        const v = Reflect.get(t, name, r);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          unkeyed = true; // any other operation: not a read the trace can make again
          return v.apply(t, args);
        };
      },
    });
    // a field is a step the first time the code uses it; after, the same answer, no step
    const asked = new Set<string>();
    const given1 = (name: string) => {
      if (asked.has(name)) return pass("given", name);
      asked.add(name);
      return step("given", name);
    };
    const traced: { [k: string]: unknown } = {};
    for (const name of Object.keys(given)) {
      if (name === "api") traced.api = api;
      else if (GIVEN.has(name)) {
        Object.defineProperty(traced, name, { enumerable: true, get: () => given1(name) });
      } else traced[name] = (given as unknown as { [k: string]: unknown })[name];
    }

    const v = fn(traced as unknown as Parameters<Loaded>[0]);
    if (served < steps.length) diverged = true;
    if (v === given.pending || unkeyed || diverged) {
      if (diverged) stats.diverged++;
      if (unkeyed) stats.unkeyed++;
      return v;
    }

    // Keep the trace: each step with its mode, then the leaf.
    let leaf: Uint8Array;
    try {
      leaf = encode(plain(v));
    } catch {
      stats.unkeyed++;
      return v;
    }
    const writes: [Hash, Entry][] = [];
    let at = root;
    try {
      for (const s of steps) {
        const old = store.get(at);
        if (old && (isLeaf(old) || hex(encode(old.step)) !== s.bytes)) {
          stats.diverged++;
          return v;
        }
        const mode = s.touched || (old && old.mode === "whole") ? "whole" : "values";
        if (!old || old.mode !== mode) writes.push([at, { step: s.call, mode, used: now }]);
        at = chain(at, answerHash(s, mode));
      }
    } catch {
      stats.unkeyed++;
      return v;
    }
    for (const [h, e] of writes) store.put(h, e);
    store.put(at, {
      leaf: decode(leaf),
      from: { process: p.id, marked, at: Date.now() },
      used: now,
    });
    stats.stored++;
    stats.evicted += store.evict(budget);
    return v;
  };

  return {
    stats,
    started: (p) => inner.started?.(p),
    killed: (p) => inner.killed?.(p),
    load(code, part, p) {
      const fn = inner.load(code, part, p);
      if (part !== "compute" || p.code === undefined || p.code.effect !== undefined) return fn;
      const k = key(code, part);
      if (k === undefined) return fn;
      return compute(p, fn, digest(encode(["ermine-cache", k])));
    },
  };
}
