/// <reference lib="dom" />
// Ask: an LLM that builds in the graph, and is itself in the graph. It is a
// node, {"@type": "llm"}, in some node's slot "llm", the root's at first; its
// model, its system prompt and its talk are its children. Where it sits is
// what it sees, from there down, and where it builds; move the node and it
// moves. It asks around itself for what it needs, by lookup from its own
// node up, as a process would: "model", its name at OpenRouter; "prompt"; and
// "api", a program it calls with the key it finds by looking up "key" around
// the api. The key's node nobody
// may read, by protect, and only chee may write; the host reads it beneath
// protect to hand it on, and never shows it.
//
// The LLM's tools run snippets like any other, undone with ⌘Z, as an agent of
// its own named for its model, "computer/claude-opus-5.5". It checks its work
// after it changes the graph, and goes on until it is right. A small model
// gets a smaller prompt, built around ui(), which makes a UI that is reactive
// by construction.

import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Id, Step } from "../../../src/mod.ts";
import { Agent, Empty, NodeLink } from "./bits.tsx";
import { act, dock, draft, select, selected, undo, world } from "./state.ts";
import { J, ROOT, World } from "./world.ts";

const MODELS = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-haiku-4.5",
];

/** This browser's copy of the key, for when the graph's says only that it is hidden. */
const KEY = "ermine-openrouter-key";

