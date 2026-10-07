// The why panel: from a pixel to the node that holds it, the process that
// placed that node, its last run, and what the run wrote. Every line is a
// read made now, a record finish returned, or a change the tap saw.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  type Change,
  type HandlerRecord,
  type Id,
  type Identity,
  isLive,
  type Item,
  type ProcessItem,
  type Record,
} from "d2/ermine";
import { isObject, isPid, type Json } from "./stack.ts";
import * as act from "./actions.ts";
import {
  Agent,
  Cause,
  Deck,
  HeaderLine,
  Layer,
  Path,
  selectProcess,
  short,
  ui,
  Value,
  world as w,
} from "./view.tsx";
import { Editor } from "./editor.tsx";

const ups = (k: number) => Array.from({ length: k }, () => "..");

/** A read as the host, beneath protect: untracked, kept by no one. */
function peek(place: string[], address: string[]): Item[] {
  try {
    return w.tap.read({ agent: "host", place, address });
  } catch {
    return [];
  }
}

/** A read through the top, so a process node gives its own items in front. */
function look(path: string[]): (Item | ProcessItem)[] {
  try {
    return w.s.read({ agent: "host", address: path }) as unknown as (Item | ProcessItem)[];
  } catch {
    return [];
  }
}

const nodeAt = (place: string[], address: string[]) => {
  try {
    return w.tap.reach?.({ agent: "host", place, address }).node;
  } catch {
    return undefined;
  }
};

/** Where a process was placed: the node its start placed it in. */
const placeOf = (pid: Id) => {
  const start = w.started.get(pid);
  return start ? w.pathOf(start.node) : undefined;
};

const lineAt = (time: number) => w.lines.find((l) => l.change.time === time);

function ChangeRow({ change }: { change: Change }) {
  const line = lineAt(change.time);
  const at = line?.at;
  const what = change.kind === "write"
    ? "✎"
    : change.kind === "place"
    ? "+"
    : isObject(change.cause) && "killed" in change.cause
    ? "release"
    : "−";
  return (
    <li class="change">
      <span class="sym">{what}</span>
      <Path path={change.kind === "write" ? at : at && [...at, change.name]} id={change.node} />
      <HeaderLine change={change} />
    </li>
  );
}

function Times({ times }: { times: readonly number[] }) {
  if (!times.length) return <span class="muted">none</span>;
  return (
    <ul class="changes">
      {times.map((t) => {
        const line = lineAt(t);
        return line ? <ChangeRow key={t} change={line.change} /> : (
          <li key={t} class="muted">
            t={t} (not among the changes this page has seen: the graph keeps no log)
          </li>
        );
      })}
    </ul>
  );
}

/** One search re-read now, a rung per directory, nearest first, against what the process kept. */
function Ladder({ place, path, kept, label }: {
  v: number;
  place: string[];
  path: string[];
  kept?: Identity;
  label: string;
}) {
  let found = false;
  const rungs = [];
  for (let k = 0; k <= place.length; k++) {
    const address = [...ups(k), ...path];
    const dir = nodeAt(place, ups(k));
    let mark: Json = "none";
    let hit: Item | undefined;
    if (!found) {
      hit = peek(place, address).find((i) => "value" in i);
      if (hit) {
        found = true;
        const route = (hit as unknown as { from: { route: readonly { node: Id }[] } }).from.route;
        const node = route[route.length - 1]?.node;
        const time = (hit as { change?: { time: number } }).change?.time ?? 0;
        mark = kept && kept.node === node && kept.time === time ? "✓ kept" : `✓ ${node} @${time}`;
        if (kept && !(kept.node === node && kept.time === time)) mark += " · differs from kept";
      }
    } else mark = "not searched";
    rungs.push(
      <li
        key={k}
        class={`rung ${hit ? "hit" : ""} ${mark === "not searched" ? "skip" : ""}`}
        onMouseEnter={() => (ui.lit.value = dir)}
        onMouseLeave={() => (ui.lit.value = undefined)}
      >
        <code>{address.join("/")}</code>
        <span class="in">in {dir ? <Path path={w.pathOf(dir)} id={dir} /> : "?"}</span>
        <span class="mark">{String(mark)}</span>
      </li>,
    );
  }
  return (
    <div class="ladder">
      <div class="ladder-head">
        {label} <span class="muted">· re-read now by the host, untracked</span>
      </div>
      <ol>{rungs}</ol>
    </div>
  );
}

