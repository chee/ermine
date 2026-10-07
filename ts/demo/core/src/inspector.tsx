/// <reference lib="dom" />
// The inspector: one node, everything about it, and every operation on it.
// Each button writes a line of code into the workspace and does it, so the
// change it makes carries a site, and the code teaches the api.

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { Code, type Mark } from "./editor.tsx";
import type { Change, Id, Json, Record as Run } from "../../../src/mod.ts";
import type { ProcessItem } from "../../../src/schedule.ts";
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
import { isLoader, isProgram as programValue, J, plain, ROOT, siteOf } from "./world.ts";
import { itemNote, LinkPart } from "./link.tsx";

export function Inspector() {
  world.version.value;
  const sel = selected.value;
  if (!sel || !world.made.has(sel.id)) {
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
        <LinkPart id={sel.id} />
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

/** A program node: its value is {kind, compute, effect?} (SCHEDULER.tex, Programs). */
function isProgram(id: Id) {
  return programValue(world.valueOf(id));
}

function Header({ id }: { id: Id }) {
  world.version.value;
  const made = world.made.get(id);
  const where = world.placements().get(id) ?? [];
  const running = world.running().has(id);
  const eph = world.ephemeral.has(id);
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
              {running ? "process · running" : "process · killed"}
            </span>
          )
          : null}
        {isProgram(id) ? <span class="badge b-prog">program</span> : null}
        {isLoader(world.valueOf(id)) ? <span class="badge b-prog">loader</span> : null}
        {eph
          ? (
            <span class="badge b-stop" title="nobody keeps it: it goes with its process">
              ephemeral
            </span>
          )
          : null}
      </h1>
      {made
        ? (
          <div class="made">
            made <Ref r={made.time} /> by <Agent agent={made.agent} />
            {made.process
              ? (
                <>
                  in <NodeLink id={made.process} />
                </>
              )
              : null}
            {siteOf(made.cause)
              ? <SiteLink site={siteOf(made.cause)!} remote={world.linked.has(made.time)} />
              : null}
          </div>
        )
        : id !== ROOT && world.kept
        ? <div class="made muted">kept from before this page: loaded with the graph</div>
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
  const editable = plain(value ?? null);
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
      aside={editable
        ? (
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
        )
        : (
          <span class="muted" title="bytes, typed arrays and live values are not JSON">
            not JSON
          </span>
        )}
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
                  {" "}· set <Ref r={item.change.time} /> by <Agent agent={item.change.agent} />
                </>
              )
              : " · as the host gave it"}
            {item.ephemeral ? " · ephemeral: nobody keeps it" : ""}
            {itemNote(item)}
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
          <div class="hist" onClick={() => (focus.value = { t: "change", ref: c.time })}>
            <span class="t">@{c.time}</span>
            <span class={`kind-tag kt-${c.kind}`}>{c.kind}</span>
            {c.ephemeral ? <span class="kind-tag kt-make" title="ephemeral">~</span> : null}
            <span class="hist-what">{describe(c)}</span>
            <Agent agent={c.agent} />
            {c.process ? <span class="via">via {c.process}</span> : null}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** One item a scheduler puts in front of a process's value (SCHEDULER.tex, Pending, waiting and errors). */
function FrontItem({ item }: { item: ProcessItem }) {
  world.version.value;
  if ("waiting" in item) {
    return (
      <div class="hint">
        <Ending ending="pending" /> waiting{item.waiting.length ? ", kept for it:" : ""}{" "}
        {item.waiting.map((t) => <Ref key={t} r={t} />)}
      </div>
    );
  }
  if ("stopped" in item) {
    return (
      <div class="hint">
        <span class="ending e-refused">■ stopped</span>{" "}
        killed with the process that started it; it stays placed until it is unplaced
      </div>
    );
  }
  if ("error" in item) {
    return (
      <div class="error-line">
        ✕ run #{item.from.run} ended with{" "}
        <span class={`kind-tag kt-${item.error.kind}`}>{item.error.kind}</span>{" "}
        {item.error.op ? <b>{item.error.op}</b> : null} {item.error.why.code}
        {item.error.why.text ? `: ${item.error.why.text}` : ""}
        {item.error.why.message !== undefined ? `: ${String(item.error.why.message)}` : ""}
      </div>
    );
  }
  const n = item.newer;
  const say = (what: string, i: { node: string; time: number } | null | undefined) =>
    i === undefined ? null : (
      <span>
        {what}: {i === null ? <b>none is found now</b> : (
          <>
            <NodeLink id={i.node} /> <span class="at">@{i.time}</span>
          </>
        )}
        {" "}
      </span>
    );
  return (
    <div class="hint">
      <span class="ending e-pending">↑ newer</span> {say("program", n.program)}
      {say("loader", n.loader)}
      <span class="muted">— it keeps running the one it started with</span>
    </div>
  );
}

