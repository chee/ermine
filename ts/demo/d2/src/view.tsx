// Small pieces every panel uses: values, change headers, code chains, paths,
// and the deck an item list is drawn as. They draw what reads, records and
// changes returned, as given.

import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import {
  type Header,
  type Id,
  isBytes,
  isLive,
  type Item,
  kindOf,
  type ProcessItem,
} from "d2/ermine";
import { isObject, type Json, siteOf, type World } from "./stack.ts";

/** What is selected: an ephemeral node with a live value, or any node by id. */
export type Selection = { node: Id } | undefined;

export const ui = {
  version: signal(0),
  selected: signal<Selection>(undefined),
  /** a node to light up on the map and the stage, as a ladder rung is hovered */
  lit: signal<Id | undefined>(undefined),
  /** a site to show, with its source */
  site: signal<{ file: string; line: number; column: number } | undefined>(undefined),
  /** a burst being stepped through, and the line it is at */
  replay: signal<{ burst: number; at: number } | undefined>(undefined),
  xray: signal(false),
  tab: signal<"why" | "map">("why"),
};

/** The world, once booted. */
export let world: World;
export function setWorld(w: World) {
  world = w;
}

const COLOURS: { [actor: string]: string } = { you: "var(--you)", guest: "var(--guest)" };
export function colourOf(actor: unknown): string {
  if (typeof actor === "string" && COLOURS[actor]) return COLOURS[actor];
  return "var(--other)";
}

/** The actor of an agent: the agent itself unless it has one. */
export function actorOf(agent: unknown): Json {
  return isObject(agent) && "actor" in agent ? agent.actor : agent as Json;
}

export const short = (id: Id) => id.length > 22 ? id.slice(0, 20) + "…" : id;

/** A path from the root, as a person reads it. */
export function Path({ path, id }: { path?: readonly string[]; id?: Id }) {
  if (!path) return <span class="path gone">{id ? short(id) : "?"} (not reachable)</span>;
  return (
    <span class="path">
      {path.length === 0 ? "/" : path.map((p, i) => (
        <span key={i}>
          <span class="sep">/</span>
          {p}
        </span>
      ))}
    </span>
  );
}

/** A value by its kind: JSON, bytes, a typed array, or live. */
export function Value({ value, long }: { value: unknown; long?: boolean }) {
  if (isLive(value)) {
    const tag = (value as { tagName?: string }).tagName?.toLowerCase();
    return <span class="value live">live ⟨{tag ?? (value as object).constructor?.name}⟩</span>;
  }
  if (isBytes(value)) return <span class="value bytes">bytes · {value.byteLength}</span>;
  const kind = kindOf(value);
  if (kind) {
    const a = value as unknown as ArrayLike<number>;
    const head = Array.from(a).slice(0, long ? 12 : 4).map((x) => +Number(x).toFixed(2)).join(", ");
    return <span class="value typed">{kind}[{a.length}] {head}{a.length > 4 ? " …" : ""}</span>;
  }
  let text = JSON.stringify(
    value,
    (_k, v) =>
      isLive(v)
        ? `⟨live⟩`
        : isBytes(v)
        ? `⟨${v.byteLength} bytes⟩`
        : kindOf(v)
        ? `⟨${kindOf(v)}⟩`
        : v,
  );
  if (text === undefined) text = String(value);
  const max = long ? 600 : 90;
  return (
    <code class="value json" title={text}>
      {text.length > max ? text.slice(0, max) + "…" : text}
    </code>
  );
}

/** One step of an agent's code, as a chip that selects that process. */
export function Step({ step }: { step: Json }) {
  if (!isObject(step)) return <span class="chip">{JSON.stringify(step)}</span>;
  const pid = typeof step.process === "string" ? step.process : "?";
  const what = "run" in step
    ? `run ${step.run}`
    : "handler" in step
    ? `handler ${step.handler}`
    : "lasting" in step
    ? `lasting ${step.lasting}`
    : "item" in step
    ? `item ${step.item}`
    : "cleanup" in step
    ? "cleanup"
    : "";
  return (
    <button
      type="button"
      class="chip proc"
      onClick={() => selectProcess(pid)}
      title="show this process"
    >
      {pid} <i>{what}</i>
    </button>
  );
}

