/// <reference lib="dom" />
// The dock: the workspace (do it, print it), the stage effects draw on, the
// rules protect asks, the lookup tester, and forms for making things.

import { useEffect, useRef, useState } from "preact/hooks";
import { Code } from "./editor.tsx";
import type { Id } from "../../../src/mod.ts";
import { Agent, Empty, literal, NodeLink } from "./bits.tsx";
import {
  act,
  dock,
  type DockTab,
  draft,
  focus,
  lit,
  pointAt,
  selected,
  tall,
  world,
} from "./state.ts";
import { type Found, J, problem, ROOT, type Rule } from "./world.ts";

export function Dock() {
  world.version.value;
  const tabs: [DockTab, string, string][] = [
    ["workspace", "workspace", "✎"],
    ["stage", "stage", "✦"],
    ["protect", "protect", "⊘"],
    ["lookup", "lookup", "⌕"],
    ["make", "make", "＋"],
  ];
  const screens = world.screens.size;
  return (
    <section class="pane dock">
      <div class="dock-tabs">
        {tabs.map(([t, label, glyph]) => (
          <button
            type="button"
            class={`dock-tab${dock.value === t ? " on" : ""}`}
            onClick={() => (dock.value = t)}
          >
            <span class="glyph">{glyph}</span> {label}
            {t === "stage" && screens ? <span class="count">{screens}</span> : null}
            {t === "protect" && world.rules.some((r) => r.on)
              ? <span class="count">{world.rules.filter((r) => r.on).length}</span>
              : null}
          </button>
        ))}
        <button
          type="button"
          class="dock-tab grow"
          title={tall.value ? "give the dock back its room" : "give the dock most of the height"}
          onClick={() => (tall.value = !tall.value)}
        >
          {tall.value ? "⤡" : "⤢"}
        </button>
      </div>
      <div class="dock-body">
        <div class={`dock-page${dock.value === "workspace" ? "" : " hidden"}`}>
          <Workspace />
        </div>
        <div class={`dock-page${dock.value === "stage" ? "" : " hidden"}`}>
          <Stage />
        </div>
        {dock.value === "protect" ? <Protect /> : null}
        {dock.value === "lookup" ? <Lookup /> : null}
        {dock.value === "make" ? <Make /> : null}
      </div>
    </section>
  );
}

// --- workspace ---

function Workspace() {
  world.version.value;
  const [out, setOut] = useState<{ ok: boolean; text: string } | undefined>();
  const code = draft.value;
  const p = pointAt.value;
  const hot = p && world.snippets[p.n - 1]?.code === code ? p.line : undefined;
  const doIt = (text: string, print: boolean) => {
    if (!text.trim()) return;
    const s = print ? world.print(text) : world.run(text);
    pointAt.value = undefined;
    if (s.ok) {
      setOut(
        print
          ? { ok: true, text: s.result ?? "undefined" }
          : { ok: true, text: `✓ snippet-${s.n}` },
      );
    } else setOut({ ok: false, text: `✕ ${s.error?.kind}: ${s.error?.why}` });
  };
  return (
    <div class="workspace">
      <div class="ws-main">
        <div class="ws-editor">
          <Code
            value={code}
            marks={hot ? [{ line: hot, cls: "hot" }] : []}
            onChange={(t) => (draft.value = t)}
            onRun={doIt}
          />
        </div>
        <div class="ws-bar">
          <button type="button" class="primary" onClick={() => doIt(draft.value, false)}>
            do it <kbd>⌘↵</kbd>
          </button>
          <button type="button" onClick={() => doIt(draft.value, true)}>
            print it <kbd>⇧⌘↵</kbd>
          </button>
          <button
            type="button"
            class="ghostbtn"
            onClick={() => ((draft.value = ""), setOut(undefined))}
          >
            clear
          </button>
          <span class="hint">a selection runs alone</span>
          <span class="ws-as">
            acting as <Agent agent={world.agent} />
          </span>
          {out ? <pre class={`ws-out${out.ok ? "" : " bad"}`}>{out.text}</pre> : null}
        </div>
      </div>
      <div class="ws-history">
        <div class="sub-title">
          history <span class="muted">every act from outside is a snippet</span>
        </div>
        {world.snippets.length === 0 ? <Empty>nothing done yet.</Empty> : null}
        {[...world.snippets].reverse().map((s) => (
          <div
            class={`hist-snip${s.ok === false ? " bad" : ""}`}
            onClick={() => {
              draft.value = s.code;
              focus.value = { t: "snippet", n: s.n };
            }}
          >
            <span class="t">{s.n}</span>
            <span class="snip-text">{s.label ?? firstLine(s.code)}</span>
            {s.times.length
              ? (
                <span class="muted">
                  @{s.times[0]}
                  {s.times.length > 1 ? `–${s.times[s.times.length - 1]}` : ""}
                </span>
              )
              : null}
            <Agent agent={s.agent} />
          </div>
        ))}
      </div>
    </div>
  );
}

