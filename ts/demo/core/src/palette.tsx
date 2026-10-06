/// <reference lib="dom" />
// The palette: ⌘K, or the + on a row. Making things where you are, editing,
// going, and projects. Everything it does to the graph is a line of code in
// the workspace, so it has a site, shows in the transcript, and can be undone.

import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Id, Step } from "../../../src/mod.ts";
import { examples, rulesFor } from "./examples.ts";
import {
  current,
  exportFile,
  fresh,
  importFile,
  open,
  projects,
  remove,
  rename,
  save,
} from "./projects.ts";
import {
  act,
  dock,
  draft,
  explode,
  select,
  selected,
  type Selection,
  tall,
  theme,
  undo,
  world,
} from "./state.ts";
import { J, ROOT } from "./world.ts";

export const palette = signal<{ context?: Selection; only?: string } | undefined>(undefined);

type Command = {
  group: string;
  title: string;
  hint?: string;
  /** asks for a word first, with this prompt */
  ask?: { prompt: string; initial?: string };
  run: (answer?: string) => void;
};

/** An id not yet taken, from a name. */
export function freshId(base: string): Id {
  const b = base.trim().replace(/\s+/g, "-") || "node";
  if (!world.made.has(b)) return b;
  let i = 2;
  while (world.made.has(`${b}-${i}`)) i++;
  return `${b}-${i}`;
}

function made(where: Selection, name: string, id: Id) {
  select(id, [...where.route, world.step(where.id, name, id)]);
}

/** Makes a node in the context, by placing it, and selects it. */
function makeHere(where: Selection, name: string, value: string, label: string) {
  const id = freshId(name);
  const s = act(`make(${J(where.id)}, ${J(name)}, ${J(id)}, ${value})`, label);
  if (s.ok) made(where, name, id);
}

const VIEW_COMPUTE =
  `// a compute only reads: it gets { api, self, cwd, name, changes }, and returns
// the process's value. api.lookup({ name }) finds the nearest slot by that name,
// from here up; an item's from.path is the address it was found at, which
// api.read({ address }) reads. here, the directory it runs in, is the address []
export default function ({ api }) {
  return api.directory({ address: [] }).directory.map(([name]) => name)
}`;

const VIEW_EFFECT =
  `// an effect draws what the compute returned: it gets { api, lasting, self, cwd,
// name, value, previous, handler }, and may write through lasting later
import { h, screen } from "demo"
export default function ({ self, value }) {
  screen(self).replaceChildren(
    h("div", { class: "label" }, self),
    h("pre", {}, JSON.stringify(value, null, 1)),
  )
}`;

const DERIVED = `// a derived value: what this returns is the process's value
export default function ({ api }) {
  const [n] = api.lookup({ name: "n" })
  return (n ? api.read({ address: n.from.path })[0].value : 0) * 2
}`;

const RENDERER = `// a renderer: draws thing into el. h(tag, props, ...kids) makes elements;
// save(newThing) writes the thing back.
el.replaceChildren(h("pre", {}, JSON.stringify(thing, null, 1)))`;

/** A process that lives in the folder it works on: it runs there, and its lookups search there. */
function processHere(where: Selection, name: string, compute: string, effect?: string) {
  const id = freshId(name);
  const code = [
    `// it lives in ${where.id}, so it runs there, and its lookups search there first`,
    `process(${J(where.id)}, ${J(name)}, ${J(id)}, {`,
    `  compute: ${J(compute)},`,
    ...(effect ? [`  effect: ${J(effect)},`] : []),
    `})`,
  ];
  const s = act(code.join("\n"), "make: process");
  if (s.ok) {
    const path: Step[] = [...where.route, world.step(where.id, name, id)];
    select(`${id}.compute`, [...path, world.step(id, "compute", `${id}.compute`)]);
    dock.value = "stage";
  }
}

const FOLDER_VIEW = `// what this folder holds, and a child process for each thing in it.
// it runs in the folder: [] is the folder, and [name] this process's own node.
// a directory item carries the change that last set its slot, so a thing
// dragged away and back is a new placement, and gets a new card
export default function ({ api, self, cwd, name }) {
  const here = cwd[cwd.length - 1] ?? "root"
  const items = api.directory({ address: [] }).directory
    .filter(([slot]) => !slot.startsWith("render-") && !slot.startsWith("view") && slot !== name)
    .filter(([slot]) => api.directory({ address: [slot], name: "compute" }).items.length === 0)
    .flatMap(([slot, found]) => found.filter((item) => item.id !== self)
      .map((item) => ({ name: slot, id: item.id, since: item.change.time })))
  const kids = Object.fromEntries(
    api.directory({ address: [name] }).directory.map(([slot, found]) => [slot, found.map((item) => item.id)]))
  return { here, items, kids }
}`;