/** A lookup from a record: its rungs as recorded, and the slot it found, read now as a deck. */
function LookupView({ place, lookup }: {
  v: number;
  place: string[];
  lookup: Record["lookups"][number];
}) {
  const last = lookup.searched[lookup.searched.length - 1];
  const foundAt = lookup.found.length ? lookup.searched.length - 1 : -1;
  const address = foundAt >= 0 ? [...ups(foundAt), lookup.name] : undefined;
  const items = address ? peek(place, address) : [];
  const parent = last && w.pathOf(last.node);
  const [step, setStep] = useState(-1);
  return (
    <div class="lookup">
      <div class="lookup-head">
        lookup <b>{lookup.name}</b>
        <button
          type="button"
          class="small"
          onClick={() => {
            // the climb, one rung at a time, lit on the map and the stage
            let k = 0;
            const tick = () => {
              if (k >= lookup.searched.length) {
                setStep(-1);
                ui.lit.value = undefined;
                return;
              }
              setStep(k);
              ui.lit.value = lookup.searched[k].node;
              k++;
              setTimeout(tick, 650);
            };
            tick();
          }}
        >
          climb
        </button>
      </div>
      <ol class="rungs">
        {lookup.searched.map((s, k) => (
          <li
            key={k}
            class={`rung ${k === step ? "lit" : ""} ${"refused" in s ? "refused" : ""} ${
              k === foundAt ? "hit" : ""
            }`}
            onMouseEnter={() => (ui.lit.value = s.node)}
            onMouseLeave={() => (ui.lit.value = undefined)}
          >
            <code>{[...ups(k), lookup.name].join("/")}</code>
            <span class="in">
              in <Path path={w.pathOf(s.node)} id={s.node} />
            </span>
            <span class="mark">
              {"refused" in s
                ? "refused (something farther up was not searched)"
                : k === foundAt
                ? `✓ found, ${
                  s.saw === null ? "its slot's changes were all ephemeral" : `saw t=${s.saw}`
                }`
                : s.saw === null
                ? "none"
                : `none, saw t=${s.saw}`}
            </span>
          </li>
        ))}
      </ol>
      {address && (
        <Deck
          items={items}
          actions={(item, i) =>
            // a live or ephemeral member is the process's own: it is not moved or copied
            !("value" in item) || item.ephemeral || isLive(item.value) ? null : i > 0 && parent
              ? (
                <button
                  type="button"
                  class="small"
                  onClick={() => {
                    const route = item.from.route;
                    act.front(w, parent, lookup.name, route[route.length - 1].node);
                  }}
                >
                  front
                </button>
              )
              : i === 0 && foundAt > 0
              ? (
                <button
                  type="button"
                  class="small"
                  title={`read ${
                    address.join("/")
                  } as ${w.actor}, and place a copy in the directory the process runs in`}
                  onClick={() => act.nearer(w, place, lookup.name, address)}
                >
                  place {lookup.name} nearer
                </button>
              )
              : null}
        />
      )}
    </div>
  );
}

function ReadView({ place, read }: { v: number; place: string[]; read: Record["reads"][number] }) {
  const items = read.op === "read" ? peek(place, [...read.address]) : [];
  let names: string[] = [];
  if (read.op === "directory") {
    try {
      const got = w.tap.directory({
        agent: "host",
        place,
        address: [...read.address],
        ...(read.name ? { name: read.name } : {}),
      });
      names = "directory" in got ? got.directory.map(([n]) => n) : got.items.map((i) => i.id);
    } catch { /* gone */ }
  }
  const nowSaw = items.find((i) => "change" in i) as { change?: { time: number } } | undefined;
  const stale = read.op === "read" && nowSaw?.change && read.saw !== null &&
    nowSaw.change.time !== read.saw;
  return (
    <div class={`read ${read.refused ? "refused" : ""}`}>
      <div class="read-head">
        {read.op} <code>{read.address.join("/") || "."}</code>
        {read.name && <span>name {read.name}</span>}
        <span class="muted">
          · saw {read.saw === null ? "nothing" : `t=${read.saw}`}
          {read.refused && " · refused"}
          {stale && " · changed since"}
        </span>
      </div>
      {read.op === "read" ? <Deck items={items} /> : <div class="names">{names.join(" · ")}</div>}
    </div>
  );
}