function stored(k: string, fallback = ""): string {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(k: string, v: string) {
  try {
    v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
  } catch { /* no storage: it lasts the page */ }
}

/** A node to make a renderer for, and where the right click was. */
export const askAt = signal<{ id: Id; route: Step[]; x: number; y: number } | undefined>();

/** The LLM the pane talks to, when one was picked. */
const picked = signal<Id | undefined>(undefined);

export const busy = signal(false);
/** Why the last question could not be asked, if it could not. */
const trouble = signal<string | undefined>(undefined);
/** The model an LLM is placed with, when one is placed. */
const placing = signal(MODELS[0]);
/** What the LLM is saying, before it is said: it goes into the graph when the step ends. */
const live = signal<{ llm: Id; text: string } | undefined>(undefined);
let stop: AbortController | undefined;

// --- the LLM in the graph ---

/** model: only in graphs from before the model was a node of its own. */
type Llm = { "@type": "llm"; model?: string; tools?: string[] };

/** One thing said in a talk: a node in the LLM's slot "talk". */
type Said =
  | { role: "user"; text: string; by: string; about?: Id; context?: string; nudge?: true }
  | {
    role: "assistant";
    text: string;
    calls?: { id: string; name: string; arguments: string }[];
    error?: true;
  }
  | {
    role: "tool";
    call: string;
    name: string;
    args: { [k: string]: unknown };
    result: string;
    ok: boolean;
    snippet?: number;
    changed?: boolean;
  };

function llmOf(id: Id): Llm | undefined {
  const v = world.valueOf(id);
  return v && typeof v === "object" && !Array.isArray(v) && (v as Llm)["@type"] === "llm"
    ? v as Llm
    : undefined;
}

/** Every LLM node the root reaches. */
export function llms(): Id[] {
  return [...world.made.keys()].filter((id) => llmOf(id) && world.addressOf(id));
}

const short = (model: string) => model.split("/").pop() || model;
/** The agent an LLM acts as: the computer, named for its model. */
export const agentOf = (llm: Id) => "computer/" + short(modelOf(llm));

/**
 * The node an LLM's model is in: "model", looked up around it. The host looks
 * as the acting agent, since the LLM's own agent is named for what is found.
 */
function modelNode(llm: Id): Id | undefined {
  return around("model", llm, world.agent);
}

/** An LLM's model: its "model" node's value; in an older graph, its own field. */
function modelOf(llm: Id): string {
  const at = modelNode(llm);
  const v = at === undefined ? undefined : world.valueOf(at);
  if (typeof v === "string" && v) return v;
  return llmOf(llm)?.model || MODELS[0];
}
/** Every LLM's agent, for the protect tab. */
export const computers = () => [...new Set(llms().map(agentOf))];

/** Whether a model is small enough for the small prompt. */
const small = (model: string) => /haiku|mini|nano|tiny|small|flash-lite|8b|7b|3b/i.test(model);

/** The route from the root to a node, by first placements, as the canvas finds one. */
function routeOf(id: Id): Step[] | undefined {
  const where = world.placements();
  const route: Step[] = [];
  let at = id;
  const seen = new Set<Id>();
  while (at !== ROOT) {
    if (seen.has(at)) return undefined;
    seen.add(at);
    const p = (where.get(at) ?? []).find((x) => x.name !== "compute" && x.name !== "effect") ??
      where.get(at)?.[0];
    if (!p) return undefined;
    route.unshift({ parent: p.parent, name: p.name, node: at, position: p.index });
    at = p.parent;
  }
  return route;
}

/**
 * What a lookup of name finds around a node: in its own slots first, then up
 * the way it was reached, nearest first, as a process placed in it would.
 */
function around(name: string, node: Id, agent: string): Id | undefined {
  const route = routeOf(node);
  if (!route) return undefined;
  // a lookup searches from the directory its route's last step is in: one step into node
  const into: Step = { parent: node, name, node, position: 0 };
  try {
    return world.lookup(name, [...route, into], agent).found[0];
  } catch {
    return undefined;
  }
}

/** The node an LLM sits in: its first slot named "llm", or its first slot. */
function seat(llm: Id): Id | undefined {
  const ps = world.placements().get(llm) ?? [];
  return (ps.find((p) => p.name === "llm") ?? ps[0])?.parent;
}

/** The LLM nearest a node: in its slot "llm", or up from it. */
function nearest(route: Step[] | undefined): Id | undefined {
  const node = route?.at(-1)?.node ?? ROOT;
  const found = around("llm", node, world.agent);
  return found && llmOf(found) ? found : undefined;
}

/** The LLM the pane talks to: the one picked, or the one nearest the selection, or any. */
export function current(): Id | undefined {
  const p = picked.value;
  if (p && llmOf(p) && world.addressOf(p)) return p;
  return nearest(selected.value?.route) ?? llms()[0];
}

function free(stem: string): Id {
  if (!world.made.has(stem)) return stem;
  for (let i = 2;; i++) if (!world.made.has(`${stem}-${i}`)) return `${stem}-${i}`;
}

/**
 * Places an LLM in a node, as the acting agent: the node, its model, its
 * prompt, and, if no "api" is found from there, the OpenRouter api in the root.
 */
export function placeLlm(parent: Id = ROOT, model = MODELS[0]): Id | undefined {
  const id = free(model.includes("claude") ? "claude" : "llm");
  const tiny = small(model);
  const value: Llm = tiny ? { "@type": "llm", tools: SMALL_TOOLS } : { "@type": "llm" };
  const needsApi = !around("api", parent, world.agent);
  const s = world.run(
    [
      "batch(() => {",
      `  make(${J(parent)}, "llm", ${J(id)}, ${J(value)})`,
      `  make(${J(id)}, "model", ${J(id + ".model")}, ${J(model)})`,
      `  make(${J(id)}, "prompt", ${J(id + ".prompt")}, prompt)`,
      ...(needsApi ? [`  make("root", "api", ${J(free("openrouter"))}, api)`] : []),
      "})",
    ].join("\n"),
    `ask: an LLM in ${parent}`,
    "act",
    undefined,
    { prompt: tiny ? SMALL : SYSTEM, api: OPENROUTER },
  );
  if (!s.ok) return undefined;
  picked.value = id;
  // the key this browser kept is placed with it, so it is not typed again
  const api = around("api", id, world.agent);
  if (api && !around("key", api, world.agent) && stored(KEY)) keepKey(id, stored(KEY));
  return id;
}

/** Moves an LLM into a node's slot "llm", as the acting agent. */
export function moveLlm(llm: Id, to: Id) {
  const from = seat(llm);
  if (from === to) return;
  act(
    from === undefined
      ? `place(${J(to)}, "llm", ${J(llm)})`
      : `batch(() => {\n  place(${J(to)}, "llm", ${J(llm)})\n  unplace(${J(from)}, "llm", ${
        J(llm)
      })\n})`,
    `ask: move ${llm}`,
  );
}

/** The talk, in order. */
export function talkOf(llm: Id): { id: Id; said: Said }[] {
  return world.slotOf(llm, "talk").flatMap((id) => {
    const v = world.valueOf(id);
    return v && typeof v === "object" ? [{ id, said: v as unknown as Said }] : [];
  });
}

/** Adds to the talk, as whoever said it. A conversation is not undone with ⌘Z. */
function say(llm: Id, said: Said, agent: string) {
  const n = world.slotOf(llm, "talk").length + 1;
  const id = free(`${llm}.${n}`);
  return world.run(
    `make(${J(llm)}, "talk", ${J(id)}, said)`,
    `ask: ${said.role}`,
    "talk",
    agent,
    { said: JSON.parse(JSON.stringify(said)) },
  );
}

/** A new talk: what was said is taken out of the slot, and stays in the history. */
function forget(llm: Id) {
  const ids = world.slotOf(llm, "talk");
  if (!ids.length) return;
  world.run(
    `batch(() => {\n${ids.map((id) => `  unplace(${J(llm)}, "talk", ${J(id)})`).join("\n")}\n})`,
    "ask: a new talk",
    "talk",
  );
}

/** The key an api finds around itself, revealed by the host, or this browser's copy. */
function keyFor(api: Id, agent: string): string | undefined {
  const node = around("key", api, agent);
  if (!node) return undefined;
  const v = world.revealed(node);
  if (typeof v === "string" && v && v !== World.HIDDEN) return v;
  return stored(KEY) || undefined;
}

/**
 * Keeps the key in a node beside the api, in the slot "key" of the node the
 * api sits in, so any api below finds it, and a nearer key shadows it. It is
 * made the first time with the rules that nobody may read it and only chee may
 * write it. The key is a word of the snippet, not its code, so no history shows it.
 */
export function keepKey(llm: Id, key: string): string | undefined {
  const api = around("api", llm, agentOf(llm));
  if (!api) return `${llm} finds no "api" around it`;
  let node = around("key", api, agentOf(llm));
  if (!node) {
    node = free("openrouter-key");
    world.rules = [
      { agent: "chee", op: "write", node, allow: true, on: true },
      { node, allow: false, on: true },
      ...world.rules,
    ];
    const beside = (world.placements().get(api) ?? [])[0]?.parent ?? ROOT;
    const made = world.run(
      `make(${J(beside)}, "key", ${J(node)}, "")`,
      "ask: a node for the key",
      "talk",
    );
    if (!made.ok) return made.error?.why;
  }
  const s = world.run(`write(${J(node)}, key)`, "ask: the key", "talk", undefined, { key });
  if (!s.ok) return s.error?.why;
  store(KEY, key);
}

// --- what the LLM is told ---

const SYSTEM = String.raw`You build things in ermine, a graph of values that says why, by writing
snippets for its demo's workspace. A snippet is JavaScript run once, as the acting agent, with these
words in scope (a word names a node by its id, or by an address: a list of names from the root):

make(parent, name, id, value)   make a node by placing it in parent's slot name; an id the graph has, and the root reaches, is only placed; one nothing reaches is gone: take a new id
write(id, value)                replace a node's value
set(id, path, key, value?)      set a key of the object at path in a node's value; no value deletes it
splice(id, path, from, to, v?)  splice the list at path
place(parent, name, id, pos?)   place an existing node in another slot too (a node may be in many)
unplace(parent, name, id)       take it out of that slot
read(id) · dir(id, name?) · lookup(name, place?)
program(parent, id, code)       a program node, made in parent's slot named id
process(parent, name, id, { compute, effect?, value? })
                                a process: placed in parent's slot name, it runs there. compute and effect
                                are program source, or the id of a program node to share
batch(fn)                       several changes as one, so nothing runs until they are all there
ui(parent, name, { state, watch?, draw })
                                an app on the stage that is reactive by construction: see below

The graph: every node has a JSON value and a directory of named slots, each an ordered list of ids.
The root is "root". Anything the root does not reach cannot be addressed.

A process runs where it sits: placed in node X, the address [] is X, [name] is the process's own
node, [".."] is X's parent, ["a", "b"] is X's slot a, then that node's slot b. Its programs are
modules whose default export the driver calls with a context:

compute: export default function ({ api, self, cwd, name, changes }) { ... return value }
  It only reads, and returns the process's value (JSON), or PENDING (import { PENDING } from "ermine").
  api.read({ address })            → [{ value, from }], the first item the node the address reaches
  api.directory({ address })       → { directory: [[name, [{ id, change: { time } }, ...]], ...] }
  api.directory({ address, name }) → { items: [{ id, ... }] }
  api.lookup({ name })             → [{ id, from: { path } }]: the nearest slot by that name, searching
                                     from [] up; read it with api.read({ address: item.from.path })
  Every read marks the process: when what it read changes, it computes again, and its effect runs.
  Skip the slots named compute and effect, and the process's own slot (its name), when walking [].

effect: export default function ({ api, lasting, self, cwd, name, value, previous, handler }) { ... }
  It only writes. value is what compute returned. lasting works until the process stops, for code
  called later (clicks, timers): lasting.write({ address, patches: [{ type: "snapshot", value }] }),
  lasting.place({ address, name, id, value? }), lasting.unplace({ address, name, id }).
  Return a cleanup function if it set timers or listeners.
  What a person does on the screen (a click, typing, a drag) must go through a handler: register
  it with handler(name, fn), where fn writes through lasting, and call fire(self, name, input)
  from the DOM listener. Never call lasting from a DOM listener directly. A handler call acts as
  whoever fired it, so the change is credited to the person who clicked; lasting called any other
  way acts as you, the process's starter, which is right only for timers and other work of yours.
  From "demo", this host: import { h, screen, fire } from "demo"
    screen(self)                       the element this process draws on, in the stage
    h(tag, props, ...children)         builds an element; props.style may be an object; on* props are handlers
    fire(self, handlerName, input?)    runs a handler named with handler(name, fn), as the acting agent
  Draw with screen(self).replaceChildren(...). The stage has a light and a dark theme: colour with
  CSS variables, var(--ink) text, var(--ink-2) quieter, var(--panel) and var(--sunk) backgrounds,
  var(--line) borders, accents var(--rose) var(--lilac) var(--mint) var(--butter) var(--sky)
  var(--peach), each with a -soft tint; fonts var(--sans) var(--mono) var(--serif). Classes "big"
  and "label" exist.

For an interactive UI, prefer ui(): it writes the compute and the effect for you, so the UI
redraws whenever what it shows changes, whoever changed it, and every click is credited to whoever
clicked. state is { name: first value }: each is looked up from parent, and made beside the UI if
not found; watch names more to look up. draw is the source of a function, as a string,
({ h, state, set }) => element or [elements]; set(name, value) changes a value, and the UI redraws.
Give inputs a name attribute, so they keep focus across a redraw. The UI's draw is the node
"<its id>.draw": write it to change how the UI draws, and it redraws at once.

Write program source in String.raw template literals: String.raw${"`"}...${"`"}. Inside program source
never use backticks or "${"${"}": build strings with + instead.

Here is a whole snippet, for shape, as you would pass it to run:

${"```"}js
make("root", "clicks", "clicks", 0)
process("root", "counter", "counter", {
  compute: String.raw${"`"}
export default function ({ api }) {
  const [clicks] = api.lookup({ name: "clicks" })
  return { n: api.read({ address: clicks.from.path })[0].value, at: clicks.from.path }
}
${"`"},
  effect: String.raw${"`"}
import { h, screen, fire } from "demo"
export default function ({ self, value, lasting, handler }) {
  let n = value.n
  const big = h("div", { class: "big" }, n)
  handler("press", () => {
    lasting.write({ address: value.at, patches: [{ type: "snapshot", value: ++n }] })
    big.textContent = n
  })
  screen(self).replaceChildren(big, h("button", { onclick: () => fire(self, "press") }, "hop"))
}
${"`"},
})
${"```"}

You work with tools, and nothing you write in a message runs: to change the graph, call run with
a snippet. Then check your work before you say you are done: look at the stage to see what a
process drew, inspect the nodes and processes you made (their values, their last run, what threw),
fire a handler to try a click, and print an expression to read the graph. If anything is wrong or
looks poor, fix it and check again. A failed snippet may have made some of its nodes: inspect, and
change or unplace what is there rather than making it again. Choose ids the graph does not have yet,
unless you mean to place or change an existing node.
An effect runs when its process starts, and after that only when the compute's value changes: after
changing a running process's programs, restart it, by unplace(parent, name, id) and then
place(parent, name, id), as two statements, not in one batch.
When it works and looks right, end with one or two sentences saying what you made, and call no tool.`;

/** The tools a small model is given. */
const SMALL_TOOLS = ["run", "look", "inspect"];

/** The prompt for a small model: a few words, and ui(), which cannot be made unreactive. */
const SMALL = String.raw`You build small apps in ermine, a graph of values. To change the graph,
call the run tool with a snippet of JavaScript. These words are in scope in a snippet:

make(parent, name, id, value)   a node holding value, in parent's slot name
write(id, value)                change a node's value
read(id)                        a node's value
ui(parent, name, { state, draw })
                                an app on the stage, in parent's slot name. It returns its id.

ui() is how you make anything people see or click. state is the values the app keeps, as
{ name: first value }; each is made beside the app unless one by that name is found. draw is the
source of a function, given as a string:

  ({ h, state, set }) => an element, or a list of elements

  h(tag, props, ...children)   makes an element: h("button", { onclick: () => set("n", state.n + 1) }, "+")
  state.name                   a value, as it is now
  set(name, value)             changes a value. The app draws again by itself, for everyone.

The app draws again whenever any of its state changes, whoever changed it. Never keep state in
variables, and never change it except with set. Give each input a name attribute, so it keeps
focus when the app draws again. For text, read the input in a form's onsubmit, not on each key.
Colour with CSS variables: var(--ink), var(--ink-2), var(--panel), var(--sunk), var(--line),
var(--rose), var(--mint), var(--sky). Never put backticks or "${"${"}" inside draw.

Here is a whole snippet, a todo list:

ui("root", "todos", {
  state: { todos: [] },
  draw: String.raw${"`"}({ h, state, set }) => {
  const text = h("input", { name: "new", placeholder: "a new todo" })
  const add = (e) => {
    e.preventDefault()
    if (text.value) set("todos", [...state.todos, { text: text.value, done: false }])
  }
  const flip = (i) => set("todos", state.todos.map((t, j) => j === i ? { ...t, done: !t.done } : t))
  return h("div", {},
    h("form", { onsubmit: add }, text, h("button", {}, "add")),
    ...state.todos.map((t, i) => h("label", { style: { display: "block" } },
      h("input", { type: "checkbox", checked: t.done, onchange: () => flip(i) }),
      " " + t.text)))
}${"`"},
})

After each run, call look to see what the stage shows, and inspect the app's id to see if it threw.
If something is wrong, fix it: write(id + ".draw", newSource) changes how an app draws, and it
draws again at once. When it works, say what you made in one sentence, and call no tool.`;

/**
 * The api the root has at first: a program the host calls with the key, the
 * model, the messages and the tools. It asks OpenRouter, streaming, telling
 * onText each piece of words, and gives back the words and the tool calls.
 * Place another "api" nearer an LLM to change how it talks.
 */
const OPENROUTER = `// an api for an LLM node, found by looking up "api" from it. The host calls it
// with the key it finds by looking up "key" from here, which nobody can read
export default async function ({ key, model, messages, tools, signal, onText }) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { authorization: "Bearer " + key, "content-type": "application/json", "x-title": "ermine" },
    body: JSON.stringify({ model, messages, tools, stream: true }),
  })
  if (!r.ok || !r.body) {
    const body = await r.text()
    let why = body
    try { why = JSON.parse(body).error?.message ?? body } catch { /* not json */ }
    throw new Error("openrouter said " + r.status + ": " + why)
  }
  // server-sent events: lines of "data: {json}", ending "data: [DONE]"; a tool call comes in pieces
  const calls = []
  let text = "", buf = ""
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    const lines = buf.split("\\n")
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const ev = JSON.parse(line.slice(6))
      if (ev.error) throw new Error(ev.error.message ?? JSON.stringify(ev.error))
      const d = ev.choices?.[0]?.delta ?? {}
      if (d.content) (text += d.content, onText(d.content))
      for (const c of d.tool_calls ?? []) {
        const at = calls[c.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } }
        if (c.id) at.id = c.id
        if (c.function?.name) at.function.name += c.function.name
        if (c.function?.arguments) at.function.arguments += c.function.arguments
      }
    }
  }
  return { text, calls: calls.filter(Boolean) }
}`;

/** What an LLM sees as it is asked: where it sits, and the graph from there down. */
function context(llm: Id, about?: Id, route?: readonly Step[]): string {
  const agent = agentOf(llm);
  const at = seat(llm) ?? ROOT;
  let image = world.image(at, (id) => llmOf(id) !== undefined);
  if (image.length > 24000) image = image.slice(0, 24000) + "\n// … the rest is left out";
  const sel = selected.value;
  const where = (id: Id, r?: readonly Step[]) => {
    const a = world.addressOf(id, r);
    return a ? `${J(id)}, at address ${J(a)}` : J(id);
  };
  const thrown = [...world.thrown].map(([p, t]) => `${p}'s ${t.part} threw: ${t.message}`);
  return [
    `You are ${J(llm)}, a node in the graph, in ${where(at)}'s slot "llm". You act as ${
      J(agent)
    }, an agent of your own; the person asking acts as ${J(world.agent)}.`,
    `You sit in ${J(at)}: build there unless asked otherwise. You see the graph from there down; ` +
    `the graph tool with { "whole": true } shows all of it.`,
    sel && sel.id !== ROOT && !about ? `Selected: ${where(sel.id, sel.route)}.` : "",
    about ? `The node: ${where(about, route)}.` : "",
    thrown.length ? "Programs that threw:\n" + thrown.join("\n") : "",
    `The graph from ${J(at)}, as a boot image:\n` + "```js\n" + image + "\n```",
  ].filter(Boolean).join("\n\n");
}

