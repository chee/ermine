/// <reference lib="dom" />
// The browser: the graph as directories, from the root down. A node placed in
// many slots shows in each. Program slots are dim; process nodes glow when
// the driver runs them.

import { useState } from "preact/hooks";
import type { Id, Json, Step } from "../../../src/mod.ts";
import { peek } from "./bits.tsx";
import { lit, select, selected, world } from "./state.ts";
import { ROOT } from "./world.ts";
import { dragData, drop, indexIn, readDrag } from "./dnd.ts";
import { palette } from "./palette.tsx";
import { askAt } from "./ask.tsx";

function kindOf(
  id: Id,
  value: Json | undefined,
  running: ReadonlyMap<Id, unknown>,
): { glyph: string; cls: string } {
  if (world.isProcess(id)) {
    return running.has(id) ? { glyph: "◉", cls: "k-run" } : { glyph: "○", cls: "k-proc" };
  }
  if (typeof value === "string" && isProgram(id)) return { glyph: "λ", cls: "k-prog" };
  if (Array.isArray(value) && isProgram(id)) return { glyph: "λ", cls: "k-prog" };
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    (value as { "@type"?: unknown })["@type"] === "llm"
  ) return { glyph: "✧", cls: "k-llm" };
  if (value === undefined) return { glyph: "·", cls: "k-absent" };
  if (Array.isArray(value)) return { glyph: "[]", cls: "k-list" };
  if (typeof value === "object" && value !== null) return { glyph: "{}", cls: "k-obj" };
  if (typeof value === "string") return { glyph: "“”", cls: "k-str" };
  if (typeof value === "number") return { glyph: "#", cls: "k-num" };
  return { glyph: "•", cls: "k-other" };
}

let programs = new Set<Id>();
function isProgram(id: Id) {
  return programs.has(id);
}

/** Every node beneath these, through every slot, from the host's copy, beneath protect. */
function reachable(from: Id[]): Set<Id> {
  const seen = new Set<Id>(from);
  const todo = [...from];
  while (todo.length) {
    for (const [, ids] of world.slotsOf(todo.pop()!)) {
      for (const id of ids) if (!seen.has(id)) seen.add(id), todo.push(id);
    }
  }
  return seen;
}

const rk = (route: Step[]) => route.map((s) => `${s.parent}/${s.name}/${s.node}`).join("|");