function ProgramEditor({ program, onDone }: { program: Id; onDone: () => void }) {
  const path = w.pathOf(program);
  const value = path ? peek([], path)[0] : undefined;
  const v = value && "value" in value
    ? value.value as { kind?: string; compute?: Json }
    : undefined;
  if (!v) return <p class="muted">the program is not reachable</p>;
  const isJs = v.kind === "js" && typeof v.compute === "string";
  const doc = isJs ? v.compute as string : JSON.stringify(v, null, 2);
  return (
    <div class="editor-wrap">
      <div class="muted">
        <Path path={path} /> · {isJs ? "one module: compute and effect" : `kind ${v.kind}, data`}
        {" "}
        · saving writes the program node; running processes keep their code and show ↑ newer
      </div>
      <Editor
        doc={doc}
        json={!isJs}
        onSave={(text) => {
          if (isJs) act.editProgram(w, program, text);
          else {
            try {
              act.editProgram(w, program, JSON.parse(text));
            } catch (e) {
              alert(`not JSON: ${(e as Error).message}`);
              return;
            }
          }
          onDone();
        }}
      />
    </div>
  );
}

function ProcessLayers({ pid, n, v }: { pid: Id; n: number; v: number }) {
  const [editing, setEditing] = useState(false);
  const [which, setWhich] = useState<number | undefined>(undefined);
  const place = placeOf(pid);
  const path = place ? [...place, pid] : undefined;
  const items = path ? look(path) : [];
  const records = w.records.get(pid) ?? [];
  const record = which === undefined
    ? records[records.length - 1]
    : records.find((r) => r.run === which);
  const start = w.started.get(pid);
  const program = (record ?? records.find((r) => r.program))?.program as Identity | undefined;
  const programPath = program ? act.programPath(w, program.node) : undefined;
  const programValue = program ? peek([], w.pathOf(program.node) ?? [])[0] : undefined;
  const kind = programValue && "value" in programValue && isObject(programValue.value)
    ? String(programValue.value.kind)
    : undefined;
  const handlers: HandlerRecord[] = w.handlers.get(pid) ?? [];
  const handler = handlers[handlers.length - 1];
  const starter = isObject(start?.agent) && Array.isArray(start.agent.code)
    ? start.agent.code[start.agent.code.length - 1]
    : undefined;
  const newer = items.find((i) => "newer" in i);
  return (
    <>
      <Layer
        n={n}
        title={
          <>
            process <b>{pid}</b>
          </>
        }
      >
        <div class="kv">
          <span>at</span>
          {path ? <Path path={path} /> : <span class="gone">unplaced: killed</span>}
          <span>started by</span>
          <span>{start ? <HeaderLine change={start as never} /> : "?"}</span>
          {starter && (
            <>
              <span>child of</span>
              <span>
                <button
                  type="button"
                  class="chip proc"
                  onClick={() => selectProcess(String((starter as { process: string }).process))}
                >
                  {String((starter as { process: string }).process)}
                </button>
              </span>
            </>
          )}
          <span>acts as</span>
          <span>{record ? <Agent agent={record.agent} /> : "?"}</span>
          <span>program</span>
          <span>
            {program
              ? (
                <>
                  <code>{JSON.stringify(program)}</code> from{" "}
                  <Path path={w.pathOf(program.node)} id={program.node} />
                  {kind && (
                    <>
                      · kind <b>{kind}</b>
                    </>
                  )}
                </>
              )
              : "?"}
          </span>
        </div>
        <div class="muted small-note">
          reading the process node gives its own items in front of its value:
        </div>
        <Deck items={items} />
        {place && programPath && (
          <Ladder
            v={v}
            place={place}
            path={programPath}
            kept={program}
            label={`program search: ${programPath.join("/")}`}
          />
        )}
        {place && kind && (
          <Ladder
            v={v}
            place={place}
            path={["loaders", kind]}
            label={`loader search: loaders/${kind}`}
          />
        )}
        <div class="actions">
          {path && program && (
            <button
              type="button"
              onClick={() => {
                const started = act.restart(w, pid, program.node);
                if (started?.change.kind === "place") {
                  ui.selected.value = { node: started.change.id };
                }
              }}
              class={newer ? "go" : ""}
            >
              restart{newer ? " (takes up ↑ newer)" : ""}
            </button>
          )}
          {path && <button type="button" onClick={() => act.kill(w, pid)}>unplace (kill)</button>}
          {program && (
            <button type="button" onClick={() => setEditing(!editing)}>
              {editing ? "close editor" : "edit program"}
            </button>
          )}
          {path && place && kind === "js" && place[place.length - 2] === "cards" && (
            <button
              type="button"
              title="place this card's node again under another name: two processes, one node"
              onClick={() => {
                const cards = place.slice(0, -1);
                const id = start!.node;
                const name = `${place[place.length - 1]}-again`;
                act.twice(w, cards, id, name);
              }}
            >
              show twice
            </button>
          )}
          {path && place && place[place.length - 1] === "hush" && (
            <button
              type="button"
              onClick={() => {
                const started = act.startHere(w, place, ["programs", "hush"]);
                if (started?.change.kind === "place") {
                  ui.selected.value = { node: started.change.id };
                }
              }}
            >
              start here as {w.actor}
            </button>
          )}
        </div>
        {editing && program && (
          <ProgramEditor
            program={program.node}
            onDone={() => setEditing(false)}
          />
        )}
      </Layer>
      <Layer
        n={n + 1}
        title={record
          ? (
            <>
              run {record.run} · <span class={`ending ${record.ending}`}>{record.ending}</span>
              {records.length > 1 && (
                <span class="runs">
                  {records.map((r) => (
                    <button
                      type="button"
                      key={r.run}
                      class={`small ${r === record ? "on" : ""}`}
                      onClick={() => setWhich(r.run)}
                    >
                      {r.run}
                    </button>
                  ))}
                </span>
              )}
            </>
          )
          : "no run seen yet"}
      >
        {record && place && (
          <>
            <div class="sub">marked by</div>
            <Times times={record.marked} />
            {record.lookups.map((l, i) => <LookupView key={i} v={v} place={place} lookup={l} />)}
            {record.reads.map((r, i) => <ReadView key={i} v={v} place={place} read={r} />)}
            {record.errors.length > 0 && (
              <div class="errors">
                {record.errors.map((e, i) => (
                  <div key={i} class="error">✕ {e.kind}: {e.why.code} {e.why.text ?? ""}</div>
                ))}
              </div>
            )}
          </>
        )}
      </Layer>
      <Layer n={n + 2} title="what it wrote">
        {record
          ? <Times times={[...record.cleanup, ...record.changes]} />
          : <span class="muted">nothing yet</span>}
        <p class="muted small-note">
          What an effect does to the page (making elements, drawing on a canvas) is not a change in
          the graph; only what it places and writes is.
        </p>
        {handler && (
          <div class="handler">
            <div class="sub">
              last handler call:{" "}
              {String((handler.agent as { code: { handler?: string }[] }).code.at(-1)?.handler)} ·
              {" "}
              {handler.ending}
            </div>
            <Agent agent={handler.agent} />
            <Times times={handler.changes} />
            {handler.errors.map((e, i) => (
              <div key={i} class="error">
                ✕ {e.kind}: {e.why.code}
                {e.why.rule ? ` · rule ${e.why.rule}` : ""} {e.why.text ?? ""}
              </div>
            ))}
          </div>
        )}
      </Layer>
    </>
  );
}