function firstLine(code: string) {
  return code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ??
    code.trim();
}

// --- stage ---

function Stage() {
  world.version.value;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.append(world.stage);
  }, []);
  return (
    <div class="stage">
      {world.screens.size === 0
        ? (
          <Empty>
            effects draw here. an effect gets <code>screen()</code>, its own element, and{" "}
            <code>h()</code> to build with. try the <b>hello</b> or <b>typing</b> example.
          </Empty>
        )
        : null}
      <div ref={host} class="stage-host" />
    </div>
  );
}

// --- protect ---

const OPS = [
  "read",
  "directory",
  "lookup",
  "write",
  "place",
  "unplace",
  "subscribe",
  "unsubscribe",
  "bind",
  "record",
  "finish",
];

function Protect() {
  world.version.value;
  const rules = world.rules;
  const set = (i: number, r: Partial<Rule>) => {
    const next = { ...rules[i], ...r };
    for (const k of ["agent", "process", "op", "node"] as const) {
      if (next[k] === "") delete next[k];
    }
    world.rules = rules.map((x, j) => (j === i ? next : x));
    world.bump();
  };
  const move = (i: number, d: number) => {
    const next = [...rules];
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r);
    world.rules = next;
    world.bump();
  };
  return (
    <div class="protect">
      <div class="protect-intro">
        <b>may(agent, process, op, node)</b>{" "}
        is asked before every operation, including each directory a lookup reads. the first rule
        whose given fields all match wins; when none does, the operation is allowed. blank matches
        anything.
      </div>
      <table class="rules">
        <thead>
          <tr>
            <th />
            <th>agent</th>
            <th>process</th>
            <th>op</th>
            <th>node</th>
            <th>says</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr class={r.on ? "" : "off"}>
              <td>
                <input
                  type="checkbox"
                  checked={r.on}
                  onChange={() => set(i, { on: !r.on })}
                  title="on"
                />
              </td>
              <td>
                <input
                  class="code"
                  list="agents"
                  value={r.agent ?? ""}
                  placeholder="any"
                  onInput={(e) => set(i, { agent: (e.target as HTMLInputElement).value })}
                />
              </td>
              <td>
                <input
                  class="code"
                  list="processes"
                  value={r.process ?? ""}
                  placeholder="any"
                  onInput={(e) => set(i, { process: (e.target as HTMLInputElement).value })}
                />
              </td>
              <td>
                <select
                  value={r.op ?? ""}
                  onChange={(e) => set(i, { op: (e.target as HTMLSelectElement).value })}
                >
                  <option value="">any</option>
                  {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </td>
              <td>
                <input
                  class="code"
                  list="all-ids"
                  value={r.node ?? ""}
                  placeholder="any"
                  onInput={(e) => set(i, { node: (e.target as HTMLInputElement).value })}
                />
              </td>
              <td>
                <button
                  type="button"
                  class={`allow ${r.allow ? "yes" : "no"}`}
                  onClick={() => set(i, { allow: !r.allow })}
                >
                  {r.allow ? "allow" : "refuse"}
                </button>
              </td>
              <td class="rule-tools">
                <button
                  type="button"
                  class="ghostbtn"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="ghostbtn"
                  disabled={i === rules.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="ghostbtn danger"
                  onClick={() => {
                    world.rules = rules.filter((_, j) => j !== i);
                    world.bump();
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="agents">{world.agents.map((a) => <option key={a} value={a} />)}</datalist>
      <datalist id="processes">
        {[...world.made.keys()].filter((x) => world.isProcess(x)).map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <div class="row-actions">
        <button
          type="button"
          class="primary"
          onClick={() => {
            world.rules = [...rules, {
              agent: world.agent === "chee" ? "bun" : world.agent,
              op: "write",
              allow: false,
              on: true,
            }];
            world.bump();
          }}
        >
          ＋ rule
        </button>
        <span class="hint">
          rules belong to the host that built the stack, not the graph; changing them is not a
          change.
        </span>
      </div>
    </div>
  );
}

// --- lookup ---

function Lookup() {
  world.version.value;
  const [name, setName] = useState("theme");
  const [res, setRes] = useState<Found | { error: string } | undefined>();
  const route = selected.value?.route ?? [];
  // the directory the selected node is in: where a process placed beside it runs
  const place = route.slice(0, -1);
  const run = () => {
    try {
      const r = world.lookup(name, route);
      setRes(r);
      lit.value = {
        searched: r.searched.map((s) => s.node),
        found: r.found,
      };
    } catch (e) {
      setRes({ error: problem(e).why });
      lit.value = undefined;
    }
  };
  useEffect(() => () => void (lit.value = undefined), []);
  return (
    <div class="lookup">
      <div class="protect-intro">
        a process finds a node by name by searching the directories along its place, starting in the
        directory it sits in and going up, taking the nearest slot with that name. the place here is
        the directory the selected node is in, by the route you took to it in the browser.
      </div>
      <div class="lookup-form">
        <span class="muted">place</span>
        <span class="route">
          {place.length
            ? place.map((s, i) => (
              <>
                {i ? <span class="crumb-sep">/</span> : null}
                <span class="crumb">{s.name}</span>
              </>
            ))
            : <span class="muted">the root — select a node by its route in the browser</span>}
        </span>
        <input
          class="code"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <button type="button" class="primary" onClick={run}>look up</button>
      </div>
      {res && "error" in res ? <div class="error-line">✕ {res.error}</div> : null}
      {res && "found" in res
        ? (
          <div class="lookup-result">
            <div class="sub-title">searched, nearest first</div>
            <ol class="searched-list">
              {res.searched.map((s) => (
                <li class={"refused" in s ? "refused" : ""}>
                  <NodeLink id={s.node} />
                  {"refused" in s
                    ? <span>🔒 refused — the search ends here</span>
                    : <span class="at">@{s.saw ?? "∅"}</span>}
                </li>
              ))}
            </ol>
            <div class="sub-title">found</div>
            {res.found.length
              ? res.items.map((x, i) => (
                <span key={`${x.id}#${i}`}>
                  <NodeLink id={x.id} />
                  {"path" in x.from
                    ? <code class="muted">{x.from.path.join("/")}[{x.from.position}]</code>
                    : null}
                </span>
              ))
              : <Empty>no slot named {J(name)} along the place.</Empty>}
          </div>
        )
        : null}
    </div>
  );
}

// --- make ---

const COMPUTE_TEMPLATE = `// a compute only reads. it returns the process's value, or PENDING.
// you have: find(name), and where(name), the address a lookup found it at,
// which look up from the process's place; lookup(name), read(address),
// dir(address, name?), self, cwd, name, changes, ctx.api. an address is a list
// of names from the directory it runs in, []; its own node is [name]
return find("clicks")`;

const EFFECT_TEMPLATE = `// an effect only writes. it runs when the driver wrote the value.
// you have: value, previous, self, cwd, name, write(address, v),
// patch(address, ...patches), make(address, name, id, v), place, unplace,
// later (the lasting interface), handler(name, fn), fire(name, input),
// screen() and h(tag, props, ...children). return a cleanup if you like.
screen().replaceChildren(h("div", { class: "big" }, value))`;

function Make() {
  world.version.value;
  const sel = selected.value;
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [value, setValue] = useState("");
  const [pname, setPname] = useState("");
  const [compute, setCompute] = useState(COMPUTE_TEMPLATE);
  const [effect, setEffect] = useState(EFFECT_TEMPLATE);
  const [withEffect, setWithEffect] = useState(true);
  const [there, setThere] = useState(false);
  const [err, setErr] = useState<string>();
  // a node is made by placing it: into the selected node, or the root
  const parent: Id = sel && world.made.has(sel.id) ? sel.id : ROOT;
  // a process runs where it sits, once the root reaches it: under the root or a
  // process, or, with there, in the selected node, so its lookups search there
  const runner: Id = there ? parent : sel && world.isProcess(sel.id) ? sel.id : ROOT;
  const makeNode = () => {
    if (!name) return setErr("a node is made by placing it: it needs a name in its parent");
    const s = act(
      `make(${J(parent)}, ${J(name)}, ${J(id || name)}, ${literal(value)})`,
      "make: node",
    );
    setErr(s.ok ? undefined : s.error?.why);
    if (s.ok) (setName(""), setId(""));
  };
  const makeProcess = () => {
    if (!pname) return setErr("a process needs a name");
    const lines = [
      `process(${J(runner)}, ${J(pname)}, ${J(pname)}, {`,
      `  compute: ${J(compute)},`,
      ...(withEffect ? [`  effect: ${J(effect)},`] : []),
      `})`,
    ];
    const s = act(lines.join("\n"), "make: process");
    setErr(s.ok ? undefined : s.error?.why);
    if (s.ok) setPname("");
  };
  const input = (v: string, set: (s: string) => void, placeholder = "") => (
    <input
      class="code"
      placeholder={placeholder}
      value={v}
      onInput={(e) => set((e.target as HTMLInputElement).value)}
    />
  );
  return (
    <div class="make">
      <div class="make-col">
        <div class="sub-title">
          a node{" "}
          <span class="muted">
            made by placing it in <code>{parent}</code>
          </span>
        </div>
        <label>name{input(name, setName, "its name in the slot")}</label>
        <label>id{input(id, setId, name || "defaults to the name")}</label>
        <label>value{input(value, setValue, 'JSON, or text: "hello", 1, {"a": 1}')}</label>
        <button type="button" class="primary" onClick={makeNode}>make</button>
        <div class="sub-title">reference</div>
        <div class="reference">
          <p>
            <b>workspace</b> — <code>api</code>{" "}
            is the top of the stack, acting as you, with sites filled in as causes. a node is made
            by placing it. the graph is reached by address; a word names a node by its id or an
            address, and the host turns an id into an address from the root that reaches it.
          </p>
          <code>
            make(parent, name, id, value) · write(id, v) · patch(id, ...patches) · splice(id, path,
            from, to, v?) · set(id, path, key, v?) · place(parent, name, id, pos?) · unplace(parent,
            name, id) · read(id) · dir(id, name?) · lookup(name, place?) · program(parent, id, code)
            · process(parent, name, id,{" "}
            {"{"}compute, effect?{"}"}) · start(id, under?, name?) · stop(id, under?, name?) ·
            fire(process, handler, input?) · batch(fn) · as(agent, fn) · because(cause, fn) ·
            PENDING
          </code>
        </div>
      </div>
      <div class="make-col wide">
        <div class="sub-title">
          a process{" "}
          <span class="muted">
            placed in <code>{runner}</code>, where it runs
          </span>
        </div>
        <div class="inline">
          <label>name{input(pname, setPname, "its name and id")}</label>
          <label class="check">
            <input type="checkbox" checked={there} onChange={() => setThere(!there)} />
            put it in the selected node, {there && sel?.route.length
              ? <code>{sel.route.map((s) => s.name).join("/")}</code>
              : <code>{parent}</code>}
            <span class="muted">(it runs there, and lookups search from there)</span>
          </label>
        </div>
        <div class="two">
          <label class="block">
            compute
            <textarea
              class="code program"
              rows={7}
              spellcheck={false}
              value={compute}
              onInput={(e) => setCompute((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <label class="block">
            <span>
              <input
                type="checkbox"
                checked={withEffect}
                onChange={() => setWithEffect(!withEffect)}
              />{" "}
              effect
            </span>
            <textarea
              class="code program"
              rows={7}
              spellcheck={false}
              disabled={!withEffect}
              value={effect}
              onInput={(e) => setEffect((e.target as HTMLTextAreaElement).value)}
            />
          </label>
        </div>
        <button type="button" class="primary" onClick={makeProcess}>make the process</button>
        {err ? <div class="error-line">✕ {err}</div> : null}
      </div>
    </div>
  );
}
