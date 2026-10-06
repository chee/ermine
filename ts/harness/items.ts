// Reads as lists of items (CORE.tex, "Reads are lists"; PROTOCOL.tex,
// Encodings). The library answers a read with a value or absent; the harness
// gives every reader the list of items the protocol names.

import type { Fixed, Found, Json, Listing, Reading } from "../src/types.ts";

export type Item = { [key: string]: Json };

/** An item read by id. */
function byNode(node: string, value: Json): Item {
  return { value, from: { node } };
}

export function readItems(node: string, r: Reading): Item[] {
  return "value" in r ? [byNode(node, r.value)] : [];
}

export function dataItems(node: string, r: Fixed): Item[] {
  return "data" in r ? [byNode(node, r.data)] : [];
}

/** The items of one slot, in slot order. */
export function slotItems(parent: string, name: string, ids: readonly string[], up?: number) {
  return ids.map((id, position): Item => ({
    id,
    from: { slot: { parent, name }, position, ...(up === undefined ? {} : { up }) },
  }));
}

/** A directory listing: items of one slot with a name, [[name, [item]]] without. */
export function listingItems(
  node: string,
  name: string | undefined,
  r: Listing,
): { items: Item[] } | {
  directory: [string, Item[]][];
} {
  if ("directory" in r) {
    return { directory: r.directory.map(([name, ids]) => [name, slotItems(node, name, ids)]) };
  }
  if (name === undefined) return { directory: [] };
  return { items: "slot" in r ? slotItems(node, name!, r.slot) : [] };
}

/**
 * A lookup's items: each from the slot of the nearest directory that had the
 * name, which is the last one searched, and how far above the first it is.
 */
export function lookupItems(name: string, r: Found): Item[] {
  if (r.found.length === 0) return [];
  const up = r.searched.length - 1;
  const last = r.searched[up] as { node: string };
  return slotItems(last.node, name, r.found, up);
}