function rendererPrompt(id: Id, wish: string, tiny: boolean): string {
  const name = free(id + "-view");
  return [
    tiny
      ? `Make an app that shows what ${J(id)} holds: ui(${J(id)}, ${J(name)}, { watch: [...], ` +
        `draw }), watching the names of ${J(id)}'s slots that hold what to show.`
      : `Make a renderer for ${J(id)}: a process placed in ${J(id)}, so [] is ${J(id)}, that ` +
        `draws what its directory holds, live. Its compute reads api.directory({ address: [] }) ` +
        `and the values it needs; its effect draws them on screen(self). Call it ${J(name)}, in ` +
        `the slot of that name. ui() will do, if what it shows has names you know.`,
    wish.trim() ? `How it should look and behave: ${wish.trim()}` : "",
  ].filter(Boolean).join("\n");
}

// --- what the LLM can do ---

const TOOLS = [
  {
    name: "run",
    description: "Runs a snippet in the workspace, as the acting agent: it changes the graph. " +
      "Returns whether it worked, the runs it caused, and what their screens show.",
    parameters: { code: { type: "string", description: "the snippet" } },
    required: ["code"],
  },
  {
    name: "print",
    description: "Evaluates a snippet whose last line is an expression, and returns its value, " +
      'as the workspace\'s print-it does: read("id"), dir("id"), lookup("name"). For looking.',
    parameters: { code: { type: "string" } },
    required: ["code"],
  },
  {
    name: "inspect",
    description: "A node as the acting agent sees it: its value, its slots, where it is placed, " +
      "and, for a process, its last run (value, ending, errors, what it read) and anything thrown.",
    parameters: { node: { type: "string", description: "a node's id" } },
    required: ["node"],
  },
  {
    name: "look",
    description: "What the stage shows: each process's screen as text and HTML, or one process's.",
    parameters: { process: { type: "string", description: "a process id; leave out for all" } },
    required: [],
  },
  {
    name: "fire",
    description:
      "Fires a process's handler, as a click on its screen would, then reports as run does.",
    parameters: {
      process: { type: "string" },
      handler: { type: "string" },
      input: { description: "optional JSON input" },
    },
    required: ["process", "handler"],
  },
  {
    name: "graph",
    description: "The graph, now, as a boot image: from where you sit down, or all of it.",
    parameters: { whole: { type: "boolean", description: "the whole graph, from the root" } },
    required: [],
  },
].map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: { type: "object", properties: t.parameters, required: t.required },
  },
}));