function NodeLayer({ id, n }: { id: Id; n: number; v: number }) {
  const path = w.pathOf(id);
  const items = path ? look(path) : [];
  const made = w.made.get(id);
  const live = w.ephemeral.get(id);
  let names: [string, number][] = [];
  if (path) {
    try {
      const got = w.tap.directory({ agent: "host", address: path });
      if ("directory" in got) names = got.directory.map(([name, its]) => [name, its.length]);
    } catch { /* gone */ }
  }
  return (
    <Layer
      n={n}
      title={live !== undefined
        ? (
          <>
            pixel · <b>{short(id)}</b>
          </>
        )
        : (
          <>
            node <b>{short(id)}</b>
          </>
        )}
    >
      <div class="kv">
        <span>path</span>
        <Path path={path} id={id} />
        {w.ephemeral.has(id) && (
          <>
            <span>kept?</span>
            <span>ephemeral: never kept; a reload makes a new one with a new id</span>
          </>
        )}
        {made && (
          <>
            <span>made by</span>
            <HeaderLine change={made as never} />
          </>
        )}
      </div>
      <Deck items={items} />
      {path?.length === 1 && path[0] === "rules" && (
        <p class="muted small-note">
          protect reads these on every operation, the first rule whose fields all match winning.
          Changing them takes effect at the next operation, and marks no one: a run refused before
          runs again only when something it read changes.
        </p>
      )}
      {names.length > 0 && (
        <div class="names">
          {names.map(([name, count]) => (
            <button
              type="button"
              key={name}
              class="small"
              onClick={() => {
                const target = path && peek([], [...path, name])[0];
                const route = target && "from" in target &&
                  (target as { from: { route?: { node: Id }[] } }).from.route;
                const node = route && route[route.length - 1]?.node;
                if (node) ui.selected.value = { node };
              }}
            >
              {name}
              {count > 1 && <sup>{count}</sup>}
            </button>
          ))}
        </div>
      )}
    </Layer>
  );
}

