/// <reference lib="dom" />
// Handles. The core has no node handles, on purpose: everything is reached
// by path, and every read gives a list of items (CORE.tex, Paths). A handle
// is library sugar over that: an interface and an address, callable.
//
//   const count = node(api, "count")
//   count()                 the value of the first item with a value; tracked in a scope's compute
//   count(count() + 1)      a snapshot written through api, as its agent
//   count.items()           every item: waiting, stopped, error, newer, and each member's value
//
// A handle holds no id and no value: each call follows its address afresh,
// so it is whatever is at that path now. A write made from outside any
// process gets its site as its cause from the graph, captured where it
// entered the stack: this file is ermine's, so the site is the line that
// called the handle, such as an onClick on a JSX line.

import {
  type Address,
  type Changed,
  type Id,
  type Interface,
  type Item,
  type Json,
  ours,
  type Patch,
  type SlotItem,
} from "../types.ts";
import { reader, type Source, tracked, untracked, writer } from "./track.ts";

ours(import.meta.url);

export interface Handle extends Source {
  /** The value of the first item that has one, undefined if none; tracked in a scope. */
  (): Json | undefined;
  /**
   * Writes, as shift's streams do: a function is an updater, h(f) is h(f(h()));
   * a patch is applied; any other value is written as a snapshot. What it
   * marks, the scopes drawing the page included, has run when it returns.
   */
  // deno-lint-ignore no-explicit-any
  (change: Json | Patch | ((value: any) => Json | Patch)): Changed;
  /** Every item reading the address gives, items in front included; tracked. */
  items(): Item[];
  /** The ids in the slot the address's last name selects, in slot order, pending ones included; tracked. */
  slot(): SlotItem[];
  /** The names in the directory of the node the address reaches; tracked. */
  names(): string[];
  /** A handle on a path from this one: "title", "..", "/x". */
  at(path: string | Address): Handle;
  write(patches: readonly Patch[]): Changed;
  place(
    name: string,
    id: Id,
    value?: Json,
    more?: { position?: number; ephemeral?: boolean },
  ): Changed;
  unplace(name: string, id: Id): Changed;
}

/** A path as the console writes it: "/" first starts at "/", "." is skipped, ".." goes back. */
export function parse(path: string | Address): string[] {
  if (typeof path !== "string") return [...path];
  const out: string[] = path.startsWith("/") ? ["/"] : [];
  for (const part of path.split("/")) if (part && part !== ".") out.push(part);
  return out;
}

/** Joins a path onto an address: ".." takes back the last name, or goes up. */
function join(base: Address, path: string | Address): string[] {
  const more = parse(path);
  if (more[0] === "/") return more;
  const out = [...base];
  for (const part of more) {
    const last = out[out.length - 1];
    if (part === ".." && last !== undefined && last !== ".." && last !== "/") out.pop();
    else out.push(part);
  }
  return out;
}

const isName = (s: string | undefined) => s !== undefined && s !== "/" && s !== "..";

/** A handle on the address path, through api; agent for interfaces that are not bound. */
export function node(
  api: Interface,
  path: string | Address,
  options: { agent?: Json } = {},
): Handle {
  const address = Object.freeze(parse(path));
  const acting = options.agent === undefined ? {} : { agent: options.agent };
  const op = <T>(o: T) => ({ ...acting, ...o }) as never;

  /** A read: through the scope being computed, if one is, so its record has it; else through api. */
  const read = (): Item[] => {
    const r = reader(h);
    const items = r.api.read({ ...r.acting, address: r.address } as never) as Item[];
    tracked(r.address, items);
    return items;
  };
  /** Through the handle's interface; inside a compute, through its api, which refuses it. */
  const to = () => writer() ?? api;
  const write = (patches: readonly Patch[]) => to().write(op({ address, patches }));

  const h = function (this: unknown, ...args: [] | [unknown]) {
    if (args.length === 0) {
      const first = read().find((i) => Object.hasOwn(i, "value"));
      return first && "value" in first ? first.value : undefined;
    }
    // an updater's read is not the compute's
    return write([patchOf(args[0], () => untracked(() => h()))]);
  } as Handle;

  Object.defineProperties(h, {
    api: { value: api },
    path: { value: address },
    acting: { value: acting },
    name: { value: address.join("/") || "." },
  });
  Object.assign(h, {
    items: read,
    slot(): SlotItem[] {
      const name = address[address.length - 1];
      if (!isName(name)) return [];
      const r = reader(h.at(".."));
      const listing = r.api.directory({ ...r.acting, address: r.address, name } as never);
      return "items" in listing ? listing.items : [];
    },
    names(): string[] {
      const r = reader(h);
      const listing = r.api.directory({ ...r.acting, address: r.address } as never);
      const entries = "directory" in listing ? listing.directory : [];
      return entries.map(([n]) => n);
    },
    at: (more: string | Address) => node(api, join(address, more), options),
    write,
    place: (
      name: string,
      id: Id,
      value?: Json,
      more: { position?: number; ephemeral?: boolean } = {},
    ) => to().place(op({ address, name, id, ...(value === undefined ? {} : { value }), ...more })),
    unplace: (name: string, id: Id) => to().unplace(op({ address, name, id })),
    toString: () => address.join("/"),
  });
  return h;
}

/** What a handle's write means, as in shift: a function updates the value now, a patch is itself, anything else is a snapshot. */
export function patchOf(change: unknown, now: () => unknown): Patch {
  const c = typeof change === "function" ? change(now()) : change;
  return isPatch(c) ? c : { type: "snapshot", value: c as Json };
}

/** Whether a value is shaped as a patch: a snapshot, splice or set. */
export function isPatch(v: unknown): v is Patch {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  if (p.type === "snapshot") return Object.hasOwn(p, "value");
  if (!Array.isArray(p.path)) return false;
  if (p.type === "splice") return Array.isArray(p.range) && p.range.length === 2;
  if (p.type === "set") return typeof p.key === "string";
  return false;
}

/** Whether a value is a handle. */
export function isHandle(v: unknown): v is Handle {
  return typeof v === "function" && "path" in v && "api" in v && "items" in v;
}