const cut = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + ` … (${s.length - n} more)` : s;
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** A screen as the acting agent sees it: what was drawn again for them, or what the process drew. */
function screenOf(id: Id): HTMLElement | undefined {
  const box = world.screens.get(id);
  if (!box) return undefined;
  return (box.querySelector(":scope > .seen") ?? box.querySelector(":scope > .own")) as HTMLElement;
}

function shown(id: Id, html = 0) {
  const el = screenOf(id);
  if (!el) return { process: id, screen: "none: it has drawn nothing" };
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    process: id,
    text: cut(text, 600) || "(no text)",
    ...(html ? { html: cut(el.innerHTML, html) } : {}),
  };
}

/** What the runs since the log was that long did: each process's last, and its screen. */
function since(from: number) {
  const last = new Map<Id, ReturnType<typeof runOf>>();
  for (const e of world.log.slice(from)) {
    if (e.t === "record") last.set(e.record.process, runOf(e.record.process));
    if (e.t === "error") last.set("(error)", { error: e.error } as never);
  }
  const runs = [...last.values()];
  const screens = [...last.keys()].filter((id) => world.screens.has(id)).map((id) => shown(id));
  return { runs, ...(screens.length ? { screens } : {}) };
}

function runOf(id: Id) {
  const r = world.records.get(id)?.at(-1);
  const t = world.thrown.get(id);
  if (!r) return { process: id, runs: "none yet" };
  return {
    process: id,
    run: r.run,
    ending: r.ending,
    ...(r.value !== undefined ? { value: cut(J(r.value), 400) } : {}),
    ...(r.errors.length ? { errors: r.errors } : {}),
    ...(t
      ? { threw: `its ${t.part} threw${t.line ? ` at line ${t.line}` : ""}: ${t.message}` }
      : {}),
  };
}

