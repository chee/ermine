/// <reference lib="dom" />
// Dragging nodes about. Every drop is a line of code in the workspace: a
// placement, a move (place here, then unplace there), or a mount (place here
// too). Placement is the whole of the interface: what changes after a drop is
// what the processes that read those slots make of it.

import type { Id } from "../../../src/mod.ts";
import { act, world } from "./state.ts";
import { J } from "./world.ts";

/** Where a dragged node is placed now, if anywhere. */
export type From = { parent: Id; name: string };

/** Where it is dropped: into a node, or into a slot at a position. */
export type Target =
  | { into: Id }
  | { parent: Id; name: string; position: number };

export const MIME = "application/x-ermine-node";

export function dragData(e: DragEvent, id: Id, from?: From) {
  e.dataTransfer!.setData(MIME, JSON.stringify({ id, from }));
  e.dataTransfer!.setData("text/plain", id);
  e.dataTransfer!.effectAllowed = "copyMove";
}

export function readDrag(e: DragEvent): { id: Id; from?: From } | undefined {
  const t = e.dataTransfer?.getData(MIME);
  if (!t) return;
  try {
    return JSON.parse(t);
  } catch {
    return;
  }
}

/** Drops id at target: a move, unless mounting, or it was placed nowhere. */
export function drop(id: Id, from: From | undefined, target: Target, mount: boolean) {
  const parent = "into" in target ? target.into : target.parent;
  const name = "into" in target ? from?.name ?? id : target.name;
  if (parent === id) return;
  const pos = "into" in target ? "" : `, ${target.position}`;
  const here = `place(${J(parent)}, ${J(name)}, ${J(id)}${pos})`;
  const same = from && from.parent === parent && from.name === name;
  if (same && "into" in target) return;
  let code = here;
  if (same) code = here; // a move within one slot is a placement at a new position
  else if (from && !mount) {
    code = `batch(() => {\n  ${here}\n  unplace(${J(from.parent)}, ${J(from.name)}, ${J(id)})\n})`;
  }
  act(code, mount ? "drag: mount" : from ? "drag: move" : "drag: place");
}

/** The slot index of id in parent's slot name, from the host's copy, beneath protect. */
export function indexIn(parent: Id, name: string, id: Id): number {
  return world.slotOf(parent, name).indexOf(id);
}
