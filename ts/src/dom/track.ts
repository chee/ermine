// Tracking: the scheduler's scopes, as the renderer uses them (ts/demo/dom.org,
// Scopes). JSX is an effect scope, as in Solid: each bound part is a scope
// the scheduler runs. Its compute reads, through a recording under the
// scope's id, so the graph marks it; its effect patches the DOM. Nothing
// here subscribes, or keeps a table of reads: the record says what was read.
//
// While a scope's compute runs, it is the *frame*: a handle read goes through
// its recorded interface, a handle write is refused by it, read-only, and a
// scope made goes under it. untracked code (components) reads through the
// handle's own interface, recording nothing, and still owns what it makes. A
// handler keeps the owner it was registered under, as Solid's runWithOwner.

import type { MakeScope, Scope, ScopeCompute, ScopeEffect } from "../loaders.ts";
import { type Address, type Interface, type Item, ours } from "../types.ts";

ours(import.meta.url);

export type { Scope } from "../loaders.ts";

/** A handle as the tracker knows it: an interface, an address, and how to act as its agent. */
export type Source = {
  readonly api: Interface;
  readonly path: Address;
  readonly acting: { agent?: unknown };
};

/** The scope being computed, or the owner being rendered into: where reads go, where scopes go. */
type Frame = { make: MakeScope; api?: Interface; seen?: Map<string, Item[]> };

let frame: Frame | undefined;
let listening = true;

/** What each scope's last compute read, by address: the items behind its record's reads. */
export const seen = new WeakMap<Scope, Map<string, Item[]>>();

/** Runs fn with frame f. */
function within<T>(f: Frame | undefined, fn: () => T): T {
  const was = frame, heard = listening;
  frame = f;
  listening = true;
  try {
    return fn();
  } finally {
    frame = was;
    listening = heard;
  }
}

/**
 * Runs fn so that what it reads binds nothing, as components and handlers
 * run; scopes it makes are still owned by the scope being computed.
 */
export function untracked<T>(fn: () => T): T {
  const was = listening;
  listening = false;
  try {
    return fn();
  } finally {
    listening = was;
  }
}

/** The owner a scope made now goes under, if any. */
export const owner = (): MakeScope | undefined => frame?.make;

/** Where a handle writes now: through the compute's api while one runs, which refuses it; else undefined. */
export const writer = (): Interface | undefined => frame?.api;

/** Runs fn with make as the owner of the scopes it makes, reading nothing tracked. */
export function owned<T>(make: MakeScope, fn: () => T): T {
  return within({ make }, fn);
}

const sameCwd = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * Where a handle reads now: through the scope's recording, while a compute
 * runs and is listening; else through its own interface. A handle whose
 * interface is placed elsewhere reads by an absolute address.
 */
export function reader(h: Source): { api: Interface; address: Address; acting: object } {
  const api = listening ? frame?.api : undefined;
  if (!api) return { api: h.api, address: h.path, acting: h.acting };
  if (sameCwd(h.api.cwd ?? [], api.cwd ?? [])) return { api, address: h.path, acting: {} };
  if (h.path[0] === "/") return { api, address: h.path, acting: {} };
  let up = 0;
  while (h.path[up] === "..") up++;
  const cwd = h.api.cwd ?? [];
  return {
    api,
    address: ["/", ...cwd.slice(0, cwd.length - up), ...h.path.slice(up)],
    acting: {},
  };
}

/** Notes what a read through a scope's recording gave, for why. */
export function tracked(address: Address, items: Item[]) {
  if (listening && frame?.api && frame.seen) frame.seen.set(JSON.stringify(address), items);
}

/**
 * A scope under the current owner: compute reads, tracked; effect applies.
 * Throws when there is no owner: render inside an effect, with its ctx.
 */
export function scope<T>(
  compute: () => T,
  effect: ScopeEffect<T>,
): Scope {
  const make = frame?.make;
  if (!make) {
    throw new Error("no owner: render inside a program's effect, as render(fn, el, ctx) or show");
  }
  let reads = new Map<string, Item[]>();
  // its first run is over before make returns, and so before this is set
  const made: { scope?: Scope } = {};
  made.scope = make<T>(
    ((given) => {
      const now = reads = new Map();
      try {
        return within({ make: given.scope, api: given.api, seen: now }, compute);
      } finally {
        // the reads of the run its record will be: why pairs the two
        if (made.scope) seen.set(made.scope, now);
      }
    }) as ScopeCompute<T>,
    // an effect is not the compute: it is not refused, and reads nothing tracked
    (value, previous) => within(frame && { make: frame.make }, () => effect(value, previous)),
  );
  seen.set(made.scope, reads);
  return made.scope;
}