/** Runs a tool as the LLM, and gives what it found as text, and the snippet, if it ran one. */
async function use(
  llm: Id,
  name: string,
  args: { [k: string]: unknown },
): Promise<{ result: string; snippet?: number; changed?: boolean }> {
  const agent = agentOf(llm);
  const code = String(args.code ?? "");
  switch (name) {
    case "run": {
      const from = world.log.length;
      const first = code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"));
      const s = act(code, "ask: " + (first?.trim().slice(0, 50) ?? "a snippet"), agent);
      await tick();
      return {
        snippet: s.n,
        changed: s.times.length > 0,
        result: J({
          ok: s.ok,
          snippet: s.n,
          ...(s.error ? { error: `${s.error.kind}: ${s.error.why}` } : {}),
          ...(s.ok && s.result !== undefined && s.result !== "undefined"
            ? { returned: cut(s.result, 400) }
            : {}),
          changes: s.times.length,
          ...since(from),
        }),
      };
    }
    case "print": {
      const s = world.print(code, "ask: print", agent);
      return {
        result: s.ok
          ? cut(s.result ?? "undefined", 6000)
          : `failed: ${s.error?.kind}: ${s.error?.why}`,
      };
    }
    case "inspect": {
      const id = String(args.node);
      if (!world.made.has(id)) return { result: `no node ${J(id)} in the graph` };
      const r = world.read(id, undefined, agent);
      const value = "refused" in r ? `refused: ${r.refused}` : r.value;
      return {
        result: J({
          id,
          address: world.addressOf(id) ?? "no address from the root reaches it",
          value: typeof value === "string" ? cut(value, 3000) : cut(J(value ?? null), 3000),
          slots: Object.fromEntries(world.slotsOf(id)),
          placedIn: world.placements().get(id) ?? [],
          ...(world.isProcess(id)
            ? {
              process: {
                running: world.running().has(id),
                ...runOf(id),
                handlers: [...(world.handlers.get(id) ?? [])],
                reads: (world.records.get(id)?.at(-1)?.reads ?? []).map((x) => x.address),
              },
            }
            : {}),
        }),
      };
    }
    case "look": {
      const p = args.process === undefined ? undefined : String(args.process);
      if (p) return { result: J(shown(p, 4000)) };
      if (!world.screens.size) {
        return { result: "the stage is empty: no process has drawn anything" };
      }
      return { result: J([...world.screens.keys()].map((id) => shown(id, 1200))) };
    }
    case "fire": {
      const from = world.log.length;
      const r = world.fireFromWorld(
        String(args.process),
        String(args.handler),
        args.input as never,
        agent,
      );
      await tick();
      const err = world.log.slice(from).find((e) => e.t === "error");
      return {
        result: J({
          fired: r !== undefined,
          ...(err && err.t === "error" ? { error: err.error.why } : {}),
          ...since(from),
        }),
      };
    }
    case "graph":
      return {
        result: cut(
          world.image(args.whole ? ROOT : seat(llm) ?? ROOT, (id) => llmOf(id) !== undefined),
          24000,
        ),
      };
  }
  return { result: `no tool ${J(name)}` };
}

// --- talking ---

/** What the api program is called with, and what it gives back. */
type Api = (o: {
  key: string;
  model: string;
  messages: unknown[];
  tools: unknown[];
  signal: AbortSignal;
  onText: (piece: string) => void;
}) => Promise<
  { text: string; calls: { id: string; function: { name: string; arguments: string } }[] }
>;

/**
 * The talk as messages for the api. The newest question goes with the graph as
 * it was asked; earlier ones keep only their words. A reply whose tool calls
 * were not all answered, as when it was stopped, goes without them.
 */
