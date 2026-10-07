/// <reference lib="dom" />
// ermine/signals: Solid-style signals inside a program. The design is
// plans/signals.org. It is a library a program imports, not core.
//
//   const my = signals({ count: input(0), todos: keep(null), doc: source("doc") })
//
//   export function compute(ctx) { const { count } = my(ctx); return count() * 2 }
//   export function effect(ctx)  { const { count } = my(ctx); ctx.handler("hop", () => count((n) => n + 1)) }
//
// The declarations sit at module level and hold only names and first values.
// my(ctx) gives handles, and tells the compute from the effect by what the
// scheduler passed. Three kinds of signal:
//
//   input(v, at?)   an ephemeral node at <pid>/<key>: it goes with the process
//   keep(v, at?)    an ordinary node at ./<key>, beside the process: it stays,
//                   and a later process, or another one here, finds it
//   source(name)    the nearest name a lookup finds; never made
//
// In the effect, my(ctx) makes each input and keep whose slot is empty,
// through ctx.api, so the placement is in the run's record; every later run
// finds the slot and makes nothing. In the compute, a read that finds nothing
// gives the declared first value, so the first run does not stall.
//
// A signal is an ermine/dom Handle (isHandle is true, {count} renders in
// JSX, why(el) leads back), with add and drop added.

import { type Handle, node, parse, patchOf, untracked } from "../dom/mod.ts";
import {
  type Address,
  type Changed,
  invalid,
  type Json,
  ours,
  type Patch,
  type PathFrom,
  type PlaceOp,
  type SlotItem,
} from "../types.ts";
import type { EffectGiven } from "../loaders.ts";
import { type Given, isEffect, type Route, routeOf } from "./route.ts";

export { show } from "./show.ts";
export type { Given } from "./route.ts";

ours(import.meta.url);

/** What kind of node a signal is on: its children are made the same way. */
type Kind = "input" | "keep" | "source";

/** A declaration: a kind, a first value, and where, if not the default. */
export type Decl<T> =
  | { readonly kind: "input" | "keep"; readonly first: T; readonly at?: string }
  | { readonly kind: "source"; readonly name: string; readonly first?: T };

/** A handle on a node, callable: s() reads, s(v) writes. */
export interface Signal<T = Json> extends Handle {
  /** The value of the first item with one; if none, the declared first value, or undefined. */
  (): T;
  /**
   * Writes, as a handle does (s(f) is s(f(s())), a patch is applied, anything
   * else is a snapshot): in the effect's body through its api, after through lasting.
   */
  (change: T | Patch | ((value: T) => T | Patch)): Changed;
  /** Places a child: ephemeral under an input, ordinary otherwise. Gives its signal. */
  add<U extends Json = Json>(value: U, name?: string): Signal<U>;
  /** Unplaces every node in the child slot of that name. */
  drop(name: string): Changed;
  /** A signal on a path from this one: "title", "..", "/x". */
  // deno-lint-ignore no-explicit-any
  at<U = any>(path: string | Address): Signal<U>;
}

/** A first value's type, widened as a variable's would be: input(0) is a number, not 0. */
type Widen<T> = T extends number ? number
  : T extends string ? string
  : T extends boolean ? boolean
  : T;

/** An ephemeral node at <pid>/<key>, or at `at`, a path from ".". It goes with the process. */
export function input<T extends Json>(first: T, at?: string): Decl<Widen<T>> {
  return at === undefined
    ? { kind: "input", first } as never
    : { kind: "input", first, at } as never;
}

/** An ordinary node at ./<key>, or at `at`. It outlives the process. */
export function keep<T extends Json>(first: T, at?: string): Decl<Widen<T>> {
  return at === undefined ? { kind: "keep", first } as never : { kind: "keep", first, at } as never;
}

/** The nearest `name` a lookup finds, nearest first. Never made; undefined when nothing is there. */
export function source<T extends Json = Json>(name: string): Decl<T | undefined> {
  return { kind: "source", name };
}

type Signals<D> = { [K in keyof D]: D[K] extends Decl<infer T> ? Signal<T> : never };

/**
 * Declared at module level. Called with a part's context, gives a signal for
 * each declaration; in an effect it first makes any input or keep whose slot
 * is empty, in the order declared.
 */