function ProcessPart({ id }: { id: Id }) {
  world.version.value;
  const p = world.procs.get(id)!;
  const running = p.state === "running";
  const placed = world.addressOf(id) !== undefined;
  const front = world.front(id);
  const runs: Run[] = world.records.get(id) ?? [];
  const last = runs[runs.length - 1];
  const handlers = [...(world.handlers.get(id) ?? [])];
  const kids = [...world.procs.values()].filter((q) => q.by === id);
  const newer = front.some((i) => "newer" in i);
  const place = world.routeOf(p.cwd);
  const kind = programValue(p.code) ? p.code.kind : undefined;
  const [inputs, setInputs] = useState<{ [h: string]: string }>({});
  return (
    <Section
      title={<>process {running ? <span class="dot-run" /> : null}</>}
      aside={
        <span>
          {running && newer && p.path
            ? (
              <button
                type="button"
                class="mini go"
                title="start the program again where it is, and unplace this one"
                onClick={(e) => {
                  e.preventDefault();
                  const s = act(`replace(${J(id)})`, "inspector: replace");
                  const next = s.ok && s.result ? JSON.parse(s.result) : undefined;
                  if (typeof next === "string") {
                    select(
                      next,
                      world.routeOf(world.addressOf(next) ?? []),
                    );
                  }
                }}
              >
                ↻ replace
              </button>
            )
            : null}
          {placed
            ? (
              <button
                type="button"
                class="mini danger"
                onClick={(e) => {
                  e.preventDefault();
                  act(`stop(${J(id)})`, running ? "inspector: stop" : "inspector: unplace");
                }}
              >
                {running ? "■ stop" : "unplace"}
              </button>
            )
            : null}
        </span>
      }
    >
      <div class="proc-grid">
        <div class="kv">
          <span class="k">pid</span>
          <span class="v">
            <code>{id}</code>{" "}
            <span class="muted">
              started <Ref r={p.started} />
            </span>
          </span>
        </div>
        <div class="kv">
          <span class="k">runs in</span>
          <span class="v">
            {place.length
              ? place.map((s, i) => (
                <>
                  {i ? <span class="crumb-sep">/</span> : null}
                  <NodeLink id={s.node} route={place.slice(0, i + 1)} />
                </>
              ))
              : <span class="muted">the root — lookups search it</span>}
          </span>
        </div>
        <div class="kv">
          <span class="k">program</span>
          <span class="v">
            <NodeLink id={p.program.node} /> <span class="at">@{p.program.time}</span>
            {p.path ? <code class="muted">{p.path.join("/")}</code> : null}
            {kind ? <span class="muted">· loaders/{kind}</span> : null}
          </span>
        </div>
        <div class="kv">
          <span class="k">acts as</span>
          <span class="v">
            {last ? <Agent agent={last.agent} /> : <Agent agent={p.actor} />}
          </span>
        </div>
        <div class="kv">
          <span class="k">started by</span>
          <span class="v">
            {p.by ? <NodeLink id={p.by} /> : <span class="muted">outside any process</span>}
          </span>
        </div>
        {kids.length
          ? (
            <div class="kv">
              <span class="k">started</span>
              <span class="v">
                {kids.map((k) => (
                  <span class={k.state === "running" ? "" : "shadowed"}>
                    <NodeLink id={k.pid} />
                  </span>
                ))}
              </span>
            </div>
          )
          : null}
      </div>
      {front.length
        ? (
          <div class="handlers">
            <div class="sub-title">in front of its value</div>
            {front.map((item, i) => <FrontItem key={i} item={item} />)}
          </div>
        )
        : null}
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
        {runs.length === 0 ? <Empty>no runs yet: it is marked by its start.</Empty> : null}
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
              {r.marked.slice(0, 3).map((t) => <Ref key={t} r={t} />)}
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

/** One part of a program: its code, written into the program's value a moment after typing. */
function PartEditor(
  { id, part, code, steps }: { id: Id; part: "compute" | "effect"; code: Json; steps: boolean },
) {
  const asText = typeof code === "string" ? code : JSON.stringify(code ?? null, null, 2);
  const [text, setText] = useState(asText);
  const [err, setErr] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // a write from elsewhere shows, unless there is typing not yet written
  const written = useRef(asText);
  useEffect(() => {
    if (text === written.current) setText(asText);
    written.current = asText;
  }, [id, asText]);
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
      `set(${J(id)}, [], ${J(part)}, ${J(value)})`,
      live.value ? `live: ${part}` : `inspector: rewrite ${part}`,
    );
    setErr(s.ok ? undefined : s.error?.why);
  };
  const thrown = [...world.thrown.entries()].filter(([, t]) =>
    t.program === id && (t.part === part || (part === "effect" && t.part === "handler"))
  );
  const marks: Mark[] = thrown.flatMap(([, t]) =>
    t.line && t.code === code ? [{ line: t.line, cls: "error" as const }] : []
  );
  return (
    <div class="editbox">
      <div class="sub-title">{part}</div>
      <Code
        value={text}
        lang={steps ? "json" : "js"}
        marks={marks}
        minHeight={80}
        maxHeight={420}
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
          ✕ the {t.part} of <NodeLink id={p} />
          {t.line ? ` threw at line ${t.line}` : " threw"}: {t.message}
        </div>
      ))}
      {!live.value
        ? (
          <div class="row-actions">
            <button
              type="button"
              class="primary"
              disabled={text === written.current}
              onClick={() => save()}
            >
              save the {part}
            </button>
          </div>
        )
        : null}
      {err ? <div class="error-line">✕ {err}</div> : null}
    </div>
  );
}