const CARD_COMPUTE =
  `// it runs in the folder's view, so its thing is in the folder, by its own name
export default function ({ api, name }) {
  const at = ["..", name]
  const thing = api.read({ address: at })[0]?.value
  const type = (thing && typeof thing === "object" && thing["@type"]) || typeof thing
  const by = api.lookup({ name: "render-" + type })[0]
  return { name, at, thing: thing ?? null, renderer: by?.id ?? null, code: by ? api.read({ address: by.from.path })[0].value : null }
}`;

const CARD_EFFECT = `import { h, screen } from "demo"
export default function ({ self, value, lasting }) {
  const el = screen(self)
  const body = h("div", { class: "thing-body" })
  el.replaceChildren(h("div", { class: "thing-head" }, h("span", { class: "thing-name" }, value.name),
    h("span", { class: "thing-by" }, value.renderer ? "drawn by " + value.renderer : "no render-" + (typeof value.thing))), body)
  const save = (v) => lasting.write({ address: value.at, patches: [{ type: "snapshot", value: v }] })
  try {
    new Function("thing", "el", "h", "save", value.code ?? "el.textContent = JSON.stringify(thing)")(value.thing, body, h, save)
  } catch (e) { body.replaceChildren(h("div", { class: "oops" }, e.message)) }
}`;

const FOLDER_KIDS = `// a card for each thing: a process placed under this one, by the thing's
// name, so it runs here, with its programs in its own slots. cards of things
// that left are unplaced
import { h, screen } from "demo"
export default function ({ api, self, name, value }) {
  screen(self).replaceChildren(h("div", { class: "folder-title" }, "▤ " + value.here))
  const want = new Set()
  for (const t of value.items) {
    const pid = self + ":" + t.id + "@" + t.since
    want.add(pid)
    if ((value.kids[t.name] ?? []).includes(pid)) continue
    api.place({ address: [name], name: t.name, id: pid, value: null })
    api.place({ address: [name, t.name], name: "compute", id: pid + ".compute", value: ${
  J(CARD_COMPUTE)
} })
    api.place({ address: [name, t.name], name: "effect", id: pid + ".effect", value: ${
  J(CARD_EFFECT)
} })
  }
  for (const [slot, ids] of Object.entries(value.kids))
    for (const pid of ids) if (pid.startsWith(self + ":") && !want.has(pid)) api.unplace({ address: [name], name: slot, id: pid })
}`;