function messagesOf(llm: Id, prompt: string): unknown[] {
  const talk = talkOf(llm).map((t) => t.said);
  const newest = talk.findLastIndex((s) => s.role === "user" && !s.nudge);
  const answered = new Set(talk.flatMap((s) => (s.role === "tool" ? [s.call] : [])));
  const sent = new Set<string>();
  const out: unknown[] = [{ role: "system", content: prompt }];
  talk.forEach((s, i) => {
    if (s.role === "user") {
      out.push({
        role: "user",
        content: i === newest && s.context ? s.context + "\n\n" + s.text : s.text,
      });
    } else if (s.role === "assistant") {
      if (s.error) return;
      const calls = (s.calls ?? []).every((c) => answered.has(c.id)) ? s.calls ?? [] : [];
      for (const c of calls) sent.add(c.id);
      if (!s.text && !calls.length) return;
      out.push({
        role: "assistant",
        content: s.text || null,
        ...(calls.length
          ? {
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          }
          : {}),
      });
    } else if (sent.has(s.call)) {
      out.push({ role: "tool", tool_call_id: s.call, content: s.result });
    }
  });
  return out;
}

/** The longest a question goes on before it stops to ask. */
const STEPS = 30;

const LOOKERS = new Set(["look", "inspect", "print", "graph"]);

/** What an LLM needs, found around it; or why it cannot be asked. */
function needs(llm: Id): { api: Api; prompt: string; key: string } | string {
  if (modelNode(llm) === undefined && !llmOf(llm)?.model) {
    return `${llm} finds no "model" around it`;
  }
  const agent = agentOf(llm);
  const promptAt = around("prompt", llm, agent);
  if (!promptAt) return `${llm} finds no "prompt" around it`;
  const prompt = world.read(promptAt, undefined, agent);
  if ("refused" in prompt) return `${llm} may not read its prompt, ${promptAt}: ${prompt.refused}`;
  const apiAt = around("api", llm, agent);
  if (!apiAt) return `${llm} finds no "api" around it`;
  const code = world.read(apiAt, undefined, agent);
  if ("refused" in code) return `${llm} may not read its api, ${apiAt}: ${code.refused}`;
  let key = keyFor(apiAt, agent);
  // a key this browser kept is placed for the api, so it is not typed again
  if (!key && stored(KEY)) {
    const why = keepKey(llm, stored(KEY));
    if (why) return why;
    key = keyFor(apiAt, agent);
  }
  if (!key) return `${apiAt} finds no key around it`;
  let api: Api;
  try {
    api = world.module(String(code.value), "api") as Api;
  } catch (e) {
    return `${apiAt} does not load: ${(e as Error).message}`;
  }
  return { api, prompt: String(prompt.value ?? ""), key };
}

/**
 * Asks an LLM, and lets it work: each tool it calls runs, and what it found
 * goes back, until it answers without one. If it changed the graph since it
 * last looked, it is told to check before it may stop. Everything said goes
 * into its talk, as whoever said it.
 */
export async function ask(
  text: string,
  o: { about?: { id: Id; route?: Step[] }; llm?: Id } = {},
): Promise<string | undefined> {
  if (busy.value || !text.trim()) return;
  // it defaults to the root
  const llm = o.llm ?? current() ?? placeLlm(ROOT, placing.value);
  if (!llm) return (trouble.value = "no LLM could be placed");
  const need = needs(llm);
  if (typeof need === "string") return (trouble.value = need);
  trouble.value = undefined;
  const agent = agentOf(llm);
  const model = modelOf(llm);
  const allowed = llmOf(llm)!.tools;
  const tools = allowed ? TOOLS.filter((t) => allowed.includes(t.function.name)) : TOOLS;
  say(llm, {
    role: "user",
    text,
    by: world.agent,
    ...(o.about ? { about: o.about.id } : {}),
    context: context(llm, o.about?.id, o.about?.route),
  }, world.agent);
  busy.value = true;
  stop = new AbortController();
  let unchecked = false;
  let nudged = 0;
  let worked = false;
  try {
    for (let n = 0; n < STEPS; n++) {
      live.value = { llm, text: "" };
      const reply = await need.api({
        key: need.key,
        model,
        messages: messagesOf(llm, need.prompt),
        tools,
        signal: stop.signal,
        onText: (piece) => (live.value = { llm, text: (live.value?.text ?? "") + piece }),
      });
      live.value = undefined;
      const calls = reply.calls.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      }));
      say(llm, { role: "assistant", text: reply.text, ...(calls.length ? { calls } : {}) }, agent);
      if (!calls.length) {
        if (unchecked && nudged < 2) {
          nudged++;
          say(llm, {
            role: "user",
            by: "host",
            nudge: true,
            text: "You changed the graph since you last checked it. Check your work now, with " +
              "look or inspect, and fix what is wrong. When it is right, say so in a sentence, " +
              "calling no tool.",
          }, "host");
          continue;
        }
        break;
      }
      for (const c of calls) {
        let args: { [k: string]: unknown } = {};
        let done: { result: string; snippet?: number; changed?: boolean };
        try {
          args = c.arguments ? JSON.parse(c.arguments) : {};
          done = await use(llm, c.name, args);
        } catch (e) {
          done = { result: `the tool failed: ${(e as Error).message}` };
        }
        const ok = !/"ok":false|^failed|"ending":"(failed|refused)"|"threw"|"error"|the tool failed/
          .test(done.result);
        say(llm, { role: "tool", call: c.id, name: c.name, args, ok, ...done }, agent);
        if (c.name === "run" || c.name === "fire") {
          unchecked = true;
          if (c.name === "run" && ok) worked = true;
        } else if (LOOKERS.has(c.name)) unchecked = false;
      }
      if (n === STEPS - 1) {
        say(llm, {
          role: "assistant",
          text: `(it stopped after ${STEPS} steps: ask it to go on)`,
          error: true,
        }, "host");
      }
    }
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    say(llm, {
      role: "assistant",
      text: aborted ? "(stopped)" : "✕ " + (e as Error).message,
      error: true,
    }, "host");
  } finally {
    live.value = undefined;
    busy.value = false;
    stop = undefined;
  }
  if (worked && o.about) dock.value = "stage";
}

