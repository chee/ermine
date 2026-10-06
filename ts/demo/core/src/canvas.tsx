/// <reference lib="dom" />
// The canvas: the graph exploded. Every node is a card, laid out as a tree
// from the root by placement. Edges show what holds what, which programs a
// process runs, what each process's last run read and what it wrote. When a
// change marks a process, a spark runs from the node to the process; when a
// process writes, from the process to the node.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Change, Id, Json, Record as Run } from "../../../src/mod.ts";
import { Agent, Ending, Json as JsonView, peek } from "./bits.tsx";
import { explode, focus, select, selected, world } from "./state.ts";
import { type Entry, ROOT } from "./world.ts";

const W = 184;
const H = 58;
const COL = 250;
const ROW = 74;

type Kind = "place" | "program" | "read" | "write" | "process";
type Edge = { from: Id; to: Id; kind: Kind; label?: string };
type Spark = { n: number; from: Id; to: Id; kind: "mark" | "write" | "outside" };
type Layers = { [k in Kind]: boolean } & { sparks: boolean };

/** Tidy-ish tree layout by placement: depth across, leaves down. */
function layout(): {
  at: Map<Id, { x: number; y: number }>;
  edges: Edge[];
  unreachable: Id[];
} {
  const at = new Map<Id, { x: number; y: number }>();
  const edges: Edge[] = [];
  const children = new Map<Id, { name: string; id: Id }[]>();
  for (const parent of world.made.keys()) {
    const d = world.bare.directory({ agent: "host", node: parent });
    if (!("directory" in d)) continue;
    const list: { name: string; id: Id }[] = [];
    for (const [name, ids] of d.directory) {
      for (const id of ids) {
        list.push({ name, id });
        const program = name === "compute" || name === "effect";
        const process = world.isProcess(id) && (parent === ROOT || world.isProcess(parent));
        edges.push({
          from: parent,
          to: id,
          kind: program ? "program" : process ? "process" : "place",
          label: name,
        });
      }
    }
    // programs last, so a process's own tree reads first
    list.sort((a, b) =>
      Number(a.name === "compute" || a.name === "effect") -
      Number(b.name === "compute" || b.name === "effect")
    );
    children.set(parent, list);
  }
  let row = 0;
  const fresh = (id: Id, seen: Set<Id>) =>
    (children.get(id) ?? []).filter((k) => !seen.has(k.id) && world.made.has(k.id));
  // a node's children that hold nothing new are packed three across, so a
  // folder of many leaves is a block, not a long column
  const ACROSS = 3;
  const place = (id: Id, depth: number, seen: Set<Id>): number => {
    seen.add(id);
    const kids = fresh(id, seen);
    const ys: number[] = [];
    const leaves: Id[] = [];
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      if (fresh(k.id, new Set([...seen, k.id])).length === 0) {
        seen.add(k.id);
        leaves.push(k.id);
      } else ys.push(place(k.id, depth + 1, seen));
    }
    if (leaves.length) {
      const top = row;
      leaves.forEach((leaf, i) => {
        const y = (top + Math.floor(i / ACROSS)) * ROW;
        at.set(leaf, { x: (depth + 1) * COL + (i % ACROSS) * (W + 18), y });
        if (i % ACROSS === 0) ys.push(y);
      });
      row += Math.ceil(leaves.length / ACROSS);
    }
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : row++ * ROW;
    at.set(id, { x: depth * COL, y });
    return y;
  };
  const seen = new Set<Id>();
  if (world.made.has(ROOT)) place(ROOT, 0, seen);
  const unreachable = [...world.made.keys()].filter((id) => !seen.has(id));
  let maxX = 0;
  for (const p of at.values()) maxX = Math.max(maxX, p.x);
  for (const id of unreachable) {
    if (seen.has(id)) continue;
    const depth = maxX / COL + 1.6;
    place(id, depth, seen);
  }

  // what processes did in their last runs, and by their lasting interfaces
  for (const [p, runs] of world.records) {
    const last = runs[runs.length - 1];
    if (!last) continue;
    const read = new Set(last.reads.map((r) => r.node));
    for (const l of last.lookups) for (const f of l.found) read.add(f);
    for (const n of read) if (n !== p) edges.push({ from: p, to: n, kind: "read" });
  }
  const wrote = new Set<string>();
  for (const e of world.log) {
    if (e.t !== "change" || !e.change.process || e.change.node === e.change.process) continue;
    const k = `${e.change.process}>${e.change.node}`;
    if (wrote.has(k)) continue;
    wrote.add(k);
    edges.push({ from: e.change.process, to: e.change.node, kind: "write" });
  }
  return { at, edges, unreachable };
}

