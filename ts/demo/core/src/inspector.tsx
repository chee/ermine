/// <reference lib="dom" />
// The inspector: one node, everything about it, and every operation on it.
// Each button writes a line of code into the workspace and does it, so the
// change it makes carries a site, and the code teaches the api.

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { Code, type Mark } from "./editor.tsx";
import type { Change, Id, Json, Record as Run } from "../../../src/mod.ts";
import {
  Agent,
  Empty,
  Ending,
  Json as JsonView,
  literal,
  NodeLink,
  parseJson,
  peek,
  Ref,
  Section,
  SiteLink,
} from "./bits.tsx";
import { act, dock, focus, select, selected, world } from "./state.ts";
import { palette } from "./palette.tsx";
import { J, ROOT, siteOf } from "./world.ts";

export function Inspector() {
  world.version.value;
  const sel = selected.value;
  if (!sel || (!world.made.has(sel.id) && !world.isProcess(sel.id))) {
    return (
      <main class="pane inspector">
        <div class="pane-head">
          <span class="pane-title">inspector</span>
        </div>
        <div class="welcome">
          <div class="welcome-mark">⁂</div>
          <h2>a graph of values that says why</h2>
          <p>
            pick a node in the browser. every change says who made it, why, and the line of code it
            came from. every run says what marked it, what it read, and what it wrote.
          </p>
          {sel
            ? (
              <p class="ghost-note">
                <code>{sel.id}</code> is absent: no node has that id.
              </p>
            )
            : null}
        </div>
      </main>
    );
  }
  return (
    <main class="pane inspector">
      <Header id={sel.id} />
      <div class="inspector-body">
        {world.isProcess(sel.id) ? <ProcessPart id={sel.id} /> : null}
        {isProgram(sel.id) ? <ProgramPart id={sel.id} /> : null}
        {isProgram(sel.id) ? null : <ValuePart id={sel.id} />}
        <DirectoryPart id={sel.id} />
        <SubscribePart id={sel.id} />
        <HistoryPart id={sel.id} />
      </div>
    </main>
  );
}

