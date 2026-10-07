// X-ray and halos, drawn over the stage by the host, never into it.
//
// X-ray: every element that is an ephemeral node's live value gets a dashed
// outline and a label: its node, the process that placed it, and that
// process's items. The host knows which elements those are only from the
// placements the tap saw (World.owner). Dashed is what a reload does not
// bring back.
//
// Halos: when a change that is not ephemeral marks a process, the surfaces
// that process placed glow for a second in the colour of the change's actor,
// as its header names it.

import type { Id, ProcessItem } from "d2/ermine";
import { isObject, type Line, type World } from "./stack.ts";
import { colourOf, ui } from "./view.tsx";

export function xray(w: World, layer: HTMLElement) {
  const draw = () => {
    for (const old of layer.querySelectorAll(".xbox, .xcaption")) old.remove();
    if (!ui.xray.value) return;
    const doc = layer.ownerDocument;
    const caption = doc.createElement("div");
    caption.className = "xcaption";
    caption.textContent = "dashed = ephemeral: never kept. A reload brings back everything else.";
    layer.append(caption);
    const base = layer.getBoundingClientRect();
    for (const [live, id] of w.owner) {
      if (!(live instanceof HTMLElement) || !live.isConnected) continue;
      const r = live.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const box = doc.createElement("div");
      box.className = "xbox";
      box.style.left = `${r.left - base.left}px`;
      box.style.top = `${r.top - base.top}px`;
      if (w.made.get(id)?.process === undefined) box.classList.add("host");
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      const by = w.made.get(id)?.process;
      let items: ProcessItem[] = [];
      const path = by ? w.pathOf(by) : undefined;
      if (path) {
        try {
          items = (w.s.read({ agent: "host", address: path }) as unknown[])
            .filter((i) => isObject(i) && !("value" in i)) as ProcessItem[];
        } catch { /* gone */ }
      }
      const tag = doc.createElement("span");
      tag.className = "xtag";
      tag.textContent = `${id}${by ? ` · by ${by}` : ""}${
        items.map((i) =>
          " · " + ("waiting" in i
            ? "waiting"
            : "stopped" in i
            ? "stopped"
            : "error" in i
            ? "error"
            : "newer")
        ).join("")
      }`;
      box.append(tag);
      layer.append(box);
    }
  };
  return draw;
}

/** Lights the surfaces of the processes a line marked, in its actor's colour, on the layer. */
export function halos(w: World, layer: HTMLElement, from: number): number {
  // from counts every line the tap has seen; w.lines holds only the newest
  const fresh = Math.min(w.seen() - from, w.lines.length);
  const lines: Line[] = fresh > 0 ? w.lines.slice(w.lines.length - fresh) : [];
  const lit = new Map<Id, string>();
  for (const l of lines) {
    if (l.change.ephemeral || !l.marked.length) continue;
    const agent = l.change.agent;
    const actor = isObject(agent) && "actor" in agent ? agent.actor : agent;
    for (const pid of l.marked) lit.set(pid, colourOf(actor));
  }
  for (const [pid, colour] of lit) glow(w, layer, pid, colour);
  return w.seen();
}

function glow(w: World, layer: HTMLElement, pid: Id, colour: string) {
  for (const [id, live] of w.ephemeral) {
    // what the process placed directly under its own node: its surface
    if (!(live instanceof HTMLElement) || !live.isConnected) continue;
    if (w.made.get(id)?.process !== pid || w.where.get(id)?.[0]?.parent !== pid) continue;
    ring(layer, live, colour, "halo");
  }
}

/** A box over an element, on the layer. */
export function ring(layer: HTMLElement, live: HTMLElement, colour: string, kind: string) {
  const base = layer.getBoundingClientRect();
  const r = live.getBoundingClientRect();
  const box = layer.ownerDocument.createElement("div");
  box.className = kind;
  box.style.left = `${r.left - base.left + layer.scrollLeft}px`;
  box.style.top = `${r.top - base.top + layer.scrollTop}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
  box.style.setProperty("--halo", colour);
  layer.append(box);
  if (kind === "halo") setTimeout(() => box.remove(), 1100);
  return box;
}
