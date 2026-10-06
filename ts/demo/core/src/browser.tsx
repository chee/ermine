/// <reference lib="dom" />
// The browser: the graph as directories, from the root down. A node placed in
// many slots shows in each. Program slots are dim; process nodes glow when
// the driver runs them.

import { useState } from "preact/hooks";
import type { Id, Json, Step } from "../../../src/mod.ts";
import { peek } from "./bits.tsx";
import { lit, select, selected, world } from "./state.ts";
import { ROOT } from "./world.ts";

function kindOf(id: Id, value: Json | undefined, running: Set<Id>): { glyph: string; cls: string } {
  if (world.isProcess(id)) {
    return running.has(id) ? { glyph: "◉", cls: "k-run" } : { glyph: "○", cls: "k-proc" };
  }
  if (typeof value === "string" && isProgram(id)) return { glyph: "λ", cls: "k-prog" };
  if (Array.isArray(value) && isProgram(id)) return { glyph: "λ", cls: "k-prog" };
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

/** Every node beneath these, through every slot, read beneath protect. */
function reachable(from: Id[]): Set<Id> {
  const seen = new Set<Id>(from);
  const todo = [...from];
  while (todo.length) {
    const d = world.bare.directory({ agent: "host", node: todo.pop()! });
    if (!("directory" in d)) continue;
    for (const [, ids] of d.directory) {
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

  const row = (id: Id, route: Step[], name: string | undefined, depth: number, trail: Set<Id>) => {
    const k = rk(route);
    const r = world.read(id);
    const value = "value" in r ? r.value : undefined;
    const dir = world.directory(id);
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
    const kids = !looped && isOpen
      ? slots.flatMap(([slot, ids]) =>
        ids.map((child) =>
          row(
            child,
            [...route, { parent: id, name: slot, node: child }],
            slot,
            depth + 1,
            new Set([...trail, id]),
          )
        )
      )
      : [];
    // what the process's last run read: the edges a process has besides its slots
    const reads = world.isProcess(id) && isOpen && !looped
      ? [...new Set((world.records.get(id)?.at(-1)?.reads ?? []).map((r) => r.node))]
      : [];
    const anyKid = kids.some((x) => x !== null);
    if (!matches && !anyKid) return null;
    return (
      <div class="tree-node" key={k}>
        <div
          class={`row${sel ? " sel" : ""}${dim ? " dim" : ""}${light}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => select(id, route)}
          title={route.length ? route.map((s) => s.name).join(" / ") : "root"}
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
          {name !== undefined && name !== id
            ? (
              <>
                <span class="slot-name">{name}</span>
                <span class="arrow">→</span>
              </>
            )
            : null}
          <span class="row-id">{id}</span>
          {refused ? <span class="lock" title="protect refused a read">🔒</span> : null}
          {looped ? <span class="loop" title="placed beneath itself">↺</span> : null}
          <span class="row-peek">{kind.cls === "k-prog" ? "" : peek(value, 22)}</span>
          <span class="pulse" key={latest} />
        </div>
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
                title="CORE.tex: a node is removed when no place reaches it. This code does not remove yet, so it shows them here."
              >
                unreachable — removed, by CORE.tex
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
