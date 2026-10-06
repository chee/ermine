/// <reference lib="dom" />
// What the panes share: the world, what is selected, what is being explained.

import { signal } from "@preact/signals";
import type { ChangeRef, Id, Step } from "../../../src/mod.ts";
import { World } from "./world.ts";

export const world = new World();

/** A node, and the route it was reached by, which is a path for lookups. */
export type Selection = { id: Id; route: Step[] };
export const selected = signal<Selection | undefined>(undefined);

/** What the why pane explains. */
export type Focus =
  | { t: "change"; ref: ChangeRef }
  | { t: "record"; process: Id; run: number }
  | { t: "snippet"; n: number; line?: number };
export const focus = signal<Focus | undefined>(undefined);

/** Whether the graph is exploded onto the canvas. */
export const explode = signal(false);

/** Whether the dock takes most of the height, for watching the stage. */
export const tall = signal(false);

export type DockTab = "workspace" | "stage" | "protect" | "lookup" | "make";
export const dock = signal<DockTab>("workspace");

/** Code waiting in the workspace editor. */
export const draft = signal<string>("");
/** The line of a snippet to point at in the workspace. */
export const pointAt = signal<{ n: number; line: number } | undefined>(undefined);

/** Lookups found by the lookup pane, to light up in the browser. */
export const lit = signal<{ searched: Id[]; found: Id[] } | undefined>(undefined);

export const theme = signal<"light" | "dark">(
  (() => {
    try {
      const t = localStorage.getItem("ermine-theme");
      if (t === "light" || t === "dark") return t;
    } catch { /* no storage */ }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  })(),
);

export function select(id: Id, route: Step[] = []) {
  selected.value = { id, route };
}

/** Runs code in the workspace and shows it there. */
/** The last act from the ui, shown for a moment with the code it ran. */
export const toast = signal<
  { n: number; code: string; label?: string; ok: boolean; why?: string } | undefined
>(
  undefined,
);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function act(code: string, label?: string) {
  const s = world.run(code, label);
  toast.value = { n: s.n, code, label, ok: s.ok !== false, why: s.error?.why };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = undefined), s.ok === false ? 5000 : 2600);
  return s;
}

/** Undoes or redoes the last act, as a new change, and shows the code it ran. */
export function undo(redo = false) {
  const s = redo ? world.redo() : world.undo();
  if (!s) {
    toast.value = {
      n: -1,
      code: redo ? "nothing to redo" : "nothing to undo",
      label: redo ? "redo" : "undo",
      ok: true,
    };
  } else {toast.value = {
      n: s.n,
      code: s.code,
      label: s.label,
      ok: s.ok !== false,
      why: s.error?.why,
    };}
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = undefined), 2600);
}