// deno-lint-ignore no-explicit-any
export function signals<D extends { [key: string]: Decl<any> }>(
  decls: D,
): (ctx: Given) => Signals<D> {
  const given = new WeakMap<Given, Signals<D>>();
  return (ctx) => {
    const had = given.get(ctx);
    if (had) return had;
    const route = routeOf(ctx);
    const out: { [key: string]: Signal } = {};
    for (const [key, d] of Object.entries(decls)) {
      if (d.kind === "source") {
        out[key] = signal(route, found(route, d.name), "source");
        continue;
      }
      const address = d.at !== undefined
        ? parse(d.at)
        : d.kind === "input"
        ? [ctx.name, key]
        : [key];
      if (isEffect(ctx)) make(ctx, route, address, d.kind, d.first);
      out[key] = signal(route, address, d.kind, d.first);
    }
    const signals = out as Signals<D>;
    given.set(ctx, signals);
    return signals;
  };
}

/**
 * A signal on the process's own node: what its compute returned, waiting and
 * error items in front. What add places under it is ephemeral, as under an
 * input: an ordinary node under the process would be kept with the dead
 * process node and never found again.
 */
// deno-lint-ignore no-explicit-any
export function me<T = any>(ctx: Given): Signal<T | undefined> {
  return signal<T | undefined>(routeOf(ctx), [ctx.name], "input");
}

/** A new id: the core only compares them. */
const fresh = () => crypto.randomUUID();

/**
 * A child's name when add is given none. A directory lists in code point
 * order, so the name starts with the time, and each is later than the last
 * made here: children list in the order they were added. The random tail
 * keeps two devices adding at one moment from sharing a slot.
 */
let lastMade = 0;
const nameOf = () => {
  lastMade = Math.max(Date.now(), lastMade + 1);
  return `${lastMade.toString(36)}-${crypto.randomUUID().slice(0, 5)}`;
};

/**
 * Makes the node at address if its slot is empty. It checks the slot, not the
 * value, through lasting, which is neither kept nor recorded, so a mounted
 * node that is not here yet counts as there.
 */
function make(ctx: EffectGiven, route: Route, address: string[], kind: Kind, first: Json) {
  const parent = address.slice(0, -1);
  const name = address[address.length - 1];
  const listing = ctx.lasting.directory({ address: parent, name } as never);
  if ("items" in listing && listing.items.length) return;
  route.place({
    address: parent,
    name,
    id: fresh(),
    value: first,
    ...(kind === "input" ? { ephemeral: true } : {}),
  } as PlaceOp);
}

/**
 * Where a lookup finds name: the path to the nearest slot with that name.
 * Finding a slot ends the search, so a slot whose node is pending (mounted,
 * not here yet) is still the one; its read then shows the pending item.
 * When nothing is found, ./name, which the compute's recorded lookup will
 * notice being made.
 */
function found(route: Route, name: string): string[] {
  const items = route.lookup({ name } as never);
  const hit = items.find((i): i is SlotItem => "id" in i);
  return hit ? [...(hit.from as PathFrom).path] : [name];
}

/** A signal over route at address: a dom Handle, with first-value reads, add, drop. */
function signal<T = Json>(
  route: Route,
  address: readonly string[],
  kind: Kind,
  first?: Json,
): Signal<T> {
  const h = node(route, address);
  const s = function (...args: [] | [unknown]) {
    if (args.length) return h(patchOf(args[0], () => untracked(() => s())));
    // the first value stands in only when the read gives nothing at all: a
    // pending, waiting or error item is something, and gives undefined, as a
    // handle does, so the compute can see it in items() and say pending
    const items = h.items();
    const hit = items.find((i) => Object.hasOwn(i, "value"));
    if (hit) return (hit as { value: Json }).value;
    return items.length ? undefined : first;
  } as Signal<T>;
  Object.defineProperties(s, {
    api: { value: route },
    path: { value: h.path },
    acting: { value: (h as unknown as { acting: unknown }).acting },
    name: { value: h.name },
  });
  const child: Kind = kind === "input" ? "input" : "keep";
  Object.assign(s, {
    items: h.items,
    slot: h.slot,
    names: h.names,
    write: h.write,
    place: h.place,
    unplace: h.unplace,
    toString: h.toString,
    at: (path: string | Address) => signal(route, h.at(path).path, child),
    add(value: Json, name?: string) {
      const id = fresh();
      const n = name ?? nameOf();
      route.place({
        address: h.path,
        name: n,
        id,
        value,
        ...(child === "input" ? { ephemeral: true } : {}),
      } as PlaceOp);
      return s.at(n);
    },
    drop(name: string) {
      const listing = route.directory({ address: h.path, name } as never);
      const ids = "items" in listing ? listing.items.map((i) => i.id) : [];
      if (!ids.length) throw invalid("nothing-there", `${name} is not there to drop`, { name });
      let last!: Changed;
      for (const id of ids) last = route.unplace({ address: h.path, name, id } as never);
      return last;
    },
  });
  return s;
}