/** v: the world's version, passed down so the panel draws again whenever the world changes */
export function WhyPanel({ v }: { v: number }) {
  const sel = ui.selected.value;
  if (!sel) {
    return (
      <div class="why-empty">
        <p>Click anything on the desk.</p>
        <p class="muted">
          Hold <kbd>Alt</kbd> for x-ray: dashed is what a reload does not bring back.
        </p>
        <p class="muted">
          Each answer here is a read made now, a record a run finished with, or a change as it was
          made. Nothing is remembered on the side.
        </p>
      </div>
    );
  }
  const id = sel.node;
  const placer = w.made.get(id)?.process;
  const pid = isPid(id) && w.started.has(id) ? id : placer;
  return (
    <div class="why">
      {pid !== id && <NodeLayer id={id} n={1} v={v} />}
      {pid && <ProcessLayers key={pid} pid={pid} n={pid !== id ? 2 : 1} v={v} />}
    </div>
  );
}

/** The site popover: the source line a change was made from, fetched from the file it names. */
export function SitePopover() {
  const site = ui.site.value;
  const [text, setText] = useState<string[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    setText(undefined);
    setError(undefined);
    if (!site) return;
    fetch(site.file).then((r) => r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))).then(
      (t) => setText(t.split("\n")),
      (e) => setError(String(e)),
    );
  }, [site?.file, site?.line, site?.column]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && (ui.site.value = undefined);
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, []);
  if (!site) return null;
  const from = Math.max(0, site.line - 3);
  return (
    <div class="popover-back" onClick={() => (ui.site.value = undefined)}>
      <div class="popover" ref={box} onClick={(e) => e.stopPropagation()}>
        <div class="popover-head">
          <code>{site.file}:{site.line}:{site.column}</code>
          <button type="button" class="small" onClick={() => (ui.site.value = undefined)}>
            close
          </button>
        </div>
        <p class="muted small-note">
          The site: where the call entered the stack, captured from the call stack. The first frame
          outside ermine's own files (ermine.js is built apart so that d2.js is outside it).
        </p>
        {error && <p class="error">could not fetch it: {error}</p>}
        {text && (
          <pre class="source">
            {text.slice(from, site.line + 2).map((l, i) => (
              <div key={i} class={from + i + 1 === site.line ? "hit" : ""}>
                <span class="ln">{from + i + 1}</span>
                {l}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

export { Cause, Value };