function kindOf(id: Id): string {
  if (world.isProcess(id)) return "process";
  const where = world.placements().get(id) ?? [];
  if (where.some((p) => p.name === "compute" || p.name === "effect")) return "program";
  const r = world.bare.read({ agent: "host", node: id });
  const v = "value" in r ? r.value : undefined;
  if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
    return "folder";
  }
  return "data";
}

export function Canvas() {
  world.version.value;
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 60, y: 60, k: 0.85 });
  const [pinned, setPinned] = useState<Map<Id, { x: number; y: number }>>(new Map());
  const [hover, setHover] = useState<Id>();
  const [layers, setLayers] = useState<Layers>({
    place: true,
    process: true,
    program: true,
    read: true,
    write: true,
    sparks: true,
  });
  const [sparks, setSparks] = useState<Spark[]>([]);
  const seenLog = useRef(world.log.length ? world.log[world.log.length - 1].n : 0);
  const drag = useRef<
    | { t: "pan"; x: number; y: number; vx: number; vy: number }
    | { t: "card"; id: Id; x: number; y: number; ox: number; oy: number; moved: boolean }
    | undefined
  >(undefined);
  const fitted = useRef(false);

  const { at: auto, edges, unreachable } = layout();
  const pos = (id: Id) => pinned.get(id) ?? auto.get(id) ?? { x: 0, y: 0 };
  const running = world.running();

  // sparks from what happened since the last render
  useEffect(() => {
    const fresh: Spark[] = [];
    for (const e of world.log) {
      if (e.n <= seenLog.current) continue;
      if (e.t === "record") {
        for (const m of e.record.marked) {
          if (m.node !== e.record.process) {
            fresh.push({
              n: e.n * 100 + fresh.length,
              from: m.node,
              to: e.record.process,
              kind: "mark",
            });
          }
        }
      }
      if (e.t === "change" && e.change.process && e.change.node !== e.change.process) {
        fresh.push({
          n: e.n * 100 + fresh.length,
          from: e.change.process,
          to: e.change.node,
          kind: "write",
        });
      }
      if (e.t === "change" && !e.change.process) {
        fresh.push({
          n: e.n * 100 + fresh.length,
          from: e.change.node,
          to: e.change.node,
          kind: "outside",
        });
      }
    }
    if (world.log.length) seenLog.current = world.log[world.log.length - 1].n;
    if (!fresh.length) return;
    setSparks((s) => [...s, ...fresh].slice(-80));
    const t = setTimeout(() => {
      const gone = new Set(fresh.map((f) => f.n));
      setSparks((s) => s.filter((x) => !gone.has(x.n)));
    }, 1300);
    return () => clearTimeout(t);
  }, [world.version.value]);

  const fit = () => {
    const el = host.current;
    if (!el || auto.size === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of world.made.keys()) {
      const p = pos(id);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + W);
      y1 = Math.max(y1, p.y + H);
    }
    const r = el.getBoundingClientRect();
    // never smaller than readable; a graph taller than that starts at its top
    const k = Math.max(
      0.55,
      Math.min(1.1, Math.min((r.width - 80) / (x1 - x0), (r.height - 80) / (y1 - y0))),
    );
    const tall = (y1 - y0) * k > r.height - 40;
    setView({
      k,
      x: Math.max(40 - x0 * k, (r.width - (x1 - x0) * k) / 2 - x0 * k),
      y: tall ? 40 - y0 * k : (r.height - (y1 - y0) * k) / 2 - y0 * k,
    });
  };
  useLayoutEffect(() => {
    if (!fitted.current && auto.size) {
      fitted.current = true;
      fit();
    }
  });

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = host.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2 && !e.shiftKey) {
      const k = Math.max(0.2, Math.min(2.6, view.k * Math.exp(-e.deltaY * 0.0022)));
      setView({ k, x: mx - (mx - view.x) * (k / view.k), y: my - (my - view.y) * (k / view.k) });
    } else {
      setView({ ...view, x: view.x - e.deltaX, y: view.y - e.deltaY });
    }
  };
  useEffect(() => {
    const el = host.current!;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onDown = (e: PointerEvent) => {
    const card = (e.target as HTMLElement).closest("[data-card]") as HTMLElement | null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (card) {
      const id = card.dataset.card!;
      const p = pos(id);
      drag.current = { t: "card", id, x: e.clientX, y: e.clientY, ox: p.x, oy: p.y, moved: false };
    } else {
      drag.current = { t: "pan", x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    }
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.t === "pan") {
      setView({ ...view, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
    } else {
      const dx = (e.clientX - d.x) / view.k, dy = (e.clientY - d.y) / view.k;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) setPinned(new Map(pinned).set(d.id, { x: d.ox + dx, y: d.oy + dy }));
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (d?.t === "card" && !d.moved) select(d.id, routeTo(d.id));
  };

  const sel = selected.value?.id;
  // hovering isolates a node: its edges and neighbours stay, the rest fade;
  // the selected node's edges are drawn stronger
  const near = hover;
  const touches = (e: Edge) => !near || e.from === near || e.to === near;
  const mine = (e: Edge) => sel !== undefined && (e.from === sel || e.to === sel);
  const shown = edges.filter((e) => layers[e.kind]);
  const curve = (a: Id, b: Id) => {
    const p = pos(a), q = pos(b);
    const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2;
    if (a === b) return `M ${p.x + W / 2} ${p.y} m -14 0 a 14 14 0 1 0 28 0 a 14 14 0 1 0 -28 0`;
    if (x2 < x1 - 20) {
      // backwards: loop out and come round, so it does not cross the card
      const bx = x2 - 30, ax = x1 + 30, my = (y1 + y2) / 2 + (y2 > y1 ? 30 : -30);
      return `M ${x1} ${y1} C ${ax} ${y1}, ${ax} ${my}, ${
        (x1 + x2) / 2
      } ${my} S ${bx} ${y2}, ${x2} ${y2}`;
    }
    const dx = Math.max(50, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };
  let uy = Infinity, ux = 0;
  for (const id of unreachable) {
    const p = pos(id);
    uy = Math.min(uy, p.y);
    ux = p.x;
  }

  return (
    <div class="canvas pane">
      <div class="canvas-bar">
        <span class="pane-title">the graph, exploded</span>
        <div class="layer-toggles">
          {([
            ["place", "holds"],
            ["process", "runs"],
            ["program", "programs"],
            ["read", "reads"],
            ["write", "writes"],
            ["sparks", "sparks"],
          ] as [keyof Layers, string][]).map(([k, label]) => (
            <button
              type="button"
              class={`layer l-${k}${layers[k] ? " on" : ""}`}
              onClick={() => setLayers({ ...layers, [k]: !layers[k] })}
            >
              <i />
              {label}
            </button>
          ))}
        </div>
        <button type="button" class="mini" onClick={fit}>fit</button>
        <button type="button" class="mini" onClick={() => setPinned(new Map())}>re-lay out</button>
        <button type="button" class="mini" onClick={() => (explode.value = false)}>gather ✕</button>
      </div>
      <div
        class="canvas-host"
        ref={host}
        onPointerDown={onDown as never}
        onPointerMove={onMove as never}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div
          class="canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          {unreachable.length
            ? (
              <div class="unreach-zone" style={{ left: `${ux - 20}px`, top: `${uy - 40}px` }}>
                unreachable — removed, by CORE.tex
              </div>
            )
            : null}
          <svg class="edges" width="1" height="1">
            <defs>
              {(["place", "process", "program", "read", "write"] as Kind[]).map((k) => (
                <marker
                  id={`arrow-${k}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" class={`ah ah-${k}`} />
                </marker>
              ))}
            </defs>
            {shown.map((e) => (
              <g
                class={`edge e-${e.kind}${touches(e) ? "" : " faint"}`}
                key={`${e.kind}${e.from}>${e.to}${e.label}`}
              >
                <path d={curve(e.from, e.to)} marker-end={`url(#arrow-${e.kind})`} />
                {e.label && (e.kind === "place" || e.kind === "program" || e.kind === "process") &&
                    e.label !== e.to
                  ? (
                    <text
                      x={(pos(e.from).x + W + pos(e.to).x) / 2}
                      y={(pos(e.from).y + pos(e.to).y) / 2 + H / 2 - 5}
                      class="edge-label"
                    >
                      {e.label}
                    </text>
                  )
                  : null}
              </g>
            ))}
            {layers.sparks
              ? sparks.map((s) => (
                <path
                  key={s.n}
                  class={`spark s-${s.kind}`}
                  d={curve(s.from, s.to)}
                  pathLength={100}
                />
              ))
              : null}
          </svg>
          {[...world.made.keys()].map((id) => {
            const p = pos(id);
            const kind = kindOf(id);
            const r = world.bare.read({ agent: "host", node: id });
            const v: Json | undefined = "value" in r ? r.value : undefined;
            const runs = world.records.get(id);
            const last = runs?.[runs.length - 1];
            const latest = world.latest.get(id) ?? 0;
            const lit = sparks.some((s) => s.to === id);
            return (
              <div
                key={id}
                data-card={id}
                class={`card k-${kind}${sel === id ? " sel" : ""}${hover === id ? " hov" : ""}${
                  running.has(id) ? " running" : ""
                }${lit ? " lit" : ""}${
                  near && near !== id &&
                    !edges.some((e) =>
                      (e.from === near && e.to === id) || (e.to === near && e.from === id)
                    )
                    ? " dim"
                    : ""
                }`}
                style={{ left: `${p.x}px`, top: `${p.y}px`, width: `${W}px`, height: `${H}px` }}
                onPointerEnter={() => setHover(id)}
                onPointerLeave={() => setHover(undefined)}
              >
                <div class="card-top">
                  <span class="card-kind">
                    {kind === "process"
                      ? (running.has(id) ? "◉" : "○")
                      : kind === "program"
                      ? "λ"
                      : kind === "folder"
                      ? "▤"
                      : "◆"}
                  </span>
                  <span class="card-id">{id}</span>
                  {last ? <Ending ending={last.ending} /> : null}
                </div>
                <div class="card-peek">
                  {kind === "program"
                    ? (typeof v === "string" ? v.trim().split("\n")[0] : "steps")
                    : kind === "folder"
                    ? `${(world.directory(id) as [string, Id[]][] | undefined)?.length ?? 0} names`
                    : peek(v, 40)}
                </div>
                <span class="card-time" key={latest}>@{latest}</span>
              </div>
            );
          })}
        </div>
        <Legend />
        {sel && world.made.has(sel) ? <Detail id={sel} /> : null}
      </div>
    </div>
  );
}

/** The route from the root to a node by first placements, for lookups from it. */
function routeTo(id: Id) {
  const where = world.placements();
  const route: { parent: Id; name: string; node: Id }[] = [];
  let at = id;
  const seen = new Set<Id>();
  while (at !== ROOT && !seen.has(at)) {
    seen.add(at);
    const p = (where.get(at) ?? []).find((x) => x.name !== "compute" && x.name !== "effect") ??
      where.get(at)?.[0];
    if (!p) return [];
    route.unshift({ parent: p.parent, name: p.name, node: at });
    at = p.parent;
  }
  return at === ROOT ? route : [];
}

function Legend() {
  world.version.value;
  return (
    <details class="legend-card" onPointerDown={(e) => e.stopPropagation()}>
      <summary>legend</summary>
      <div>
        <i class="sw l-place" /> a directory holds a node
      </div>
      <div>
        <i class="sw l-process" /> placing a process under one runs it
      </div>
      <div>
        <i class="sw l-program" /> a process's compute and effect
      </div>
      <div>
        <i class="sw l-read" /> its last run read this
      </div>
      <div>
        <i class="sw l-write" /> it wrote this
      </div>
      <div>
        <i class="sw l-mark" /> a spark: a change marked a process
      </div>
      <div class="muted">drag to pan · wheel to zoom · drag cards · hover to isolate</div>
    </details>
  );
}

function Detail({ id }: { id: Id }) {
  world.version.value;
  const r = world.bare.read({ agent: "host", node: id });
  const runs: Run[] = world.records.get(id) ?? [];
  const last = runs[runs.length - 1];
  const changes = world.log.filter((e): e is Entry & { t: "change" } =>
    e.t === "change" && e.change.node === id
  ).map((e) => e.change as Change);
  const lastChange = changes[changes.length - 1];
  return (
    <div class="detail" onPointerDown={(e) => e.stopPropagation()}>
      <div class="detail-head">
        <b>{id}</b>
        <span class="muted">{kindOf(id)}</span>
      </div>
      <div class="value-view small">
        <JsonView value={"value" in r ? r.value : undefined} />
      </div>
      {lastChange
        ? (
          <div class="detail-row">
            last changed @{lastChange.time} by <Agent agent={lastChange.agent} />
            {lastChange.process ? <span class="via">◉ {lastChange.process}</span> : null}
          </div>
        )
        : null}
      {last
        ? (
          <div class="detail-row">
            run #{last.run} <Ending ending={last.ending} /> read {last.reads.length}, looked up{" "}
            {last.lookups.length}
          </div>
        )
        : null}
      <div class="row-actions">
        <button
          type="button"
          class="primary"
          onClick={() => {
            explode.value = false;
          }}
        >
          inspect
        </button>
        {lastChange
          ? (
            <button type="button" onClick={() => (focus.value = { t: "change", ref: lastChange })}>
              why this value?
            </button>
          )
          : null}
        {last
          ? (
            <button
              type="button"
              onClick={() => (focus.value = { t: "record", process: id, run: last.run })}
            >
              last run
            </button>
          )
          : null}
      </div>
    </div>
  );
}