function commands(where: Selection): Command[] {
  const at = where.id;
  const step = where.route[where.route.length - 1];
  const cmds: Command[] = [];
  const mk = (title: string, hint: string, value: string, name: string) =>
    cmds.push({
      group: `make in ${at}`,
      title,
      hint,
      ask: { prompt: `a name for the new ${title}, in ${at}`, initial: name },
      run: (n) => n && makeHere(where, n, value, `make: ${title}`),
    });
  mk("folder", "a node to put things in", "{}", "folder");
  mk("text", "a string", J(""), "note");
  mk("number", "a number", "0", "n");
  mk("list", "a list", "[]", "list");
  mk("object", "an object", "{}", "thing");
  mk(
    "checklist",
    "a thing a renderer can draw",
    J({ "@type": "list", title: "todo", items: [] }),
    "todo",
  );
  mk("program", "code: a compute or an effect", J("return null"), "program");
  cmds.push({
    group: `make in ${at}`,
    title: "renderer",
    hint: "draws things of a type, for everything here and below",
    ask: { prompt: "the type it draws (things say it in @type)", initial: "list" },
    run: (type) => type && makeHere(where, `render-${type}`, J(RENDERER), "make: renderer"),
  });
  cmds.push({
    group: `make in ${at}`,
    title: "process: a view",
    hint: "a compute that reads from here, an effect that draws",
    ask: { prompt: "a name for the process", initial: "view" },
    run: (n) => n && processHere(where, n, VIEW_COMPUTE, VIEW_EFFECT),
  });
  cmds.push({
    group: `make in ${at}`,
    title: "process: a derived value",
    hint: "a compute only: its value is what it returns",
    ask: { prompt: "a name for the process", initial: "derived" },
    run: (n) => n && processHere(where, n, DERIVED),
  });
  cmds.push({
    group: `make in ${at}`,
    title: "process: show this folder",
    hint: "a card for each thing here, each drawn by the renderer it finds",
    ask: { prompt: "a name for the process", initial: "view" },
    run: (n) => n && processHere(where, n, FOLDER_VIEW, FOLDER_KIDS),
  });

  if (step) {
    cmds.push({
      group: `edit ${at}`,
      title: "rename",
      hint: `its name in ${step.parent}; the id stays`,
      ask: { prompt: `a new name for ${at} in ${step.parent}`, initial: step.name },
      run: (n) => {
        if (!n || n === step.name) return;
        const s = act(
          `batch(() => {\n  place(${J(step.parent)}, ${J(n)}, ${J(at)})\n  unplace(${
            J(step.parent)
          }, ${J(step.name)}, ${J(at)})\n})`,
          "edit: rename",
        );
        if (s.ok) select(at, [...where.route.slice(0, -1), world.step(step.parent, n, at)]);
      },
    });
    cmds.push({
      group: `edit ${at}`,
      title: "duplicate",
      hint: "a new node with its value; what it holds is placed in the copy too",
      run: () => {
        const id = freshId(`${at}-copy`);
        // its value and slots, from the host's copy, beneath protect
        const lines = [
          `make(${J(step.parent)}, ${J(`${step.name} copy`)}, ${J(id)}, ${
            J(world.valueOf(at) ?? null)
          })`,
        ];
        for (const [name, ids] of world.slotsOf(at)) {
          for (const x of ids) lines.push(`place(${J(id)}, ${J(name)}, ${J(x)})`);
        }
        const s = act(
          `batch(() => {\n${lines.map((l) => "  " + l).join("\n")}\n})`,
          "edit: duplicate",
        );
        if (s.ok) {
          select(id, [
            ...where.route.slice(0, -1),
            world.step(step.parent, `${step.name} copy`, id),
          ]);
        }
      },
    });
    cmds.push({
      group: `edit ${at}`,
      title: "remove from here",
      hint: `unplace it from ${step.parent}; gone if nothing else reaches it`,
      run: () => {
        const s = act(`unplace(${J(step.parent)}, ${J(step.name)}, ${J(at)})`, "edit: remove");
        if (s.ok) select(step.parent, where.route.slice(0, -1));
      },
    });
  }
  const places = world.placements().get(at) ?? [];
  if (places.length > 1) {
    cmds.push({
      group: `edit ${at}`,
      title: "remove everywhere",
      hint: `unplace it from all ${places.length} places`,
      run: () => {
        act(
          `batch(() => {\n${
            places.map((p) => `  unplace(${J(p.parent)}, ${J(p.name)}, ${J(at)})`).join("\n")
          }\n})`,
          "edit: remove everywhere",
        );
        select(ROOT, []);
      },
    });
  }
  cmds.push(
    {
      group: "edit",
      title: "undo",
      hint: "⌘Z — a new change that reverses the last",
      run: () => undo(),
    },
    {
      group: "edit",
      title: "redo",
      hint: "⇧⌘Z",
      run: () => undo(true),
    },
  );

  for (const id of world.made.keys()) {
    cmds.push({
      group: "go to",
      title: id,
      hint: (world.placements().get(id) ?? []).map((p) => `${p.parent}.${p.name}`).join(", ") ||
        (id === ROOT ? "the root" : "placed nowhere"),
      run: () => select(id, routeOf(id)),
    });
  }

  cmds.push(
    {
      group: "project",
      title: "new project",
      hint: "a fresh graph with just the root",
      ask: { prompt: "a name for the project", initial: fresh("untitled") },
      run: (n) => n && open({ name: fresh(n), image: "" }, "new"),
    },
    {
      group: "project",
      title: "save as",
      hint: `${current.value} saves itself; this keeps a copy under another name`,
      ask: { prompt: "save as", initial: fresh(current.value) },
      run: (n) => n && save(n),
    },
    {
      group: "project",
      title: "rename project",
      ask: { prompt: "a new name for this project", initial: current.value },
      run: (n) => n && n !== current.value && rename(n),
    },
    {
      group: "project",
      title: "export",
      hint: "a .ermine.js file: the boot image",
      run: () => exportFile(),
    },
    {
      group: "project",
      title: "import",
      hint: "open a .ermine.js file",
      run: () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".js,.ermine.js,text/javascript";
        input.onchange = () => input.files?.[0] && importFile(input.files[0]);
        input.click();
      },
    },
    {
      group: "project",
      title: "show the boot image",
      hint: "the code that rebuilds this graph, in the workspace",
      run: () => {
        draft.value = world.image();
        dock.value = "workspace";
      },
    },
  );
  for (const p of projects()) {
    if (p.name === current.value) continue;
    cmds.push({
      group: "project",
      title: `open ${p.name}`,
      hint: `saved ${new Date(p.saved).toLocaleString()}`,
      run: () => open(p),
    });
  }
  for (const p of projects()) {
    if (p.name === current.value) continue;
    cmds.push({
      group: "project",
      title: `delete ${p.name}`,
      hint: "from this browser",
      run: () => remove(p.name),
    });
  }
  for (const e of examples) {
    cmds.push({
      group: "examples",
      title: e.title,
      hint: e.blurb,
      run: () =>
        open({ name: fresh(e.title), image: e.code, rules: rulesFor[e.id] ?? [] }, "example"),
    });
  }
  cmds.push(
    {
      group: "view",
      title: explode.value ? "gather" : "explode",
      hint: "the graph on a canvas",
      run: () => (explode.value = !explode.value),
    },
    {
      group: "view",
      title: tall.value ? "short dock" : "tall dock",
      run: () => (tall.value = !tall.value),
    },
    {
      group: "view",
      title: theme.value === "dark" ? "light" : "dark",
      run: () => (theme.value = theme.value === "dark" ? "light" : "dark"),
    },
  );
  return cmds;
}

