/// <reference lib="dom" />
// The inspector: one node, everything about it, and every operation on it.
// Each button writes a line of code into the workspace and does it, so the
// change it makes carries a site, and the code teaches the api.

import { useEffect, useState } from "preact/hooks";
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
import { J, ROOT } from "./world.ts";

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
        <ValuePart id={sel.id} />
        <DirectoryPart id={sel.id} />
        <DataPart id={sel.id} />
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
    if (ps.name === "compute" || ps.name === "effect") return true;
  }
  return false;
}

function Header({ id }: { id: Id }) {
  world.version.value;
  const made = world.made.get(id);
  const where = world.placements().get(id) ?? [];
  const running = world.running().has(id);
  const route = selected.value?.route ?? [];
  return (
    <div class="inspector-head">
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
            {made.site ? <SiteLink site={made.site} /> : null}
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
        : <div class="placed-in unreachable">placed nowhere: by CORE.tex, removed</div>}
    </div>
  );
}

function ValuePart({ id }: { id: Id }) {
  world.version.value;
  const r = world.read(id);
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
  const write = () => {
    const p = parseJson(text);
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
            <textarea
              class="code"
              value={text}
              rows={Math.min(14, text.split("\n").length + 1)}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) write();
              }}
            />
            <div class="row-actions">
              <button type="button" class="primary" onClick={write}>write snapshot</button>
              <span class="hint">⌘↵ — a snapshot patch replaces the whole value</span>
            </div>
          </div>
        )
        : (
          <div class="value-view">
            <JsonView value={value} />
          </div>
        )}
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

function DataPart({ id }: { id: Id }) {
  world.version.value;
  const d = world.data(id);
  return (
    <Section
      title="fixed data"
      aside={<span class="muted">given when made, never changes</span>}
      open={d !== null}
    >
      <div class="value-view">
        <JsonView value={d} />
      </div>
    </Section>
  );
}

function DirectoryPart({ id }: { id: Id }) {
  world.version.value;
  const dir = world.directory(id);
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
                  <NodeLink id={x} route={[...route, { parent: id, name: slot, node: x }]} />
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
                        act(`place(${J(id)}, ${J(slot)}, ${J(x)}, ${i + 1})`, "inspector: move")}
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
    case "make":
      return `made ${peek(c.value, 28)}`;
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
      return `${c.name} ← ${c.id}${c.position !== undefined ? ` at ${c.position}` : ""}`;
    case "unplace":
      return `${c.name} ✕ ${c.id}`;
  }
}
export { describe };

function HistoryPart({ id }: { id: Id }) {
  world.version.value;
  const changes = world.log.filter((e) => e.t === "change" && e.change.node === id).map((e) =>
    (e as { change: Change }).change
  ).reverse();
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
  const running = world.running().has(id);
  const data = world.data(id) as { path?: unknown } | undefined;
  const path = Array.isArray(data?.path)
    ? data.path as { parent: Id; name: string; node: Id }[]
    : [];
  const runs: Run[] = world.records.get(id) ?? [];
  const last = runs[runs.length - 1];
  const handlers = [...(world.handlers.get(id) ?? [])];
  const where = (world.placements().get(id) ?? []).filter((p) =>
    p.parent === ROOT || world.isProcess(p.parent)
  );
  const dir = world.directory(id);
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
          <span class="k">path</span>
          <span class="v">
            {path.length
              ? path.map((s, i) => (
                <>
                  {i ? <span class="crumb-sep">/</span> : null}
                  <NodeLink id={s.node} route={path.slice(0, i + 1)} />
                </>
              ))
              : <span class="muted">[] — lookups find nothing</span>}
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
              : <span class="muted">nothing: it is not placed under the root or a process</span>}
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

function ProgramPart({ id }: { id: Id }) {
  world.version.value;
  const r = world.read(id);
  const code = "value" in r ? r.value : null;
  const asText = typeof code === "string" ? code : JSON.stringify(code, null, 2);
  const [text, setText] = useState(asText);
  const [err, setErr] = useState<string>();
  useEffect(() => setText(asText), [id, asText]);
  const users = (world.placements().get(id) ?? []).filter((p) =>
    p.name === "compute" || p.name === "effect"
  );
  const save = () => {
    let value: Json = text;
    if (typeof code !== "string") {
      const p = parseJson(text);
      if (!p.ok) return setErr(p.why);
      value = p.value;
    }
    const s = act(`write(${J(id)}, ${J(value)})`, "inspector: rewrite program");
    setErr(s.ok ? undefined : s.error?.why);
  };
  return (
    <Section
      title="program"
      aside={
        <span class="muted">
          {typeof code === "string" ? "JS" : "steps"} · the {users.map((u) => u.name).join(" & ")}
          {" "}
          of {users.map((u) => <NodeLink key={u.parent + u.name} id={u.parent} />)}
        </span>
      }
    >
      <textarea
        class="code program"
        spellcheck={false}
        value={text}
        rows={Math.max(4, Math.min(22, text.split("\n").length + 1))}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            const t = e.target as HTMLTextAreaElement;
            const a = t.selectionStart;
            t.setRangeText("  ", a, t.selectionEnd, "end");
            setText(t.value);
          }
        }}
      />
      <div class="row-actions">
        <button type="button" class="primary" disabled={text === asText} onClick={save}>
          save — write the program
        </button>
        <span class="hint">
          ⌘↵ · a write to a program marks every process running it ·{" "}
          <a onClick={() => (dock.value = "make")}>what can programs use?</a>
        </span>
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
