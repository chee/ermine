/// <reference lib="dom" />
// What the panes share: the world, what is selected, what is being explained.

import { signal } from "@preact/signals";
import type { Id, Step } from "../../../src/mod.ts";
import { World } from "./world.ts";
import { Console } from "./console.ts";

export const world = new World();

const HISTORY = "ermine-console-history";

/** The console: its commands act on the world as the acting agent, through the page's stack. */
export const shell = new Console(world, {
  history: (() => {
    try {
      const h = JSON.parse(localStorage.getItem(HISTORY) ?? "[]");
      return Array.isArray(h) ? h.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  })(),
  saved: (history) => {
    try {
      localStorage.setItem(HISTORY, JSON.stringify(history.slice(-200)));
    } catch { /* no storage */ }
  },
});

/** Whether the console is open; and the line to show, when a site names one. */
export const consoleOpen = signal(false);
export const consoleAt = signal<number | undefined>(undefined);

/** A node, and the route it was reached by, which is a path for lookups. */
export type Selection = { id: Id; route: Step[] };
export const selected = signal<Selection | undefined>(undefined);

/** What the why pane explains. */
export type Focus =
  | { t: "change"; ref: number }
  | { t: "record"; process: Id; run: number }
  | { t: "handler"; n: number }
  | { t: "snippet"; n: number; line?: number };
export const focus = signal<Focus | undefined>(undefined);

/** Whether the graph is exploded onto the canvas. */
export const explode = signal(false);

/** Whether the dock takes most of the height, for watching the stage. */
export const tall = signal(false);

/** The panels' sizes, in pixels, where they have been dragged; the rest are the stylesheet's. */
export type Panels = { left?: number; right?: number; dock?: number; why?: number };
const PANELS = "ermine-panels";
export const panels = signal<Panels>((() => {
  try {
    const p = JSON.parse(localStorage.getItem(PANELS) ?? "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
})());

/** Sizes a panel, or gives it back its default with undefined. */
export function size(panel: keyof Panels, px: number | undefined) {
  const next = { ...panels.value };
  if (px === undefined) delete next[panel];
  else next[panel] = px;
  panels.value = next;
  try {
    localStorage.setItem(PANELS, JSON.stringify(next));
  } catch { /* no storage */ }
}

export type DockTab = "workspace" | "stage" | "ask" | "protect" | "lookup" | "make";
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

/** Runs code in the workspace: the transcript shows it, and what it did. */
export function act(code: string, label?: string, agent?: string) {
  return world.run(code, label, "act", agent);
}

/** Undoes or redoes the last act, as a new change. */
export function undo(redo = false) {
  return redo ? world.redo() : world.undo();
}