/** An agent: the actor's dot, and the code chain. */
export function Agent({ agent }: { agent: Json | undefined }) {
  const actor = actorOf(agent);
  const code = isObject(agent) && Array.isArray(agent.code) ? agent.code : [];
  return (
    <span class="agent">
      <span class="dot" style={{ background: colourOf(actor) }} />
      <b>{typeof actor === "string" ? actor : JSON.stringify(actor)}</b>
      {code.length > 0 && (
        <span class="chain">
          {code.map((s, i) => (
            <span key={i}>
              {i > 0 && <span class="arrow">→</span>}
              <Step step={s} />
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** A cause: a site, a kill, or whatever the program gave. */
export function Cause({ cause }: { cause: unknown }) {
  if (cause === undefined) return null;
  const site = siteOf(cause);
  if (site) {
    const file = site.file.split("/").pop();
    return (
      <button type="button" class="site" onClick={() => (ui.site.value = site)} title={site.file}>
        site {file}:{site.line}:{site.column}
      </button>
    );
  }
  if (isObject(cause) && typeof cause.killed === "string") {
    return <span class="cause">released: killed {cause.killed} by t={String(cause.by)}</span>;
  }
  return (
    <span class="cause">
      <Value value={cause} />
    </span>
  );
}

/** A change's header, as an item carries it. */
export function HeaderLine({ change }: { change?: Header }) {
  if (!change) return <span class="header none">no change set it (the root's first value)</span>;
  return (
    <span class="header">
      <span class="t">t={change.time}</span>
      <span class="kind">{change.kind}</span>
      <Agent agent={change.agent} />
      <Cause cause={change.cause} />
      {change.ephemeral && <span class="eph">ephemeral</span>}
    </span>
  );
}

/** Selects a process: its surface if it drew one, else the process node. */
export function selectProcess(pid: Id) {
  const surface = `${pid}/surface`;
  ui.selected.value = { node: world.ephemeral.has(surface) ? surface : pid };
  ui.tab.value = "why";
}

/** A route as breadcrumbs: each step's slot, the member taken and its position. */
export function From({ from }: { from: unknown }) {
  if (!isObject(from)) return null;
  if (Array.isArray(from.route)) {
    const route = from.route as unknown as {
      parent: Id;
      name: string;
      node: Id;
      position: number;
    }[];
    return (
      <span class="from">
        from {route.length === 0 ? "." : route.map((s, i) => (
          <span
            key={i}
            class="crumb"
            title={`slot ${s.name} of ${s.parent}: ${s.node} at ${s.position}`}
          >
            {i > 0 && " ▸ "}
            {s.name}
            {s.position > 0 && <sup>{s.position}</sup>}
          </span>
        ))}
        {typeof from.position === "number" && <span>· position {from.position}</span>}
      </span>
    );
  }
  if (Array.isArray(from.path)) {
    return (
      <span class="from">
        found at {(from.path as string[]).join("/") || "."}
        {typeof from.position === "number" && <span>· position {from.position}</span>}
      </span>
    );
  }
  if (typeof from.process === "string") {
    return (
      <span class="from">
        from the scheduler, of {from.process}
        {"run" in from ? ` run ${from.run}` : ""}
      </span>
    );
  }
  return null;
}

/** A process's own item, put in front of its value by the scheduler. */
export function ProcessBadge({ item }: { item: ProcessItem }) {
  if ("waiting" in item) {
    return <span class="badge waiting">⧗ waiting: changes [{item.waiting.join(", ")}]</span>;
  }
  if ("stopped" in item) return <span class="badge stopped">■ stopped</span>;
  if ("error" in item) {
    return (
      <span class="badge error" title={JSON.stringify(item.error)}>
        ✕ error ({item.error.kind}: {item.error.why.code}) in run {item.from.run}
      </span>
    );
  }
  return (
    <span class="badge newer" title={JSON.stringify(item.newer)}>
      ↑ newer {Object.entries(item.newer).map(([k, v]) =>
        `${k} ${
          v === null ? "gone" : `${(v as { node: Id }).node} @${(v as { time: number }).time}`
        }`
      ).join(" · ")}
    </span>
  );
}

/** A read's items, as a deck: the first wins, the rest are greyed behind it. */
export function Deck(
  { items, actions }: {
    items: readonly (Item | ProcessItem)[];
    actions?: (item: Item, index: number) => ComponentChildren;
  },
) {
  if (!items.length) return <div class="deck empty">no items: nothing is known here yet</div>;
  let firstValue = true;
  return (
    <ol class="deck">
      {items.map((it, i) => {
        if ("waiting" in it || "stopped" in it || "error" in it || "newer" in it) {
          return (
            <li key={i} class="item own">
              <ProcessBadge item={it as ProcessItem} />
            </li>
          );
        }
        const behind = !firstValue;
        firstValue = false;
        return (
          <li
            key={i}
            class={`item ${behind ? "behind" : "wins"} ${
              (it as { ephemeral?: true }).ephemeral ? "eph" : ""
            }`}
          >
            <div class="what">
              {"refused" in it
                ? <span class="refused">refused here: the search ended</span>
                : "value" in it
                ? <Value value={it.value} />
                : (
                  <span class="id">
                    {it.id}
                    {it.pending && <i>(pending: not here)</i>}
                  </span>
                )}
              {behind ? <span class="tag">behind</span> : <span class="tag win">wins</span>}
              {actions?.(it as Item, i)}
            </div>
            <div class="why">
              <From from={it.from} />
              {"change" in it && <HeaderLine change={it.change} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A labelled section of the panel. */
export function Layer(
  { n, title, children }: { n: number; title: ComponentChildren; children: ComponentChildren },
) {
  return (
    <section class="layer">
      <h2>
        <span class="n">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