export function halt() {
  stop?.abort();
}

/** The snippets that changed the graph in answer to the question at i, by number. */
function didFor(talk: { said: Said }[], i: number): number[] {
  const out: number[] = [];
  for (let j = i + 1; j < talk.length; j++) {
    const s = talk[j].said;
    if (s.role === "user" && !s.nudge) break;
    if (s.role === "tool" && s.changed && s.snippet) out.push(s.snippet);
  }
  return out;
}

/** Whether those snippets are the last acts, so undoing them undoes only the LLM's work. */
function undoable(did: number[]): boolean {
  const tail = world.undoable.slice(-did.length);
  return did.length > 0 && tail.length === did.length && tail.every((n, i) => n === did[i]);
}

// --- the dock's pane ---

export function Ask() {
  world.version.value;
  const [text, setText] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyTrouble, setKeyTrouble] = useState<string>();
  const log = useRef<HTMLDivElement>(null);
  const llm = current();
  const talk = llm ? talkOf(llm) : [];
  const said = live.value?.llm === llm ? live.value?.text : undefined;
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [talk.length, said]);
  const send = () => {
    if (busy.value || !text.trim()) return;
    ask(text, llm ? { llm } : {});
    setText("");
  };
  const agent = llm ? agentOf(llm) : undefined;
  const api = llm && agent ? around("api", llm, agent) : undefined;
  const prompt = llm && agent ? around("prompt", llm, agent) : undefined;
  const modelAt = llm ? modelNode(llm) : undefined;
  const keyNode = api && agent ? around("key", api, agent) : undefined;
  // a key this browser kept counts: it is placed when the LLM is asked
  const hasKey = !!(api && agent && (keyFor(api, agent) || stored(KEY)));
  const keep = () => {
    if (!llm || !keyDraft.trim()) return;
    const why = keepKey(llm, keyDraft.trim());
    setKeyTrouble(why);
    if (!why) (setKeyDraft(""), setKeyOpen(false));
  };
  const at = llm ? seat(llm) : undefined;
  const all = llms();
  return (
    <div class="ask">
      <div class="ask-bar">
        {llm
          ? (
            <>
              {all.length > 1
                ? (
                  <select
                    value={llm}
                    onChange={(e) => (picked.value = (e.target as HTMLSelectElement).value)}
                  >
                    {all.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                )
                : <NodeLink id={llm} />}
              <span class="muted">in</span>
              {at ? <NodeLink id={at} /> : <span class="muted">nowhere</span>}
              <input
                class="code ask-model"
                list="ask-models"
                value={modelOf(llm)}
                title={modelAt
                  ? `its model, the node ${modelAt}: any OpenRouter model id that can call tools`
                  : 'its model: a node named "model" it will find around itself'}
                onChange={(e) => {
                  const m = (e.target as HTMLInputElement).value.trim();
                  if (!m) return;
                  // the node it finds is written; with none, it gets one of its own
                  act(
                    modelAt
                      ? `write(${J(modelAt)}, ${J(m)})`
                      : `make(${J(llm)}, "model", ${J(llm + ".model")}, ${J(m)})`,
                    `ask: ${llm}'s model`,
                  );
                }}
              />
              <span class="ask-finds" title="what it finds by looking up around itself">
                finds {modelAt ? <NodeLink id={modelAt} /> : <b class="bad">no model</b>} ·{" "}
                {prompt ? <NodeLink id={prompt} /> : <b class="bad">no prompt</b>} ·{" "}
                {api ? <NodeLink id={api} /> : <b class="bad">no api</b>} ·{" "}
                <button
                  type="button"
                  class={`ghostbtn${hasKey ? "" : " bad"}`}
                  disabled={!api}
                  title={keyNode
                    ? `${keyNode}: nobody may read it, and only chee may write it`
                    : hasKey
                    ? "the key this browser kept: placed for the api when the LLM is asked"
                    : "a key for the api"}
                  onClick={() => setKeyOpen(!keyOpen)}
                >
                  {hasKey ? "🔒 key" : "no key"}
                </button>
              </span>
              <button
                type="button"
                class="ghostbtn"
                disabled={busy.value || !talk.length}
                onClick={() => forget(llm)}
              >
                new talk
              </button>
            </>
          )
          : (
            <>
              <span class="muted">no LLM here yet: asking places one in the root, with</span>
              <input
                class="code ask-model"
                list="ask-models"
                value={placing.value}
                onChange={(
                  e,
                ) => (placing.value = (e.target as HTMLInputElement).value.trim() || MODELS[0])}
              />
              <button type="button" class="ghostbtn" onClick={() => placeLlm(ROOT, placing.value)}>
                place it now
              </button>
            </>
          )}
        <datalist id="ask-models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
      </div>
      {keyOpen && llm
        ? (
          <div class="ask-key">
            <p class="muted">
              the key goes in a node beside {api}, in a slot <code>key</code>{" "}
              that any api below finds, which protect lets nobody read and only chee write; the host
              reads it beneath protect to hand it to the api, and shows it nowhere. this browser
              keeps a copy too, for after a reload.
            </p>
            <div class="inline">
              <input
                class="code"
                type="password"
                placeholder="sk-or-…"
                value={keyDraft}
                onInput={(e) => setKeyDraft((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === "Enter" && keep()}
              />
              <button type="button" class="primary" disabled={!keyDraft.trim()} onClick={keep}>
                keep it, as <Agent agent={world.agent} />
              </button>
            </div>
            {keyTrouble ? <div class="error-line">✕ {keyTrouble}</div> : null}
          </div>
        )
        : null}
      <div class="ask-log" ref={log}>
        {talk.length === 0 && !said
          ? (
            <Empty>
              ask for something to build: "a todo list", "a clock", "a view of the selected node".
              it sees the graph from where it sits down, and checks what it made until it is right.
              drag it in the browser to move it; its prompt and its talk are its children.
            </Empty>
          )
          : null}
        {talk.map(({ id, said: s }, i) =>
          s.role === "user"
            ? s.nudge
              ? <div class="ask-nudge" key={id}>host: check your work</div>
              : (
                <div class="ask-you" key={id}>
                  {s.about ? <span class="ask-about">renderer for {s.about}</span> : null}
                  {s.text}
                  <UndoIts did={didFor(talk, i)} />
                </div>
              )
            : s.role === "tool"
            ? <ToolStep key={id} t={{ ...s, done: true }} />
            : s.text
            ? <div class={`ask-words${s.error ? " muted" : ""}`} key={id}>{s.text}</div>
            : null
        )}
        {said !== undefined
          ? <div class="ask-words">{said || <span class="muted">…</span>}</div>
          : null}
        {busy.value ? <div class="muted">working…</div> : null}
        {trouble.value ? <div class="error-line">✕ {trouble.value}</div> : null}
      </div>
      <div class="ask-input">
        <textarea
          class="code"
          rows={2}
          placeholder={busy.value ? "…" : "what should it build?"}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy.value
          ? <button type="button" onClick={halt}>stop</button>
          : (
            <button type="button" class="primary" disabled={!text.trim()} onClick={send}>
              ask
            </button>
          )}
        <span class="ws-as">
          you as <Agent agent={world.agent} />
          {agent
            ? (
              <>
                · it as <Agent agent={agent} />
              </>
            )
            : null}
        </span>
      </div>
    </div>
  );
}

function UndoIts({ did }: { did: number[] }) {
  if (busy.value || !undoable(did)) return null;
  return (
    <button
      type="button"
      class="ghostbtn ask-undo"
      onClick={() => {
        for (let k = 0; k < did.length; k++) undo();
      }}
    >
      ↶ undo its {did.length} snippet{did.length > 1 ? "s" : ""}
    </button>
  );
}

const GLYPH: { [tool: string]: string } = {
  run: "▶",
  print: "≡",
  inspect: "⌕",
  look: "◐",
  fire: "↯",
  graph: "⧉",
};

/** One tool the model used: what it asked, and what came back, folded. */
function ToolStep(
  { t }: {
    t: {
      name: string;
      args: { [k: string]: unknown };
      result?: string;
      ok?: boolean;
      done: boolean;
    };
  },
) {
  const code = typeof t.args.code === "string" ? t.args.code : undefined;
  const brief = code !== undefined
    ? code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ?? ""
    : Object.values(t.args).map((v) => (typeof v === "string" ? v : J(v))).join(" ");
  return (
    <details class={`ask-step${t.done ? (t.ok ? "" : " bad") : " busy"}`}>
      <summary>
        <span class="ask-glyph">{GLYPH[t.name] ?? "·"}</span>
        <b>{t.name}</b> <span class="muted">{cut(brief, 70)}</span>
        {t.done ? <span class="ask-mark">{t.ok ? "✓" : "✕"}</span> : <span class="muted">…</span>}
      </summary>
      {code !== undefined
        ? (
          <div class="ask-tools">
            <button
              type="button"
              class="ghostbtn"
              onClick={() => {
                draft.value = code;
                dock.value = "workspace";
              }}
            >
              to the workspace
            </button>
          </div>
        )
        : null}
      {code !== undefined ? <pre class="ask-code">{code}</pre> : null}
      {t.result !== undefined ? <pre class="ask-code result">{pretty(t.result)}</pre> : null}
    </details>
  );
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 1);
  } catch {
    return s;
  }
}

