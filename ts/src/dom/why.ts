/// <reference lib="dom" />
// The way back. From any DOM node, such as a click's target, why() finds the
// nearest node a bound part made, or the nearest element one was put in, and
// answers from the record of the scope that made it (ts/demo/dom.org, Scopes):
// for each value its last compute read, the path, the route, and the change
// it saw (the record's saw), with every item the read gave; of the item
// shown, the node it reached (its id, for mounting only); and, when a
// process made that change, which process and which run, handler call or
// lasting interface, as the change's agent names them (SCHEDULER.tex, What
// a process acts as).
//
// Nothing is put in the DOM: no ids, no paths. A scope that runs again has a
// new record, so after a re-render the same text node answers with the
// newer change.

import type { Address, Header, Id, Item, Json, ReadEntry, Route } from "../types.ts";
import { bound, holds, type Ref } from "./render.ts";
import { type Scope, seen } from "./track.ts";

/** What one read gave, and why. */
export type Reason = {
  /** the address read, from the process's place */
  path: Address;
  /** every item the read gave, items in front included */
  items: Item[];
  /** the item this node shows, or else the one whose change the record saw */
  item?: Item;
  /** the node the item came from: an id, which only mounts */
  node?: Id;
  route?: Route;
  /** the change that last set what the item holds: its agent, process, cause and time */
  change?: Header;
  /** the last step of the change's agent, when code made it: process, program, and run or handler */
  by?: Json;
};

export type Why = {
  /** the nearest DOM node made from the graph, or holding something made from it */
  node: Node;
  /** what made it read, one reason per value read */
  reasons: Reason[];
};

/** Why a DOM node shows what it shows: the nearest bound node at or above it, and its scope's record. */
export function why(target: Node): Why | undefined {
  for (let n: Node | null = target; n; n = n.parentNode) {
    const b = bound.get(n);
    if (b?.ref.scope && live(b.ref)) return { node: n, reasons: reasons(b.ref.scope, b.item) };
    const scopes = holds.get(n)?.filter((r) => live(r) && valueReads(r.scope!).length);
    if (scopes?.length) return { node: n, reasons: scopes.flatMap((r) => reasons(r.scope!)) };
  }
}

const live = (r: Ref) => r.scope !== undefined && !r.scope.disposed;

/** The reads of a scope's last record that read values, not directories. */
function valueReads(s: Scope): ReadEntry[] {
  // an address read twice in one run: the later read is what it shows
  const by = new Map<string, ReadEntry>();
  for (const r of s.record?.reads ?? []) {
    if (r.op !== "read") continue;
    const k = JSON.stringify(r.address);
    by.delete(k);
    by.set(k, r);
  }
  return [...by.values()];
}

function reasons(scope: Scope, shown?: Item): Reason[] {
  const reads = valueReads(scope);
  const gave = seen.get(scope);
  return reads.map((entry) => {
    const items = gave?.get(JSON.stringify(entry.address)) ?? [];
    const at = (i: Item) => (i as { change?: Header }).change?.time === entry.saw;
    const item = shown && (items.includes(shown) || reads.length === 1)
      ? shown
      : items.find(at) ?? items.find((i) => Object.hasOwn(i, "value")) ?? items[0];
    const r: Reason = { path: entry.address, items, route: entry.route };
    const last = entry.route.at(-1);
    if (last) r.node = last.node;
    if (!item) return r;
    r.item = item;
    const from = (item as { from?: { route?: Route } }).from;
    if (from?.route?.length) {
      r.route = from.route;
      r.node = from.route.at(-1)!.node;
    }
    const change = (item as { change?: Header }).change;
    if (change) {
      r.change = change;
      const code = (change.agent as { code?: Json[] } | null)?.code;
      if (Array.isArray(code) && code.length) r.by = code[code.length - 1];
    }
    return r;
  });
}