function ProgramPart({ id }: { id: Id }) {
  world.version.value;
  const v = world.valueOf(id);
  if (!programValue(v)) return null;
  const steps = v.kind === "steps";
  // the processes that kept this program when they started; one started before its last change shows newer
  const users = [...world.procs.values()].filter((p) => p.program.node === id);
  const now = world.made.get(id)?.time;
  const latest = Math.max(now ?? 0, world.latest.get(id) ?? 0);
  return (
    <Section
      title="program"
      aside={
        <span class="program-aside">
          <label class="live" title="write each part a moment after you stop typing">
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
          <span class="muted">kind {v.kind}, run by loaders/{v.kind}</span>
        </span>
      }
    >
      <div class="program-users">
        {users.length
          ? users.map((u) => {
            const runs = world.records.get(u.pid);
            const last = runs?.[runs.length - 1];
            const old = u.state === "running" && u.program.time < latest;
            return (
              <span class="program-user" key={u.pid}>
                <NodeLink id={u.pid} />
                {u.state === "running" ? null : <span class="muted">killed</span>}
                {last ? <Ending ending={last.ending} /> : null}
                {old
                  ? (
                    <span class="ending e-pending" title="it runs the program as it started">
                      ↑ newer
                    </span>
                  )
                  : null}
              </span>
            );
          })
          : (
            <span class="muted">
              no process runs this yet: start(where, path) starts one, as programs/name
            </span>
          )}
      </div>
      <PartEditor id={id} part="compute" code={v.compute} steps={steps} />
      {v.effect !== undefined
        ? <PartEditor id={id} part="effect" code={v.effect} steps={steps} />
        : (
          <div class="hint">
            no effect: a process running it is a derived value.{" "}
            <a
              onClick={() =>
                act(
                  `set(${J(id)}, [], "effect", ${J(steps ? [] : EFFECT)})`,
                  "inspector: an effect",
                )}
            >
              add one
            </a>
          </div>
        )}
      <div class="row-actions">
        <span class="hint">
          {live.value
            ? "live: each pause writes the part. a process keeps the program it started with, and shows newer"
            : "⌘↵ · a process keeps the program it started with, and shows newer"}
        </span>
        <a onClick={() => (dock.value = "make")}>what can programs use?</a>
      </div>
    </Section>
  );
}

const EFFECT = `import { h, screen } from "demo"
export default function ({ self, value }) {
  screen(self).replaceChildren(h("pre", {}, JSON.stringify(value, null, 1)))
}`;

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
                    onClick={() => (focus.value = { t: "change", ref: e.change.time })}
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
                    onClick={() =>
                      e.record.run !== undefined && (focus.value = {
                        t: "record",
                        process: e.record.process,
                        run: e.record.run,
                      })}
                  >
                    <span class="t">▷</span>
                    <span>
                      {e.record.run !== undefined ? `record #${e.record.run}` : "a handler call"}
                    </span>
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