/** The route to a node by its first placements, from the root. */
export function routeOf(id: Id): Step[] {
  const where = world.placements();
  const route: Step[] = [];
  let at = id;
  const seen = new Set<Id>();
  while (at !== ROOT && !seen.has(at)) {
    seen.add(at);
    const p = (where.get(at) ?? []).find((x) => x.name !== "compute" && x.name !== "effect") ??
      where.get(at)?.[0];
    if (!p) return [];
    route.unshift({ parent: p.parent, name: p.name, node: at, position: p.index });
    at = p.parent;
  }
  return at === ROOT ? route : [];
}

export function Palette() {
  world.version.value;
  const p = palette.value;
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const [asking, setAsking] = useState<Command>();
  const [answer, setAnswer] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setQ(p?.only ?? "");
    setI(0);
    setAsking(undefined);
    setTimeout(() => input.current?.focus(), 0);
  }, [p]);
  useEffect(() => {
    setTimeout(() => {
      input.current?.focus();
      if (asking) input.current?.select();
    }, 0);
  }, [asking]);
  if (!p) return null;
  const where: Selection = p.context ?? selected.value ?? { id: ROOT, route: [] };
  const all = commands(where);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((c) => {
    const text = `${c.group} ${c.title} ${c.hint ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }).filter((c) => q || c.group !== "go to").slice(0, 60);
  const close = () => (palette.value = undefined);
  const run = (c: Command) => {
    if (c.ask && !asking) {
      setAsking(c);
      setAnswer(c.ask.initial ?? "");
      return;
    }
    close();
    c.run(asking ? answer.trim() : undefined);
  };
  let group = "";
  return (
    <div class="palette-scrim" onPointerDown={close}>
      <div class="palette" onPointerDown={(e) => e.stopPropagation()}>
        {asking
          ? (
            <>
              <div class="palette-asking">
                <span class="muted">{asking.group} ›</span> <b>{asking.title}</b>
              </div>
              <input
                ref={input}
                class="palette-input"
                value={answer}
                placeholder={asking.ask!.prompt}
                onInput={(e) => setAnswer((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim()) run(asking);
                  if (e.key === "Escape") setAsking(undefined);
                }}
              />
              <div class="palette-hint">
                {asking.ask!.prompt} — enter to make it, esc to go back
              </div>
            </>
          )
          : (
            <>
              {p.only === "examples" && world.made.size <= 1
                ? (
                  <div class="palette-welcome">
                    <b>a new graph, with just its root.</b>{" "}
                    open an example to play, or press esc and make your own: ⌘K anywhere, or the +
                    on a row, makes things where you are. it saves itself.
                  </div>
                )
                : null}
              <input
                ref={input}
                class="palette-input"
                value={q}
                placeholder={`make something in ${where.id}, go to a node, open a project…`}
                onInput={(e) => {
                  setQ((e.target as HTMLInputElement).value);
                  setI(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {(e.preventDefault(),
                      setI(Math.min(shown.length - 1, i + 1)));}
                  if (e.key === "ArrowUp") (e.preventDefault(), setI(Math.max(0, i - 1)));
                  if (e.key === "Enter" && shown[i]) run(shown[i]);
                  if (e.key === "Escape") close();
                }}
              />
              <div class="palette-list">
                {shown.map((c, j) => {
                  const head = c.group !== group ? (group = c.group) : undefined;
                  return (
                    <>
                      {head ? <div class="palette-group" key={`g${j}`}>{head}</div> : null}
                      <button
                        type="button"
                        key={`${c.group}/${c.title}`}
                        class={`palette-item${i === j ? " on" : ""}`}
                        onPointerEnter={() => setI(j)}
                        onClick={() => run(c)}
                      >
                        <span class="palette-title">{c.title}</span>
                        {c.hint ? <span class="palette-hint-inline">{c.hint}</span> : null}
                        {c.ask ? <span class="palette-more">…</span> : null}
                      </button>
                    </>
                  );
                })}
                {shown.length === 0 ? <div class="empty">nothing matches.</div> : null}
              </div>
            </>
          )}
      </div>
    </div>
  );
}