// --- the right click ---

/** A prompt for a renderer, where the browser was right-clicked, for the LLM nearest it. */
export function AskPopover() {
  world.version.value;
  const at = askAt.value;
  const [wish, setWish] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (at) (setWish(""), box.current?.focus());
  }, [at]);
  if (!at) return null;
  const llm = nearest(at.route) ?? current();
  const close = () => (askAt.value = undefined);
  const go = () => {
    close();
    dock.value = "ask";
    const tiny = small(llm ? modelOf(llm) : placing.value);
    // it builds, then checks the stage until the renderer is right
    ask(rendererPrompt(at.id, wish, tiny), {
      about: { id: at.id, route: at.route },
      ...(llm ? { llm } : {}),
    });
  };
  const x = Math.min(at.x, innerWidth - 360);
  const y = Math.min(at.y, innerHeight - 240);
  return (
    <div class="ask-scrim" onClick={close} onContextMenu={(e) => (e.preventDefault(), close())}>
      <div
        class="ask-pop"
        style={{ left: `${x}px`, top: `${y}px` }}
        onClick={(e) =>
          e.stopPropagation()}
      >
        <div class="sub-title">
          a renderer for <code>{at.id}</code>
        </div>
        <textarea
          ref={box}
          class="code"
          rows={3}
          placeholder="how should it look? e.g. cards in a grid, a bar chart of the numbers…"
          value={wish}
          onInput={(e) =>
            setWish((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              close();
            }
            if (e.key === "Enter" && !e.shiftKey) {
              (e.preventDefault(), go());
            }
          }}
        />
        <div class="ask-tools">
          <button type="button" class="primary" disabled={busy.value} onClick={go}>
            make it
          </button>
          <button type="button" class="ghostbtn" onClick={close}>cancel</button>
          <span class="hint">
            {llm ? <>asks {llm}, nearest</> : <>places an LLM in the root</>}
          </span>
        </div>
        <div class="ask-tools">
          {llm && seat(llm) !== at.id
            ? (
              <button
                type="button"
                class="ghostbtn"
                onClick={() => {
                  moveLlm(llm, at.id);
                  close();
                }}
              >
                move {llm} here
              </button>
            )
            : null}
          {!llm || seat(llm) !== at.id
            ? (
              <button
                type="button"
                class="ghostbtn"
                onClick={() => {
                  const id = placeLlm(at.id, llm ? modelOf(llm) : placing.value);
                  if (id) {
                    select(id, [...at.route, {
                      parent: at.id,
                      name: "llm",
                      node: id,
                      position: 0,
                    }]);
                  }
                  close();
                }}
              >
                another LLM here
              </button>
            )
            : null}
        </div>
      </div>
    </div>
  );
}
