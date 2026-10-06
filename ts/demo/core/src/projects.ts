/// <reference lib="dom" />
// Projects: a graph kept as a boot image, with its rules and agents, in this
// browser's storage. A boot image rebuilds the state, not the history: opening
// a project starts a new history from it. Saving is automatic.

import { signal } from "@preact/signals";
import { dock, draft, focus, lit, pointAt, select, world } from "./state.ts";
import { ROOT, type Rule } from "./world.ts";

export type Project = {
  name: string;
  image: string;
  rules: Rule[];
  agents: string[];
  saved: string;
};

const KEY = "ermine-projects";
const CURRENT = "ermine-current";

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
  try {
    localStorage.setItem(CURRENT, name);
  } catch { /* fine */ }
}

/** Starts a fresh graph from a boot image, as a project of that name. */
export function open(p: Pick<Project, "name" | "image"> & Partial<Project>, label = "open") {
  world.rules = (p.rules ?? []).map((r) => ({ ...r }));
  if (p.agents?.length) world.agents = [...p.agents];
  world.agent = world.agents[0] ?? "chee";
  world.reset();
  focus.value = undefined;
  lit.value = undefined;
  pointAt.value = undefined;
  if (p.image.trim()) world.run(p.image, `${label}: ${p.name}`, "boot");
  current.value = p.name;
  draft.value = "";
  select(ROOT, []);
  dock.value = world.screens.size ? "stage" : "workspace";
  save(p.name);
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

// keep the current project saved, a moment after anything happens
let timer: ReturnType<typeof setTimeout> | undefined;
let seen = -1;
world.version.subscribe((v) => {
  if (v === seen) return;
  seen = v;
  clearTimeout(timer);
  timer = setTimeout(() => save(), 700);
});