export function Browser() {
  world.version.value;
  const [open, setOpen] = useState<Set<string>>(() => new Set(["", rk([])]));
  const [filter, setFilter] = useState("");
  /** the node under the pointer: its other places light up too */
  const [twin, setTwin] = useState<Id>();
  const [over, setOver] = useState<{ k: string; at: "before" | "into" | "after" }>();
  const running = world.running();
  const where = world.placements();
  programs = new Set(
    [...where.entries()].filter(([, ps]) =>
      ps.some((p) => p.name === "compute" || p.name === "effect")
    )
      .map(([id]) => id),
  );
  const toggle = (k: string) => {
    const next = new Set(open);
    next.has(k) ? next.delete(k) : next.add(k);
    setOpen(next);
  };

  /** A slot's head, for a slot holding several ids: they are together, in order. */
  const slotHead = (parent: Id, slot: string, ids: Id[], depth: number, key: string) => (
    <div
      key={key}
      class={`row slot-head${over?.k === key ? " drop-into" : ""}`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      title={`${parent}'s slot ${slot}: ${ids.length} ids, in order. drop here to add to the end.`}
      onDragOver={(e) => {
        e.preventDefault();
        if (over?.k !== key) setOver({ k: key, at: "into" });
      }}
      onDragLeave={() => over?.k === key && setOver(undefined)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(undefined);
        const d = readDrag(e);
        if (!d) return;
        // a position is a gap in the slot as it is: the end, whether it moves within the slot or not
        const position = ids.length;
        drop(d.id, d.from, { parent, name: slot, position }, e.shiftKey || e.altKey);
      }}
    >
      <span class="caret none">▸</span>
      <span class="kind">⧉</span>
      <span class="slot-label">{slot}</span>
      <span class="slot-count">{ids.length} in order</span>
    </div>
  );

  const row = (
    id: Id,
    route: Step[],
    name: string | undefined,
    depth: number,
    trail: Set<Id>,
    /** its place in a slot that holds several, which its group's head names */
    index?: number,
  ) => {
    const k = rk(route);
    const r = world.read(id, route);
    const value = "value" in r ? r.value : undefined;
    const dir = world.directory(id, route);
    const slots = Array.isArray(dir) ? dir : [];
    const refused = "refused" in r || (dir && !Array.isArray(dir));
    const kind = kindOf(id, value, running);
    const isOpen = open.has(k) || (filter !== "" && depth < 6);
    const sel = selected.value?.id === id && rk(selected.value.route) === k;
    const latest = world.latest.get(id) ?? 0;
    const looped = trail.has(id);
    const dim = name === "compute" || name === "effect";
    const l = lit.value;
    const light = l?.found.includes(id)
      ? " lit-found"
      : l?.searched.includes(id)
      ? " lit-searched"
      : "";
    const matches = filter === "" ||
      id.toLowerCase().includes(filter.toLowerCase()) ||
      (name ?? "").toLowerCase().includes(filter.toLowerCase());
    // each slot: one id is a row; several are a group under the slot's name,
    // numbered in slot order, so what is together looks together
    const below = new Set([...trail, id]);
    const kids = !looped && isOpen
      ? slots.map(([slot, ids]) => {
        const step = (child: Id, position: number) => [
          ...route,
          { parent: id, name: slot, node: child, position },
        ];
        if (ids.length === 1) return row(ids[0], step(ids[0], 0), slot, depth + 1, below);
        const members = ids.map((child, i) =>
          row(child, step(child, i), slot, depth + 2, below, i)
        );
        if (!members.some((m) => m !== null)) return null;
        return (
          <div class="slot-group" key={`${k}#${slot}`}>
            {slotHead(id, slot, ids, depth + 1, `${k}#${slot}`)}
            {members}
          </div>
        );
      })
      : [];
    // what the process's last run read: the edges a process has besides its slots
    const reads = world.isProcess(id) && isOpen && !looped
      ? [
        ...new Set(
          (world.records.get(id)?.at(-1)?.reads ?? []).flatMap((r) => world.readNode(id, r) ?? []),
        ),
      ]
      : [];
    const anyKid = kids.some((x) => x !== null);
    if (!matches && !anyKid) return null;
    return (
      <div class="tree-node" key={k}>
        <div
          class={`row${sel ? " sel" : ""}${dim ? " dim" : ""}${light}${
            over?.k === k ? ` drop-${over.at}` : ""
          }${twin === id && (where.get(id)?.length ?? 0) > 1 ? " twin" : ""}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onPointerEnter={() => setTwin(id)}
          onPointerLeave={() => twin === id && setTwin(undefined)}
          onClick={() => select(id, route)}
          onContextMenu={(e) => {
            e.preventDefault();
            select(id, route);
            askAt.value = { id, route, x: e.clientX, y: e.clientY };
          }}
          title={route.length ? route.map((s) => s.name).join(" / ") : "root"}
          draggable={id !== ROOT}
          onDragStart={(e) => {
            const last = route[route.length - 1];
            dragData(e, id, last ? { parent: last.parent, name: last.name } : undefined);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const f = (e.clientY - r.top) / r.height;
            const inSlot = route.length > 0;
            const at = inSlot && f < 0.28 ? "before" : inSlot && f > 0.72 ? "after" : "into";
            e.dataTransfer!.dropEffect = e.shiftKey ? "copy" : "move";
            if (over?.k !== k || over.at !== at) setOver({ k, at });
          }}
          onDragLeave={() => over?.k === k && setOver(undefined)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(undefined);
            const d = readDrag(e);
            if (!d) return;
            // where in the row, from the drop itself: state may not have caught up
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const f = (e.clientY - r.top) / r.height;
            const inSlot = route.length > 0;
            const at = inSlot && f < 0.28 ? "before" : inSlot && f > 0.72 ? "after" : "into";
            if (at === "into") return drop(d.id, d.from, { into: id }, e.shiftKey || e.altKey);
            const step = route[route.length - 1];
            // a position is a gap in the slot as it is, so a move within the slot needs no
            // allowance for the id's old place: the graph takes it out after putting it in
            const position = indexIn(step.parent, step.name, id) + (at === "after" ? 1 : 0);
            drop(
              d.id,
              d.from,
              { parent: step.parent, name: step.name, position },
              e.shiftKey || e.altKey,
            );
          }}
        >
          <span
            class={`caret${slots.length && !looped ? "" : " none"}${isOpen ? " open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (slots.length) toggle(k);
            }}
          >
            ▸
          </span>
          <span class={`kind ${kind.cls}`}>{kind.glyph}</span>
          {index !== undefined ? <span class="pos">{index + 1}</span> : null}
          {index === undefined && name !== undefined && name !== id
            ? (
              <>
                <span class="slot-name">{name}</span>
                <span class="arrow">→</span>
              </>
            )
            : null}
          <span class="row-id">{id}</span>
          {(where.get(id)?.length ?? 0) > 1
            ? (
              <span
                class="places"
                title={`${id} is one node, placed in ${where.get(id)!.length} slots: ${
                  where.get(id)!.map((p) => `${p.parent}.${p.name}`).join(", ")
                }`}
              >
                ×{where.get(id)!.length}
              </span>
            )
            : null}
          {refused ? <span class="lock" title="protect refused a read">🔒</span> : null}
          {looped ? <span class="loop" title="placed beneath itself">↺</span> : null}
          <span class="row-peek">{kind.cls === "k-prog" ? "" : peek(value, 22)}</span>
          <button
            type="button"
            class="row-plus"
            title={`make something in ${id}`}
            onClick={(e) => {
              e.stopPropagation();
              select(id, route);
              palette.value = { context: { id, route }, only: "make in" };
            }}
          >
            ＋
          </button>
          <span class="pulse" key={latest} />
        </div>
        {kids.length || reads.length
          ? (
            <div class="tree-kids" style={{ "--guide": `${8 + depth * 14 + 5}px` }}>
              {kids}
              {reads.map((r) => (
                <div
                  key={`${k}~${r}`}
                  class={`row reads${selected.value?.id === r ? " sel" : ""}`}
                  style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
                  onClick={() => select(r, [])}
                  title={`${id}'s last run read ${r}`}
                >
                  <span class="caret none">▸</span>
                  <span class="kind">⇠</span>
                  <span class="slot-name">reads</span>
                  <span class="row-id">{r}</span>
                  {world.made.has(r) ? null : <span class="muted">absent</span>}
                </div>
              ))}
            </div>
          )
          : null}
      </div>
    );
  };

  const tree = world.made.has(ROOT) ? row(ROOT, [], undefined, 0, new Set()) : null;
  // what the root does not reach: first the nodes placed nowhere, then any
  // left over, such as a ring of nodes placed only in each other
  const reach = new Set<Id>(world.made.has(ROOT) ? reachable([ROOT]) : []);
  const loose: Id[] = [];
  for (const id of world.made.keys()) {
    if (reach.has(id) || where.has(id)) continue;
    loose.push(id);
    for (const r of reachable([id])) reach.add(r);
  }
  for (const id of world.made.keys()) {
    if (reach.has(id)) continue;
    loose.push(id);
    for (const r of reachable([id])) reach.add(r);
  }

  return (
    <aside class="pane browser">
      <div class="pane-head">
        <span class="pane-title">browser</span>
        <input
          class="filter"
          placeholder="find…"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="tree">
        {tree ?? (
          <div class="empty">
            no <code>root</code>: the host gives it when the graph is made.
          </div>
        )}
        {loose.length
          ? (
            <div class="loose">
              <div
                class="loose-title"
                title="CORE.tex: a node that no place reachable from the root holds cannot be addressed, so nothing can read or write it; placing its id again brings it back as it was. The host's copy still knows them, so it shows them here."
              >
                unreachable — cannot be addressed, by CORE.tex
              </div>
              {loose.map((id) => row(id, [], undefined, 0, new Set()))}
            </div>
          )
          : null}
      </div>
      <div class="legend">
        <span>
          <b class="k-run">◉</b> running
        </span>
        <span>
          <b class="k-proc">○</b> process
        </span>
        <span>
          <b class="k-prog">λ</b> program
        </span>
        <span>
          <b>🔒</b> refused
        </span>
      </div>
    </aside>
  );
}
