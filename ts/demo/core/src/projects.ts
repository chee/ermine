/// <reference lib="dom" />
// Projects: a graph kept as a boot image, with its rules and agents, in this
// browser's storage. A boot image rebuilds the state, not the history: opening
// a project starts a new history from it. Saving is automatic.
//
// The graph itself is kept too, by the keeper, in IndexedDB: one graph, the
// project's last open. A page that finds the current project's graph kept
// loads it, takes out the process nodes it kept, which nothing runs any more,
// and runs the boot image only for its starts (World.reopen).

import type { Kept } from "../../../src/mod.ts";
import { dock, draft, focus, lit, pointAt, select, world } from "./state.ts";
import { ROOT, type Rule } from "./world.ts";
import { signal } from "@preact/signals";

export type Project = {
  name: string;
  image: string;
  rules: Rule[];
  agents: string[];
  saved: string;
};

const KEY = "ermine-projects";
const CURRENT = "ermine-current";
/** which project the kept graph is */
const KEPT = "ermine-kept";

export const current = signal<string>("untitled");
export const savedAt = signal<string | undefined>(undefined);

function all(): Record<string, Project> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

function store(projects: Record<string, Project>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(projects));
  } catch { /* storage is full or blocked; the project lives on in the page */ }
}

/** The project whose graph is kept, if one is. */
export function keptFor(): string | undefined {
  try {
    return localStorage.getItem(KEPT) ?? undefined;
  } catch {
    return undefined;
  }
}

function markKept(name: string | undefined) {
  try {
    name === undefined ? localStorage.removeItem(KEPT) : localStorage.setItem(KEPT, name);
  } catch { /* fine */ }
}

export function projects(): Project[] {
  return Object.values(all()).sort((a, b) => b.saved.localeCompare(a.saved));
}

/** The current graph as a project. */
export function snapshot(name = current.value): Project {
  return {
    name,
    image: world.image(),
    rules: world.rules.map((r) => ({ ...r })),
    agents: [...world.agents],
    saved: new Date().toISOString(),
  };
}

export function save(name = current.value) {
  const p = snapshot(name);
  const ps = all();
  ps[name] = p;
  store(ps);
  current.value = name;
  savedAt.value = p.saved;
  // the graph kept is this one's, whatever it is called now
  if (world.keeper) markKept(name);
  try {
    localStorage.setItem(CURRENT, name);
  } catch { /* fine */ }
}

/**
 * Starts a graph from a boot image, as a project of that name. With kept, the
 * graph is the one kept, and the image is run only for its starts.
 */
export function open(
  p: Pick<Project, "name" | "image"> & Partial<Project>,
  label = "open",
  kept?: Kept,
) {
  world.rules = (p.rules ?? []).map((r) => ({ ...r }));
  if (p.agents?.length) world.agents = [...p.agents];
  world.agent = world.agents[0] ?? "chee";
  world.reset({ keep: true, ...(kept ? { kept } : {}) });
  markKept(p.name);
  focus.value = undefined;
  lit.value = undefined;
  pointAt.value = undefined;
  if (kept) world.reopen(p.image, `reopen: ${p.name}`);
  else if (p.image.trim()) world.run(p.image, `${label}: ${p.name}`, "boot");
  current.value = p.name;
  draft.value = "";
  select(ROOT, []);
  dock.value = world.running().size ? "stage" : "workspace";
  save(p.name);
}

/**
 * The project last open here, from what this browser kept of its graph if it
 * kept the graph, or else from its boot image.
 */
export async function reopen(p: Project | undefined) {
  const name = p?.name ?? "untitled";
  const kept = p && keptFor() === name ? await world.loadKept() : undefined;
  open(p ?? { name, image: "" }, "open", kept);
}

/**
 * Forgets the graph this browser kept, and opens the project again from its
 * boot image: a fresh graph, kept from then on.
 */
export async function forget() {
  const p = all()[current.value] ?? snapshot();
  await world.forgetKept();
  markKept(undefined);
  open(p, "start over");
}

export function remove(name: string) {
  const ps = all();
  delete ps[name];
  store(ps);
}

export function rename(to: string) {
  const ps = all();
  delete ps[current.value];
  store(ps);
  save(to);
}

/** A name not yet taken. */
export function fresh(base: string): string {
  const ps = all();
  if (!ps[base]) return base;
  let i = 2;
  while (ps[`${base} ${i}`]) i++;
  return `${base} ${i}`;
}

/** The project last open, if there is one. */
export function last(): Project | undefined {
  try {
    const name = localStorage.getItem(CURRENT);
    return name ? all()[name] : undefined;
  } catch {
    return;
  }
}

/** A file of the boot image, to keep or give to someone. */
export function exportFile() {
  const p = snapshot();
  const text = [
    `// ermine project: ${p.name}`,
    `// rules: ${JSON.stringify(p.rules)}`,
    `// agents: ${JSON.stringify(p.agents)}`,
    p.image,
    "",
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  a.download = `${p.name.replace(/[^\w -]+/g, "").trim() || "ermine"}.ermine.js`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Opens a project file, as exportFile writes them, or any snippet. */
export async function importFile(file: File) {
  const text = await file.text();
  const name = text.match(/^\/\/ ermine project: (.*)$/m)?.[1] ??
    file.name.replace(/\.ermine\.js$|\.js$/, "");
  const parse = <T>(re: RegExp, or: T): T => {
    try {
      const m = text.match(re);
      return m ? JSON.parse(m[1]) : or;
    } catch {
      return or;
    }
  };
  open({
    name: fresh(name),
    image: text,
    rules: parse(/^\/\/ rules: (.*)$/m, []),
    agents: parse(/^\/\/ agents: (.*)$/m, []),
  }, "import");
}

// keep the current project saved, a moment after anything happens, and as the
// page goes, so the boot image a reload reopens with has every start the kept graph has
addEventListener("pagehide", () => save());
let timer: ReturnType<typeof setTimeout> | undefined;
let seen = -1;
world.version.subscribe((v) => {
  if (v === seen) return;
  seen = v;
  clearTimeout(timer);
  timer = setTimeout(() => save(), 700);
});
