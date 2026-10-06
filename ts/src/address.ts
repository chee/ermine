// Addresses and walks (CORE.tex, Paths). An address is an optional first
// "/", then any "..", then names. A walk goes down from a node, name by name:
// each name selects a slot, and the walk takes the first id in it whose node
// is here and has the next name, as Plan 9 walks a union directory; for the
// last name, the first id whose node is here.

import { type Address, type Id, missing, ours, type Step, wrongField } from "./types.ts";

ours(import.meta.url);

/** An address taken apart: whether it starts at "/", how many "..", and the names after. */
export type Parsed = { root: boolean; up: number; names: string[] };

/** Whether a part may be a name: anything but ".", ".." and "/". */
export function isName(part: unknown): part is string {
  return typeof part === "string" && part !== "." && part !== ".." && part !== "/";
}

/** An address's parts; wrong-field, naming the field, if it is not an address. */
export function parseAddress(address: unknown, field = "address"): Parsed {
  if (address === undefined) throw missing(field);
  if (!Array.isArray(address) || !address.every((p) => typeof p === "string")) {
    throw wrongField(field, `${field} is a list of parts, each a string`);
  }
  let i = 0;
  const root = address[0] === "/";
  if (root) i++;
  let up = 0;
  while (address[i] === "..") {
    up++;
    i++;
  }
  const names = address.slice(i) as string[];
  if (!names.every(isName)) {
    throw wrongField(
      field,
      `${field}: "/" only comes first, ".." only before the names, and "." never`,
    );
  }
  return { root, up, names };
}

/** What a walk reads of a graph: whether a node is here, and its slots. */
export interface View {
  here(id: Id): boolean;
  /** The ids in a slot of a node that is here; empty when the slot is gone. */
  slot(id: Id, name: string): readonly Id[];
}

/** Told what a walk depends on: each slot it tried, and each member it tried. */
export interface Track {
  slot(node: Id, name: string): void;
  here(id: Id): void;
}

/** Where a walk got to: the node it reached, if any, and the route it took. */
export type Walked = { node?: Id; route: Step[] };

/**
 * Walks the names down from a node that is here. after is the name that
 * follows the last one, when the walk is part of a longer one, so its last
 * step takes the first member that has it.
 */
export function walk(
  view: View,
  from: Id,
  names: readonly string[],
  track?: Track,
  after?: string,
): Walked {
  let at = from;
  const route: Step[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const next = i + 1 < names.length ? names[i + 1] : after;
    track?.slot(at, name);
    const slot = view.slot(at, name);
    let taken = -1;
    for (let j = 0; j < slot.length; j++) {
      const id = slot[j];
      track?.here(id);
      if (!view.here(id)) continue;
      if (next !== undefined) {
        track?.slot(id, next);
        if (view.slot(id, next).length === 0) continue;
      }
      taken = j;
      break;
    }
    if (taken < 0) return { route };
    route.push({ parent: at, name, node: slot[taken], position: taken });
    at = slot[taken];
  }
  return { node: at, route };
}

/**
 * The nodes a directory read of these names lists together: with no names,
 * the node walked from; otherwise every member of the last name's slot that
 * is here, in slot order, each with its route, as ls lists a Plan 9 union.
 */
export function members(
  view: View,
  from: Id,
  names: readonly string[],
  track?: Track,
): { node: Id; route: Step[] }[] {
  if (names.length === 0) return [{ node: from, route: [] }];
  const last = names[names.length - 1];
  const head = walk(view, from, names.slice(0, -1), track, last);
  if (head.node === undefined) return [];
  const parent = head.node;
  track?.slot(parent, last);
  const out: { node: Id; route: Step[] }[] = [];
  view.slot(parent, last).forEach((id, position) => {
    track?.here(id);
    if (view.here(id)) {
      out.push({ node: id, route: [...head.route, { parent, name: last, node: id, position }] });
    }
  });
  return out;
}

/** The address of a lookup's step k: k ".." then the name. */
export function upward(k: number, name: string): Address {
  return [...Array.from({ length: k }, () => ".."), name];
}