function isProgram(id: Id) {
  const r = world.read(id);
  if (!("value" in r)) return false;
  const v = r.value;
  if (typeof v !== "string" && !Array.isArray(v)) return false;
  for (const ps of world.placements().get(id) ?? []) {
    if (ps.name === "compute" || ps.name === "effect" || ps.name.startsWith("render-")) return true;
  }
  // code that is not in a slot yet still reads as code
  return typeof v === "string" && /\breturn\b|=>|screen\(|el\.|\bconst\b/.test(v);
}

function Header({ id }: { id: Id }) {
  world.version.value;
  const made = world.made.get(id);
  const where = world.placements().get(id) ?? [];
  const running = world.running().has(id);
  const route = selected.value?.route ?? [];
  const step = route[route.length - 1];
  const ask = (only: string) => (palette.value = { context: { id, route }, only });
  return (
    <div class="inspector-head">
      <div class="node-actions">
        <button
          type="button"
          class="mini go"
          onClick={() => ask("make in")}
          title="make something in this node"
        >
          ＋ make here
        </button>
        {step
          ? (
            <>
              <button type="button" class="mini" onClick={() => ask("rename")}>rename</button>
              <button type="button" class="mini" onClick={() => ask("duplicate")}>duplicate</button>
              <button
                type="button"
                class="mini danger"
                title={`unplace it from ${step.parent}`}
                onClick={() => {
                  act(`unplace(${J(step.parent)}, ${J(step.name)}, ${J(id)})`, "edit: remove");
                  select(step.parent, route.slice(0, -1));
                }}
              >
                remove
              </button>
            </>
          )
          : null}
      </div>
      <div class="crumbs">
        {route.length
          ? (
            <>
              <button type="button" class="crumb" onClick={() => select(ROOT, [])}>root</button>
              {route.map((s, i) => (
                <>
                  <span class="crumb-sep">/</span>
                  <button
                    type="button"
                    class={`crumb${i === route.length - 1 ? " here" : ""}`}
                    onClick={() => select(s.node, route.slice(0, i + 1))}
                    title={`${s.parent}'s slot ${s.name}`}
                  >
                    {s.name}
                  </button>
                </>
              ))}
            </>
          )
          : <span class="crumb here">{id === ROOT ? "the root" : "reached directly"}</span>}
      </div>
      <h1 class="node-id">
        {id}
        {world.isProcess(id)
          ? (
            <span class={`badge ${running ? "b-run" : "b-stop"}`}>
              {running ? "running" : "process"}
            </span>
          )
          : null}
        {isProgram(id) ? <span class="badge b-prog">program</span> : null}
      </h1>
      {made
        ? (
          <div class="made">
            made <Ref r={made} /> by <Agent agent={made.agent} />
            {made.process
              ? (
                <>
                  in <NodeLink id={made.process} />
                </>
              )
              : null}
            {siteOf(made.cause) ? <SiteLink site={siteOf(made.cause)!} /> : null}
          </div>
        )
        : null}
      {where.length
        ? (
          <div class="placed-in">
            placed in {where.map((p) => (
              <span class="placement">
                <NodeLink id={p.parent} />
                <span class="slot-name">.{p.name}</span>
                <span class="at">[{p.index}]</span>
              </span>
            ))}
          </div>
        )
        : id === ROOT
        ? <div class="placed-in muted">the root: the host gave it</div>
        : (
          <div class="placed-in unreachable">
            placed nowhere: by CORE.tex, it cannot be addressed; placing its id again brings it back
          </div>
        )}
    </div>
  );
}

function ValuePart({ id }: { id: Id }) {
  world.version.value;
  const r = world.read(id, selected.value?.route);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string>();
  const [kind, setKind] = useState<"splice" | "set">("set");
  const [path, setPath] = useState("[]");
  const [from, setFrom] = useState("0");
  const [to, setTo] = useState("0");
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  useEffect(() => {
    setEditing(false);
    setErr(undefined);
  }, [id]);
  if ("refused" in r) {
    return (
      <Section title="value">
        <div class="refused">🔒 {r.refused}</div>
      </Section>
    );
  }
  const value = "value" in r ? r.value : undefined;
  const write = (t = text) => {
    const p = parseJson(t);
    if (!p.ok) return setErr(p.why);
    const s = act(`write(${J(id)}, ${JSON.stringify(p.value)})`, "inspector: write");
    if (s.ok) setEditing(false);
    else setErr(s.error?.why);
  };
  const applyPatch = () => {
    const pv = v.trim() === "" ? undefined : literal(v);
    const pp = parseJson(path);
    if (!pp.ok) return setErr("path: " + pp.why);
    const code = kind === "splice"
      ? `splice(${J(id)}, ${J(pp.value)}, ${Number(from)}, ${Number(to)}${
        pv === undefined ? "" : ", " + pv
      })`
      : `set(${J(id)}, ${J(pp.value)}, ${J(k)}${pv === undefined ? "" : ", " + pv})`;
    const s = act(code, `inspector: ${kind}`);
    setErr(s.ok ? undefined : s.error?.why);
  };
  return (
    <Section
      title="value"
      aside={
        <button
          type="button"
          class="mini"
          onClick={(e) => {
            e.preventDefault();
            setText(JSON.stringify(value ?? null, null, 2));
            setEditing(!editing);
          }}
        >
          {editing ? "cancel" : "✎ edit"}
        </button>
      }
    >
      {editing
        ? (
          <div class="editbox">
            <Code value={text} lang="json" autofocus onChange={setText} onRun={(t) => write(t)} />
            <div class="row-actions">
              <button type="button" class="primary" onClick={() => write()}>write snapshot</button>
              <span class="hint">⌘↵ — a snapshot patch replaces the whole value</span>
            </div>
          </div>
        )
        : (
          <div class="value-view">
            <JsonView value={value} />
          </div>
        )}
      {r.address === undefined
        ? (
          <div class="hint">
            no address from the root reaches{" "}
            {id}, so it cannot be read or written: it is placed nowhere the root reaches, or only
            behind another node in its slots (CORE.tex)
          </div>
        )
        : r.items.map((item, i) => (
          <div class="hint" key={i}>
            from /{item.from.route.map((s) => s.name).join("/")}
            {item.change
              ? (
                <>
                  {" "}· set <Ref r={item.change} /> by <Agent agent={item.change.agent} />
                </>
              )
              : " · as the host gave it"}
          </div>
        ))}
      <div class="patcher">
        <div class="patcher-head">
          <span class="muted">patch</span>
          <div class="seg">
            <button type="button" class={kind === "set" ? "on" : ""} onClick={() => setKind("set")}>
              set
            </button>
            <button
              type="button"
              class={kind === "splice" ? "on" : ""}
              onClick={() => setKind("splice")}
            >
              splice
            </button>
          </div>
        </div>
        <div class="patcher-fields">
          <label>
            path<input
              class="code"
              value={path}
              onInput={(e) => setPath((e.target as HTMLInputElement).value)}
            />
          </label>
          {kind === "splice"
            ? (
              <>
                <label>
                  from<input
                    class="code num"
                    value={from}
                    onInput={(e) => setFrom((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label>
                  to<input
                    class="code num"
                    value={to}
                    onInput={(e) => setTo((e.target as HTMLInputElement).value)}
                  />
                </label>
              </>
            )
            : (
              <label>
                key<input
                  class="code"
                  value={k}
                  onInput={(e) => setK((e.target as HTMLInputElement).value)}
                />
              </label>
            )}
          <label class="grow">
            value
            <input
              class="code"
              placeholder={kind === "set" ? "empty deletes the key" : "empty deletes the range"}
              value={v}
              onInput={(e) => setV((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && applyPatch()}
            />
          </label>
          <button type="button" class="primary" onClick={applyPatch}>apply</button>
        </div>
        <div class="hint">
          {kind === "splice"
            ? "replaces [from, to) of the string or list at path; strings count code points"
            : "sets key of the object at path"}
        </div>
      </div>
      {err ? <div class="error-line">✕ {err}</div> : null}
    </Section>
  );
}

function DirectoryPart({ id }: { id: Id }) {
  world.version.value;
  const dir = world.directory(id, selected.value?.route);
  const [name, setName] = useState("");
  const [child, setChild] = useState("");
  const [pos, setPos] = useState("");
  const [err, setErr] = useState<string>();
  const route = selected.value?.route ?? [];
  if (dir && !Array.isArray(dir)) {
    return (
      <Section title="directory">
        <div class="refused">🔒 {dir.refused}</div>
      </Section>
    );
  }
  const slots = dir ?? [];
  const place = () => {
    if (!name || !child) return setErr("a placement needs a name and an id");
    const p = pos.trim() === "" ? "" : `, ${Number(pos)}`;
    const s = act(`place(${J(id)}, ${J(name)}, ${J(child)}${p})`, "inspector: place");
    setErr(s.ok ? undefined : s.error?.why);
    if (s.ok) setChild("");
  };
  const ids = [...world.made.keys()];
  return (
    <Section title="directory" aside={<span class="muted">{slots.length} slots</span>}>
      {slots.length === 0 ? <Empty>no slots. a slot with no ids in it is gone.</Empty> : null}
      <div class="slots">
        {slots.map(([slot, xs]) => (
          <div class="slot">
            <div class="slot-label">{slot}</div>
            <div class="slot-ids">
              {xs.map((x, i) => (
                <span class="slot-id">
                  <NodeLink
                    id={x}
                    route={[...route, { parent: id, name: slot, node: x, position: i }]}
                  />
                  <span class="slot-tools">
                    <button
                      type="button"
                      class="ghostbtn"
                      disabled={i === 0}
                      title="move earlier: place at a new position"
                      onClick={() =>
                        act(`place(${J(id)}, ${J(slot)}, ${J(x)}, ${i - 1})`, "inspector: move")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="ghostbtn"
                      disabled={i === xs.length - 1}
                      title="move later"
                      onClick={() =>
                        // a position is a gap in the slot as it is: the one after the next id
                        act(`place(${J(id)}, ${J(slot)}, ${J(x)}, ${i + 2})`, "inspector: move")}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="ghostbtn danger"
                      title="unplace"
                      onClick={() =>
                        act(`unplace(${J(id)}, ${J(slot)}, ${J(x)})`, "inspector: unplace")}
                    >
                      ✕
                    </button>
                  </span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div class="placer">
        <input
          class="code"
          placeholder="name"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <span class="arrow">→</span>
        <input
          class="code"
          placeholder="id"
          list="all-ids"
          value={child}
          onInput={(e) => setChild((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && place()}
        />
        <input
          class="code num"
          placeholder="pos"
          value={pos}
          onInput={(e) => setPos((e.target as HTMLInputElement).value)}
        />
        <button type="button" class="primary" onClick={place}>place</button>
        <datalist id="all-ids">{ids.map((x) => <option key={x} value={x} />)}</datalist>
      </div>
      <div class="hint">
        an absent id can be placed: a slot may name a node that is not here yet
      </div>
      {err ? <div class="error-line">✕ {err}</div> : null}
    </Section>
  );
}

function describe(c: Change): string {
  switch (c.kind) {
    case "write":
      return c.patches.map((p) =>
        p.type === "snapshot"
          ? `= ${peek(p.value, 28)}`
          : p.type === "set"
          ? `.${[...p.path, p.key].join(".")} ${
            "value" in p ? "= " + peek(p.value, 18) : "deleted"
          }`
          : `[${p.range[0]},${p.range[1]}) ${"value" in p ? "← " + peek(p.value, 18) : "deleted"}`
      ).join("; ") || "no patches";
    case "place":
      // a placement with a value made the node
      return `${c.name} ← ${c.id}${c.position !== undefined ? ` at ${c.position}` : ""}${
        c.value !== undefined ? `, made ${peek(c.value, 28)}` : ""
      }`;
    case "unplace":
      return `${c.name} ✕ ${c.id}`;
  }
}
export { describe };

function HistoryPart({ id }: { id: Id }) {
  world.version.value;
  // its changes, and the placement that made it: the parent's change and its first
  const changes = world.log.filter((e) =>
    e.t === "change" &&
    (e.change.node === id || (e.change.kind === "place" && e.change.value !== undefined &&
      e.change.id === id))
  ).map((e) => (e as { change: Change }).change).reverse();
  return (
    <Section title="changes" aside={<span class="muted">{changes.length}</span>}>
      <div class="history">
        {changes.map((c) => (
          <div class="hist" onClick={() => (focus.value = { t: "change", ref: c })}>
            <span class="t">@{c.time}</span>
            <span class={`kind-tag kt-${c.kind}`}>{c.kind}</span>
            <span class="hist-what">{describe(c)}</span>
            <Agent agent={c.agent} />
            {c.process ? <span class="via">via {c.process}</span> : null}
          </div>
        ))}
      </div>
    </Section>
  );
}

function ProcessPart({ id }: { id: Id }) {
  world.version.value;
  // a process runs where the driver's walk reaches it: in the directory it sits in, its cwd
  const at = world.running().get(id);
  const running = at !== undefined;
  const path = (at?.route ?? []).slice(0, -1);
  const runs: Run[] = world.records.get(id) ?? [];
  const last = runs[runs.length - 1];
  const handlers = [...(world.handlers.get(id) ?? [])];
  const where = at ? [{ parent: at.parent, name: at.name }] : [];
  const dir = world.directory(id, at?.route);
  const slot = (n: string) => Array.isArray(dir) ? dir.find(([s]) => s === n)?.[1] ?? [] : [];
  const [inputs, setInputs] = useState<{ [h: string]: string }>({});
  return (
    <Section
      title={<>process {running ? <span class="dot-run" /> : null}</>}
      aside={running
        ? (
          <button
            type="button"
            class="mini danger"
            onClick={(e) => {
              e.preventDefault();
              const p = where[0];
              act(`unplace(${J(p.parent)}, ${J(p.name)}, ${J(id)})`, "inspector: stop");
            }}
          >
            ■ stop
          </button>
        )
        : (
          <button
            type="button"
            class="mini go"
            onClick={(e) => {
              e.preventDefault();
              act(`start(${J(id)})`, "inspector: start");
            }}
          >
            ▶ start under root
          </button>
        )}
    >
      <div class="proc-grid">
        <div class="kv">
          <span class="k">runs in</span>
          <span class="v">
            {path.length
              ? path.map((s, i) => (
                <>
                  {i ? <span class="crumb-sep">/</span> : null}
                  <NodeLink id={s.node} route={path.slice(0, i + 1)} />
                </>
              ))
              : running
              ? <span class="muted">the root — lookups search it</span>
              : <span class="muted">nowhere — no place the root reaches holds it</span>}
          </span>
        </div>
        <div class="kv">
          <span class="k">runs as</span>
          <span class="v">
            {last ? <Agent agent={last.agent} /> : <span class="muted">not run yet</span>}
          </span>
        </div>
        <div class="kv">
          <span class="k">started by</span>
          <span class="v">
            {where.length
              ? where.map((p) => (
                <span class="placement">
                  <NodeLink id={p.parent} />
                  <span class="slot-name">.{p.name}</span>
                </span>
              ))
              : <span class="muted">nothing: no place the root reaches holds it</span>}
          </span>
        </div>
        <div class="kv">
          <span class="k">compute</span>
          <span class="v">
            {slot("compute").map((x, i) => (
              <span class={i ? "shadowed" : ""}>
                <NodeLink id={x} />
              </span>
            ))}
            {slot("compute").length === 0 ? <span class="muted">none: runs fail</span> : null}
          </span>
        </div>
        <div class="kv">
          <span class="k">effect</span>
          <span class="v">
            {slot("effect").map((x, i) => (
              <span class={i ? "shadowed" : ""}>
                <NodeLink id={x} />
              </span>
            ))}
            {slot("effect").length === 0 ? <span class="muted">none: a derived value</span> : null}
          </span>
        </div>
      </div>
      {handlers.length
        ? (
          <div class="handlers">
            <div class="sub-title">handlers</div>
            {handlers.map((h) => (
              <div class="handler">
                <span class="handler-name">{h}</span>
                <input
                  class="code"
                  placeholder="input (JSON, optional)"
                  value={inputs[h] ?? ""}
                  onInput={(e) =>
                    setInputs({ ...inputs, [h]: (e.target as HTMLInputElement).value })}
                />
                <button
                  type="button"
                  class="primary"
                  disabled={!running}
                  onClick={() => {
                    const i = (inputs[h] ?? "").trim();
                    act(
                      `fire(${J(id)}, ${J(h)}${i ? ", " + literal(i) : ""})`,
                      "inspector: fire",
                    );
                  }}
                >
                  fire
                </button>
              </div>
            ))}
          </div>
        )
        : null}
      <div class="runs">
        <div class="sub-title">
          runs <span class="muted">{runs.length}</span>
        </div>
        {runs.length === 0 ? <Empty>no runs yet. a process runs once it is started.</Empty> : null}
        {[...runs].reverse().slice(0, 30).map((r) => (
          <div
            class={`run-row${
              focus.value?.t === "record" && focus.value.process === id && focus.value.run === r.run
                ? " sel"
                : ""
            }`}
            onClick={() => (focus.value = { t: "record", process: id, run: r.run })}
          >
            <span class="t">#{r.run}</span>
            <Ending ending={r.ending} />
            <span class="run-value">{"value" in r ? peek(r.value, 30) : ""}</span>
            <span class="run-marks">
              {r.marked.slice(0, 3).map((m) => <Ref key={`${m.node}@${m.time}`} r={m} />)}
              {r.marked.length > 3 ? <span class="muted">+{r.marked.length - 3}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Whether to write a program as it is typed, a moment after each pause. */
const live = signal(
  (() => {
    try {
      return localStorage.getItem("ermine-live") !== "off";
    } catch {
      return true;
    }
  })(),
);

function ProgramPart({ id }: { id: Id }) {
  world.version.value;
  const r = world.read(id);
  const code = "value" in r ? r.value : null;
  const steps = typeof code !== "string";
  const asText = typeof code === "string" ? code : JSON.stringify(code, null, 2);
  const [text, setText] = useState(asText);
  const [err, setErr] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // a write from elsewhere shows, unless there is typing not yet written
  const written = useRef(asText);
  useEffect(() => {
    if (text === written.current) setText(asText);
    written.current = asText;
  }, [id, asText]);
  const users = (world.placements().get(id) ?? []).filter((p) =>
    p.name === "compute" || p.name === "effect" || p.name.startsWith("render-")
  );
  const save = (t = text) => {
    let value: Json = t;
    if (steps) {
      const p = parseJson(t);
      if (!p.ok) return setErr(p.why);
      value = p.value;
    }
    if (t === written.current) return;
    written.current = t;
    const s = act(
      `write(${J(id)}, ${J(value)})`,
      live.value ? "live: program" : "inspector: rewrite program",
    );
    setErr(s.ok ? undefined : s.error?.why);
  };
  // what the processes running it threw, and where
  const thrown = [...world.thrown.entries()].filter(([, t]) => t.code === code);
  const failing = users.filter((u) => u.name === "compute" || u.name === "effect").map((u) => {
    const runs = world.records.get(u.parent);
    return { process: u.parent, last: runs?.[runs.length - 1] };
  });
  const marks: Mark[] = thrown.flatMap((
    [, t],
  ) => (t.line ? [{ line: t.line, cls: "error" as const }] : []));
  return (
    <Section
      title="program"
      aside={
        <span class="program-aside">
          <label class="live" title="write the program a moment after you stop typing">
            <input
              type="checkbox"
              checked={live.value}
              onChange={() => {
                live.value = !live.value;
                try {
                  localStorage.setItem("ermine-live", live.value ? "on" : "off");
                } catch { /* fine */ }
              }}
            />
            live
          </label>
          <span class="muted">{steps ? "steps" : "JS"}</span>
        </span>
      }
    >
      <div class="program-users">
        {users.length
          ? users.map((u) => {
            const f = failing.find((x) => x.process === u.parent);
            return (
              <span class="program-user" key={u.parent + u.name}>
                the {u.name} of <NodeLink id={u.parent} />
                {f?.last ? <Ending ending={f.last.ending} /> : null}
              </span>
            );
          })
          : (
            <span class="muted">
              no process runs this yet: drop it into a process's compute or effect slot
            </span>
          )}
      </div>
      <Code
        value={text}
        lang={steps ? "json" : "js"}
        marks={marks}
        minHeight={120}
        maxHeight={520}
        onChange={(t) => {
          setText(t);
          if (live.value) {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => save(t), 650);
          }
        }}
        onRun={() => save()}
      />
      {thrown.map(([p, t]) => (
        <div class="error-line" key={p}>
          ✕ {t.part} of <b>{p}</b>
          {t.line ? ` threw at line ${t.line}` : " threw"}: {t.message}
        </div>
      ))}
      <div class="row-actions">
        {live.value
          ? (
            <span class="hint">
              live: each pause writes it, and every process running it runs again
            </span>
          )
          : (
            <>
              <button
                type="button"
                class="primary"
                disabled={text === written.current}
                onClick={() => save()}
              >
                save — write the program
              </button>
              <span class="hint">⌘↵ · a write to a program marks every process running it</span>
            </>
          )}
        <a onClick={() => (dock.value = "make")}>what can programs use?</a>
      </div>
      {err ? <div class="error-line">✕ {err}</div> : null}
    </Section>
  );
}

function SubscribePart({ id }: { id: Id }) {
  world.version.value;
  const entry = world.subs.get(id);
  const [err, setErr] = useState<string>();
  useEffect(() => setErr(undefined), [id]);
  return (
    <Section
      title="subscription"
      open={!!entry}
      aside={
        <button
          type="button"
          class={`mini${entry ? " on" : ""}`}
          onClick={(e) => {
            e.preventDefault();
            const p = entry ? world.unsubscribe(id) : world.subscribe(id);
            setErr(p?.why);
          }}
        >
          {entry ? `◉ subscribed · ${entry.events.length} — unsubscribe` : "subscribe"}
        </button>
      }
    >
      <div class="hint">
        a subscriber receives each change to the node, and each record of a process at it.
        subscribing goes through protect as {String(world.agent)}.
      </div>
      {err ? <div class="error-line">✕ {err}</div> : null}
      {entry
        ? (
          <div class="subs">
            {entry.events.length === 0 ? <Empty>nothing received yet.</Empty> : null}
            {[...entry.events].reverse().map((e, i) =>
              "change" in e
                ? (
                  <div
                    key={i}
                    class="sub-event"
                    onClick={() => (focus.value = { t: "change", ref: e.change })}
                  >
                    <span class="t">@{e.change.time}</span>
                    <span class={`kind-tag kt-${e.change.kind}`}>{e.change.kind}</span>
                    <span class="hist-what">{describe(e.change)}</span>
                  </div>
                )
                : (
                  <div
                    key={i}
                    class="sub-event"
                    onClick={() => (focus.value = {
                      t: "record",
                      process: e.record.process,
                      run: e.record.run,
                    })}
                  >
                    <span class="t">▷</span>
                    <span>record #{e.record.run}</span>
                    <Ending ending={e.record.ending} />
                  </div>
                )
            )}
          </div>
        )
        : null}
    </Section>
  );
}
